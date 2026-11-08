/**
 * Ticket 5.3: seasons and prestige rewards (docs/LEADERBOARDS.md "Seasons", "Prestige rewards").
 * - The window rule at the boundary: a change counts in the season whose window holds the
 *   request's clock, also when its refresh runs after the end; the end moment belongs to the next
 *   season; nothing is written into a season after its archive.
 * - Season boards: only heroes whose score rose; the board's order; the archive equals the board
 *   at the season's end (every metric, filters, pages); sanctioned accounts left out.
 * - Awards: tiers by place, exactly once, resumable after a crash mid-award; the default display;
 *   choosing a title and a frame; shown on boards, profiles and guild rosters.
 * - Privacy: the 5.2 profile-link rules hold on season boards and archives.
 * - Admin controls (admins only, audited) and the owner CLI.
 * - Invariance: awards and displays change no gameplay row and no score input.
 * Each describe has its own database (seasons are global).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import {
  PROFILE_VISIBILITIES,
  SCORE_METRICS,
  SEASON_CLOSE_GRACE_MS,
  canViewProfile,
  compareBoardEntries,
  computeScores,
  seasonAwards as computeAwards,
  type ProfileRelation,
  type ProfileVisibility,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import {
  accounts,
  auditLog,
  blocks,
  characters,
  friendships,
  guildMembers,
  itemInstances,
  leaderboardEntries,
  prestigeDisplays,
  sanctions,
  seasonAwards,
  seasonEntries,
  seasonStandings,
  seasons,
} from '../db/schema.js';
import { uuidv7 } from '../db/uuid.js';
import { createTestDatabase } from '../test/db.js';
import { insertGuild } from '../test/guilds.js';
import { insertCharacter } from '../test/heroes.js';
import { caller, insertAccount, type TestAccount } from '../test/social.js';
import { cliDeps } from '../leaderboards/leaderboard-cli.js';
import { refreshHeroScores, snapshotInput } from '../leaderboards/snapshot.js';
import type { BoardView } from '../leaderboards/routes.js';
import {
  archiveSeason,
  awardSeason,
  runSeasonJobs,
  scheduleSeason,
  setSeasonEnd,
} from './model.js';
import { runSeasonCommand } from './season-cli.js';

const DAY = 86_400_000;
const WEEK = 7 * DAY;

/** A fresh database and app with a settable game clock (auth uses the same clock). */
async function world(startIso: string) {
  const database = await createTestDatabase();
  const clock = { ms: Date.parse(startIso) };
  const now = () => new Date(clock.ms);
  const app = buildApp({
    database,
    auth: { now },
    activity: { ...DEFAULT_ACTIVITY_OPTIONS, now },
    leaderboards: { readLimit: { max: 100_000, windowMs: 60_000 } },
    worldStateTtlMs: 0,
    ...(process.env.SEASON_TEST_LOG ? { logger: { level: 'error' } } : {}),
  });
  await app.ready();
  const deps = cliDeps(database.db);
  const db = database.db;
  /** Sets the hero's level and XP and refreshes it as a request that arrived at `at`. */
  const progress = async (heroId: string, level: number, experience: number, at = now()) => {
    await db.update(characters).set({ level, experience }).where(eq(characters.id, heroId));
    return refreshHeroScores(deps, heroId, at);
  };
  const board = async (who: TestAccount, path: string) => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/leaderboards/${path}`,
      cookies: { wf_session: who.token },
    });
    return res;
  };
  const boardOf = async (who: TestAccount, path: string) => {
    const res = await board(who, path);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ board: BoardView }>().board;
  };
  const seasonRow = async (season: number, heroId: string, metric = 'level' as const) =>
    (
      await db
        .select()
        .from(seasonEntries)
        .where(
          and(
            eq(seasonEntries.season, season),
            eq(seasonEntries.characterId, heroId),
            eq(seasonEntries.metric, metric),
          ),
        )
    )[0];
  return { database, db, app, clock, now, deps, progress, board, boardOf, seasonRow };
}

type World = Awaited<ReturnType<typeof world>>;
const cli = { accountId: null, via: 'cli' as const };

describe('the season boundary (window rule)', () => {
  let w: World;
  const start = new Date('2027-01-04T00:00:00Z');
  const end = new Date(start.getTime() + 8 * WEEK);
  beforeAll(async () => {
    w = await world('2027-01-01T12:00:00Z');
    await scheduleSeason(w.db, { startsAt: start, endsAt: end }, w.now(), cli);
  });
  afterAll(async () => {
    await w.app.close();
    await w.database.close();
  });

  it('counts a change only inside [start, end), by the request clock, frozen after the archive', async () => {
    const who = await insertAccount(w.db, { now: w.now() });
    const hero = await insertCharacter(w.db, who.id, { level: 5 });
    // Before the season: the all-time row only.
    await w.progress(hero.id, 5, 10);
    expect(await w.seasonRow(1, hero.id)).toBeUndefined();

    // The first moment of the season counts; the base is the standing before it.
    w.clock.ms = start.getTime();
    await w.progress(hero.id, 6, 0);
    const first = (await w.seasonRow(1, hero.id))!;
    expect(first.sortKey).toEqual([6, 0]);
    expect(first.baseSortKey).toEqual([5, 10]);
    expect(first.achievedAt).toEqual(start);

    // The next season follows on its own, back to back.
    w.clock.ms = start.getTime() + DAY;
    expect((await runSeasonJobs(w.db, w.now(), w.now())).created).toBe(2);

    // A request that arrived 1 ms before the end, refreshed after it: counts in season 1.
    w.clock.ms = end.getTime() + 30_000;
    await w.progress(hero.id, 7, 0, new Date(end.getTime() - 1));
    expect((await w.seasonRow(1, hero.id))!.sortKey).toEqual([7, 0]);
    expect(await w.seasonRow(2, hero.id)).toBeUndefined();

    // The end moment belongs to season 2 only.
    await w.progress(hero.id, 7, 40, end);
    expect((await w.seasonRow(1, hero.id))!.sortKey).toEqual([7, 0]);
    expect((await w.seasonRow(2, hero.id))!.sortKey).toEqual([7, 40]);
    expect((await w.seasonRow(2, hero.id))!.baseSortKey).toEqual([7, 0]);

    // Not archived within the grace; then archived once.
    expect(await archiveSeason(w.db, 1, w.now(), w.now())).toBe('not_due');
    w.clock.ms = end.getTime() + SEASON_CLOSE_GRACE_MS;
    expect(await archiveSeason(w.db, 1, w.now(), w.now())).toBe('archived');
    expect(await archiveSeason(w.db, 1, w.now(), w.now())).toBe('already');

    // A very late refresh with a clock inside season 1 writes nothing into it any more.
    await w.progress(hero.id, 8, 0, new Date(end.getTime() - 1000));
    expect((await w.seasonRow(1, hero.id))!.sortKey).toEqual([7, 0]);
    const [standing] = await w.db
      .select()
      .from(seasonStandings)
      .where(and(eq(seasonStandings.season, 1), eq(seasonStandings.characterId, hero.id)));
    expect(standing!.sortKey).toEqual([7, 0]);
  });
});

describe('a formula bump mid-season (ticket B.4)', () => {
  let w: World;
  const start = new Date('2027-01-04T00:00:00Z');
  const end = new Date(start.getTime() + 8 * WEEK);
  beforeAll(async () => {
    w = await world('2027-01-01T12:00:00Z');
    await scheduleSeason(w.db, { startsAt: start, endsAt: end }, w.now(), cli);
  });
  afterAll(async () => {
    await w.app.close();
    await w.database.close();
  });

  it('a longer key (a new tie-breaker) is no rise; a real rise stays on the board', async () => {
    // Gear Score version 2 appended a tie-breaker to version 1's key [total]. Two heroes stored
    // under version 1 mid-season: one rose this season (base below its key), one fell and came
    // back to where it started (base = key). The sweep then rewrites both under version 2.
    w.clock.ms = start.getTime() + DAY;
    const rows: { id: string; base: number[] }[] = [];
    for (const base of [[-5], [0]]) {
      const who = await insertAccount(w.db, { now: w.now() });
      const hero = await insertCharacter(w.db, who.id, { level: 12 });
      await refreshHeroScores(w.deps, hero.id, w.now());
      await w.db
        .update(leaderboardEntries)
        .set({ formulaVersion: 1, sortKey: [0] })
        .where(
          and(
            eq(leaderboardEntries.characterId, hero.id),
            eq(leaderboardEntries.metric, 'gearScore'),
          ),
        );
      const row = {
        season: 1,
        characterId: hero.id,
        metric: 'gearScore' as const,
        accountId: who.id,
        classId: 'warrior' as const,
        level: 12,
        formulaVersion: 1,
        value: 0,
        sortKey: [0],
        baseSortKey: base,
        achievedAt: w.now(),
        updatedAt: w.now(),
      };
      await w.db
        .insert(seasonEntries)
        .values(row)
        .onConflictDoUpdate({
          target: [seasonEntries.season, seasonEntries.characterId, seasonEntries.metric],
          set: { formulaVersion: 1, sortKey: [0], baseSortKey: base },
        });
      rows.push({ id: hero.id, base });
    }
    w.clock.ms += DAY;
    for (const r of rows) await refreshHeroScores(w.deps, r.id, w.now());
    const [rose, back] = await Promise.all(
      rows.map(async (r) => (await w.seasonRow(1, r.id, 'gearScore' as 'level'))!),
    );
    expect(rose!.formulaVersion).toBe(2);
    expect(rose!.sortKey).toEqual([0, 0]);
    expect(rose!.baseSortKey).toEqual([-5]);
    expect(back!.sortKey).toEqual([0, 0]);
    expect(back!.baseSortKey).toEqual([0, 0]);
    // The board lists the hero that rose, not the one that only came back.
    const viewer = await insertAccount(w.db, { now: w.now() });
    const board = await w.boardOf(viewer, 'gearScore?scope=season&season=1');
    const listed = new Set(board.entries.map((e) => e.value));
    expect(board.total).toBe(1);
    expect(listed).toEqual(new Set([0]));
  });
});

describe('season boards, archive integrity and awards', () => {
  let w: World;
  let call: ReturnType<typeof caller>;
  const start = new Date('2027-03-01T00:00:00Z');
  const end = new Date(start.getTime() + 2 * WEEK);
  const viewers: TestAccount[] = [];
  const heroes: { who: TestAccount; id: string; classId: string }[] = [];

  beforeAll(async () => {
    w = await world('2027-02-20T00:00:00Z');
    call = caller(w.app);
    await scheduleSeason(w.db, { startsAt: start, endsAt: end }, w.now(), cli);
    // Fourteen players with standings before the season (a few with two heroes).
    const classes = ['warrior', 'mage', 'hunter', 'warlock'] as const;
    for (let i = 0; i < 14; i++) {
      const who = await insertAccount(w.db, { now: w.now() });
      viewers.push(who);
      for (let j = 0; j < (i % 5 === 0 ? 2 : 1); j++) {
        const classId = classes[(i + j) % 4]!;
        const hero = await insertCharacter(w.db, who.id, { classId, level: 8 + (i % 4) });
        heroes.push({ who, id: hero.id, classId });
        await w.progress(hero.id, 8 + (i % 4), 0);
      }
    }
  });
  afterAll(async () => {
    await w.app.close();
    await w.database.close();
  });

  it('a season board lists only heroes whose score rose, ranked like every board', async () => {
    w.clock.ms = start.getTime() + DAY;
    // Before anyone moves: the season under way, an empty board.
    const empty = await w.boardOf(viewers[0]!, 'level?scope=season');
    expect(empty.season?.number).toBe(1);
    expect(empty.season?.status).toBe('active');
    expect(empty.total).toBe(0);
    // Two thirds of the heroes progress (different amounts, a few ties); one falls and rises
    // back to where it was (not listed: no rise).
    for (const [i, h] of heroes.entries()) {
      if (i % 3 === 2) continue;
      w.clock.ms += 60_000;
      const [row] = await w.db.select().from(characters).where(eq(characters.id, h.id));
      await w.progress(h.id, row!.level + 1 + (i % 4), (i % 2) * 50);
    }
    const fallen = heroes[2]!;
    const [fallenRow] = await w.db.select().from(characters).where(eq(characters.id, fallen.id));
    await w.progress(fallen.id, fallenRow!.level - 1, 0);
    await w.progress(fallen.id, fallenRow!.level, 0);

    for (const metric of SCORE_METRICS) {
      const page = await w.boardOf(viewers[0]!, `${metric}?scope=season&limit=100`);
      const rows = (await w.db.select().from(seasonEntries)).filter((r) => r.metric === metric);
      const rose = rows.filter(
        (r) => r.baseSortKey === null || compareKeys(r.sortKey, r.baseSortKey) > 0,
      );
      expect(page.total, metric).toBe(rose.length);
      const expected = [...rose]
        .sort((a, b) =>
          compareBoardEntries(
            { sortKey: a.sortKey, achievedAt: a.achievedAt, id: a.characterId },
            { sortKey: b.sortKey, achievedAt: b.achievedAt, id: b.characterId },
          ),
        )
        .map((r) => r.value);
      expect(
        page.entries.map((e) => e.value),
        metric,
      ).toEqual(expected);
    }
    const level = await w.boardOf(viewers[0]!, 'level?scope=season&limit=100');
    expect(level.total).toBe(heroes.filter((_, i) => i % 3 !== 2).length);
  });

  it('the archive equals the season boards at the end (every metric, filters, pages)', async () => {
    // A sanctioned account at the end is left off the board and the archive.
    const banned = heroes[0]!.who;
    await w.db.insert(sanctions).values({
      id: uuidv7(),
      subjectId: banned.id,
      kind: 'mute',
      reason: 'test',
      createdAt: w.now(),
      expiresAt: new Date(end.getTime() + 52 * WEEK),
    });
    w.clock.ms = end.getTime() - 1;
    const viewer = viewers[5]!;
    const paths = [
      ...SCORE_METRICS.map((m) => `${m}?scope=season&season=1&limit=100`),
      'level?scope=season&season=1&class=mage&limit=100',
      'power?scope=season&season=1&bracket=10-19&limit=100',
      'level?scope=season&season=1&limit=3',
    ];
    const atEnd = [];
    for (const p of paths) atEnd.push(await w.boardOf(viewer, p));
    expect(atEnd[0]!.entries.some((e) => e.player.handle === banned.handle)).toBe(false);

    w.clock.ms = end.getTime() + SEASON_CLOSE_GRACE_MS;
    const out = await runSeasonJobs(w.db, w.now(), w.now());
    expect(out.archived).toEqual([1]);
    expect(out.awarded).toEqual([1]);
    for (const [i, p] of paths.entries()) {
      const archived = await w.boardOf(viewer, p);
      expect(archived.season?.archivedAt, p).not.toBeNull();
      expect(archived.season?.status, p).toBe('closed');
      // Equal but for the season's state and the prestige just awarded (shown from now on).
      expect(withoutPrestige(archived), p).toEqual(withoutPrestige(atEnd[i]!));
    }
    // No archived row of the sanctioned account, and no award for it.
    const standings = await w.db.select().from(seasonStandings);
    expect(standings.some((s) => s.accountId === banned.id)).toBe(false);
    const awards = await w.db.select().from(seasonAwards);
    expect(awards.some((a) => a.accountId === banned.id)).toBe(false);
    // Ranks are 1…n per board.
    for (const m of SCORE_METRICS) {
      const ranks = standings.filter((s) => s.metric === m).map((s) => s.rank);
      expect(ranks.sort((a, b) => a - b)).toEqual(ranks.map((_, i) => i + 1));
    }
  });

  it('awards each account its best tier per board, exactly once; the default display', async () => {
    const standings = await w.db
      .select()
      .from(seasonStandings)
      .where(eq(seasonStandings.season, 1));
    const expected = computeAwards(standings);
    const stored = await w.db.select().from(seasonAwards).where(eq(seasonAwards.season, 1));
    expect(
      stored
        .map((a) => ({
          accountId: a.accountId,
          metric: a.metric,
          tier: a.tier,
          rank: a.rank,
          characterId: a.characterId,
        }))
        .sort(byAward),
    ).toEqual([...expected].sort(byAward));
    expect(stored.some((a) => a.tier === 'champion')).toBe(true);
    // Running again gives nothing twice.
    w.clock.ms += 60_000;
    expect(await runSeasonJobs(w.db, w.now(), w.now())).toMatchObject({
      archived: [],
      awarded: [],
    });
    expect(await awardSeason(w.db, 1, w.now())).toEqual({ kind: 'already' });
    expect(await w.db.select().from(seasonAwards)).toHaveLength(stored.length);
    // Every decorated account shows its best award by default.
    const displays = await w.db.select().from(prestigeDisplays);
    expect(new Set(displays.map((d) => d.accountId))).toEqual(
      new Set(stored.map((a) => a.accountId)),
    );
    const champion = stored.find((a) => a.tier === 'champion' && a.metric === 'level')!;
    const shown = displays.find((d) => d.accountId === champion.accountId)!;
    expect(
      stored.find((a) => a.accountId === shown.accountId && a.metric === shown.titleMetric)!.tier,
    ).toBe('champion');
  });

  it('players choose an earned title and frame (or none); shown on boards, profiles, guild rosters', async () => {
    const award = (await w.db.select().from(seasonAwards)).find((a) => a.tier !== 'champion')!;
    const owner = viewers.find((v) => v.id === award.accountId)!;
    const other = viewers.find((v) => v.id !== award.accountId && v.id !== heroes[0]!.who.id)!;
    const settings = await call(owner, 'GET', '/api/account/prestige');
    expect(settings.statusCode).toBe(200);
    const earned = settings.json<{ earned: { season: number; metric: string }[] }>().earned;
    expect(earned.length).toBeGreaterThan(0);
    // Not earned: refused, nothing changes.
    const refused = await call(owner, 'POST', '/api/account/prestige', {
      title: {
        season: 1,
        metric: SCORE_METRICS.find((m) => !earned.some((e) => e.metric === m)) ?? 'level',
      },
      frame: null,
    });
    if (earned.length < SCORE_METRICS.length) {
      expect(refused.statusCode, refused.body).toBe(422);
      expect(refused.json().error.code).toBe('award_not_earned');
    }
    expect(
      (
        await call(owner, 'POST', '/api/account/prestige', {
          title: { season: 2, metric: 'level' },
          frame: null,
        })
      ).statusCode,
    ).toBe(422);
    const bad = await call(owner, 'POST', '/api/account/prestige', {
      title: 'Champion',
      frame: null,
    });
    expect(bad.statusCode).toBe(400);

    const chose = await call(owner, 'POST', '/api/account/prestige', {
      title: { season: 1, metric: award.metric },
      frame: null,
    });
    expect(chose.statusCode, chose.body).toBe(200);
    const want = { title: { season: 1, metric: award.metric, tier: award.tier }, frame: null };
    expect(chose.json().shown).toEqual(want);

    // The board, the profile and the guild rosters show it.
    const page = await w.boardOf(other, 'level?limit=100');
    expect(page.entries.find((e) => e.player.handle === owner.handle)!.player.prestige).toEqual(
      want,
    );
    await w.db
      .update(accounts)
      .set({ profileVisibility: 'public' })
      .where(eq(accounts.id, owner.id));
    const profile = await call(other, 'GET', `/api/players/${owner.handle}/profile`);
    expect(profile.json().profile.prestige).toEqual(want);
    const guild = await insertGuild(w.db, owner.id, { members: [{ accountId: other.id }] });
    const mine = await call(other, 'GET', '/api/guild');
    expect(mine.statusCode, mine.body).toBe(200);
    const member = mine
      .json<{ guild: { members: { handle: string; prestige: unknown }[] } }>()
      .guild.members.find((m) => m.handle === owner.handle)!;
    expect(member.prestige).toEqual(want);
    const pub = await call(other, 'GET', `/api/guilds/${guild.handle}`);
    expect(pub.statusCode, pub.body).toBe(200);
    expect(
      pub
        .json<{ members: { handle: string; prestige: unknown }[] }>()
        .members.find((m) => m.handle === owner.handle)!.prestige,
    ).toEqual(want);

    // Showing none is a choice; a later award does not override it.
    const none = await call(owner, 'POST', '/api/account/prestige', { title: null, frame: null });
    expect(none.json().shown).toEqual({ title: null, frame: null });
    const [row] = await w.db
      .select()
      .from(prestigeDisplays)
      .where(eq(prestigeDisplays.accountId, owner.id));
    expect(row).toMatchObject({ titleSeason: null, frameSeason: null });
    const audited = await w.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.event, 'profile.prestige'));
    expect(audited.length).toBeGreaterThanOrEqual(2);
  });
});

describe('award runs are resumable', () => {
  let w: World;
  beforeAll(async () => {
    w = await world('2027-05-01T00:00:00Z');
  });
  afterAll(async () => {
    await w.app.close();
    await w.database.close();
  });

  it('a crash mid-award, then a rerun: every award exactly once', async () => {
    const start = new Date('2027-05-02T00:00:00Z');
    const end = new Date(start.getTime() + 2 * DAY);
    await scheduleSeason(w.db, { startsAt: start, endsAt: end }, w.now(), cli);
    w.clock.ms = start.getTime() + 1000;
    for (let i = 0; i < 12; i++) {
      const who = await insertAccount(w.db, { now: w.now() });
      const hero = await insertCharacter(w.db, who.id, { level: 10 });
      w.clock.ms += 1000;
      await w.progress(hero.id, 10 + i, 0);
    }
    w.clock.ms = end.getTime() + SEASON_CLOSE_GRACE_MS;
    expect(await archiveSeason(w.db, 1, w.now(), w.now())).toBe('archived');
    await expect(awardSeason(w.db, 1, w.now(), { batch: 5, failAfterBatches: 2 })).rejects.toThrow(
      /stopped after 2 batches/,
    );
    expect(await w.db.select().from(seasonAwards)).toHaveLength(10);
    const [mid] = await w.db.select().from(seasons).where(eq(seasons.number, 1));
    expect(mid!.awardedAt).toBeNull();
    expect(await w.db.select().from(prestigeDisplays)).toHaveLength(0);

    const out = await awardSeason(w.db, 1, w.now(), { batch: 5 });
    expect(out).toMatchObject({ kind: 'awarded', inserted: 38, total: 48 });
    const awards = await w.db.select().from(seasonAwards);
    expect(awards).toHaveLength(48);
    expect(new Set(awards.map((a) => `${a.accountId}:${a.metric}`)).size).toBe(48);
    expect(await w.db.select().from(prestigeDisplays)).toHaveLength(12);
    const standings = await w.db.select().from(seasonStandings);
    expect([...computeAwards(standings)].sort(byAward)).toEqual(
      awards
        .map((a) => ({
          accountId: a.accountId,
          metric: a.metric,
          tier: a.tier,
          rank: a.rank,
          characterId: a.characterId,
        }))
        .sort(byAward),
    );
  });
});

describe('privacy: the profile-link rules hold on season boards and archives', () => {
  let w: World;
  const start = new Date('2027-07-05T00:00:00Z');
  const end = new Date(start.getTime() + 2 * DAY);
  beforeAll(async () => {
    w = await world('2027-07-04T00:00:00Z');
    await scheduleSeason(w.db, { startsAt: start, endsAt: end }, w.now(), cli);
  });
  afterAll(async () => {
    await w.app.close();
    await w.database.close();
  });

  const RELATIONS = [
    'self',
    'friend',
    'guildmate',
    'stranger',
    'blocked-by-me',
    'blocked-by-them',
  ] as const;
  const asProfileRelation = (r: (typeof RELATIONS)[number]): ProfileRelation =>
    r === 'blocked-by-me' || r === 'blocked-by-them' ? 'blocked' : r;

  it('links the name and shows the hero only where the profile may be opened', async () => {
    const cases: {
      owner: TestAccount;
      viewer: TestAccount;
      heroName: string;
      label: string;
      allowed: boolean;
    }[] = [];
    w.clock.ms = start.getTime() + 1000;
    for (const visibility of PROFILE_VISIBILITIES) {
      for (const relation of RELATIONS) {
        const owner = await insertAccount(w.db, { now: w.now() });
        const viewer = relation === 'self' ? owner : await insertAccount(w.db, { now: w.now() });
        await w.db
          .update(accounts)
          .set({ profileVisibility: visibility as ProfileVisibility })
          .where(eq(accounts.id, owner.id));
        const hero = await insertCharacter(w.db, owner.id, { classId: 'warlock', level: 7 });
        w.clock.ms += 1000;
        await w.progress(hero.id, 7, 5);
        const [low, high] = owner.id < viewer.id ? [owner.id, viewer.id] : [viewer.id, owner.id];
        if (relation === 'friend') {
          await w.db.insert(friendships).values({
            accountLow: low,
            accountHigh: high,
            status: 'friends',
            requestedBy: viewer.id,
            createdAt: w.now(),
            acceptedAt: w.now(),
          });
        }
        if (relation === 'guildmate') {
          await insertGuild(w.db, owner.id, { members: [{ accountId: viewer.id }] });
        }
        if (relation === 'blocked-by-me' || relation === 'blocked-by-them') {
          const [blockerId, blockedId] =
            relation === 'blocked-by-me' ? [viewer.id, owner.id] : [owner.id, viewer.id];
          await w.db.insert(blocks).values({ blockerId, blockedId, createdAt: w.now() });
        }
        cases.push({
          owner,
          viewer,
          heroName: hero.name,
          label: `${visibility} × ${relation}`,
          allowed: canViewProfile(visibility, asProfileRelation(relation)),
        });
      }
    }
    const check = async (path: string) => {
      for (const c of cases) {
        const page = await w.boardOf(c.viewer, path);
        const entry = [...page.entries, ...page.yours].find(
          (e) => e.player.handle === c.owner.handle,
        );
        expect(entry, `${path} ${c.label}`).toBeDefined();
        expect(entry!.player.displayName, c.label).toBe(c.owner.displayName);
        expect(entry!.player.profile, c.label).toBe(c.allowed);
        expect(entry!.hero.name, c.label).toBe(c.allowed ? c.heroName : null);
      }
    };
    await check('level?scope=season&limit=100');
    w.clock.ms = end.getTime() + SEASON_CLOSE_GRACE_MS;
    await runSeasonJobs(w.db, w.now(), w.now());
    await check('level?scope=season&season=1&limit=100');
  });

  it('answers 404 for a season that has not begun or does not exist; none yet is empty', async () => {
    const who = await insertAccount(w.db, { now: w.now() });
    expect((await w.board(who, 'level?scope=season&season=99')).statusCode).toBe(404);
    expect((await w.board(who, 'level?scope=season&season=2')).statusCode).toBe(200);
    expect((await w.board(who, 'level?scope=season&season=3')).statusCode).toBe(404);
    expect((await w.board(who, 'level?scope=season&season=0')).statusCode).toBe(400);
    const res = await w.app.inject({ method: 'GET', url: '/api/seasons' });
    expect(res.statusCode).toBe(401);
  });
});

describe('admin controls and the owner CLI', () => {
  let w: World;
  let call: ReturnType<typeof caller>;
  beforeAll(async () => {
    w = await world('2027-09-01T10:00:00Z');
    call = caller(w.app);
  });
  afterAll(async () => {
    await w.app.close();
    await w.database.close();
  });

  it('admins view, schedule, extend and end seasons; everyone else gets the 404', async () => {
    const admin = await insertAccount(w.db, { role: 'admin', now: w.now() });
    const moderator = await insertAccount(w.db, { role: 'moderator', now: w.now() });
    const player = await insertAccount(w.db, { now: w.now() });
    for (const who of [moderator, player, null]) {
      expect((await call(who, 'GET', '/api/admin/seasons')).statusCode).toBe(404);
      expect(
        (await call(who, 'POST', '/api/admin/seasons', { startsAt: 'x', endsAt: 'y' })).statusCode,
      ).toBe(404);
      expect((await call(who, 'POST', '/api/admin/seasons/1/end', {})).statusCode).toBe(404);
    }
    const view = await call(admin, 'GET', '/api/admin/seasons');
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json()).toMatchObject({ current: null, next: null, past: [] });

    const startsAt = '2027-09-06T00:00:00.000Z';
    const endsAt = new Date(Date.parse(startsAt) + 8 * WEEK).toISOString();
    const made = await call(admin, 'POST', '/api/admin/seasons', { startsAt, endsAt });
    expect(made.statusCode, made.body).toBe(200);
    expect(made.json().next).toMatchObject({ number: 1, startsAt, endsAt, status: 'scheduled' });
    // Refused plans say why.
    const overlap = await call(admin, 'POST', '/api/admin/seasons', {
      startsAt: '2027-08-01T00:00:00Z',
      endsAt,
    });
    expect(overlap.statusCode).toBe(409);
    expect(overlap.json().error.details.problem).toBe('starts_in_past');

    // The season begins; the next follows automatically; extend the current one.
    w.clock.ms = Date.parse(startsAt) + DAY;
    await runSeasonJobs(w.db, w.now(), w.now());
    const later = new Date(Date.parse(endsAt) + WEEK).toISOString();
    const extended = await call(admin, 'POST', '/api/admin/seasons/1/end', { endsAt: later });
    expect(extended.statusCode, extended.body).toBe(200);
    expect(extended.json().current).toMatchObject({ number: 1, endsAt: later });
    expect(extended.json().next).toMatchObject({ number: 2, startsAt: later });

    // End early: now; the next season starts at once.
    w.clock.ms += DAY;
    const ended = await call(admin, 'POST', '/api/admin/seasons/1/end', {});
    expect(ended.statusCode, ended.body).toBe(200);
    expect(ended.json().current).toMatchObject({ number: 2, startsAt: w.now().toISOString() });
    expect(ended.json().past[0]).toMatchObject({ number: 1, status: 'closing' });
    const again = await call(admin, 'POST', '/api/admin/seasons/1/end', {});
    expect(again.statusCode).toBe(409);
    expect(again.json().error.details.problem).toBe('already_ended');

    const audited = (await w.db.select().from(auditLog)).map((a) => a.event);
    for (const e of ['season.schedule', 'season.extend', 'season.end', 'admin.view'])
      expect(audited, e).toContain(e);
  });

  it('the CLI shows, schedules, extends, ends and closes seasons', async () => {
    const out = (args: string[]) => runSeasonCommand(w.db, args, w.now());
    expect(await out(['status'])).toMatch(/Current: Season 2/);
    const next = new Date(w.now().getTime() + 60 * DAY);
    // Season 3 was created automatically; scheduling replaces it.
    await runSeasonJobs(w.db, w.now(), w.now());
    const at = next.toISOString().replace('.000', '');
    const sched = await out(['schedule', '--start', at, '--weeks', '4']);
    expect(sched).toMatch(/Scheduled Season 3/);
    await expect(out(['schedule', '--start', '2027-01-01'])).rejects.toThrow(
      /ISO time with a zone/,
    );
    await expect(out(['schedule', '--start', at, '--weeks', '40'])).rejects.toThrow(/1 to 26/);
    expect(
      await out(['extend', '3', '--to', new Date(next.getTime() + 5 * WEEK).toISOString()]),
    ).toMatch(/Season 3 now ends/);
    w.clock.ms += DAY;
    expect(await out(['end', '2'])).toMatch(/Season 2 ended/);
    w.clock.ms += SEASON_CLOSE_GRACE_MS;
    expect(await out(['close'])).toMatch(/Archived: Season 1, Season 2\./);
    const audit = await w.db.select().from(auditLog).where(eq(auditLog.event, 'season.schedule'));
    expect(audit.some((a) => (a.data as { via?: string }).via === 'cli')).toBe(true);
  });

  it('setSeasonEnd refuses a season that does not exist', async () => {
    await expect(setSeasonEnd(w.db, 77, w.now(), w.now(), cli)).rejects.toMatchObject({
      code: 'season_plan_refused',
    });
  });
});

describe('cosmetic only (invariance)', () => {
  let w: World;
  beforeAll(async () => {
    w = await world('2027-11-01T00:00:00Z');
  });
  afterAll(async () => {
    await w.app.close();
    await w.database.close();
  });

  it('seasons, awards and displays change no gameplay row and no score input', async () => {
    const start = new Date('2027-11-02T00:00:00Z');
    const end = new Date(start.getTime() + 2 * DAY);
    await scheduleSeason(w.db, { startsAt: start, endsAt: end }, w.now(), cli);
    const who = await insertAccount(w.db, { now: w.now() });
    const hero = await insertCharacter(w.db, who.id, { classId: 'hunter', level: 14 });
    w.clock.ms = start.getTime() + 1000;
    await w.progress(hero.id, 15, 20);
    const snapshot = async () => {
      const [row] = await w.db.select().from(characters).where(eq(characters.id, hero.id));
      return {
        hero: row,
        items: await w.db
          .select()
          .from(itemInstances)
          .where(eq(itemInstances.characterId, hero.id)),
        members: await w.db.select().from(guildMembers),
        scores: computeScores(await snapshotInput(w.db, row!, w.deps.worldFlags)),
        boards: (await w.db.select().from(leaderboardEntries)).map((e) => [e.metric, e.value]),
      };
    };
    const before = await snapshot();
    w.clock.ms = end.getTime() + SEASON_CLOSE_GRACE_MS;
    await runSeasonJobs(w.db, w.now(), w.now());
    expect(await w.db.select().from(seasonAwards)).toHaveLength(4);
    await caller(w.app)(who, 'POST', '/api/account/prestige', {
      title: { season: 1, metric: 'power' },
      frame: { season: 1, metric: 'level' },
    });
    expect(await snapshot()).toEqual(before);
  });

  it('no gameplay module of game-core reads the prestige or season rules', () => {
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
    const importers = files.filter((p) =>
      /from '\.\/(prestige|seasons)\.js'|from '\.\.\/scoring\/(prestige|seasons)\.js'/.test(
        readFileSync(p, 'utf8'),
      ),
    );
    expect(importers.map((p) => p.slice(root.length + 1)).sort()).toEqual(['scoring/index.ts']);
  });
});

function withoutPrestige(b: BoardView) {
  const strip = (e: BoardView['entries'][number]) => ({
    ...e,
    player: { ...e.player, prestige: null },
  });
  return { ...b, season: null, entries: b.entries.map(strip), yours: b.yours.map(strip) };
}

function compareKeys(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

const byAward = (
  a: { accountId: string; metric: string },
  b: { accountId: string; metric: string },
) => (`${a.accountId}:${a.metric}` < `${b.accountId}:${b.metric}` ? -1 : 1);
