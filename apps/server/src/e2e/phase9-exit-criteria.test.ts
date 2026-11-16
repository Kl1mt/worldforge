/**
 * Phase 9 exit criteria, end to end through the HTTP API with a simulated server clock (ticket
 * 9.6): each class plays as its GDD row reads (its resource drives its skills, a loadout is picked
 * outside combat); older gear keeps its value; the boards and PvP move by versions between seasons;
 * accounts grow by playing (character slots, a longer offline cap, the Shrine's free draws); and
 * everything is reconciled, fair and free of pay-to-win.
 *
 * Several players on one clock in an invite-only town, composing the Phase 9 journey steps
 * (`./journey.ts`: `playSkillsStep`, `playSkillQuestStep`, `playShrineStep`). Heroes above level 5
 * are seeded like the Phase 8 run (a level, the bosses behind them, a kit), each seeding measured
 * (`holdingsBaseline`) so the holdings replay holds from it on. Random outcomes come from the
 * server's `crypto` seeds and the run asserts only what holds for every seed, or predicts the
 * outcome from the stored seed with game-core. The one outcome it needs that a seed decides (a
 * companion from the Shrine) is a single draw pinned to a seed game-core shows producing one
 * (`shrine.drawSeed`, CLAUDE.md "Writing tests that don't flake").
 *
 * The town's story: Season 1 was planned before the Phase 9 release reached it, so the release
 * plans Power 4 and duel rules 3 for the season's end (9.2, 5.3's rule). Day 0 is a Monday 06:00
 * UTC derived from the wall clock (CLAUDE.md "Dates"); the run spans about three weeks.
 *
 * - The Shrine's free-draw bank across day boundaries (a new account's first draw, a replayed key
 *   on both sides of midnight, the bank full at 7 and never paid back), a companion worn.
 * - Loadouts and presets (a fresh mage from level 1); a warlock's damage-over-time loadout in both
 *   simulations (the offline settlement predicted from its stored seed by game-core's aggregate
 *   settlement, a crypt run's detailed log replayed with its ticks and casts); a loadout switch
 *   racing a settlement and a defence refresh.
 * - The skill quests (the Tyrant's Lesson), the deeds it earns live: the third character slot (the
 *   creation refused before it, allowed after it, refused past it), the 8-hour offline cap against
 *   a new account's 3 hours, the deed's Shrine draws.
 * - The season boundary: to its last millisecond Power 3 and duel rules 2; from its end Power 4
 *   (the defence loadout) on every board and duel rules 3; the season's honours pay Shrine draws.
 * - The test account draws at the Shrine but counts in no telemetry, and sits on no board.
 *
 * Valid means: every hero's holdings equal the audit log; every account's Shrine reconciles;
 * `reconcileWithAudit` and the real `pnpm report:telemetry -- --reconcile` on this run's database
 * match in every check; and no player's response ever carried another player's email, account id
 * or hero id.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, asc, count, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  FORMULA_VERSIONS,
  PVP_RULES_VERSION,
  SHRINE_BANK_LIMIT,
  computeScore,
  duelFighter,
  settleFarming,
  shrineOutcome,
  shrineSeasonDraws,
  simulateDuel,
  type ClassId,
  type Loadout,
  type PrestigeTier,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { setTestAccount } from '../admin/test-accounts.js';
import {
  accountGrowthGrants,
  accounts,
  activities,
  auditLog,
  characters,
  dungeonRuns,
  duelDefences,
  duels,
  gameSettings,
  itemInstances,
  leaderboardEntries,
  seasonAwards as seasonAwardRows,
  seasons,
  shrineDrawGrants,
  shrineDraws,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { replayRun } from '../dungeon/routes.js';
import { FORMULA_SCHEDULE_KEY } from '../leaderboards/formulas.js';
import { checkLeaderboards } from '../leaderboards/check.js';
import { cliDeps } from '../leaderboards/leaderboard-cli.js';
import { snapshotDeps } from '../leaderboards/routes.js';
import { sweepLeaderboards } from '../leaderboards/snapshot.js';
import { loadProfessions } from '../materials/store.js';
import { runSeasonJobs } from '../seasons/model.js';
import { reconcileShrine } from '../shrine/model.js';
import { createPgliteDatabase } from '../test/db.js';
import { equipKit } from '../test/arena.js';
import { packItemsWhere } from '../inventory/location.js';
import { reconcileWithAudit, type RollupRow, type TelemetryReport } from '../telemetry/report.js';
import {
  HOUR,
  MIN,
  expectHoldingsMatchAudit,
  holdingsBaseline,
  openInviteOnlyTown,
  playShrineStep,
  playSkillQuestStep,
  playSkillsStep,
  playerOf,
  startJourney,
  type HoldingsBaseline,
  type Journey,
} from './journey.js';

const DAY = 24 * HOUR;
const CAP = DEFAULT_ACTIVITY_OPTIONS.offlineCapMs;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

let dataDir: string;
let database: DatabaseHandle;
let app: FastifyInstance;
// CLAUDE.md "Dates": derived from the wall clock, never a fixed date. The next Monday, 06:00 UTC,
// at least a day ahead.
const D0 = (() => {
  const day = Math.floor(Date.now() / DAY) * DAY + DAY;
  const weekday = (new Date(day).getUTCDay() + 6) % 7; // 0 = Monday
  return day + ((7 - weekday) % 7) * DAY + 6 * HOUR;
})();
/** Season 1 began three weeks before day 0 and ends on day 21 at 00:00 UTC (a Monday). */
const SEASON_START = D0 - 21 * DAY;
const SEASON_END = D0 + 21 * DAY - 6 * HOUR;
let nowMs = D0;
const clock = { now: () => nowMs, set: (ms: number) => void (nowMs = Math.max(nowMs, ms)) };
const now = () => new Date(nowMs);
const activityOptions = { ...DEFAULT_ACTIVITY_OPTIONS, offlineCapMs: CAP, now };

