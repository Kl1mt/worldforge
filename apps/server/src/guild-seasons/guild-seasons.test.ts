/**
 * The guild season roll (ticket 8.4, docs/LEADERBOARDS.md "Guild seasons"): the score from stored
 * facts and its recompute check, the churn rules (joiners, leavers, gifts before joining, honours
 * by tenure and taking part), test accounts and sanctions left off, privacy, the archive inside
 * 5.3's, honours exactly once (a crash mid-award, then a rerun), a season archived before 8.4, and
 * the import scan. Dates derive from the wall clock (CLAUDE.md "Dates").
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { guildSeasonCosmeticsEarned, guildSeasonScore } from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import {
  accountNotifications,
  auditLog,
  blocks,
  cosmeticUnlocks,
  guildMembers,
  guildSeasonAwards,
  guildSeasonEntries,
  guildSeasonRosters,
  guildSeasonStandings,
  guilds,
  sanctions,
  seasons,
  type Guild,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { createTestDatabase } from '../test/db.js';
import { insertGuild } from '../test/guilds.js';
import { caller, insertAccount, type TestAccount } from '../test/social.js';
import {
  DAY,
  dayFromNow,
  insertGift,
  insertPve,
  insertSeason,
  insertStage,
} from '../test/guild-seasons.js';
import { setTestAccount } from '../admin/test-accounts.js';
import { runSeasonJobs } from '../seasons/model.js';
import { awardGuildSeason, checkGuildSeasons, refreshGuildSeason } from './model.js';

const day = (d: Date) => d.toISOString().slice(0, 10);

describe('guild season roll', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let call: ReturnType<typeof caller>;
  // Season 1 starts at tomorrow's midnight (UTC) and lasts 56 days; the game clock moves.
  const START = dayFromNow(1);
  const END = new Date(START.getTime() + 56 * DAY);
  let nowMs = START.getTime() + 20 * DAY;
  const now = () => new Date(nowMs);
  const db = () => database.db;

  beforeAll(async () => {
    database = await createTestDatabase();
    app = buildApp({
      database,
      auth: { socialWriteLimit: { windows: [{ windowMs: 60_000, max: 100_000 }] } },
      activity: { ...DEFAULT_ACTIVITY_OPTIONS, now },
    });
    await app.ready();
    call = caller(app);
    await insertSeason(db(), 1, START, END);
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  /** A guild of `n` players who joined `joinedDaysBefore` days before START. */
  async function guildOf(n: number, joinedDaysBefore = 30) {
    const players: TestAccount[] = [];
    for (let i = 0; i < n; i++) players.push(await insertAccount(db()));
    const joined = new Date(START.getTime() - joinedDaysBefore * DAY);
    const guild = await insertGuild(db(), players[0]!.id, {
      members: players.slice(1).map((p) => ({ accountId: p.id })),
      now: joined,
    });
    return { guild, players };
  }

  const board = async (who: TestAccount, q = '') => {
    const res = await call(who, 'GET', `/api/leaderboards/guilds${q}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  };
  const entryOf = async (who: TestAccount, g: Guild) =>
    (await board(who)).entries.find((e: { guild: { tag: string } }) => e.guild.tag === g.tag);
  const rowOf = async (g: Guild) =>
    (
      await db()
        .select()
        .from(guildSeasonEntries)
        .where(and(eq(guildSeasonEntries.season, 1), eq(guildSeasonEntries.guildId, g.id)))
    )[0];

  let champion: Awaited<ReturnType<typeof guildOf>>;

  it('scores a guild from its stored facts, and the roll shows it', async () => {
    champion = await guildOf(4);
    const [a, b, c, d] = champion.players;
    await insertStage(db(), champion.guild.id, a!.id, 1, new Date(START.getTime() + DAY));
    await insertStage(db(), champion.guild.id, b!.id, 2, new Date(START.getTime() + 2 * DAY));
    // Before the season: never counts.
    await insertStage(db(), champion.guild.id, a!.id, 5, new Date(START.getTime() - 3 * DAY));
    await insertPve(db(), a!.id, 25);
    await insertPve(db(), a!.id, 10); // the best hero counts
    await insertPve(db(), b!.id, 20);
    await insertPve(db(), c!.id, 21, 5); // version 5 has 21 milestones: a full share
    await insertGift(db(), d!.id, day(new Date(START.getTime() + 3 * DAY)), 9_000);
    await insertGift(db(), d!.id, day(new Date(START.getTime() - 2 * DAY)), 90_000); // before
    const out = await refreshGuildSeason(db(), now(), new Date());
    expect(out.season).toBe(1);
    const row = await rowOf(champion.guild);
    expect(row!.members).toBe(4);
    const score = guildSeasonScore(row!.input);
    expect(score.parts).toEqual({ boss: 20 + 40, pve: 100 + 80 + 100, community: 10 });
    expect(Number(row!.value)).toBe(score.value);
    const e = await entryOf(a!, champion.guild);
    expect(e).toMatchObject({ rank: 1, value: score.value, parts: score.parts, members: 4 });
    expect(e.guild.handle).toBe(champion.guild.handle);
    expect((await checkGuildSeasons(db())).wrong).toEqual([]);
  });

  it('the recompute check tells a tampered row apart', async () => {
    const row = await rowOf(champion.guild);
    await db()
      .update(guildSeasonEntries)
      .set({ value: Number(row!.value) + 1 })
      .where(eq(guildSeasonEntries.guildId, champion.guild.id));
    expect((await checkGuildSeasons(db())).wrong).toEqual([
      { season: 1, guildId: champion.guild.id, table: 'entries' },
    ]);
    // The next refresh rewrites only rows whose input changed: restore by hand, then check.
    await db()
      .update(guildSeasonEntries)
      .set({ value: Number(row!.value) })
      .where(eq(guildSeasonEntries.guildId, champion.guild.id));
    expect((await checkGuildSeasons(db())).wrong).toEqual([]);
  });

  it('a refresh with nothing new rewrites nothing and keeps “reached first”', async () => {
    const before = await rowOf(champion.guild);
    nowMs += 60_000;
    const out = await refreshGuildSeason(db(), now(), new Date(), [champion.guild.id]);
    expect(out.updated).toBe(0);
    expect((await rowOf(champion.guild))!.achievedAt).toEqual(before!.achievedAt);
  });

  it('churn: a joiner counts from day seven, a leaver at once takes their part', async () => {
    const { guild, players } = await guildOf(3);
    const late = await insertAccount(db());
    // Joined 3 days ago (game clock), with a gift on the day it joined and one the day after.
    const joined = new Date(nowMs - 3 * DAY);
    await db().insert(guildMembers).values({
      accountId: late.id,
      guildId: guild.id,
      role: 'member',
      joinedAt: joined,
    });
    await insertPve(db(), late.id, 25);
    await insertGift(db(), late.id, day(joined), 9_000);
    await insertGift(db(), late.id, day(new Date(joined.getTime() + DAY)), 9_000);
    for (const p of players) await insertPve(db(), p.id, 5);
    await refreshGuildSeason(db(), now(), new Date(), [guild.id]);
    expect((await rowOf(guild))!.members).toBe(3);
    nowMs += 4 * DAY;
    await refreshGuildSeason(db(), now(), new Date(), [guild.id]);
    const row = await rowOf(guild);
    expect(row!.members).toBe(4);
    // Only the gift of the day after joining counts (a tenth of the gold need: 10 points).
    expect(guildSeasonScore(row!.input).parts.community).toBe(10);
    expect(guildSeasonScore(row!.input).parts.pve).toBe(100 + 3 * 20);
    await db().delete(guildMembers).where(eq(guildMembers.accountId, late.id));
    await refreshGuildSeason(db(), now(), new Date(), [guild.id]);
    const after = guildSeasonScore((await rowOf(guild))!.input);
    expect(after.parts).toEqual({ boss: 0, pve: 60, community: 0 });
    expect(after.members).toBe(3);
  });

  it('a guild needs three counted members to be listed; its own hall still sees it', async () => {
    const { guild, players } = await guildOf(2);
    await insertStage(db(), guild.id, players[0]!.id, 3, new Date(nowMs - DAY));
    const res = await board(players[0]!);
    expect(res.entries.some((e: { guild: { tag: string } }) => e.guild.tag === guild.tag)).toBe(
      false,
    );
    expect(res.mine).toMatchObject({ rank: null, listed: false, members: 2 });
  });

  it('test accounts never count, and a guild of test accounts never appears', async () => {
    const { guild, players } = await guildOf(3);
    for (const p of players) await setTestAccount(db(), p.handle, true);
    await insertStage(db(), guild.id, players[0]!.id, 5, new Date(nowMs - DAY));
    for (const p of players) await insertPve(db(), p.id, 25);
    await refreshGuildSeason(db(), now(), new Date());
    expect(await entryOf(champion.players[0]!, guild)).toBeUndefined();
    const row = await rowOf(guild);
    expect(row?.members ?? 0).toBe(0);
    // Mixed: the test member is not counted.
    const mixed = await guildOf(4);
    await setTestAccount(db(), mixed.players[3]!.handle, true);
    await insertPve(db(), mixed.players[3]!.id, 25);
    await insertStage(db(), mixed.guild.id, mixed.players[0]!.id, 1, new Date(nowMs - DAY));
    await refreshGuildSeason(db(), now(), new Date(), [mixed.guild.id]);
    const m = await rowOf(mixed.guild);
    expect(m!.members).toBe(3);
    expect(guildSeasonScore(m!.input).parts.pve).toBe(0);
  });

  it('sanctions: a sanctioned leader takes the guild off the roll, a sanctioned member stops counting', async () => {
    const { guild, players } = await guildOf(4);
    await insertStage(db(), guild.id, players[0]!.id, 4, new Date(nowMs - DAY));
    await refreshGuildSeason(db(), now(), new Date(), [guild.id]);
    expect(await entryOf(champion.players[0]!, guild)).toBeDefined();
    const sanctionId = uuidv7();
    await db()
      .insert(sanctions)
      .values({
        id: sanctionId,
        subjectId: players[0]!.id,
        kind: 'mute',
        reason: 'test',
        issuedBy: champion.players[1]!.id,
        expiresAt: new Date(Date.now() + DAY),
      } as never);
    expect(await entryOf(champion.players[0]!, guild)).toBeUndefined();
    await refreshGuildSeason(db(), now(), new Date(), [guild.id]);
    expect((await rowOf(guild))!.members).toBe(3);
    await db().delete(sanctions).where(eq(sanctions.id, sanctionId));
    await refreshGuildSeason(db(), now(), new Date(), [guild.id]);
    expect(await entryOf(champion.players[0]!, guild)).toBeDefined();
    // A forced rename withholds it too.
    await db().update(guilds).set({ renameRequired: true }).where(eq(guilds.id, guild.id));
    expect(await entryOf(champion.players[0]!, guild)).toBeUndefined();
    await db().update(guilds).set({ renameRequired: false }).where(eq(guilds.id, guild.id));
  });

  it('privacy: no player is named, and a guild hidden by a block shows without its link', async () => {
    const viewer = await insertAccount(db());
    const res = await call(viewer, 'GET', '/api/leaderboards/guilds');
    const text = res.body;
    for (const p of champion.players) {
      expect(text).not.toContain(p.id);
      expect(text).not.toContain(p.handle);
      expect(text).not.toContain(p.displayName);
    }
    expect(text).not.toContain(champion.guild.id);
    await db()
      .insert(blocks)
      .values({ blockerId: champion.players[0]!.id, blockedId: viewer.id, createdAt: new Date() });
    const e = await entryOf(viewer, champion.guild);
    expect(e.guild.handle).toBeNull();
    expect(e.guild.name).toBe(champion.guild.name);
    const fan = await entryOf(champion.players[1]!, champion.guild);
    expect(fan.guild.handle).toBe(champion.guild.handle);
  });

  it('archives the roll with the season and honours each guild exactly once, resumably', async () => {
    const [a, b, c, d] = champion.players;
    // Give the champion a big lead; a late joiner (10 days before the end) and an idle member.
    // Stage 5 in six later weeks (one row per guild, week and stage).
    for (let i = 0; i < 6; i++)
      await insertStage(
        db(),
        champion.guild.id,
        a!.id,
        5,
        new Date(START.getTime() + (7 * (i + 1) + 3) * DAY),
      );
    void b;
    void c;
    void d;
    const late = await insertAccount(db());
    await db()
      .insert(guildMembers)
      .values({
        accountId: late.id,
        guildId: champion.guild.id,
        role: 'member',
        joinedAt: new Date(END.getTime() - 10 * DAY),
      });
    await insertStage(db(), champion.guild.id, late.id, 1, new Date(END.getTime() - 5 * DAY));
    const idle = await insertAccount(db());
    await db()
      .insert(guildMembers)
      .values({
        accountId: idle.id,
        guildId: champion.guild.id,
        role: 'member',
        joinedAt: new Date(START.getTime() - 40 * DAY),
      });
    // The season ends; the scheduler archives, then a crash mid-award.
    nowMs = END.getTime() + 10 * 60_000;
    const report = await runSeasonJobs(db(), now(), new Date(), {
      guildAward: { batch: 1, failAfterBatches: 2 },
    }).catch((e: Error) => e);
    expect(String(report)).toMatch(/stopped after 2 batches/);
    const [s] = await db().select().from(seasons).where(eq(seasons.number, 1));
    expect(s!.archivedAt).not.toBeNull();
    expect(s!.guildArchivedAt).not.toBeNull();
    expect(s!.guildAwardedAt).toBeNull();
    const standings = await db()
      .select()
      .from(guildSeasonStandings)
      .where(eq(guildSeasonStandings.season, 1));
    expect(standings.find((x) => x.rank === 1)!.guildId).toBe(champion.guild.id);
    expect(standings.map((x) => x.rank).sort((x, y) => x - y)).toEqual(
      standings.map((_, i) => i + 1),
    );
    // The honour roll: fought or gave, and 14 days in the guild by the end.
    const roll = (
      await db()
        .select()
        .from(guildSeasonRosters)
        .where(
          and(eq(guildSeasonRosters.season, 1), eq(guildSeasonRosters.guildId, champion.guild.id)),
        )
    ).map((r) => r.accountId);
    expect(roll).toContain(a!.id);
    expect(roll).toContain(b!.id);
    expect(roll).toContain(d!.id); // gave to the town works
    expect(roll).not.toContain(c!.id); // neither fought nor gave
    expect(roll).not.toContain(late.id); // joined too late
    expect(roll).not.toContain(idle.id);
    // The rerun finishes the same set, once.
    await runSeasonJobs(db(), now(), new Date());
    await runSeasonJobs(db(), now(), new Date());
    const awards = await db()
      .select()
      .from(guildSeasonAwards)
      .where(eq(guildSeasonAwards.season, 1));
    expect(awards.find((x) => x.guildId === champion.guild.id)!.tier).toBe('champion');
    expect(new Set(awards.map((x) => x.guildId)).size).toBe(awards.length);
    const owned = await db()
      .select()
      .from(cosmeticUnlocks)
      .where(eq(cosmeticUnlocks.accountId, a!.id));
    expect(owned.map((o) => o.cosmeticId).sort()).toEqual(
      guildSeasonCosmeticsEarned('champion').sort(),
    );
    expect(owned.every((o) => o.source === 'guildSeason:1')).toBe(true);
    const lateOwned = await db()
      .select()
      .from(cosmeticUnlocks)
      .where(eq(cosmeticUnlocks.accountId, late.id));
    expect(lateOwned).toEqual([]);
    const audited = await db()
      .select()
      .from(auditLog)
      .where(eq(auditLog.event, 'guild_season.award'));
    expect(audited).toHaveLength(1);
    const grants = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.event, 'cosmetic.grant'), eq(auditLog.accountId, a!.id)));
    expect(grants).toHaveLength(6);
    expect(await awardGuildSeason(db(), 1, now())).toEqual({ kind: 'already' });
    // Ticket 8.5: the honoured member's inbox has the honour once, the late joiner's nothing.
    const notes = await db()
      .select()
      .from(accountNotifications)
      .where(eq(accountNotifications.kind, 'guild.honours'));
    expect(notes.filter((n) => n.accountId === a!.id).map((n) => n.data)).toEqual([
      { season: 1, tier: 'champion' },
    ]);
    expect(notes.filter((n) => n.accountId === late.id)).toEqual([]);
    // The archive is read for season 1 now, with the tier.
    const past = await board(a!, '?season=1');
    expect(past.season.number).toBe(1);
    expect(past.entries[0]).toMatchObject({ rank: 1, tier: 'champion' });
    expect((await checkGuildSeasons(db())).wrong).toEqual([]);
  });

  it('a season archived before 8.4 is marked done with no guild honours', async () => {
    await db()
      .insert(seasons)
      .values({
        number: 50,
        startsAt: new Date(START.getTime() - 10 * DAY),
        endsAt: new Date(START.getTime() - 9 * DAY),
        archivedAt: new Date(START.getTime() - 8 * DAY),
        awardedAt: new Date(START.getTime() - 8 * DAY),
      });
    expect(await awardGuildSeason(db(), 50, now())).toEqual({ kind: 'none' });
    const [s] = await db().select().from(seasons).where(eq(seasons.number, 50));
    expect(s!.guildAwardedAt).not.toBeNull();
    expect(
      await db().select().from(guildSeasonAwards).where(eq(guildSeasonAwards.season, 50)),
    ).toEqual([]);
    void sql;
  });

  it('no gameplay rule reads the guild season or guild hall modules', () => {
    const root = join(import.meta.dirname, '../../../../packages/game-core/src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) files.push(p);
      }
    };
    walk(root);
    const importers = files
      .filter((p) => !p.includes('/guild-seasons/') && !p.includes('/guild-halls/'))
      .filter((p) => /from '[./]*\/?guild-(seasons|halls)\//.test(readFileSync(p, 'utf8')))
      .map((p) => p.slice(root.length + 1))
      .sort();
    // The index re-exports them; the cosmetic catalogue names the honour tiers (a cosmetic).
    expect(importers).toEqual(['cosmetics/catalogue.ts', 'index.ts']);
  });
});
