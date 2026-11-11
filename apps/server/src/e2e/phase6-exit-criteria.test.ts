/**
 * Phase 6 exit criteria, end to end through the HTTP API with a simulated server clock (ticket
 * 6.10, GDD §15 Phase 6): endgame systems add meaningful choices without making older content or
 * most item drops irrelevant.
 *
 * Several players on one clock in an invite-only town, played the way players would
 * (`./journey.ts`), composing the Phase 6 journey steps. Reaching levels 28–38 by play would take
 * days of farming, so the heroes are seeded like the Phase 6 journeys (a level, the bosses behind
 * them, a Legendary +10 kit at a named item level, a Forge stock), and each seeding is measured
 * (`holdingsBaseline`) so the holdings replay still holds from that moment on. Random outcomes come
 * from the server's own `crypto` seeds and the run asserts only what holds for every seed; where a
 * step needs a rare outcome (a Prismatic or Void drop, a Tyrant win for the Ember) the run's stored
 * seed is pinned to one game-core's own replay shows producing it (CLAUDE.md "Writing tests that
 * don't flake"). Outside the API: the owner's documented CLI steps (invite, roles, finishing the
 * town's first two projects, the test-setup stage command, marking a test account), the
 * scheduler's season and event jobs at the clock it would run them, and the seedings.
 *
 * - The town's first two projects finish (the Rekindling); ten givers finish the Forgeward
 *   Outpost's first stage on its first day, each at its 10 % cap (a gift past it is refused); the
 *   last two stages by the test-setup command; the era becomes the Forgeward Age.
 * - Season 1 and the Harvest of Bones are scheduled in the admin panel (players get the 404).
 * - A level-28 hero in good Ashen Pass gear opens and farms the Ashfall Verge (6.1), finishes the
 *   Harvest's whole reward track (each keepsake once), opens the collection book (6.8), then, at
 *   36 in Verge gear, farms the Cinder Depths and beats the Forge Tyrant (6.2): the hoard is bound,
 *   the Tyrant's Ember is spent on Tyrantforged Work at the bellows' price, and the Tyrant's
 *   appearance is earned and worn.
 * - The Harvest ends on its own: a settle after the end counts nothing, the close runs once.
 * - Prismatic and Void drops (6.4) from the Heroic crypt: upgraded and rerolled, they keep their
 *   variant; crafted items never carry one.
 * - Item Awakening (6.5b/c): the price, the auto-lock (selling refused), the shelf move to a second
 *   hero, the trade refusal with the switches on in the test, and the duel snapshot and bracket
 *   Power that count it.
 * - Crypt tier I carries no weekly modifier.
 * - Admin tools (D.4/D.4b) on a test account: cheats there, refused on a player; the test hero
 *   stays off the boards, out of the season's awards, out of matchmaking, out of trading and out of
 *   the Forgeward.
 * - 40 rated duels in 30+ from server lists (matchmaking 4, bracket Power 3, predicted with
 *   game-core), the eleventh refused, each rating moving once per duel.
 * - The season ends: awards once and equal to game-core's; the formula versions switch, and the
 *   sweep recomputes every hero under the current versions (Power 2, PvE Progress 4).
 * - Heroic (6.3) under the week's boss modifier, across a Monday.
 *
 * Valid means: every hero's holdings and the shelves equal the audit log; `reconcileWithAudit` and
 * the real `pnpm report:telemetry -- --reconcile` on this run's database match in every check; and
 * no player's response ever carried another player's email, account id or hero id.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import {
  BRACKET_POWER_VERSION,
  DEFAULT_TRADING_SETTINGS,
  FORMULA_VERSIONS,
  MATCHMAKING_VERSION,
  MATERIAL_IDS,
  PROVISIONAL_GAMES,
  RATED_DUELS_PER_DAY,
  bossModifierOfWeek,
  bracketPower,
  canClassUseItem,
  duelFighter,
  equipmentSlotsForKind,
  findCommunityProject,
  findItemBase,
  findPvpBracket,
  guildBossWeek,
  matchPower,
  matchmakingConfig,
  powerGap,
  ratingFactor,
  seasonAwards,
  stageCap,
  type ClassId,
  type MaterialId,
  type PrestigeMetric,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { advanceStage, completeProject } from '../community/project-cli.js';
import {
  accounts,
  auditLog,
  characterMaterials,
  characters,
  cosmeticUnlocks,
  duelDefences,
  dungeonRuns,
  friendships,
  itemInstances,
  leaderboardEntries,
  seasonAwards as seasonAwardRows,
  seasonStandings,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { replayRun } from '../dungeon/routes.js';
import { runEventJobs } from '../events/model.js';
import { checkLeaderboards } from '../leaderboards/check.js';
import { cliDeps } from '../leaderboards/leaderboard-cli.js';
import { snapshotDeps } from '../leaderboards/routes.js';
import { sweepLeaderboards } from '../leaderboards/snapshot.js';
import { createMemoryMailer, tokenIn } from '../mail/mailer.js';
import { runSeasonJobs } from '../seasons/model.js';
import { createPgliteDatabase } from '../test/db.js';
import { equipKit } from '../test/arena.js';
import { ALL_TRADING_ON, setTradingSettings } from '../test/trading.js';
import { reconcileWithAudit, type RollupRow, type TelemetryReport } from '../telemetry/report.js';
import {
  HOUR,
  MIN,
  expectHoldingsMatchAudit,
  expectShelfMatchesAudit,
  holdingsBaseline,
  openInviteOnlyTown,
  playAdminToolsStep,
  playCinderDepthsStep,
  playCinderwastesStep,
  playCollectionStep,
  playHeroicStep,
  playerOf,
  startJourney,
  type HoldingsBaseline,
  type Journey,
} from './journey.js';

const CAP = 3 * HOUR;
const DAY = 24 * HOUR;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

let dataDir: string;
let database: DatabaseHandle;
let app: FastifyInstance;
// CLAUDE.md "Dates": derived from the wall clock, never a fixed date. The next Monday, 06:00 UTC,
// at least a day ahead (the run spans a week: a season, an event, two duel days, a Monday).
const startMs = (() => {
  const day = Math.floor(Date.now() / DAY) * DAY + DAY;
  const weekday = (new Date(day).getUTCDay() + 6) % 7; // 0 = Monday
  return day + ((7 - weekday) % 7) * DAY + 6 * HOUR;
})();
let nowMs = startMs;
const clock = { now: () => nowMs, set: (ms: number) => void (nowMs = ms) };
const now = () => new Date(nowMs);
/** A minute between two duels or social steps, as a player takes them (4.1's social class). */
const pause = () => clock.set(clock.now() + MIN);
const mailer = createMemoryMailer();