/** Shrine seeds the run pins (first in, first used); every other draw is `crypto`'s. */
const pinnedShrineSeeds: string[] = [];
/** A seed game-core's own rule shows drawing a companion for an account that owns nothing. */
const COMPANION_SEED = (() => {
  for (let n = 0; n < 10_000; n++) {
    const seed = `9.6-companion-${n}`;
    if (shrineOutcome(seed, new Set()).cosmeticId.startsWith('companion.')) return seed;
  }
  throw new Error('no companion seed in 10,000');
})();

/** Every account and hero id and email seen; no player's response may carry another player's. */
const secrets = new Map<string, string>();
const leaks: string[] = [];
let watched = 0;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wf-phase9-e2e-'));
  database = await createPgliteDatabase(join(dataDir, 'db'));
  // The town before the Phase 9 release: Season 1 under way, Power 3 and PvE Progress 6 in force
  // (every switch through 8.2 done). The release plans Power 4 and duel rules 3 for its end.
  await database.db
    .insert(seasons)
    .values({ number: 1, startsAt: new Date(SEASON_START), endsAt: new Date(SEASON_END) });
  const done = (metric: string, from: number, to: number) => ({
    metric,
    from,
    to,
    afterSeason: null,
    plannedAt: new Date(SEASON_START - 30 * DAY).toISOString(),
  });
  await database.db.insert(gameSettings).values({
    key: FORMULA_SCHEDULE_KEY,
    value: { switches: [done('power', 1, 3), done('pveProgress', 1, 6)] },
    version: 1,
    updatedAt: new Date(SEASON_START),
  });
  app = buildApp({
    database,
    auth: {
      now,
      registrationMode: 'invite',
      // The run spans three game weeks; sessions don't slide, so they live longer here.
      sessionTtlMs: 120 * DAY,
    },
    activity: activityOptions,
    shrine: { drawSeed: () => pinnedShrineSeeds.shift() ?? randomBytes(16).toString('hex') },
  });
  // The privacy guard (4.11, 5.8, 6.10, 8.7).
  app.addHook('onSend', async (request, reply, payload) => {
    if (typeof payload !== 'string') return payload;
    let self = request.auth?.account.id;
    if (request.url === '/api/auth/login' && reply.statusCode === 200) {
      self = (JSON.parse(payload) as { account: { id: string } }).account.id;
    }
    if (request.url === '/api/auth/register' && reply.statusCode === 201) {
      const { account } = JSON.parse(payload) as { account: { id: string; email: string } };
      secrets.set(account.id, account.id);
      secrets.set(account.email, account.id);
      return payload;
    }
    if (request.url === '/api/characters' && request.method === 'POST' && self) {
      const { character } = JSON.parse(payload) as { character?: { id: string } };
      if (character) secrets.set(character.id, self);
    }
    if (request.url.startsWith('/api/admin/') || request.url.startsWith('/api/mod/')) {
      return payload;
    }
    watched += 1;
    for (const [secret, owner] of secrets) {
      if (owner !== self && payload.includes(secret)) {
        leaks.push(`${request.method} ${request.url} carried another player's ${secret}`);
      }
    }
    return payload;
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await database?.close().catch(() => undefined);
  rmSync(dataDir, { recursive: true, force: true });
});

type Err = { error: { code: string; details?: Record<string, unknown> } };
type ShrineView = {
  unspent: { daily: number; play: number; shop: number };
  draws: number;
  bankLimit: number;
  nextFreeAt: string | null;
  marks: number;
  paidDraws: boolean;
};
type DrawBody = {
  draw: { drawId: string; seed: string; cosmeticId: string; outcome: string; marks: number };
  shrine: ShrineView;
};
type Growth = {
  slots: { base: number; total: number; used: number };
  offline: { baseMs: number; capMs: number; nextCapMs: number | null };
};
type SkillsBody = {
  activePreset: number;
  inForce: { actives: (string | null)[]; passive: string | null };
  soulFragments: number;
};

