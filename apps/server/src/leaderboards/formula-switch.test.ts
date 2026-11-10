/**
 * Ticket 6.1: board formula versions switch between seasons (docs/LEADERBOARDS.md "Formula
 * versions between seasons"). With a season under way when the server first sees Power 2 and PvE
 * Progress 2, every write, read and check keeps version 1 until that season ends; at the end the
 * 5.2 sweep recomputes every hero under version 2 (its rows count as missing), the recompute check
 * is clean under both, and the season's own rows keep the version-1 standing they ended with.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { FORMULA_BASELINE, FORMULA_VERSIONS, computeScore } from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import {
  accounts,
  auditLog,
  gameSettings,
  leaderboardEntries,
  seasonEntries,
  seasons,
  worldFlags,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { insertCharacter } from '../test/heroes.js';
import { caller, insertAccount } from '../test/social.js';
import { checkLeaderboards } from './check.js';
import { FORMULA_SCHEDULE_KEY, ensureFormulaSchedule, loadFormulaSchedule } from './formulas.js';
import { cliDeps } from './leaderboard-cli.js';
import { refreshHeroScores, sweepLeaderboards } from './snapshot.js';
import type { BoardView } from './routes.js';

const DAY = 86_400_000;
let database: DatabaseHandle;
let app: FastifyInstance;
let call: ReturnType<typeof caller>;
let nowMs = Date.parse('2026-11-09T12:00:00Z');
const now = () => new Date(nowMs);
const db = () => database.db;
const seasonEnd = new Date(nowMs + 2 * DAY);

beforeAll(async () => {
  database = await createTestDatabase();
  // Season 1 is under way when this server first runs with the new versions.
  await db()
    .insert(seasons)
    .values({ number: 1, startsAt: new Date(nowMs - 5 * DAY), endsAt: seasonEnd });
  await db().insert(worldFlags).values({ flagId: 'ashenPassCleared', setAt: now() });
  app = buildApp({
    database,
    auth: { now },
    activity: { ...DEFAULT_ACTIVITY_OPTIONS, now },
    worldStateTtlMs: 0,
  });
  await app.ready();
  call = caller(app);
});

afterAll(async () => {
  await app.close();
  await database.close();
});

const deps = () => ({
  ...cliDeps(db()),
  formulaVersions: (at: Date) => app.formulaVersions.at(at),
});

describe('formula versions between seasons (ticket 6.1)', () => {
  it('keeps version 1 through the season, then the sweep recomputes every hero under version 2', async () => {
    const who = await insertAccount(db(), { now: now() });
    const warden = { gravewardenDefeated: true, cryptTierCleared: 3, ashenWardenDefeated: true };
    const hero = await insertCharacter(db(), who.id, { level: 34, progress: warden });
    await db().update(accounts).set({ activeCharacterId: hero.id }).where(eq(accounts.id, who.id));
    const other = await insertCharacter(db(), who.id, { level: 12 });

    // During the season: the plan waits for season 1, the versions in force are the baseline.
    expect(await app.formulaVersions.at(now())).toEqual(FORMULA_BASELINE);
    const plan = await loadFormulaSchedule(db());
    expect(plan.map((s) => [s.metric, s.from, s.to, s.afterSeason])).toEqual([
      ['power', 1, 2, 1],
      ['pveProgress', 1, FORMULA_VERSIONS.pveProgress, 1],
    ]);
    // Planning again (another instance, a restart) adds nothing and audits once.
    expect((await ensureFormulaSchedule(db(), now())).added).toEqual([]);
    const audits = await db()
      .select()
      .from(auditLog)
      .where(eq(auditLog.event, 'leaderboards.formula_schedule'));
    expect(audits).toHaveLength(1);
    const [setting] = await db()
      .select()
      .from(gameSettings)
      .where(eq(gameSettings.key, FORMULA_SCHEDULE_KEY));
    expect(setting!.version).toBe(1);

    for (const id of [hero.id, other.id]) await refreshHeroScores(deps(), id, now());
    const row = async (metric: 'power' | 'pveProgress') =>
      (
        await db()
          .select()
          .from(leaderboardEntries)
          .where(
            and(eq(leaderboardEntries.characterId, hero.id), eq(leaderboardEntries.metric, metric)),
          )
      )[0]!;
    const v1 = await row('pveProgress');
    expect(v1.formulaVersion).toBe(1);
    expect(v1.value).toBe(10);
    expect((await row('power')).formulaVersion).toBe(1);
    const board = async () =>
      (await call(who, 'GET', '/api/leaderboards/pveProgress')).json<{ board: BoardView }>().board;
    expect((await board()).formulaVersion).toBe(1);
    expect((await board()).entries.find((e) => e.you && e.hero.level === 34)?.value).toBe(10);
    const during = await checkLeaderboards(deps(), 200, now());
    expect(during.problems).toEqual([]);
    const seasonRow = async () =>
      (
        await db()
          .select()
          .from(seasonEntries)
          .where(
            and(
              eq(seasonEntries.season, 1),
              eq(seasonEntries.characterId, hero.id),
              eq(seasonEntries.metric, 'pveProgress'),
            ),
          )
      )[0];
    const inSeason = await seasonRow();
    expect(inSeason).toMatchObject({ formulaVersion: 1, value: 10 });

    // Just before the end nothing has moved; at the end version 2 is in force.
    nowMs = seasonEnd.getTime() - 1;
    expect(await app.formulaVersions.at(now())).toEqual(FORMULA_BASELINE);
    nowMs = seasonEnd.getTime();
    expect(await app.formulaVersions.at(now())).toEqual(FORMULA_VERSIONS);
    // Version-1 rows are not shown any more; the check calls them outdated until the sweep runs.
    expect((await board()).formulaVersion).toBe(FORMULA_VERSIONS.pveProgress);
    const outdated = await checkLeaderboards(deps(), 200, now());
    expect(outdated.problems.filter((p) => p.kind === 'outdated').length).toBe(4);
    const swept = await sweepLeaderboards(deps(), now(), { batch: 50, cursor: null });
    expect(swept.updated).toBe(2);
    const v2 = await row('pveProgress');
    expect(v2.formulaVersion).toBe(FORMULA_VERSIONS.pveProgress);
    // Ticket 6.2: version 3 also counts the Cinder Depths, open at 34 (14 of 17).
    expect(v2.value).toBe(14);
    // The recomputed value is game-core's on the stored input, at the version in force.
    expect(computeScore('pveProgress', v2.input, v2.formulaVersion).sortKey).toEqual(v2.sortKey);
    // A version-only change keeps when the hero got there.
    expect(v2.achievedAt).toEqual(v1.achievedAt);
    expect((await row('power')).formulaVersion).toBe(2);
    expect((await row('power')).value).toBeGreaterThanOrEqual(0);
    expect((await checkLeaderboards(deps(), 200, now())).problems).toEqual([]);
    expect((await board()).entries.find((e) => e.you && e.hero.level === 34)?.value).toBe(14);
    // Season 1 ended on version 1: its row keeps the standing it ended with.
    expect(await seasonRow()).toMatchObject({ formulaVersion: 1, value: 10 });
  });

  it('6.2: after 6.1’s plan, PvE Progress 3 waits for the season under way, then recomputes', async () => {
    const fresh = await createTestDatabase();
    let t = Date.parse('2026-12-01T12:00:00Z');
    const at = () => new Date(t);
    const app2 = buildApp({
      database: fresh,
      auth: { now: at },
      activity: { ...DEFAULT_ACTIVITY_OPTIONS, now: at },
      worldStateTtlMs: 0,
    });
    try {
      // Production already holds 6.1's switches, in force since season 1 ended.
      await fresh.db.insert(seasons).values([
        { number: 1, startsAt: new Date(t - 60 * DAY), endsAt: new Date(t - 10 * DAY) },
        { number: 2, startsAt: new Date(t - 10 * DAY), endsAt: new Date(t + 3 * DAY) },
      ]);
      const v61 = [
        { metric: 'power', from: 1, to: 2, afterSeason: 1, plannedAt: '2026-11-09T12:00:00Z' },
        {
          metric: 'pveProgress',
          from: 1,
          to: 2,
          afterSeason: 1,
          plannedAt: '2026-11-09T12:00:00Z',
        },
      ];
      await fresh.db.insert(gameSettings).values({
        key: FORMULA_SCHEDULE_KEY,
        value: { switches: v61 },
        version: 1,
        updatedAt: at(),
      });
      await fresh.db.insert(worldFlags).values({ flagId: 'ashenPassCleared', setAt: at() });
      await app2.ready();
      const who = await insertAccount(fresh.db, { now: at() });
      const tyrant = {
        gravewardenDefeated: true,
        cryptTierCleared: 3,
        ashenWardenDefeated: true,
        forgeTyrantDefeated: true,
      };
      const hero = await insertCharacter(fresh.db, who.id, { level: 40, progress: tyrant });
      const deps2 = {
        ...cliDeps(fresh.db),
        formulaVersions: (d: Date) => app2.formulaVersions.at(d),
      };
      // During season 2: version 2 in force, the new switch waits for its end.
      expect(await app2.formulaVersions.at(at())).toEqual({ ...FORMULA_VERSIONS, pveProgress: 2 });
      expect((await loadFormulaSchedule(fresh.db)).slice(2)).toEqual([
        expect.objectContaining({ metric: 'pveProgress', from: 2, to: 3, afterSeason: 2 }),
      ]);
      await refreshHeroScores(deps2, hero.id, at());
      const pve = async () =>
        (
          await fresh.db
            .select()
            .from(leaderboardEntries)
            .where(
              and(
                eq(leaderboardEntries.characterId, hero.id),
                eq(leaderboardEntries.metric, 'pveProgress'),
              ),
            )
        )[0]!;
      expect(await pve()).toMatchObject({ formulaVersion: 2, value: 13 });
      // At season 2's end: version 3, the sweep recomputes (the Depths, the Tyrant: 17 of 17).
      t += 3 * DAY;
      expect(await app2.formulaVersions.at(at())).toEqual(FORMULA_VERSIONS);
      expect(
        (await checkLeaderboards(deps2, 200, at())).problems.filter((p) => p.kind === 'outdated'),
      ).toHaveLength(1);
      expect((await sweepLeaderboards(deps2, at(), { batch: 50, cursor: null })).updated).toBe(1);
      expect(await pve()).toMatchObject({ formulaVersion: 3, value: 17 });
      expect((await checkLeaderboards(deps2, 200, at())).problems).toEqual([]);
    } finally {
      await app2.close();
      await fresh.close();
    }
  });

  it('switches at once when no season is under way', async () => {
    const fresh = await createTestDatabase();
    try {
      expect(
        (await ensureFormulaSchedule(fresh.db, now())).added.map((s) => s.afterSeason),
      ).toEqual([null, null]);
      const deps2 = cliDeps(fresh.db);
      expect(await deps2.formulaVersions(now())).toEqual(FORMULA_VERSIONS);
    } finally {
      await fresh.close();
    }
  });
});