/** Every account and hero id and email seen; no player's response may carry another player's. */
const secrets = new Map<string, string>();
const leaks: string[] = [];
let watched = 0;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wf-phase6-e2e-'));
  database = await createPgliteDatabase(join(dataDir, 'db'));
  app = buildApp({
    database,
    auth: { now, registrationMode: 'invite', mailer, publicBaseUrl: 'https://play.example.test' },
    activity: { ...DEFAULT_ACTIVITY_OPTIONS, offlineCapMs: CAP, now },
  });
  // The privacy guard (4.11, 5.8): each account's email and id at registration, each hero's id at
  // creation; a response carrying one that belongs to someone else fails the run. Staff routes
  // (`/api/admin/*`, `/api/mod/*`) answer staff about other accounts by design (they 404 to
  // everyone else, tested in their own suites); the admin tools step checks they carry no email.
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
interface Arena {
  hero: { level: number; ratedOpen: boolean; bracket: { id: string } };
  defence: { defenceId: string } | null;
  rated: {
    used: number;
    left: number;
    offer: { opponents: { defenceId: string; player: { handle: string } }[] } | null;
  };
  ladder: { you: { rating: number; games: number; standing: string }; rank: number | null };
}
interface Duel {
  id: string;
  kind: string;
  bracketId: string;
  foughtAt: string;
  rating: { before: number; after: number; factor: number } | null;
}
interface ViewItem {
  id: string;
  baseId: string;
  rarityId: string;
  variant: string | null;
  binding: string;
  bindingReason?: string;
  tradeable: boolean;
  locked: boolean;
  source: string;
  effectId: string | null;
  equippedSlot: string | null;
  affixes: unknown[];
  awakening?: { option: string; effectStrength: number };
}
type Inv = { inventory: ViewItem[]; equipped: ViewItem[] };

/** Seeding baselines per hero (`holdingsBaseline`). */
const baselines = new Map<string, HoldingsBaseline>();

/** A Phase 6 hero's seeding, as the Phase 6 journeys do it, measured for the holdings replay. */
async function seed(
  hero: Journey,
  {
    level,
    kit,
    gold,
    progress,
    materials,
    classId,
  }: {
    level: number;
    kit?: { itemLevel: number; tag: string };
    gold?: number;
    progress?: (typeof characters.$inferInsert)['progress'];
    materials?: Partial<Record<MaterialId, number>>;
    classId: ClassId;
  },
) {
  const db = database.db;
  await db
    .update(characters)
    .set({
      level,
      experience: 0,
      ...(gold !== undefined ? { gold } : {}),
      ...(progress ? { progress } : {}),
    })
    .where(eq(characters.id, hero.characterId));
  if (kit) {
    await equipKit(db, hero.characterId, classId, kit.itemLevel, 'legendary', kit.tag);
    await db
      .update(itemInstances)
      .set({ upgradeLevel: 10 })
      .where(
        and(eq(itemInstances.characterId, hero.characterId), isNotNull(itemInstances.equippedSlot)),
      );
  }
  if (materials) {
    for (const [materialId, quantity] of Object.entries(materials) as [MaterialId, number][]) {
      await db
        .insert(characterMaterials)
        .values({ characterId: hero.characterId, materialId, quantity })
        .onConflictDoUpdate({
          target: [characterMaterials.characterId, characterMaterials.materialId],
          set: { quantity },
        });
    }
  }
  hero.state.level = level;
  baselines.set(
    hero.characterId,
    await holdingsBaseline(database, hero.characterId, baselines.get(hero.characterId)),
  );
}

/** The hero rests (no farming), so the shared clock never runs its offline time past the cap. */
async function rest(hero: Journey) {
  const res = await hero.api('POST', `${hero.base}/activity/stop`);
  expect([200, 409], res.body).toContain(res.statusCode);
}

/**
 * Starts a dungeon run and pins its stored seed to one game-core's replay shows doing `wanted`
 * (a rare outcome the step is about), then settles and claims it.
 */
async function pinnedRun(
  hero: Journey,
  dungeonId: 'namelessCrypt' | 'tyrantsForge',
  tier: number,
  tag: string,
  wanted: (r: ReturnType<typeof replayRun>) => boolean,
  tries = 3_000,
) {
  const db = database.db;
  const start = await hero.api('POST', `${hero.base}/dungeon`, { dungeonId, tier });
  expect(start.statusCode, start.body).toBe(201);
  const [run] = await db
    .select()
    .from(dungeonRuns)
    .where(eq(dungeonRuns.characterId, hero.characterId))
    .orderBy(desc(dungeonRuns.startedAt))
    .limit(1);
  const pack = (await hero.inventory()).inventory.length;
  let secret: string | null = null;
  let endsAt = run!.endsAt.getTime();
  for (let i = 0; i < tries && !secret; i++) {
    const candidate = `phase6-exit:${tag}:${i}`;
    const r = replayRun({ ...run!, seedSecret: candidate }, pack, null);
    if (wanted(r)) {
      secret = candidate;
      endsAt = Math.max(endsAt, run!.startedAt.getTime() + r.durationMs);
    }
  }
  expect(secret, `a seed for ${tag}`).not.toBeNull();
  await db.update(dungeonRuns).set({ seedSecret: secret! }).where(eq(dungeonRuns.id, run!.id));
  clock.set(endsAt);
  expect((await hero.api('POST', `${hero.base}/dungeon/settle`)).statusCode).toBe(200);
  const claim = await hero.keyed(`${hero.base}/dungeon/claim`);
  expect(claim.statusCode, claim.body).toBe(200);
  return claim.json<{ result: { bossModifier: string | null; bossDefeated: boolean } }>().result;
}