const baselines = new Map<string, HoldingsBaseline>();

/** A hero's seeding (level, deeds, a kit), measured for the holdings replay. */
async function seed(
  hero: Journey,
  {
    level,
    classId,
    progress,
    kit,
  }: {
    level: number;
    classId: ClassId;
    progress?: (typeof characters.$inferInsert)['progress'];
    kit: { itemLevel: number; rarity: 'rare' | 'legendary'; upgrade: number; tag: string };
  },
) {
  const db = database.db;
  await db
    .update(characters)
    .set({ level, experience: 0, ...(progress ? { progress } : {}) })
    .where(eq(characters.id, hero.characterId));
  await equipKit(db, hero.characterId, classId, kit.itemLevel, kit.rarity, kit.tag);
  if (kit.upgrade > 0) {
    await db
      .update(itemInstances)
      .set({ upgradeLevel: kit.upgrade })
      .where(
        and(eq(itemInstances.characterId, hero.characterId), isNotNull(itemInstances.equippedSlot)),
      );
  }
  hero.state.level = level;
  baselines.set(
    hero.characterId,
    await holdingsBaseline(database, hero.characterId, baselines.get(hero.characterId)),
  );
  return baselines.get(hero.characterId)!;
}

/** The hero rests (no farming), so the shared clock never runs its offline time past the cap. */
async function rest(hero: Journey) {
  const res = await hero.api('POST', `${hero.base}/activity/stop`);
  expect([200, 409], res.body).toContain(res.statusCode);
}

/** What game-core's aggregate settlement makes of the hero's next `elapsedMs` (its stored seed). */
async function predictSettlement(hero: Journey, elapsedMs: number, loadout?: Loadout) {
  const db = database.db;
  const [a] = await db
    .select()
    .from(activities)
    .where(eq(activities.characterId, hero.characterId));
  const [c] = await db.select().from(characters).where(eq(characters.id, hero.characterId));
  const equipment = await db
    .select()
    .from(itemInstances)
    .where(
      and(eq(itemInstances.characterId, hero.characterId), isNotNull(itemInstances.equippedSlot)),
    );
  const [pack] = await db
    .select({ n: count() })
    .from(itemInstances)
    .where(packItemsWhere(hero.characterId));
  return {
    before: a!,
    result: settleFarming({
      character: {
        classId: c!.classId,
        level: c!.level,
        xp: c!.experience,
        ...(a!.health !== null ? { health: a!.health } : {}),
        momentum: a!.momentum,
        soulFragments: a!.soulFragments,
      },
      equipment,
      areaId: a!.areaId,
      ...(a!.pendingAreaId ? { switchToAreaId: a!.pendingAreaId } : {}),
      seed: a!.seedSecret,
      firstCycle: a!.cycleIndex,
      durationMs: a!.carryMs + elapsedMs,
      inventoryCount: pack?.n ?? 0,
      professions: await loadProfessions(db, hero.characterId),
      lootFilter: c!.lootFilter,
      ...(loadout ? { loadout } : {}),
    }),
  };
}

