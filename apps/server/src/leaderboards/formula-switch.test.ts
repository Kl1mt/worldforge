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
      ['power', 1, FORMULA_VERSIONS.power, 1],
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
    // Ticket 6.2: version 3 also counts the Cinder Depths, open at 34 (14 of 17; 8.1: of 21).
    expect(v2.value).toBe(14);
    // The recomputed value is game-core's on the stored input, at the version in force.
    expect(computeScore('pveProgress', v2.input, v2.formulaVersion).sortKey).toEqual(v2.sortKey);
    // A version-only change keeps when the hero got there.
    expect(v2.achievedAt).toEqual(v1.achievedAt);
    expect((await row('power')).formulaVersion).toBe(FORMULA_VERSIONS.power);
    expect((await row('power')).value).toBeGreaterThanOrEqual(0);
    expect((await checkLeaderboards(deps(), 200, now())).problems).toEqual([]);
    expect((await board()).entries.find((e) => e.you && e.hero.level === 34)?.value).toBe(14);
    // Season 1 ended on version 1: its row keeps the standing it ended with.
    expect(await seasonRow()).toMatchObject({ formulaVersion: 1, value: 10 });
  });

  it('6.3: after 6.1’s and 6.2’s plans, PvE Progress 4 follows 3 at the season’s end, then recomputes', async () => {
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
        // 6.2's switch, waiting for season 2 (production when 6.3 ships).
        {
          metric: 'pveProgress',
          from: 2,
          to: 3,
          afterSeason: 2,
          plannedAt: '2026-11-25T12:00:00Z',
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
      // During season 2: version 2 in force, the new switches wait for its end (8.1's Power 3 and
      // PvE Progress 5 ship in the same season here: they chain onto the same end).
      expect(await app2.formulaVersions.at(at())).toEqual({
        ...FORMULA_VERSIONS,
        power: 2,
        pveProgress: 2,
      });
      expect((await loadFormulaSchedule(fresh.db)).slice(3)).toEqual([
        expect.objectContaining({ metric: 'power', from: 2, to: 3, afterSeason: 2 }),
        expect.objectContaining({
          metric: 'pveProgress',
          from: 3,
          to: FORMULA_VERSIONS.pveProgress,
          afterSeason: 2,
        }),
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
      // At season 2's end: the newest versions, the sweep recomputes (version 5: 18 of 21, not
      // Heroic, the Pale Marches reached at 40 with the Tyrant slain; 8.2's version 6 the same 18
      // of 25: no lanterns, no Sovereign).
      t += 3 * DAY;
      expect(await app2.formulaVersions.at(at())).toEqual(FORMULA_VERSIONS);
      expect(
        (await checkLeaderboards(deps2, 200, at())).problems.filter((p) => p.kind === 'outdated'),
      ).toHaveLength(2);
      expect((await sweepLeaderboards(deps2, at(), { batch: 50, cursor: null })).updated).toBe(1);
      expect(await pve()).toMatchObject({
        formulaVersion: FORMULA_VERSIONS.pveProgress,
        value: 18,
      });
      expect((await checkLeaderboards(deps2, 200, at())).problems).toEqual([]);
    } finally {
      await app2.close();
      await fresh.close();
    }
  });

  // Ticket 8.2: this server knows PvE Progress 6, so the switch it plans here goes 4 → 6 at once
  // (8.1 and 8.2 shipping in the same season); the next test plays 8.1's stored switch.
  it('8.1: with 6.1–6.3 in force, Power 3 and PvE Progress 5 wait for the season under way', async () => {
    const fresh = await createTestDatabase();
    let t = Math.floor(Date.now() / DAY) * DAY + DAY / 2;
    const at = () => new Date(t);
    const iso = (ms: number) => new Date(ms).toISOString();
    const app2 = buildApp({
      database: fresh,
      auth: { now: at },
      activity: { ...DEFAULT_ACTIVITY_OPTIONS, now: at },
      worldStateTtlMs: 0,
    });
    try {
      // Production when 8.1 ships: every 6.x switch in force (Power 2, PvE Progress 4), season 3
      // under way.
      await fresh.db.insert(seasons).values([
        { number: 1, startsAt: new Date(t - 120 * DAY), endsAt: new Date(t - 64 * DAY) },
        { number: 2, startsAt: new Date(t - 64 * DAY), endsAt: new Date(t - 8 * DAY) },
        { number: 3, startsAt: new Date(t - 8 * DAY), endsAt: new Date(t + 4 * DAY) },
      ]);
      const sw = (metric: string, from: number, to: number, afterSeason: number, days: number) => ({
        metric,
        from,
        to,
        afterSeason,
        plannedAt: iso(t - days * DAY),
      });
      const stored = [
        sw('power', 1, 2, 1, 100),
        sw('pveProgress', 1, 2, 1, 100),
        sw('pveProgress', 2, 3, 2, 80),
        sw('pveProgress', 3, 4, 2, 70),
      ];
      await fresh.db.insert(gameSettings).values({
        key: FORMULA_SCHEDULE_KEY,
        value: { switches: stored },
        version: 1,
        updatedAt: at(),
      });
      await fresh.db.insert(worldFlags).values({ flagId: 'ashenPassCleared', setAt: at() });
      await app2.ready();
      const who = await insertAccount(fresh.db, { now: at() });
      const progress = {
        gravewardenDefeated: true,
        cryptTierCleared: 3,
        ashenWardenDefeated: true,
        forgeTyrantDefeated: true,
      };
      const hero = await insertCharacter(fresh.db, who.id, { level: 43, progress });
      const deps2 = {
        ...cliDeps(fresh.db),
        formulaVersions: (d: Date) => app2.formulaVersions.at(d),
      };
      const v6 = { ...FORMULA_VERSIONS, power: 2, pveProgress: 4 };
      expect(await app2.formulaVersions.at(at())).toEqual(v6);
      expect((await loadFormulaSchedule(fresh.db)).slice(4)).toEqual([
        expect.objectContaining({ metric: 'power', from: 2, to: 3, afterSeason: 3 }),
        expect.objectContaining({
          metric: 'pveProgress',
          from: 4,
          to: FORMULA_VERSIONS.pveProgress,
          afterSeason: 3,
        }),
      ]);
      await refreshHeroScores(deps2, hero.id, at());
      const row = async (metric: 'power' | 'pveProgress') =>
        (
          await fresh.db
            .select()
            .from(leaderboardEntries)
            .where(
              and(
                eq(leaderboardEntries.characterId, hero.id),
                eq(leaderboardEntries.metric, metric),
              ),
            )
        )[0]!;
      // During season 3 the season's versions stand: 17 of 18, 22 trials.
      expect(await row('pveProgress')).toMatchObject({ formulaVersion: 4, value: 17 });
      expect(await row('power')).toMatchObject({ formulaVersion: 2 });
      const powerV2 = (await row('power')).value;
      expect((await checkLeaderboards(deps2, 200, at())).problems).toEqual([]);
      // At the end: Power 3 and PvE Progress 5 (the Marches reached and its middle: 19 of 21).
      t += 4 * DAY;
      expect(await app2.formulaVersions.at(at())).toEqual(FORMULA_VERSIONS);
      expect((await sweepLeaderboards(deps2, at(), { batch: 50, cursor: null })).updated).toBe(1);
      expect(await row('pveProgress')).toMatchObject({
        formulaVersion: FORMULA_VERSIONS.pveProgress,
        value: 19,
      });
      const power = await row('power');
      expect(power.formulaVersion).toBe(3);
      // Version 3 = version 2 + the trials at 42 and 46: never lower.
      expect(power.value).toBeGreaterThanOrEqual(powerV2);
      expect(computeScore('power', power.input, 3).value).toBe(power.value);
      expect((await checkLeaderboards(deps2, 200, at())).problems).toEqual([]);
    } finally {
      await app2.close();
      await fresh.close();
    }
  });

  it('8.2: PvE Progress 6 chains after 8.1’s pending switch; the Deep and the Sovereign count after the season', async () => {
    const fresh = await createTestDatabase();
    let t = Math.floor(Date.now() / DAY) * DAY + DAY / 2;
    const at = () => new Date(t);
    const iso = (ms: number) => new Date(ms).toISOString();
    const app2 = buildApp({
      database: fresh,
      auth: { now: at },
      activity: { ...DEFAULT_ACTIVITY_OPTIONS, now: at },
      worldStateTtlMs: 0,
    });
    try {
      // Production when 8.2 ships: 6.x in force, 8.1's Power 3 and PvE Progress 5 planned for
      // the end of season 3, which is still under way.
      await fresh.db.insert(seasons).values([
        { number: 1, startsAt: new Date(t - 120 * DAY), endsAt: new Date(t - 64 * DAY) },
        { number: 2, startsAt: new Date(t - 64 * DAY), endsAt: new Date(t - 8 * DAY) },
        { number: 3, startsAt: new Date(t - 8 * DAY), endsAt: new Date(t + 4 * DAY) },
      ]);
      const sw = (metric: string, from: number, to: number, afterSeason: number, days: number) => ({
        metric,
        from,
        to,
        afterSeason,
        plannedAt: iso(t - days * DAY),
      });
      const stored = [
        sw('power', 1, 2, 1, 100),
        sw('pveProgress', 1, 2, 1, 100),
        sw('pveProgress', 2, 3, 2, 80),
        sw('pveProgress', 3, 4, 2, 70),
        sw('power', 2, 3, 3, 2),
        sw('pveProgress', 4, 5, 3, 2),
      ];
      await fresh.db.insert(gameSettings).values({
        key: FORMULA_SCHEDULE_KEY,
        value: { switches: stored },
        version: 1,
        updatedAt: at(),
      });
      await fresh.db.insert(worldFlags).values(
        ['ashenPassCleared', 'forgewardRaised', 'deepLanternsLit'].map((flagId) => ({
          flagId,
          setAt: at(),
        })),
      );
      await app2.ready();
      const who = await insertAccount(fresh.db, { now: at() });
      const progress = {
        gravewardenDefeated: true,
        cryptTierCleared: 4,
        ashenWardenDefeated: true,
        forgeTyrantDefeated: true,
        hollowSovereignDefeated: true,
      };
      const hero = await insertCharacter(fresh.db, who.id, { level: 52, progress });
      const deps2 = {
        ...cliDeps(fresh.db),
        formulaVersions: (d: Date) => app2.formulaVersions.at(d),
      };
      const v6 = { ...FORMULA_VERSIONS, power: 2, pveProgress: 4 };
      expect(await app2.formulaVersions.at(at())).toEqual(v6);
      // The new switch follows 8.1's at the same season end.
      expect((await loadFormulaSchedule(fresh.db)).slice(6)).toEqual([
        expect.objectContaining({ metric: 'pveProgress', from: 5, to: 6, afterSeason: 3 }),
      ]);
      await refreshHeroScores(deps2, hero.id, at());
      const row = async () =>
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
      // During season 3: version 4's 18 of 18.
      expect(await row()).toMatchObject({ formulaVersion: 4, value: 18 });
      expect((await checkLeaderboards(deps2, 200, at())).problems).toEqual([]);
      // At its end: version 6 in one step, all 25 (the Deep reached and held, the Sovereign).
      t += 4 * DAY;
      expect(await app2.formulaVersions.at(at())).toEqual(FORMULA_VERSIONS);
      expect((await sweepLeaderboards(deps2, at(), { batch: 50, cursor: null })).updated).toBe(1);
      const after = await row();
      expect(after).toMatchObject({ formulaVersion: 6, value: 25 });
      expect(computeScore('pveProgress', after.input, 6).sortKey).toEqual(after.sortKey);
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
