/**
 * Real-PostgreSQL races for guild seasons and guild halls (ticket 8.4). Runs when `DATABASE_URL`
 * is set, skipped otherwise (CI sets `REQUIRE_PG_TESTS=1`). Each race asserts only what holds in
 * every order:
 * - guild honour runs racing (some crashing mid-way), and a restart mid-award resumed by three runs
 *   at once: each guild honoured once (equal to game-core's `guildSeasonAwards` of the archive),
 *   each roll member's cosmetics granted and audited once, one `guild_season.award` row;
 * - one account's heroes racing gifts at the daily cap: exactly the cap is taken;
 * - members' gifts racing a disband: every gift lands before the disband (and is forfeit) or is
 *   refused; the treasury, the audit log and the telemetry reconcile in every order.
 * Dates derive from the wall clock (CLAUDE.md "Dates").
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import {
  guildSeasonAwards as computeAwards,
  guildSeasonCosmeticsEarned,
  treasuryCap,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { SESSION_COOKIE } from '../auth/index.js';
import {
  auditLog,
  characterMaterials,
  characters,
  cosmeticUnlocks,
  guildSeasonAwards,
  guildSeasonRosters,
  guildSeasonStandings,
  guildTreasuries,
  seasons,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { createPostgresTestDatabase } from '../test/db.js';
import { insertGuild } from '../test/guilds.js';
import { insertCharacter } from '../test/heroes.js';
import { insertAccount, type TestAccount } from '../test/social.js';
import { DAY, dayFromNow, insertPve, insertSeason, insertStage } from '../test/guild-seasons.js';
import { reconcileWithAudit } from '../telemetry/report.js';
import { archiveSeason } from '../seasons/model.js';
import { awardGuildSeason } from './model.js';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === '1') {
  throw new Error('REQUIRE_PG_TESTS=1 but DATABASE_URL is not set');
}

const ROUNDS = 3;

describe.skipIf(!url)('real PostgreSQL: guild seasons and treasuries race safely', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let nowMs = dayFromNow(2).getTime();
  const now = () => new Date(nowMs);
  const db = () => database.db;
  let seasonNo = 0;

  beforeAll(async () => {
    database = await createPostgresTestDatabase(url!, { poolMax: 30 });
    app = buildApp({
      database,
      auth: { socialWriteLimit: { windows: [{ windowMs: 60_000, max: 100_000 }] } },
      activity: { ...DEFAULT_ACTIVITY_OPTIONS, now },
    });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  /** A season with `count` ranked guilds of 3 members each, archived. */
  async function archivedSeason(count: number) {
    seasonNo += 1;
    const start = new Date(nowMs);
    const end = new Date(start.getTime() + 14 * DAY);
    await insertSeason(db(), seasonNo, start, end);
    for (let g = 0; g < count; g++) {
      const ps: TestAccount[] = [];
      for (let i = 0; i < 3; i++) ps.push(await insertAccount(db()));
      const guild = await insertGuild(db(), ps[0]!.id, {
        members: ps.slice(1).map((p) => ({ accountId: p.id })),
        now: new Date(start.getTime() - 30 * DAY),
      });
      for (const p of ps) {
        await insertPve(db(), p.id, 1 + ((g + 3) % 25));
        // Every member fought for the guild (the "took part" rule), on distinct weeks.
      }
      for (let i = 0; i < 3; i++)
        await insertStage(db(), guild.id, ps[i]!.id, 1 + i, new Date(start.getTime() + DAY));
    }
    nowMs = end.getTime() + 10 * 60_000;
    expect(await archiveSeason(db(), seasonNo, now(), new Date())).toBe('archived');
    return seasonNo;
  }

  async function expectHonouredOnce(season: number) {
    const standings = await db()
      .select()
      .from(guildSeasonStandings)
      .where(eq(guildSeasonStandings.season, season));
    const want = computeAwards(standings)
      .map((a) => `${a.guildId}:${a.tier}:${a.rank}`)
      .sort();
    const got = (
      await db().select().from(guildSeasonAwards).where(eq(guildSeasonAwards.season, season))
    ).map((a) => `${a.guildId}:${a.tier}:${a.rank}`);
    expect(got.sort()).toEqual(want);
    const tierOf = new Map(computeAwards(standings).map((a) => [a.guildId, a.tier]));
    const roll = await db()
      .select()
      .from(guildSeasonRosters)
      .where(eq(guildSeasonRosters.season, season));
    const honoured = roll.filter((r) => tierOf.has(r.guildId));
    expect(honoured.length).toBeGreaterThan(0);
    for (const r of honoured) {
      const owned = await db()
        .select()
        .from(cosmeticUnlocks)
        .where(eq(cosmeticUnlocks.accountId, r.accountId));
      expect(owned.map((o) => o.cosmeticId).sort()).toEqual(
        guildSeasonCosmeticsEarned(tierOf.get(r.guildId)!).sort(),
      );
      const grants = await db()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.event, 'cosmetic.grant'), eq(auditLog.accountId, r.accountId)));
      expect(grants).toHaveLength(owned.length);
    }
    const [row] = await db().select().from(seasons).where(eq(seasons.number, season));
    expect(row!.guildAwardedAt).not.toBeNull();
    const audited = (
      await db().select().from(auditLog).where(eq(auditLog.event, 'guild_season.award'))
    ).filter((a) => (a.data as { season: number }).season === season);
    expect(audited).toHaveLength(1);
  }

  it('honour runs racing, some crashing mid-award: each honour exactly once', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const season = await archivedSeason(12);
      const runs = await Promise.allSettled([
        awardGuildSeason(db(), season, now(), { batch: 2 }),
        awardGuildSeason(db(), season, now(), { batch: 1, failAfterBatches: 3 }),
        awardGuildSeason(db(), season, now(), { batch: 5 }),
        awardGuildSeason(db(), season, now(), { batch: 3, failAfterBatches: 1 }),
      ]);
      for (const r of runs)
        if (r.status === 'rejected') expect(String(r.reason)).toMatch(/stopped after/);
      await expectHonouredOnce(season);
    }
  });

  it('a restart mid-award, then three resumes racing: the same set, once', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const season = await archivedSeason(10);
      await expect(
        awardGuildSeason(db(), season, now(), { batch: 2, failAfterBatches: 2 + round }),
      ).rejects.toThrow(/stopped after/);
      const [mid] = await db().select().from(seasons).where(eq(seasons.number, season));
      expect(mid!.guildAwardedAt).toBeNull();
      await Promise.all([
        awardGuildSeason(db(), season, now(), { batch: 4 }),
        awardGuildSeason(db(), season, now(), { batch: 1 }),
        awardGuildSeason(db(), season, now()),
      ]);
      await expectHonouredOnce(season);
    }
  });

  // --- treasuries ---
  const give = (who: TestAccount, characterId: string, resource: string, amount: number) =>
    app.inject({
      method: 'POST',
      url: '/api/guild/hall/contribute',
      payload: { characterId, offer: [{ resource, amount }], acknowledgeNoRefund: true },
      headers: { 'idempotency-key': randomUUID() },
      cookies: { [SESSION_COOKIE]: who.token },
    });
  async function richHero(who: TestAccount) {
    const hero = await insertCharacter(db(), who.id, { level: 30 });
    await db().update(characters).set({ gold: 1_000_000 }).where(eq(characters.id, hero.id));
    await db()
      .insert(characterMaterials)
      .values({ characterId: hero.id, materialId: 'ironOre', quantity: 1_000 });
    return hero.id;
  }

  it('one account’s heroes racing gifts share the daily cap exactly', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const a = await insertAccount(db());
      const guild = await insertGuild(db(), a.id);
      const heroes = await Promise.all([0, 1, 2, 3].map(() => richHero(a)));
      const res = await Promise.all(heroes.map((h) => give(a, h, 'gold', 10_000)));
      for (const r of res) expect([200, 409]).toContain(r.statusCode);
      const [t] = await db()
        .select()
        .from(guildTreasuries)
        .where(eq(guildTreasuries.guildId, guild.id));
      expect(Number(t!.gold)).toBe(treasuryCap('gold'));
      const spent = (
        await db().select().from(characters).where(inArray(characters.id, heroes))
      ).reduce((s, h) => s + (1_000_000 - Number(h.gold)), 0);
      expect(spent).toBe(treasuryCap('gold'));
    }
  });

  it('gifts racing a disband: before it (forfeit) or refused; the books balance', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const leader = await insertAccount(db());
      const members: TestAccount[] = [];
      for (let i = 0; i < 6; i++) members.push(await insertAccount(db()));
      const guild = await insertGuild(db(), leader.id, {
        members: members.map((m) => ({ accountId: m.id })),
      });
      const heroes = await Promise.all(members.map((m) => richHero(m)));
      const disband = app.inject({
        method: 'POST',
        url: '/api/guild/disband',
        payload: { name: guild.name },
        cookies: { [SESSION_COOKIE]: leader.token },
      });
      const gifts = members.map((m, i) => give(m, heroes[i]!, 'gold', 1_000 + i));
      const [d, ...rs] = await Promise.all(
        round % 2 ? [disband, ...gifts] : [disband, ...gifts.reverse()],
      );
      expect(d!.statusCode).toBe(200);
      for (const r of rs) expect([200, 404]).toContain(r.statusCode);
      const [t] = await db()
        .select()
        .from(guildTreasuries)
        .where(eq(guildTreasuries.guildId, guild.id));
      expect(Number(t?.gold ?? 0)).toBe(0);
      const checks = (await reconcileWithAudit(db())).filter((c) => !c.ok);
      expect(checks).toEqual([]);
    }
  });
});