describe('Phase 9 exit criteria', () => {
  it('the Shrine’s bank across days → loadouts and presets → damage over time in both simulations → a switch racing a settlement → the skill quests, slots and the offline cap → the season boundary moves Power and duels → everything reconciles', async () => {
    const db = database.db;
    const accountIdOf = async (j: Journey) => (await playerOf(j)).account.id;
    const shrine = async (j: Journey) => {
      const res = await j.api('GET', '/api/account/shrine');
      expect(res.statusCode, res.body).toBe(200);
      return res.json<ShrineView>();
    };
    const growth = async (j: Journey) => {
      const res = await j.api('GET', '/api/account/growth');
      expect(res.statusCode, res.body).toBe(200);
      return res.json<Growth>();
    };
    const skills = async (j: Journey) => {
      const res = await j.api('GET', `${j.base}/skills`);
      expect(res.statusCode, res.body).toBe(200);
      return res.json<SkillsBody>();
    };

    // 1. The owner opens the town invite-only. The release's version plan waits for Season 1.
    const town = await openInviteOnlyTown(app, database, now());
    expect(await app.formulaVersions.at(now())).toMatchObject({ power: 3, pveProgress: 6 });
    expect(await app.formulaVersions.pvpRulesAt(now())).toBe(2);
    expect([FORMULA_VERSIONS.power, PVP_RULES_VERSION]).toEqual([4, 3]);

    const enlist = async (email: string, displayName: string, name: string, classId: ClassId) => {
      const j = await startJourney({
        app,
        clock,
        classId,
        email,
        displayName,
        name,
        inviteCode: town.invite,
      });
      await rest(j);
      return j;
    };
    const hild = await enlist('hild@graumark.test', 'Hild Candlewick', 'Hildra', 'hunter');
    const ysolde = await enlist('ysolde9@graumark.test', 'Ysolde Fenmoor', 'Ysolda', 'mage');
    const brannoc = await enlist('brannoc@graumark.test', 'Brannoc Oakhewn', 'Brannoc', 'warrior');
    const morwen = await enlist('morwen@graumark.test', 'Morwen Duskveil', 'Morwen', 'warlock');
    const garrick = await enlist(
      'garrick@graumark.test',
      'Garrick Stonebrow',
      'Garrick',
      'warrior',
    );
    const tester = await enlist('probe9@graumark.test', 'Probe Ilse', 'Probewick', 'mage');
    const testerHandle = (await playerOf(tester)).account.handle;
    expect(await setTestAccount(db, testerHandle, true)).toMatchObject({ to: true });
    const testAccountId = await accountIdOf(tester);

    // 2. The Shrine's free-draw bank across day boundaries (9.5, docs/SHRINE.md). A new account
    // holds the day it was made: one free draw, and no paid draws anywhere.
    const opened = await shrine(hild);
    expect(opened).toMatchObject({
      unspent: { daily: 1, play: 0, shop: 0 },
      draws: 1,
      bankLimit: SHRINE_BANK_LIMIT,
      paidDraws: false,
    });
    const midnight = (Math.floor(clock.now() / DAY) + 1) * DAY;
    expect(opened.nextFreeAt).toBe(new Date(midnight).toISOString());
    // The day's draw, pinned to a companion seed; its key replayed on both sides of midnight.
    pinnedShrineSeeds.push(COMPANION_SEED);
    const drawKey = randomUUID();
    const first = await hild.keyed('/api/account/shrine/draw', {}, drawKey);
    expect(first.statusCode, first.body).toBe(200);
    const firstDraw = first.json<DrawBody>().draw;
    expect(firstDraw.seed).toBe(COMPANION_SEED);
    expect(firstDraw).toMatchObject({
      cosmeticId: shrineOutcome(COMPANION_SEED, new Set()).cosmeticId,
      outcome: 'grant',
      marks: 0,
    });
    const replayDraw = async () => {
      const r = await hild.keyed('/api/account/shrine/draw', {}, drawKey);
      expect(r.headers['idempotency-replayed']).toBe('true');
      expect(r.json<DrawBody>().draw).toEqual(firstDraw);
    };
    await replayDraw();
    const none = await hild.keyed('/api/account/shrine/draw', {});
    expect(none.statusCode).toBe(409);
    expect(none.json<Err>().error.code).toBe('no_draws');
    clock.set(midnight - 1);
    expect((await shrine(hild)).unspent.daily).toBe(0);
    await replayDraw();
    clock.set(midnight);
    expect((await shrine(hild)).unspent.daily).toBe(1);
    // A replay after midnight still answers the first draw and spends nothing of the new day.
    await replayDraw();
    expect((await shrine(hild)).unspent.daily).toBe(1);
    const hildDraws = async () =>
      (
        await db
          .select()
          .from(shrineDraws)
          .where(eq(shrineDraws.accountId, await accountIdOf(hild)))
      ).length;
    expect(await hildDraws()).toBe(1);
    // The companion is worn beside the hero.
    const worn = await hild.keyed('/api/account/cosmetics/equip', {
      companion: firstDraw.cosmeticId,
    });
    expect(worn.statusCode, worn.body).toBe(200);
    // Nine days away: the bank holds 7, never 8, and the days a full bank sat through are not
    // paid back at the next midnight.
    clock.set(midnight + 9 * DAY - 1);
    const full = await shrine(hild);
    expect(full.unspent.daily).toBe(SHRINE_BANK_LIMIT);
    expect(full.nextFreeAt).toBeNull();
    clock.set(midnight + 9 * DAY);
    expect((await shrine(hild)).unspent.daily).toBe(SHRINE_BANK_LIMIT);
    const one = await hild.keyed('/api/account/shrine/draw', {});
    expect(one.statusCode, one.body).toBe(200);
    expect(one.json<DrawBody>().shrine.unspent.daily).toBe(SHRINE_BANK_LIMIT - 1);
    clock.set(midnight + 10 * DAY - 1);
    expect((await shrine(hild)).unspent.daily).toBe(SHRINE_BANK_LIMIT - 1);
    clock.set(midnight + 10 * DAY);
    expect((await shrine(hild)).unspent.daily).toBe(SHRINE_BANK_LIMIT);
    // Every held draw drawn, each predicted from its stored seed by game-core.
    const owned = new Set([firstDraw.cosmeticId, one.json<DrawBody>().draw.cosmeticId]);
    for (let left = (await shrine(hild)).draws; left > 0; left--) {
      const r = await hild.keyed('/api/account/shrine/draw', {});
      expect(r.statusCode, r.body).toBe(200);
      const d = r.json<DrawBody>().draw;
      const want = shrineOutcome(d.seed, owned);
      expect([d.cosmeticId, d.outcome, d.marks]).toEqual([
        want.cosmeticId,
        want.outcome,
        want.marks,
      ]);
      owned.add(d.cosmeticId);
    }
    expect(await hildDraws()).toBe(2 + SHRINE_BANK_LIMIT);
    expect((await reconcileShrine(db, await accountIdOf(hild))).ok).toBe(true);
    // The test account draws its bank too (its draws go to the test telemetry, 9.5).
    const testerBank = await shrine(tester);
    expect(testerBank.unspent.daily).toBe(SHRINE_BANK_LIMIT);
    for (let i = 0; i < testerBank.draws; i++) {
      expect((await tester.keyed('/api/account/shrine/draw', {})).statusCode).toBe(200);
    }

    // 3. Loadouts and presets: a fresh mage from level 1 (9.2's journey step).
    const skillsStep = await playSkillsStep(database, ysolde);
    expect(skillsStep.level).toBeGreaterThanOrEqual(5);
    await rest(ysolde);

    // 4. The warlock's resource and damage over time in both simulations. Morwen (24, Rares 23)
    // saves Agony, Corruption and Soul Burn with Malice; Garrick (24) keeps the default.
    const kit = { itemLevel: 23, rarity: 'rare' as const, upgrade: 0 };
    await seed(morwen, {
      level: 24,
      classId: 'warlock',
      progress: { gravewardenDefeated: true, cryptTierCleared: 1 },
      kit: { ...kit, tag: 'phase9-morwen' },
    });
    await seed(garrick, {
      level: 24,
      classId: 'warrior',
      progress: { gravewardenDefeated: true, cryptTierCleared: 1 },
      kit: { ...kit, tag: 'phase9-garrick' },
    });
    const shadow: Loadout = { actives: ['agony', 'corruption', 'soulBurn'], passive: 'malice' };
    const saved = await morwen.api('PUT', `${morwen.base}/skills/presets/1`, shadow);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json<SkillsBody>().inForce).toEqual(shadow);
    // The offline settlement (exact distributions): game-core predicts it from the stored seed.
    const farm = await morwen.api('POST', `${morwen.base}/activity`, { areaId: 'blackwater' });
    expect(farm.statusCode, farm.body).toBe(201);
    clock.set(clock.now() + 2 * HOUR);
    const predicted = await predictSettlement(morwen, 2 * HOUR, shadow);
    expect((await morwen.api('POST', `${morwen.base}/activity/settle`)).statusCode).toBe(200);
    const [settled] = await db
      .select()
      .from(activities)
      .where(eq(activities.characterId, morwen.characterId));
    expect(settled!.cycleIndex).toBe(predicted.before.cycleIndex + predicted.result.encounters);
    expect(settled!.soulFragments).toBe(predicted.result.soulFragments);
    const [morwenRow] = await db
      .select()
      .from(characters)
      .where(eq(characters.id, morwen.characterId));
    expect([morwenRow!.level, morwenRow!.experience]).toEqual([
      predicted.result.level,
      predicted.result.xp,
    ]);
    // The detailed simulation: a crypt run carries the loadout in its snapshot, and its log, replayed
    // from the stored seed, ticks damage over time and names each skill cast.
    await rest(morwen);
    const run = await morwen.runCrypt(1);
    const [runRow] = await db
      .select()
      .from(dungeonRuns)
      .where(eq(dungeonRuns.characterId, morwen.characterId));
    expect(runRow!.snapshot.loadout).toEqual(shadow);
    const replay = replayRun(runRow!);
    expect([replay.outcome, replay.bossDefeated, replay.xpGained]).toEqual([
      run.outcome,
      run.bossDefeated,
      run.xpGained,
    ]);
    expect(replay.events.some((e) => e.type === 'tick')).toBe(true);
    const cast = new Set(
      replay.events.flatMap((e) => (e.type === 'attack' && e.skillId ? [e.skillId] : [])),
    );
    expect([...cast].some((s) => shadow.actives.includes(s))).toBe(true);

    // 5. Duel defences carry their loadout; friends may duel at once.
    const handleOf = async (j: Journey) => (await playerOf(j)).account.handle;
    const asked = await morwen.api('POST', '/api/friends/requests', {
      name: (await playerOf(garrick)).account.displayName.toLowerCase(),
    });
    expect(asked.statusCode, asked.body).toBe(200);
    expect(
      (await garrick.api('POST', `/api/friends/requests/${await handleOf(morwen)}/accept`))
        .statusCode,
    ).toBe(200);
    type DefenceBody = { defence: { defenceId: string } };
    const defend = async (j: Journey) => {
      const res = await j.api('POST', '/api/arena/defence', { characterId: j.characterId });
      expect(res.statusCode, res.body).toBe(200);
      return res.json<DefenceBody>().defence.defenceId;
    };
    await defend(morwen);
    const garrickDefence = await defend(garrick);
    const defenceOf = async (j: Journey) =>
      (await db.select().from(duelDefences).where(eq(duelDefences.characterId, j.characterId)))[0]!;
    expect((await defenceOf(morwen)).snapshot.loadout).toEqual(shadow);
    expect((await defenceOf(garrick)).snapshot.loadout).toBeUndefined();

    // 6. A switch racing a settlement and a defence refresh: each lands whole, in some order.
    // Preset 2 holds the default; the settlement fights the loadout in force when it took the lock.
    expect(
      (await morwen.api('POST', `${morwen.base}/activity`, { areaId: 'blackwater' })).statusCode,
    ).toBe(201);
    clock.set(clock.now() + 30 * MIN);
    const [sw, st, df] = await Promise.all([
      morwen.api('POST', `${morwen.base}/skills/preset`, { preset: 2 }),
      morwen.api('POST', `${morwen.base}/activity/settle`),
      morwen.api('POST', '/api/arena/defence', { characterId: morwen.characterId }),
    ]);
    expect([sw.statusCode, st.statusCode, df.statusCode]).toEqual([200, 200, 200]);
    expect(sw.json<SkillsBody>()).toMatchObject({ activePreset: 2 });
    const raced = (await defenceOf(morwen)).snapshot.loadout;
    // Before the switch the defence kept the shadow loadout; after it, the default (none stored).
    expect([JSON.stringify(shadow), undefined]).toContain(
      raced ? JSON.stringify(raced) : undefined,
    );
    const switchRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.event, 'skills.loadout_switch'),
          eq(auditLog.characterId, morwen.characterId),
        ),
      );
    expect(switchRows).toHaveLength(1);
    // Back on the shadow preset, its defence refreshed: what Power 4 will read.
    expect(
      (await morwen.api('POST', `${morwen.base}/skills/preset`, { preset: 1 })).json<SkillsBody>()
        .inForce,
    ).toEqual(shadow);
    await defend(morwen);
    expect((await defenceOf(morwen)).snapshot.loadout).toEqual(shadow);
    expect((await skills(morwen)).soulFragments).toBeGreaterThanOrEqual(0);
    await rest(morwen);

    // 7. The skill quests and the deeds they earn (9.3, 9.4). Brannoc (38, the Phase 6 bosses
    // behind him, Legendaries 33 +10). Before any deed: two slots, three hours.
    const brannocBase = await seed(brannoc, {
      level: 38,
      classId: 'warrior',
      progress: { gravewardenDefeated: true, cryptTierCleared: 3, ashenWardenDefeated: true },
      kit: { itemLevel: 33, rarity: 'legendary', upgrade: 10, tag: 'phase9-brannoc' },
    });
    const g0 = await growth(brannoc);
    expect(g0.slots).toMatchObject({ base: 2, total: 2, used: 1 });
    expect(g0.offline.capMs).toBe(CAP);
    const createHero = (j: Journey, name: string, classId: ClassId) =>
      j.api('POST', '/api/characters', { name, classId, appearance: { banner: 'ash' } });
    const second = await createHero(brannoc, 'Brannwyn', 'hunter');
    expect(second.statusCode, second.body).toBe(201);
    const refused = await createHero(brannoc, 'Branthor', 'mage');
    expect(refused.statusCode).toBe(422);
    expect(refused.json<Err>().error.code).toBe('no_free_slot');
    // A new hero becomes the active one; Brannoc is chosen again for his dungeons.
    const select = async () =>
      expect((await brannoc.api('POST', `${brannoc.base}/select`)).statusCode).toBe(200);
    await select();
    const lesson = await playSkillQuestStep(database, brannoc, brannocBase, clock);
    expect(lesson.skill).toBe('forgebreaker');
    // The first claim recorded his deeds live: the level-28 slot and four offline steps (8 h).
    const g1 = await growth(brannoc);
    expect(g1.slots).toMatchObject({ total: 3, used: 2 });
    expect(g1.offline).toMatchObject({ capMs: CAP + 5 * HOUR, nextCapMs: null });
    const third = await createHero(brannoc, 'Branthor', 'mage');
    expect(third.statusCode, third.body).toBe(201);
    const fourth = await createHero(brannoc, 'Branmoor', 'warlock');
    expect(fourth.statusCode).toBe(422);
    await select();
    expect((await growth(brannoc)).slots).toMatchObject({ total: 3, used: 3 });
    const grantRows = await db
      .select()
      .from(accountGrowthGrants)
      .where(eq(accountGrowthGrants.accountId, await accountIdOf(brannoc)));
    expect(grantRows.map((g) => g.grantId).sort()).toEqual(
      ['level28', 'offlineCinderwastes', 'offlineCrypt1', 'offlineCrypt3', 'offlineLevel10'].sort(),
    );
    expect(grantRows.every((g) => !g.backfill && g.source === g.grantId)).toBe(true);
    // The offline cap: Brannoc's 8 hours against Ysolde's 3 (no deed yet), each to the second.
    await rest(brannoc);
    for (const j of [brannoc, ysolde]) {
      const go = await j.api('POST', `${j.base}/activity`, { areaId: 'abandonedFields' });
      expect(go.statusCode, go.body).toBe(201);
    }
    const away = clock.now();
    clock.set(away + 10 * HOUR);
    for (const [j, capMs] of [
      [brannoc, CAP + 5 * HOUR],
      [ysolde, CAP],
    ] as const) {
      const res = await j.api('POST', `${j.base}/activity/settle`);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<{ summary: { cappedMs: number } }>().summary.cappedMs).toBe(
        10 * HOUR - capMs,
      );
      await rest(j);
    }
    // The deeds paid Shrine draws (one each, live); the Shrine step draws them.
    const brannocShrine = await shrine(brannoc);
    expect(brannocShrine.unspent.play).toBeGreaterThanOrEqual(1);
    const brannocDraws = await playShrineStep(database, brannoc);
    expect(brannocDraws.draws).toBe(brannocShrine.draws);

    // 8. The season boundary (5.3's rule, 9.2). To its last millisecond: Power 3, duel rules 2.
    const duelOnce = async () => {
      const res = await morwen.keyed('/api/arena/duels', {
        characterId: morwen.characterId,
        defenceId: garrickDefence,
        kind: 'friendly',
      });
      expect(res.statusCode, res.body).toBe(201);
      const rows = await db
        .select()
        .from(duels)
        .where(eq(duels.challengerCharacterId, morwen.characterId))
        .orderBy(asc(duels.foughtAt), asc(duels.id));
      return rows.at(-1)!;
    };
    const powerRow = async (j: Journey) =>
      (
        await db
          .select()
          .from(leaderboardEntries)
          .where(
            and(
              eq(leaderboardEntries.characterId, j.characterId),
              eq(leaderboardEntries.metric, 'power'),
            ),
          )
      )[0]!;
    const deps = snapshotDeps(app);
    clock.set(SEASON_END - 1);
    expect(await app.formulaVersions.at(now())).toMatchObject({ power: 3 });
    const before = await duelOnce();
    expect(before.rulesVersion).toBe(2);
    await sweepLeaderboards(deps, now(), { batch: 200, cursor: null });
    const morwenP3 = await powerRow(morwen);
    expect(morwenP3.formulaVersion).toBe(3);
    expect(morwenP3.input.loadout).toEqual(shadow);
    // From the season's end: Power 4 (the defence loadout) and duel rules 3.
    clock.set(SEASON_END);
    expect(await app.formulaVersions.at(now())).toEqual(FORMULA_VERSIONS);
    expect(await app.formulaVersions.pvpRulesAt(now())).toBe(PVP_RULES_VERSION);
    const after = await duelOnce();
    expect(after.rulesVersion).toBe(3);
    for (const d of [before, after]) {
      const again = simulateDuel({
        challenger: duelFighter(d.challengerSnapshot),
        defender: duelFighter(d.defenderSnapshot),
        seed: d.seed,
        bracketId: d.bracketId,
        rulesVersion: d.rulesVersion,
      });
      expect([again.outcome, again.durationMs]).toEqual([d.outcome, d.durationMs]);
      expect(again.events).toEqual(d.events);
    }
    // The season's jobs after their grace minutes: archived and honoured once; the honours pay
    // Shrine draws by the best tier.
    clock.set(SEASON_END + 10 * MIN);
    const jobs = await runSeasonJobs(db, now(), now());
    expect(jobs.archived).toContain(1);
    expect((await runSeasonJobs(db, now(), now())).archived).toEqual([]);
    const awards = await db.select().from(seasonAwardRows).where(eq(seasonAwardRows.season, 1));
    expect(awards.some((a) => a.accountId === testAccountId)).toBe(false);
    const tiersBy = new Map<string, PrestigeTier[]>();
    for (const a of awards) tiersBy.set(a.accountId, [...(tiersBy.get(a.accountId) ?? []), a.tier]);
    const seasonGrants = await db
      .select()
      .from(shrineDrawGrants)
      .where(eq(shrineDrawGrants.sourceKey, 'season:1'));
    expect(seasonGrants.map((g) => [g.accountId, g.count]).sort()).toEqual(
      [...tiersBy].map(([id, tiers]) => [id, shrineSeasonDraws(tiers)]).sort(),
    );
    expect(awards.length).toBeGreaterThan(0);
    // The sweep writes Power 4 on every board: the defence loadout's score for Morwen, Power 3's
    // for a hero without one (Garrick).
    await sweepLeaderboards(deps, now(), { batch: 200, cursor: null });
    const morwenP4 = await powerRow(morwen);
    expect(morwenP4.formulaVersion).toBe(4);
    expect(morwenP4.value).toBe(computeScore('power', morwenP4.input, 4).value);
    const garrickP4 = await powerRow(garrick);
    expect(garrickP4.formulaVersion).toBe(4);
    expect(garrickP4.value).toBe(computeScore('power', garrickP4.input, 3).value);
    for (const j of [morwen, garrick, brannoc, ysolde]) {
      const scores = (await j.api('GET', `${j.base}/scores`)).json<{
        scores: Record<'level' | 'gearScore' | 'power' | 'pveProgress', { value: number }>;
      }>().scores;
      const entries = await db
        .select()
        .from(leaderboardEntries)
        .where(eq(leaderboardEntries.characterId, j.characterId));
      for (const metric of ['level', 'gearScore', 'power', 'pveProgress'] as const) {
        const row = entries.find((r) => r.metric === metric);
        expect(row, `${metric} of ${j.characterId}`).toBeDefined();
        expect(row!.formulaVersion).toBe(FORMULA_VERSIONS[metric]);
        expect(row!.value).toBe(scores[metric].value);
      }
    }
    for (const metric of ['level', 'gearScore', 'power', 'pveProgress']) {
      const board = (await morwen.api('GET', `/api/leaderboards/${metric}?limit=100`)).json<{
        board: { formulaVersion: number; entries: { player: { handle: string } }[] };
      }>().board;
      expect(board.formulaVersion).toBe(FORMULA_VERSIONS[metric as 'level']);
      expect(board.entries.some((e) => e.player.handle === testerHandle)).toBe(false);
    }
    expect(
      (await checkLeaderboards(cliDeps(db), 200, now())).problems.filter((p) => p.kind === 'wrong'),
    ).toEqual([]);
    // The season's draws are drawn (each predicted by its stored seed, in the Shrine step).
    for (const j of [morwen, garrick]) {
      if ((await shrine(j)).unspent.play > 0) await playShrineStep(database, j);
    }

    // 9. Everything held and recorded agrees; nothing leaked; one test account.
    for (const j of [morwen, garrick, brannoc]) {
      await expectHoldingsMatchAudit(database, j.characterId, baselines.get(j.characterId));
    }
    for (const j of [hild, ysolde]) await expectHoldingsMatchAudit(database, j.characterId);
    for (const j of [hild, ysolde, brannoc, morwen, garrick, tester]) {
      const r = await reconcileShrine(db, await accountIdOf(j));
      expect(r.ok, JSON.stringify(r)).toBe(true);
    }
    expect((await reconcileWithAudit(db)).filter((x) => !x.ok)).toEqual([]);
    expect(leaks).toEqual([]);
    expect(watched).toBeGreaterThan(150);
    const testAccounts = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.isTest, true));
    expect(testAccounts.map((a) => a.id)).toEqual([testAccountId]);
    const realDraws = (
      await db
        .select({ n: count() })
        .from(shrineDraws)
        .where(sql`${shrineDraws.accountId} <> ${testAccountId}`)
    )[0]!.n;
    const testerDraws = (
      await db
        .select({ n: count() })
        .from(shrineDraws)
        .where(eq(shrineDraws.accountId, testAccountId))
    )[0]!.n;
    expect(testerDraws).toBe(SHRINE_BANK_LIMIT);
    const heroesLeft = await db
      .select({ id: characters.id })
      .from(characters)
      .where(
        and(eq(characters.accountId, await accountIdOf(brannoc)), isNull(characters.deletedAt)),
      );
    expect(heroesLeft).toHaveLength(3);

    // The real report command on this run's database.
    await app.close();
    await database.close();
    const out = join(dataDir, 'report.json');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PLAYTEST_DATA_DIR: dataDir,
      INIT_CWD: REPO_ROOT,
    };
    delete env.DATABASE_URL;
    const text = execFileSync(
      'pnpm',
      ['--silent', 'report:telemetry', '--', '--reconcile', '--db', 'playtest', '--out', out],
      { cwd: REPO_ROOT, env, encoding: 'utf8' },
    );
    expect(text).toMatch(/Audit log reconciliation: all \d+ checks match/);
    const report = JSON.parse(readFileSync(out, 'utf8')) as TelemetryReport;
    expect(report.reconcile!.filter((x) => !x.ok)).toEqual([]);
    const sum = (metric: string, match: (dims: RollupRow['dims']) => boolean = () => true) =>
      report.rollups
        .filter((r) => r.metric === metric && match(r.dims))
        .reduce((s, r) => s + r.events, 0);
    // The test account's draws count nowhere; every real draw once.
    expect(sum('shrine.draw')).toBe(realDraws);

    const record = JSON.stringify({
      mageLevel: skillsStep.level,
      forgeRuns: lesson.forgeRuns,
      seals: lesson.seals,
      morwenCrypt: run.outcome,
      soulFragments: settled!.soulFragments,
      raced: raced ? 'shadow' : 'default',
      powerP3: morwenP3.value,
      powerP4: morwenP4.value,
      seasonAwards: awards.length,
      brannocDraws: brannocDraws.draws,
      realDraws,
      checks: report.reconcile!.length,
      watched,
      days: Math.round((clock.now() - D0) / DAY),
    });
    console.info(record);
    if (process.env.E2E_RECORD) appendFileSync(process.env.E2E_RECORD, `${record}\n`);
  }, 600_000);
});