describe('Phase 6 exit criteria', () => {
  it('the new region and the Tyrant → Heroic under a modifier → Prismatic, Void and awakening → an event start to end → the Forgeward and an era → the collection book → test accounts kept apart → 30+ duels → the season ends and the boards recompute → everything reconciles', async () => {
    const db = database.db;
    const auditCount = async (event: string) =>
      (await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.event, event))).length;

    // 1. The owner opens the town invite-only (CLI invite and role) and schedules Season 1 and the
    // Harvest of Bones in the admin panel, before anyone plays.
    const town = await openInviteOnlyTown(app, database, now());
    const owner = town.admin;
    const seasonStart = clock.now() + MIN;
    const seasonEnd = seasonStart + 4 * DAY;
    const planned = await owner.api('POST', '/api/admin/seasons', {
      startsAt: new Date(seasonStart).toISOString(),
      endsAt: new Date(seasonEnd).toISOString(),
    });
    expect(planned.statusCode, planned.body).toBe(200);
    const season = (planned.json<{
      current: { number: number } | null;
      next: { number: number } | null;
    }>().next ?? planned.json<{ current: { number: number } }>().current)!.number;
    const eventEnd = seasonStart + 3 * DAY;
    const harvest = await owner.api('POST', '/api/admin/events', {
      definitionId: 'harvestOfBones',
      startsAt: new Date(seasonStart).toISOString(),
      endsAt: new Date(eventEnd).toISOString(),
    });
    expect(harvest.statusCode, harvest.body).toBe(200);
    const harvestNumber = harvest.json<{
      current: { number: number } | null;
      next: { number: number } | null;
    }>();
    const eventNumber = (harvestNumber.next ?? harvestNumber.current)!.number;
    clock.set(seasonStart + 1_000);

    const enlist = (email: string, displayName: string, name: string, classId: ClassId) =>
      startJourney({ app, clock, classId, email, displayName, name, inviteCode: town.invite });
    const verge = await enlist('varra@graumark.test', 'Varra Ashwalker', 'Varra', 'warrior');
    const heroic = await enlist('hollin@graumark.test', 'Hollin Gravebell', 'Hollin', 'hunter');
    const prism = await enlist('iriel@graumark.test', 'Iriel Opaline', 'Iriel', 'warrior');
    const ember = await enlist('hralda@graumark.test', 'Hralda Banked', 'Hralda', 'warlock');
    const testerEmail = 'probe@graumark.test';
    const tester = await enlist(testerEmail, 'Probe Ansel', 'Probehold', 'mage');
    const players = [verge, heroic, prism, ember];
    for (const j of [...players, tester]) await rest(j);
    // A player can't schedule an event or a season (the admin 404).
    expect(
      (
        await verge.api('POST', '/api/admin/events', {
          definitionId: 'harvestOfBones',
          startsAt: new Date(eventEnd).toISOString(),
          endsAt: new Date(eventEnd + DAY).toISOString(),
        })
      ).statusCode,
    ).toBe(404);

    // Admin tools (D.4/D.4b): cheats on a test account (marked by the owner's CLI), refused on a
    // player; support tools; no email in any admin answer.
    await playAdminToolsStep(app, database, {
      admin: owner,
      hero: tester,
      email: testerEmail,
      bystander: heroic,
    });
    await rest(tester);

    // 2. The town's first two projects (the owner's 4.6 CLI): the Rekindling. The Forgeward
    // Outpost opens; ten givers finish its first stage on its first day, each at its cap (B.5b).
    type World = { flags: Record<string, boolean>; era: { id: string } };
    const world = async () => (await verge.api('GET', '/api/world')).json<World>();
    expect((await world()).era.id).toBe('longDusk');
    for (const id of ['restoreWarehouse', 'clearAshenPass'] as const) {
      expect(await completeProject(db, id, now())).toMatch(/completed|already complete/);
    }
    app.worldState.invalidate();
    expect((await world()).era.id).toBe('rekindling');
    const outpost = findCommunityProject('forgewardOutpost')!;
    const road = outpost.stages[0]!;
    const caps = Object.fromEntries(
      road.needs.map((n) => [n.resource, stageCap(road, n.resource)]),
    );
    expect(caps).toEqual({ gold: 6_000, ironOre: 100, soulShard: 40 });
    const givers: Journey[] = [...players];
    for (let n = givers.length; n < 10; n++) {
      const g = await enlist(
        `giver${n}@graumark.test`,
        `Giver ${'ABCDEFGHIJ'[n]}ald`,
        `Giver${'ABCDEFGHIJ'[n]}`,
        'warrior',
      );
      await rest(g);
      givers.push(g);
    }
    // Each giver holds a little more than its cap (what they gave would be farmed; seeded here).
    for (const g of givers) {
      const s = await db.select().from(characters).where(eq(characters.id, g.characterId));
      await database.db
        .update(characters)
        .set({ gold: s[0]!.gold + caps.gold! + 500 })
        .where(eq(characters.id, g.characterId));
      await seed(g, {
        level: g.state.level,
        classId: 'warrior',
        materials: { ironOre: caps.ironOre! + 5, soulShard: caps.soulShard! + 5 },
      });
    }
    type Board = {
      projects: {
        id: string;
        status: string;
        stageIndex: number;
        stages: { id: string }[];
      }[];
    };
    const outpostView = async () =>
      (await verge.api('GET', '/api/community/projects'))
        .json<Board>()
        .projects.find((p) => p.id === 'forgewardOutpost')!;
    expect(await outpostView()).toMatchObject({ status: 'open', stageIndex: 0 });
    // The test account may not give (D.4: test accounts stay out of shared progress).
    const testGift = await tester.keyed('/api/community/projects/forgewardOutpost/contribute', {
      characterId: tester.characterId,
      stageId: road.id,
      offer: [{ resource: 'gold', amount: 1 }],
    });
    expect(testGift.statusCode).toBe(403);
    expect(testGift.json<Err>().error.code).toBe('test_account');
    for (const [n, g] of givers.entries()) {
      // Each offers more than the cap; the server takes exactly the cap.
      const res = await g.keyed('/api/community/projects/forgewardOutpost/contribute', {
        characterId: g.characterId,
        stageId: road.id,
        offer: road.needs.map((x) => ({ resource: x.resource, amount: caps[x.resource]! + 5 })),
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json<{
        accepted: { resource: string; amount: number }[];
        limited: Record<string, string>;
        stagesCompleted: string[];
      }>();
      expect(Object.fromEntries(body.accepted.map((a) => [a.resource, a.amount]))).toEqual(caps);
      // The last gift fills the stage, so the stage's remainder limits it (it equals the cap).
      const by = n === 9 ? 'stage' : 'cap';
      expect(body.limited).toEqual({ gold: by, ironOre: by, soulShard: by });
      // The stage needs all ten: it finishes with the tenth gift, not before.
      expect(body.stagesCompleted).toEqual(n === 9 ? [road.id] : []);
      if (n === 0) {
        const again = await g.keyed('/api/community/projects/forgewardOutpost/contribute', {
          characterId: g.characterId,
          stageId: road.id,
          offer: [{ resource: 'gold', amount: 1 }],
        });
        expect(again.statusCode).toBe(409);
        expect(again.json<Err>().error.code).toBe('contribution_capped');
      }
    }
    expect(await outpostView()).toMatchObject({ status: 'open', stageIndex: 1 });
    expect(new Date(clock.now()).getUTCDate()).toBe(new Date(seasonStart).getUTCDate());
    // The last two stages by the owner's test-setup command (refused as production first).
    expect(await advanceStage(db, 'forgewardOutpost', now(), { production: true })).toMatch(
      /^Refused/,
    );
    for (let i = 0; i < 2; i++)
      await advanceStage(db, 'forgewardOutpost', now(), { production: false });
    app.worldState.invalidate();
    const raised = await world();
    expect(raised.flags.forgewardRaised).toBe(true);
    expect(raised.era.id).toBe('forgewardAge');
    // The era chain on record: each change once, from the one before.
    const eras = await db
      .select({ data: auditLog.data })
      .from(auditLog)
      .where(eq(auditLog.event, 'world.era_change'))
      .orderBy(auditLog.id);
    const chain = eras.map((e) => e.data as { from: string; to: string });
    expect(chain.at(-1)!.to).toBe('forgewardAge');
    for (let i = 1; i < chain.length; i++) expect(chain[i]!.from).toBe(chain[i - 1]!.to);
    // Every giver earned the Forgeward mark (and its banner, 6.8).
    const fwBanners = await db
      .select()
      .from(cosmeticUnlocks)
      .where(eq(cosmeticUnlocks.cosmeticId, 'banner.forgeward'));
    expect(fwBanners).toHaveLength(givers.length);

    // 3. The Ashfall Verge (6.1) in good Ashen Pass gear: a level-28 hero who joined the Harvest.
    const warden = { gravewardenDefeated: true, cryptTierCleared: 3 };
    await seed(verge, {
      level: 28,
      classId: 'warrior',
      progress: warden,
      kit: { itemLevel: 27, tag: 'phase6-verge' },
    });
    type HeroEvent = {
      current: { number: number } | null;
      hero: { quests: { id: string; progress: number; done: boolean }[] } | null;
      track: { tallies: number; granted: { tier: number; cosmeticId: string }[] } | null;
    };
    const eventOf = async (j: Journey) => {
      const r = await j.api('GET', `${j.base}/event`);
      expect(r.statusCode, r.body).toBe(200);
      return r.json<HeroEvent>();
    };
    const banner = (await verge.api('GET', '/api/events')).json<{
      current: { name: string } | null;
    }>();
    expect(banner.current?.name).toBe('Harvest of Bones');
    expect((await verge.api('POST', `${verge.base}/event/join`)).statusCode).toBe(201);
    const vergeOut = await playCinderwastesStep(app, database, verge, now);
    expect(vergeOut.watchRuns).toBeGreaterThanOrEqual(1);

    // The Harvest's whole track: the Fields' risen dead and the Watch's Warden count; each tier's
    // keepsake granted once, in the transaction that earned it.
    expect([200, 201]).toContain(
      (await verge.api('POST', `${verge.base}/activity`, { areaId: 'abandonedFields' })).statusCode,
    );
    let mine = await eventOf(verge);
    for (let i = 0; i < 12 && (mine.track?.granted.length ?? 0) < 3; i++) {
      await verge.settle();
      await verge.sellJunk(await verge.inventory());
      mine = await eventOf(verge);
    }
    expect(mine.hero!.quests.every((q) => q.done)).toBe(true);
    expect(mine.track!.tallies).toBe(50);
    expect(mine.track!.granted.map((g) => g.cosmeticId).sort()).toEqual(
      ['banner.harvest-sheaf', 'title-colour.bone-white', 'title.reaper-of-the-harvest'].sort(),
    );
    await rest(verge);
    const harvestGrants = await db
      .select()
      .from(cosmeticUnlocks)
      .where(
        and(
          eq(cosmeticUnlocks.accountId, (await playerOf(verge)).account.id),
          inArray(cosmeticUnlocks.cosmeticId, [
            'banner.harvest-sheaf',
            'title-colour.bone-white',
            'title.reaper-of-the-harvest',
          ]),
        ),
      );
    expect(harvestGrants).toHaveLength(3);

    // 4. The collection book (6.8): the Harvest's banner equipped; the boss appearances still
    // locked.
    const book = await playCollectionStep(verge);
    expect(book.owned).toEqual(
      expect.arrayContaining(['banner.harvest-sheaf', 'banner.warden-flame']),
    );

    // 5. The Cinder Depths and the Forge Tyrant (6.2) in good Verge gear at 36; the Ember goes to
    // Tyrantforged Work at the Forgeward bellows' price.
    await seed(verge, {
      level: 36,
      classId: 'warrior',
      gold: 5_000,
      progress: { ...warden, ashenWardenDefeated: true },
      kit: { itemLevel: 33, tag: 'phase6-depths' },
      materials: { ironOre: 60, soulShard: 12 },
    });
    const depthsOut = await playCinderDepthsStep(app, database, verge, now);
    expect(depthsOut.crafted).toBe(true);
    const [craft] = await db
      .select({ data: auditLog.data })
      .from(auditLog)
      .where(and(eq(auditLog.event, 'forge.craft'), eq(auditLog.characterId, verge.characterId)))
      .orderBy(desc(auditLog.id))
      .limit(1);
    expect((craft!.data as { gold: number }).gold).toBe(2_400);
    const crafted = await db
      .select({ variant: itemInstances.variant })
      .from(itemInstances)
      .where(
        and(eq(itemInstances.characterId, verge.characterId), eq(itemInstances.source, 'forge')),
      );
    expect(crafted.length).toBeGreaterThanOrEqual(1);
    // Forged items never carry a variant (6.4).
    expect(crafted.every((c) => c.variant === null)).toBe(true);
    // The Tyrant's appearance is earned (a milestone) and worn; the book shows it.
    const palette = await verge.keyed(`${verge.base}/appearance`, {
      appearance: 'appearance.ember',
    });
    expect(palette.statusCode, palette.body).toBe(200);
    const after = (await verge.api('GET', '/api/account/collection')).json<{
      heroes: { id: string; palette: string | null }[];
    }>();
    expect(after.heroes.find((h) => h.id === verge.characterId)!.palette).toBe('appearance.ember');
    await rest(verge);

    // 6. Prismatic and Void (6.4) from the Heroic crypt, then the Forge: neither changes variant.
    await seed(prism, {
      level: 34,
      classId: 'warrior',
      gold: 200_000,
      progress: { ...warden, ashenWardenDefeated: true },
      kit: { itemLevel: 39, tag: 'phase6-prism' },
      materials: Object.fromEntries(MATERIAL_IDS.map((m) => [m, 5_000])),
    });
    const wearable = (r: ReturnType<typeof replayRun>, variant: string) =>
      r.items.some(
        (x) => x.variant === variant && canClassUseItem(findItemBase(x.baseId)!, 'warrior'),
      );
    const prismRun = await pinnedRun(prism, 'namelessCrypt', 4, 'prismatic', (r) =>
      wearable(r, 'prismatic'),
    );
    expect(prismRun.bossModifier).toBe(bossModifierOfWeek(clock.now()).id);
    await pinnedRun(prism, 'namelessCrypt', 4, 'void', (r) => wearable(r, 'void'));
    const variantItems = ((await prism.inventory()) as unknown as Inv).inventory.filter(
      (i) => i.variant !== null,
    );
    for (const variant of ['prismatic', 'void']) {
      const item = variantItems.find((i) => i.variant === variant)!;
      expect(item, variant).toBeDefined();
      expect(['legendary', 'mythic']).toContain(item.rarityId);
      // Not tradeable under the default switches (trading closed; Prismatic and Void off).
      expect(item.tradeable).toBe(false);
      const slot = equipmentSlotsForKind(findItemBase(item.baseId)!.slot)[0]!;
      const worn = await prism.api('POST', `${prism.base}/items/${item.id}/equip`, { slot });
      expect(worn.statusCode, worn.body).toBe(200);
      const up = await prism.keyed(`${prism.base}/forge/upgrade`, { itemId: item.id });
      expect(up.statusCode, up.body).toBe(200);
      const re = await prism.keyed(`${prism.base}/forge/reroll`, {
        itemId: item.id,
        affixIndex: 0,
      });
      expect(re.statusCode, re.body).toBe(200);
      const [row] = await db.select().from(itemInstances).where(eq(itemInstances.id, item.id));
      expect(row!.variant).toBe(variant);
      expect(row!.binding).toBe('account');
    }
    // The Gear Score names both (each counted, 6.4).
    const prismScores = (await prism.api('GET', `${prism.base}/scores`)).json<{
      scores: { gearScore: { lines: { detail: string; counted: boolean }[] } };
    }>().scores;
    for (const word of ['Prismatic', 'Void']) {
      expect(prismScores.gearScore.lines.some((l) => l.counted && l.detail.includes(word))).toBe(
        true,
      );
    }
    // Crypt tier I never takes a modifier (6.3, the owner's decision): its run stores none.
    const tierOne = await prism.runDungeon('namelessCrypt', 1);
    expect(tierOne.bossModifier ?? null).toBeNull();
    const [tierOneRow] = await db
      .select({ tier: dungeonRuns.tier, modifier: dungeonRuns.bossModifier })
      .from(dungeonRuns)
      .where(eq(dungeonRuns.characterId, prism.characterId))
      .orderBy(desc(dungeonRuns.startedAt))
      .limit(1);
    expect(tierOneRow).toEqual({ tier: 1, modifier: null });
    await rest(prism);

    // 7. Item Awakening (6.5b/c): an Ember from a real Tyrant run (seed pinned to a win with the
    // hoard), the price paid once, the item locked, shelved to a second hero, never tradeable,
    // and counted by the duel snapshot and bracket Power.
    await seed(ember, {
      level: 38,
      classId: 'warlock',
      gold: 200_000,
      progress: { ...warden, ashenWardenDefeated: true },
      kit: { itemLevel: 39, tag: 'phase6-ember' },
      materials: {
        ...Object.fromEntries(MATERIAL_IDS.map((m) => [m, 1_000])),
        tyrantsEmber: 2,
        gravewardenSeal: 2,
      },
    });
    const tyrant = await pinnedRun(
      ember,
      'tyrantsForge',
      1,
      'ember',
      (r) => r.bossDefeated && (r.materials.tyrantsEmber ?? 0) >= 1,
      200,
    );
    expect(tyrant.bossDefeated).toBe(true);
    const inv = (await ember.inventory()) as unknown as Inv;
    const weapon = inv.equipped.find((i) => i.equippedSlot === 'weapon' && i.effectId)!;
    expect(weapon, 'a worn weapon with an effect').toBeDefined();
    const quote = await ember.api('GET', `${ember.base}/forge/items/${weapon.id}`);
    expect(quote.json().forge.awaken).toMatchObject({ refusal: null, blockers: [] });
    const goldBefore = (
      await db.select().from(characters).where(eq(characters.id, ember.characterId))
    )[0]!.gold;
    const key = randomUUID();
    const awake = await ember.keyed(`${ember.base}/forge/awaken`, { itemId: weapon.id }, key);
    expect(awake.statusCode, awake.body).toBe(200);
    const replay = await ember.keyed(`${ember.base}/forge/awaken`, { itemId: weapon.id }, key);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(await auditCount('forge.awaken')).toBe(1);
    const [paid] = await db
      .select({ data: auditLog.data })
      .from(auditLog)
      .where(eq(auditLog.event, 'forge.awaken'));
    const price = paid!.data as { gold: number; materials: Record<string, number> };
    expect(price.materials).toMatchObject({ tyrantsEmber: 3, gravewardenSeal: 2 });
    expect(
      (await db.select().from(characters).where(eq(characters.id, ember.characterId)))[0]!.gold,
    ).toBe(goldBefore - price.gold);
    const shown = ((await ember.inventory()) as unknown as Inv).equipped.find(
      (i) => i.id === weapon.id,
    )!;
    expect(shown).toMatchObject({
      awakening: { option: 'effect', effectStrength: 1.1 },
      binding: 'account',
      bindingReason: 'awakened',
      tradeable: false,
      locked: true,
    });
    // The duel snapshot carries it, and bracket Power 3 counts it (duel Power reads it).
    const def = await ember.keyed('/api/arena/defence', { characterId: ember.characterId });
    expect(def.statusCode, def.body).toBe(200);
    const [stored] = await db
      .select()
      .from(duelDefences)
      .where(eq(duelDefences.characterId, ember.characterId));
    expect(stored!.snapshot.equipment.find((e) => e.awakening)?.awakening).toEqual({
      option: 'effect',
      effectStrength: 1.1,
    });
    const fighter = duelFighter(stored!.snapshot);
    const bracket = findPvpBracket(stored!.bracketId)!;
    expect(stored!.powerVersion).toBe(BRACKET_POWER_VERSION);
    expect(stored!.power).toBe(bracketPower(fighter, bracket, 3));
    const plain = {
      ...fighter,
      equipment: fighter.equipment.map((i) => ({ ...i, awakening: null })),
    };
    expect(stored!.power).toBeGreaterThan(bracketPower(plain, bracket, 3));
    // Locked: the merchant refuses it (6.5c).
    const unequip = await ember.api('POST', `${ember.base}/items/${weapon.id}/unequip`);
    expect(unequip.statusCode, unequip.body).toBe(200);
    const sell = await ember.keyed(`${ember.base}/merchant/sell`, { itemIds: [weapon.id] });
    expect(sell.statusCode).toBe(409);
    expect(sell.json<Err>().error.code).toBe('item_locked');
    // With every switch on in the test: never offered in a trade; the shelf moves it to a second
    // hero of the account, still awakened.
    await setTradingSettings(app, db, ALL_TRADING_ON);
    const friendReq = await ember.api('POST', '/api/friends/requests', {
      handle: (await playerOf(verge)).account.handle,
    });
    expect(friendReq.statusCode, friendReq.body).toBe(200);
    expect(
      (
        await verge.api(
          'POST',
          `/api/friends/requests/${(await playerOf(ember)).account.handle}/accept`,
        )
      ).statusCode,
    ).toBe(200);
    // What a month of play brings (seeded: account and friendship age), and the mailed links.
    for (const [j, email] of [
      [ember, 'hralda@graumark.test'],
      [verge, 'varra@graumark.test'],
    ] as const) {
      const letter = mailer.last(email, 'verify_email');
      expect(letter, `${email} got a verification letter`).toBeDefined();
      const v = await app.inject({
        method: 'POST',
        url: '/api/auth/verify-email',
        payload: { token: tokenIn(letter!) },
      });
      expect(v.statusCode, v.body).toBe(200);
      await db
        .update(accounts)
        .set({ createdAt: new Date(clock.now() - 30 * DAY) })
        .where(eq(accounts.id, (await playerOf(j)).account.id));
    }
    await db
      .update(friendships)
      .set({
        createdAt: new Date(clock.now() - 31 * DAY),
        acceptedAt: new Date(clock.now() - 30 * DAY),
      })
      .where(eq(friendships.status, 'friends'));
    pause();
    const offer = await ember.keyed('/api/trading/offers', {
      to: (await playerOf(verge)).account.handle,
      characterId: ember.characterId,
      give: { itemIds: [weapon.id] },
    });
    expect(offer.statusCode).toBe(409);
    const checks = (offer.json<Err>().error.details!.reasons as { check: string }[]).map(
      (r) => r.check,
    );
    // Eligible accounts and an old friendship: what refuses it is the item itself.
    expect(checks).toContain('item_awakened');
    expect(checks.every((c) => c.startsWith('item_'))).toBe(true);
    const second = await ember.api('POST', '/api/characters', {
      name: 'Embersworn',
      classId: 'warlock',
      appearance: { banner: 'ash' },
    });
    expect(second.statusCode, second.body).toBe(201);
    const secondId = second.json<{ character: { id: string } }>().character.id;
    const dep = await ember.keyed(`${ember.base}/shelf/deposit`, { itemIds: [weapon.id] });
    expect(dep.statusCode, dep.body).toBe(200);
    const wd = await ember.keyed(`/api/characters/${secondId}/shelf/withdraw`, {
      itemIds: [weapon.id],
    });
    expect(wd.statusCode, wd.body).toBe(200);
    const [moved] = await db.select().from(itemInstances).where(eq(itemInstances.id, weapon.id));
    expect(moved).toMatchObject({
      characterId: secondId,
      awakening: { option: 'effect', effectStrength: 1.1 },
    });
    // The test account can't trade either (D.4), whatever the switches.
    const testOffer = await tester.keyed('/api/trading/offers', {
      to: (await playerOf(verge)).account.handle,
      characterId: tester.characterId,
      give: { gold: 1 },
    });
    expect(testOffer.statusCode).toBe(409);
    expect(
      (testOffer.json<Err>().error.details!.reasons as { check: string }[]).map((r) => r.check),
    ).toContain('test_account');
    await setTradingSettings(app, db, structuredClone(DEFAULT_TRADING_SETTINGS));
    await rest(ember);

    // 8. The test hero plays at 34 (by the admin's level tool, a cheat a test account allows) and
    // keeps out of everything shared.
    const testerHandle = (await playerOf(tester)).account.handle;
    const lvl = await owner.api(
      'POST',
      `/api/admin/accounts/${testerHandle}/heroes/${tester.characterId}/level`,
      { level: 34, reason: 'exit run' },
      { 'idempotency-key': randomUUID() },
    );
    expect(lvl.statusCode, lvl.body).toBe(200);
    tester.state.level = 34;
    await rest(tester);
    const testDefence = await tester.keyed('/api/arena/defence', {
      characterId: tester.characterId,
    });
    expect(testDefence.statusCode, testDefence.body).toBe(200);
    const testDefenceId = testDefence.json<Arena>().defence!.defenceId;

    // 9. Duels in 30+ (5.4–5.6, B.5): the four players set their defences; each fights ten rated
    // duels from the server's lists, predicted from the stored defences with matchmaking 4; the
    // eleventh is refused. Nothing anyone owns changes.
    await seed(heroic, {
      level: 34,
      classId: 'hunter',
      gold: 5_000,
      progress: { ...warden, ashenWardenDefeated: true },
      kit: { itemLevel: 39, tag: 'phase6-heroic' },
    });
    // Even bouts (as Phase 5 takes off the gear): every duellist in the same seeded kit, so the
    // lists don't hang on drops (the awakened weapon now sits with Ember's second hero).
    for (const [j, classId] of [
      [verge, 'warrior'],
      [prism, 'warrior'],
      [ember, 'warlock'],
    ] as const) {
      await seed(j, { level: j.state.level, classId, kit: { itemLevel: 39, tag: 'phase6-duel' } });
    }
    const handleOf = new Map<Journey, string>();
    for (const j of players) handleOf.set(j, (await playerOf(j)).account.handle);
    const arena = async (j: Journey) => {
      const res = await j.api('GET', `/api/arena?characterId=${j.characterId}`);
      expect(res.statusCode, res.body).toBe(200);
      return res.json<Arena>();
    };
    const defences = new Map<Journey, string>();
    for (const j of players) {
      const res = await j.keyed('/api/arena/defence', { characterId: j.characterId });
      expect(res.statusCode, res.body).toBe(200);
      defences.set(j, res.json<Arena>().defence!.defenceId);
    }
    // Ember's account is friends with Verge's: friends are never rated opponents (5.5).
    const notFriends = (j: Journey, k: Journey) =>
      !((j === ember && k === verge) || (j === verge && k === ember));
    const stored30 = await db
      .select()
      .from(duelDefences)
      .where(eq(duelDefences.bracketId, '30-plus'));
    expect(stored30.length).toBe(players.length + 1);
    for (const d of stored30) {
      expect(d.powerVersion).toBe(BRACKET_POWER_VERSION);
      expect(d.power).toBe(bracketPower(duelFighter(d.snapshot), findPvpBracket('30-plus')!, 3));
    }
    expect(MATCHMAKING_VERSION).toBe(4);
    const config = matchmakingConfig('30-plus');
    const powerOf = (j: Journey) => {
      const d = stored30.find((x) => x.characterId === j.characterId)!;
      return matchPower({ power: d.power!, classId: d.snapshot.classId }, config);
    };
    /** Who matchmaking 4 can offer `j`: in the widest Power step (fewer than five accounts). */
    const expectedFoes = (j: Journey) =>
      players
        .filter((k) => k !== j && notFriends(j, k))
        .filter((k) => powerGap(powerOf(j), powerOf(k), config) <= config.powerSteps.at(-1)!)
        .map((k) => handleOf.get(k)!)
        .sort();
    const owned = async () =>
      Promise.all(
        players.map(async (j) => {
          const i = (await j.inventory()) as unknown as Inv;
          return [...i.inventory, ...i.equipped].map((x) => x.id).sort();
        }),
      );
    const ownedBefore = await owned();
    const pairKey = (x: Journey, y: Journey) => [handleOf.get(x), handleOf.get(y)].sort().join('|');
    const pairs = new Map<string, number>();
    const fought: { duel: Duel; challenger: Journey; defender: Journey }[] = [];
    const duellists = players.filter((j) => expectedFoes(j).length > 0);
    expect(duellists).toHaveLength(players.length);
    const ratedDay = async (perHero: number) => {
      for (const j of duellists) {
        for (let n = 0; n < perHero; n++) {
          pause();
          let state = await arena(j);
          if (!state.rated.offer || state.rated.offer.opponents.length === 0) {
            const drawn = await j.api('POST', '/api/arena/opponents', {
              characterId: j.characterId,
            });
            expect(drawn.statusCode, drawn.body).toBe(200);
            state = drawn.json<Arena>();
            const handles = state.rated.offer!.opponents.map((o) => o.player.handle);
            expect(new Set(handles).size).toBe(handles.length);
            expect([...handles].sort()).toEqual(expectedFoes(j));
            // The test account's defence is never offered to a player.
            expect(state.rated.offer!.opponents.some((o) => o.defenceId === testDefenceId)).toBe(
              false,
            );
          }
          const pick = state.rated.offer!.opponents[0]!;
          const foe = players.find((x) => handleOf.get(x) === pick.player.handle)!;
          const k = randomUUID();
          const res = await j.keyed(
            '/api/arena/duels',
            { characterId: j.characterId, defenceId: pick.defenceId, kind: 'rated' },
            k,
          );
          expect(res.statusCode, res.body).toBe(201);
          const fight = res.json<{ duel: Duel }>().duel;
          expect(fight.bracketId).toBe('30-plus');
          const prior = pairs.get(pairKey(j, foe)) ?? 0;
          expect(fight.rating!.factor).toBe(ratingFactor(prior));
          pairs.set(pairKey(j, foe), prior + 1);
          fought.push({ duel: fight, challenger: j, defender: foe });
        }
        const spent = await arena(j);
        expect(spent.rated).toMatchObject({ used: RATED_DUELS_PER_DAY, left: 0 });
        if (!spent.rated.offer || spent.rated.offer.opponents.length === 0) {
          await j.api('POST', '/api/arena/opponents', { characterId: j.characterId });
        }
        const next = (await arena(j)).rated.offer!.opponents[0]!;
        const eleventh = await j.keyed('/api/arena/duels', {
          characterId: j.characterId,
          defenceId: next.defenceId,
          kind: 'rated',
        });
        expect(eleventh.statusCode, eleventh.body).toBe(409);
        expect(eleventh.json<Err>().error.code).toBe('no_duels_left');
      }
    };
    await ratedDay(RATED_DUELS_PER_DAY);
    // A test hero sees only test accounts: an empty list (nobody else is a test account).
    const testList = await tester.api('POST', '/api/arena/opponents', {
      characterId: tester.characterId,
    });
    expect(testList.statusCode, testList.body).toBe(200);
    expect(testList.json<Arena>().rated.offer?.opponents ?? []).toEqual([]);
    expect(fought).toHaveLength(players.length * RATED_DUELS_PER_DAY);
    for (const j of duellists) {
      const list = (await j.api('GET', '/api/arena/duels?limit=100')).json<{
        duels: { id: string; kind: string }[];
      }>().duels;
      const mine2 = fought.filter((f) => f.challenger === j || f.defender === j);
      const rated = list.filter((x) => x.kind === 'rated');
      expect(rated).toHaveLength(mine2.length);
      const chain2: Duel[] = [];
      for (const x of rated) {
        chain2.push((await j.api('GET', `/api/arena/duels/${x.id}`)).json<{ duel: Duel }>().duel);
      }
      chain2.sort((x, y) => Date.parse(x.foughtAt) - Date.parse(y.foughtAt));
      expect(chain2[0]!.rating!.before).toBe(1500);
      for (let n = 1; n < chain2.length; n++) {
        expect(chain2[n]!.rating!.before).toBe(chain2[n - 1]!.rating!.after);
      }
      const ladder = (await arena(j)).ladder;
      expect(ladder.you.games).toBe(mine2.length);
      expect(ladder.you.games).toBeGreaterThanOrEqual(PROVISIONAL_GAMES);
      expect(Math.round(ladder.you.rating)).toBe(Math.round(chain2.at(-1)!.rating!.after));
    }
    expect(await owned()).toEqual(ownedBefore);

    // 10. The Harvest ends on its own: a settle after the end counts nothing; the close runs once
    // and nothing earned is lost.
    clock.set(eventEnd + 1_000);
    expect((await eventOf(verge)).current).toBeNull();
    clock.set(eventEnd + 10 * MIN);
    expect((await runEventJobs(db, now())).closed).toEqual([eventNumber]);
    expect((await runEventJobs(db, now())).closed).toEqual([]);
    expect(await auditCount('event.reward')).toBe(3);
    expect(await auditCount('event.close')).toBe(1);

    // 11. The season ends: archived and awarded once, equal to game-core's awards over the stored
    // standings; the test account is in neither. Then the formula versions switch, and the sweep
    // recomputes every hero under the current versions.
    clock.set(seasonEnd + 10 * MIN);
    const first = await runSeasonJobs(db, now(), now());
    expect(first.archived).toContain(season);
    expect((await runSeasonJobs(db, now(), now())).archived).toEqual([]);
    const testAccountId = (await playerOf(tester)).account.id;
    const standings = await db
      .select()
      .from(seasonStandings)
      .where(eq(seasonStandings.season, season));
    expect(standings.some((s) => s.accountId === testAccountId)).toBe(false);
    expect(
      standings
        .filter((s) => s.metric === 'arena')
        .map((s) => s.characterId)
        .sort(),
    ).toEqual(duellists.map((j) => j.characterId).sort());
    const expected = seasonAwards(
      standings.map((s) => ({
        accountId: s.accountId,
        characterId: s.characterId,
        metric: s.metric as PrestigeMetric,
        rank: s.rank,
        level: s.level,
      })),
    );
    const awarded = await db
      .select()
      .from(seasonAwardRows)
      .where(eq(seasonAwardRows.season, season));
    const shape = (x: { accountId: string; metric: string; tier: string; rank: number }) =>
      `${x.accountId}|${x.metric}|${x.tier}|${x.rank}`;
    expect(awarded.map(shape).sort()).toEqual(expected.map(shape).sort());
    expect(awarded.some((a) => a.accountId === testAccountId)).toBe(false);
    await runSeasonJobs(db, now(), now());
    expect(
      await db.select().from(seasonAwardRows).where(eq(seasonAwardRows.season, season)),
    ).toHaveLength(awarded.length);
    // Season honours are cosmetics too (6.8): the arena champion's account owns the royal title
    // colour, granted once.
    const champion = awarded.find((a) => a.metric === 'arena' && a.tier === 'champion')!;
    const royal = await db
      .select()
      .from(cosmeticUnlocks)
      .where(
        and(
          eq(cosmeticUnlocks.accountId, champion.accountId),
          eq(cosmeticUnlocks.cosmeticId, 'title-colour.royal'),
        ),
      );
    expect(royal).toHaveLength(1);

    // The scheduler's 5.2 sweep, its next tick: every hero's rows of the old versions are missing
    // under the new ones and are recomputed (the season's own archived rows stay as they ended).
    expect(await app.formulaVersions.at(now())).toEqual(FORMULA_VERSIONS);
    const swept = await sweepLeaderboards(snapshotDeps(app), now(), { batch: 200, cursor: null });
    expect(swept.updated).toBeGreaterThanOrEqual(players.length);

    // 12. Heroic (6.3) under the week's boss modifier, its last run across Monday.
    await rest(heroic);
    const heroicOut = await playHeroicStep(app, database, heroic, clock, now);
    expect(heroicOut.modifiers).toHaveLength(heroicOut.runs);
    expect(new Set(heroicOut.modifiers).size).toBeGreaterThanOrEqual(1);
    // The weekly rotation: next week's modifier is another one (cycles of five, no repeats).
    const week = guildBossWeek(clock.now());
    expect(bossModifierOfWeek(week.endMs + 1).id).not.toBe(bossModifierOfWeek(week.startMs).id);
    await rest(heroic);

    // 13. Boards under the current formula versions (the season's end switched them): every
    // player's hero has a row per metric at the current version equal to its own breakdown; the
    // test hero has none on any board read; the recompute check finds nothing wrong.
    expect(await app.formulaVersions.at(now())).toEqual(FORMULA_VERSIONS);
    for (const j of players) {
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
      const board = (await verge.api('GET', `/api/leaderboards/${metric}?limit=100`)).json<{
        board: { formulaVersion: number; entries: { player: { handle: string } }[] };
      }>().board;
      expect(board.formulaVersion).toBe(FORMULA_VERSIONS[metric as 'level']);
      expect(board.entries.some((e) => e.player.handle === testerHandle)).toBe(false);
    }
    const recompute = await checkLeaderboards(cliDeps(db), 200, now());
    expect(recompute.problems.filter((p) => p.kind === 'wrong')).toEqual([]);

    // 14. Everything held and recorded agrees; nothing leaked.
    for (const j of [...players, ...givers.slice(players.length)]) {
      await expectHoldingsMatchAudit(database, j.characterId, baselines.get(j.characterId));
    }
    await expectHoldingsMatchAudit(database, secondId);
    await expectShelfMatchesAudit(database, (await playerOf(ember)).account.id);
    expect((await reconcileWithAudit(db)).filter((x) => !x.ok)).toEqual([]);
    expect(leaks).toEqual([]);
    // Twelve accounts (email and id each) and twelve heroes were watched.
    expect(secrets.size).toBe(36);
    expect(watched).toBeGreaterThan(300);
    const testAccounts = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.isTest, true));
    expect(testAccounts.map((a) => a.id)).toEqual([testAccountId]);

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
    expect(sum('duel.fight', (x) => x[0] === 'rated')).toBe(fought.length);
    expect(sum('event.reward')).toBe(3);
    expect(sum('world.era')).toBe(chain.length);

    const record = JSON.stringify({
      watchRuns: vergeOut.watchRuns,
      depthsRuns: depthsOut.runs,
      heroicRuns: heroicOut.runs,
      modifiers: heroicOut.modifiers,
      ratedDuels: fought.length,
      duellists: duellists.length,
      eras: chain.map((c) => c.to),
      awards: awarded.length,
      checks: report.reconcile!.length,
    });
    console.info(record);
    if (process.env.E2E_RECORD) appendFileSync(process.env.E2E_RECORD, `${record}\n`);
  }, 900_000);
});
