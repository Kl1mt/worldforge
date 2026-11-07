/**
 * Real-PostgreSQL races for seasons (ticket 5.3, docs/LEADERBOARDS.md "Seasons"). Runs when
 * `DATABASE_URL` is set, skipped otherwise (CI sets `REQUIRE_PG_TESTS=1`). Each race asserts only
 * what holds in every order:
 * - award runs racing (several at once, some crashing mid-way, then resumed): every award exactly
 *   once, equal to game-core's `seasonAwards` of the archive; one default display per decorated
 *   account; the season marked awarded and audited once;
 * - a score change racing the season's archive (the request arrived before the end): the archive
 *   equals the season board whichever commits first, and nothing is written into the season after
 *   its archive.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { seasonAwards as computeAwards } from '@worldforge/game-core';
import {
  auditLog,
  characters,
  prestigeDisplays,
  seasonAwards,
  seasonEntries,
  seasonStandings,
  seasons,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { createPostgresTestDatabase } from '../test/db.js';
import { insertCharacter } from '../test/heroes.js';
import { insertAccount } from '../test/social.js';
import { cliDeps } from '../leaderboards/leaderboard-cli.js';
import { refreshHeroScores } from '../leaderboards/snapshot.js';
import { archiveSeason, awardSeason, scheduleSeason } from './model.js';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === '1') {
  throw new Error('REQUIRE_PG_TESTS=1 but DATABASE_URL is not set');
}

const DAY = 86_400_000;
const ROUNDS = 4;
const cli = { accountId: null, via: 'cli' as const };

describe.skipIf(!url)('real PostgreSQL: seasons close and award exactly once', () => {
  let database: DatabaseHandle;
  let nowMs = Date.parse('2031-01-01T00:00:00Z');
  const now = () => new Date(nowMs);
  const db = () => database.db;

  beforeAll(async () => {
    database = await createPostgresTestDatabase(url!, { poolMax: 30 });
  });
  afterAll(async () => {
    await database?.close();
  });

  const progress = async (heroId: string, level: number, at: Date) => {
    await db().update(characters).set({ level }).where(eq(characters.id, heroId));
    return refreshHeroScores(cliDeps(db()), heroId, at);
  };

  /** A season `[start, start + 2 days)` with `players` heroes on its boards, archived. */
  async function archivedSeason(players: number) {
    const start = new Date(nowMs + DAY);
    const end = new Date(start.getTime() + 2 * DAY);
    const s = await scheduleSeason(db(), { startsAt: start, endsAt: end }, now(), cli);
    nowMs = start.getTime() + 1000;
    for (let i = 0; i < players; i++) {
      const who = await insertAccount(db(), { now: now() });
      const hero = await insertCharacter(db(), who.id, { level: 9 });
      nowMs += 1000;
      await progress(hero.id, 9 + (i % 7), now());
    }
    nowMs = end.getTime();
    expect(await archiveSeason(db(), s.number, now(), now(), 0)).toBe('archived');
    return s.number;
  }

  const awardsOf = async (season: number) =>
    db().select().from(seasonAwards).where(eq(seasonAwards.season, season));

  async function expectAwardedOnce(season: number, players: number) {
    const standings = await db()
      .select()
      .from(seasonStandings)
      .where(eq(seasonStandings.season, season));
    const want = computeAwards(standings)
      .map((a) => `${a.accountId}:${a.metric}:${a.tier}:${a.rank}`)
      .sort();
    const got = (await awardsOf(season)).map(
      (a) => `${a.accountId}:${a.metric}:${a.tier}:${a.rank}`,
    );
    expect(got.sort()).toEqual(want);
    expect(new Set(got).size).toBe(got.length);
    const accounts = new Set((await awardsOf(season)).map((a) => a.accountId));
    expect(accounts.size).toBe(players);
    const displays = await db().select().from(prestigeDisplays);
    expect(displays.filter((d) => accounts.has(d.accountId))).toHaveLength(players);
    const [row] = await db().select().from(seasons).where(eq(seasons.number, season));
    expect(row!.awardedAt).not.toBeNull();
    const audited = (
      await db().select().from(auditLog).where(eq(auditLog.event, 'season.award'))
    ).filter((a) => (a.data as { season: number }).season === season);
    expect(audited).toHaveLength(1);
  }

  it('award runs racing, some crashing mid-award: every award exactly once', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const players = 30;
      const season = await archivedSeason(players);
      const runs = await Promise.allSettled([
        awardSeason(db(), season, now(), { batch: 7 }),
        awardSeason(db(), season, now(), { batch: 3, failAfterBatches: 2 }),
        awardSeason(db(), season, now(), { batch: 11 }),
        awardSeason(db(), season, now(), { batch: 5 }),
        awardSeason(db(), season, now(), { batch: 2, failAfterBatches: 9 }),
      ]);
      // The crashing runs may finish first (nothing left to insert) or crash; never another error.
      for (const r of runs)
        if (r.status === 'rejected') expect(String(r.reason)).toMatch(/stopped after/);
      await expectAwardedOnce(season, players);
      nowMs += DAY;
    }
  });

  it('a restart mid-award, then resumes racing: every award exactly once', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const players = 25;
      const season = await archivedSeason(players);
      await expect(
        awardSeason(db(), season, now(), { batch: 4, failAfterBatches: 3 }),
      ).rejects.toThrow(/stopped after 3/);
      expect(await awardsOf(season)).toHaveLength(12);
      const [mid] = await db().select().from(seasons).where(eq(seasons.number, season));
      expect(mid!.awardedAt).toBeNull();
      await Promise.all([
        awardSeason(db(), season, now(), { batch: 4 }),
        awardSeason(db(), season, now(), { batch: 9 }),
        awardSeason(db(), season, now()),
      ]);
      await expectAwardedOnce(season, players);
      nowMs += DAY;
    }
  });

  it('a score change racing the archive: the archive equals the season board in every order', async () => {
    const orders = new Set<string>();
    for (let round = 0; round < ROUNDS * 3; round++) {
      const start = new Date(nowMs + DAY);
      const end = new Date(start.getTime() + 2 * DAY);
      const s = await scheduleSeason(db(), { startsAt: start, endsAt: end }, now(), cli);
      const who = await insertAccount(db(), { now: now() });
      const hero = await insertCharacter(db(), who.id, { level: 12 });
      await progress(hero.id, 13, new Date(start.getTime() + 1000));
      // The request arrived 1 ms before the end; its refresh races the archive (no grace).
      nowMs = end.getTime();
      await db().update(characters).set({ level: 14 }).where(eq(characters.id, hero.id));
      await Promise.all([
        refreshHeroScores(cliDeps(db()), hero.id, new Date(end.getTime() - 1)),
        archiveSeason(db(), s.number, now(), now(), 0),
      ]);
      const [entry] = await db()
        .select()
        .from(seasonEntries)
        .where(
          and(
            eq(seasonEntries.season, s.number),
            eq(seasonEntries.characterId, hero.id),
            eq(seasonEntries.metric, 'level'),
          ),
        );
      const [standing] = await db()
        .select()
        .from(seasonStandings)
        .where(
          and(
            eq(seasonStandings.season, s.number),
            eq(seasonStandings.characterId, hero.id),
            eq(seasonStandings.metric, 'level'),
          ),
        );
      expect(standing!.sortKey).toEqual(entry!.sortKey);
      expect([
        [13, 0],
        [14, 0],
      ]).toContainEqual(entry!.sortKey);
      orders.add(String(entry!.sortKey[0]));
      // A later refresh with a clock in the season writes nothing into it.
      await db().update(characters).set({ level: 15 }).where(eq(characters.id, hero.id));
      await refreshHeroScores(cliDeps(db()), hero.id, new Date(end.getTime() - 1));
      const [after] = await db()
        .select()
        .from(seasonEntries)
        .where(
          and(
            eq(seasonEntries.season, s.number),
            eq(seasonEntries.characterId, hero.id),
            eq(seasonEntries.metric, 'level'),
          ),
        );
      expect(after!.sortKey).toEqual(entry!.sortKey);
      nowMs += DAY;
    }
    // Both orders are allowed; which ones happened is informational only.
    expect(orders.size).toBeGreaterThanOrEqual(1);
  });
});
