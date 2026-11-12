/**
 * Phase 8 exit criteria, end to end through the HTTP API with a simulated server clock (ticket
 * 8.7): the live town has a new endgame region beyond level 40 that keeps Phase 6 content relevant,
 * a self-running calendar of events, better everyday comfort and a clear going-live checklist;
 * everything is reconciled, fair and free of pay-to-win.
 *
 * Several players on one clock in an invite-only town, composing the Phase 8 journey steps
 * (`./journey.ts`). Levels 40–52 take weeks of farming, so the endgame heroes are seeded like the
 * Phase 8 journeys (a level, the bosses behind them, a Legendary +10 kit, a purse and a Forge
 * stock), each seeding measured (`holdingsBaseline`) so the holdings replay holds from it on.
 * Random outcomes come from the server's `crypto` seeds and the run asserts only what holds for
 * every seed; the one rare outcome it needs (a Throne run with a drop worth a letter) is the run's
 * stored seed pinned to one game-core's replay shows producing it (CLAUDE.md "Writing tests that
 * don't flake"). Outside the API: the owner's documented CLI steps (invite, role, test account,
 * the town's first three projects, the test-setup stage command), the scheduler's season, event
 * and trade jobs at the clock it would run them, and the seedings.
 *
 * The run spans about six weeks of game time (sessions live longer than the default 30 days here,
 * a test setting): day 0 is a Monday 06:00 UTC derived from the wall clock (CLAUDE.md "Dates").
 *
 * - The readiness panel (8.6) before and after the owner's steps: Season 1, the calendar's first
 *   event, a test letter whose address is stored nowhere.
 * - Two guilds (and a third that disbands) formed on day 0; the guild hall's treasury (cap, roles,
 *   no refund, a disband's forfeit).
 * - The lanterns of the deep (8.2): ten givers each give exactly their first-day tenth on day 1,
 *   the stage finishes with the tenth gift, the test account is refused; the owner's stage command
 *   lights the lanterns; the era chain ends at the Lantern Vigil.
 * - The Pale Marches (a level-40 hero in Depths gear beats the Tyrant, then farms tier-5 drops) and
 *   the Hollow Deep (a level-50 hero farms it, the Hollow Sovereign falls, the hoard is bound and
 *   the crown shard becomes Crownforged Work at the lantern smithy's price).
 * - The calendar (8.3, 8.3b): the owner sets the rotation and turns it on; the scheduler creates
 *   the Lantern Procession once, on a Monday 00:00; a fresh hero finishes a week-1 task; weeks 2–4
 *   open on their boundaries; the Procession ends on its own, closes once, and the calendar puts
 *   the Harvest of Bones on the first Monday at least the gap later, once.
 * - Guild seasons (8.4): a leaver, a late joiner, a hopper whose old gifts don't follow them and the
 *   test account; the roll archived with Season 1, honours exactly once and equal to game-core's.
 * - The inbox (8.5) holds an entry from every source, with the privacy rules (a test account's
 *   duel reaches no one); loot-filter preset codes (malicious ones refused); a batch claim.
 * - The boards under the current versions (Power 3, PvE Progress 6); the test hero on none.
 *
 * Valid means: every hero's holdings equal the audit log; `reconcileWithAudit` and the real
 * `pnpm report:telemetry -- --reconcile` on this run's database match in every check; and no
 * player's response ever carried another player's email, account id or hero id.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  FORMULA_VERSIONS,
  GUILD_CREATE_COST,
  GUILD_SEASON_RULES,
  ceilToMonday,
  findCommunityProject,
  guildSeasonAwards,
  guildSeasonCosmeticsEarned,
  seasonAwards,
  stageCap,
  type ClassId,
  type MaterialId,
  type PrestigeMetric,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { setTestAccount } from '../admin/test-accounts.js';
import { advanceStage, completeProject } from '../community/project-cli.js';
import {
  accountNotifications,
  accounts,
  auditLog,
  characterMaterials,
  characters,
  cosmeticUnlocks,
  dungeonRuns,
  eventTrackGrants,
  friendships,
  guildSeasonAwards as guildAwardRows,
  guildSeasonRosters,
  guildSeasonStandings,
  itemInstances,
  leaderboardEntries,
  seasonAwards as seasonAwardRows,
  seasonStandings,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { replayRun } from '../dungeon/routes.js';
import { runEventJobs } from '../events/model.js';
import { checkGuildSeasons } from '../guild-seasons/model.js';
import { isDropWorthSeeing } from '../inbox/notify.js';
import { checkLeaderboards } from '../leaderboards/check.js';
import { cliDeps } from '../leaderboards/leaderboard-cli.js';
import { snapshotDeps } from '../leaderboards/routes.js';
import { sweepLeaderboards } from '../leaderboards/snapshot.js';
import { createMemoryMailer, tokenIn } from '../mail/mailer.js';
import { runSeasonJobs } from '../seasons/model.js';
import { queryRows } from '../db/query.js';
import { createPgliteDatabase } from '../test/db.js';
import { equipKit } from '../test/arena.js';
import { sweepTrades } from '../trading/offers.js';
import { reconcileWithAudit, type RollupRow, type TelemetryReport } from '../telemetry/report.js';
import {
  HOUR,
  MIN,
  expectHoldingsMatchAudit,
  holdingsBaseline,
  newPlayer,
  openInviteOnlyTown,
  playGuildHallStep,
  playHollowDeepStep,
  playHollowReachStep,
  playQualityOfLifeStep,
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
// at least a day ahead.
const D0 = (() => {
  const day = Math.floor(Date.now() / DAY) * DAY + DAY;
  const weekday = (new Date(day).getUTCDay() + 6) % 7; // 0 = Monday
  return day + ((7 - weekday) % 7) * DAY + 6 * HOUR;
})();
let nowMs = D0;
const clock = { now: () => nowMs, set: (ms: number) => void (nowMs = Math.max(nowMs, ms)) };
const now = () => new Date(nowMs);
/** A minute between social steps, as a player takes them (4.1's social class). */
const pause = () => clock.set(clock.now() + MIN);
const mailer = createMemoryMailer();
const activityOptions = { ...DEFAULT_ACTIVITY_OPTIONS, offlineCapMs: CAP, now };

/** Every account and hero id and email seen; no player's response may carry another player's. */
const secrets = new Map<string, string>();
const leaks: string[] = [];
let watched = 0;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wf-phase8-e2e-'));
  database = await createPgliteDatabase(join(dataDir, 'db'));
  app = buildApp({
    database,
    auth: {
      now,
      registrationMode: 'invite',
      mailer,
      publicBaseUrl: 'https://play.example.test',
      // The run spans six game weeks; sessions don't slide, so they live longer here.
      sessionTtlMs: 120 * DAY,
    },
    activity: activityOptions,
  });
  // The privacy guard (4.11, 5.8, 6.10), as in the Phase 6 run.
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
type Readiness = { items: { id: string; status: string }[] };
type Calendar = {
  calendar: { paused: boolean; planned: { definitionId: string }[] };
  current: { number: number; definitionId: string; source: string } | null;
  next: { number: number; definitionId: string; source: string; startsAt: string } | null;
};
type HeroEvent = {
  current: { number: number; week: number; weeks: number } | null;
  hero: { quests: { id: string; done: boolean; open: boolean }[] } | null;
  track: { tallies: number; granted: { tier: number; cosmeticId: string }[] } | null;
};
type InboxEntry = { id: string; kind: string; data: Record<string, unknown>; read: boolean };

const baselines = new Map<string, HoldingsBaseline>();

/** A Phase 8 hero's seeding, as the Phase 8 journeys do it, measured for the holdings replay. */
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
  for (const [materialId, quantity] of Object.entries(materials ?? {}) as [MaterialId, number][]) {
    await db
      .insert(characterMaterials)
      .values({ characterId: hero.characterId, materialId, quantity })
      .onConflictDoUpdate({
        target: [characterMaterials.characterId, characterMaterials.materialId],
        set: { quantity },
      });
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

describe('Phase 8 exit criteria', () => {
  it('the readiness panel → guilds → the lanterns lit by ten givers → the Marches, the Deep and the Sovereign → the calendar runs the Procession and rotates → guild seasons and halls → the inbox, presets and batch claims → the boards → everything reconciles', async () => {
    const db = database.db;
    const auditCount = async (event: string) =>
      (await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.event, event))).length;

    // 1. The owner opens the town invite-only and reads the readiness panel (8.6).
    const town = await openInviteOnlyTown(app, database, now());
    const owner = town.admin;
    const readiness = async () => {
      const res = await owner.api('GET', '/api/admin/readiness');
      expect(res.statusCode, res.body).toBe(200);
      const items = res.json<Readiness>().items;
      return Object.fromEntries(items.map((i) => [i.id, i.status]));
    };
    const before = await readiness();
    expect(before).toMatchObject({ season: 'not_set', event: 'not_set' });
    // A test letter to an address the owner types: sent, and stored nowhere.
    const typed = 'owner-check@mail.example.test';
    const letter = await owner.api('POST', '/api/admin/readiness/test-letter', { to: typed });
    expect(letter.statusCode, letter.body).toBe(200);
    expect(letter.json<{ outcome: string }>().outcome).toBe('sent');
    const [stored] = await queryRows<{ n: number }>(
      db,
      sql`select count(*)::int as n from audit_log where data::text like ${'%' + typed + '%'}`,
    );
    expect(stored!.n).toBe(0);
    // Season 1, six weeks less two days, from the next minute (admin panel).
    const seasonStart = clock.now() + MIN;
    const seasonEnd = D0 + 40 * DAY;
    const planned = await owner.api('POST', '/api/admin/seasons', {
      startsAt: new Date(seasonStart).toISOString(),
      endsAt: new Date(seasonEnd).toISOString(),
    });
    expect(planned.statusCode, planned.body).toBe(200);
    const plannedBody = planned.json<{
      current: { number: number } | null;
      next: { number: number } | null;
    }>();
    const season = (plannedBody.next ?? plannedBody.current)!.number;
    const afterSeason = await readiness();
    expect(afterSeason.season).not.toBe('not_set');
    // Test capture is not real mail: the panel asks for attention until SMTP is set (8.6).
    expect(afterSeason.email).toBe('attention');
    clock.set(seasonStart + 1_000);

    // 2. The players. Endgame heroes are seeded; the Procession's bearer plays from level 1.
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
    const lantern = findCommunityProject('deepLanterns')!;
    const posts = lantern.stages[0]!;
    const caps = Object.fromEntries(
      posts.needs.map((n) => [n.resource, stageCap(posts, n.resource)]),
    );
    expect(caps).toEqual({ gold: 9_000, ironOre: 120, soulShard: 50 });
    const giverStock = { ironOre: caps.ironOre! + 5, soulShard: caps.soulShard! + 5 };
    const marcher = await enlist('maren@graumark.test', 'Maren Palewalk', 'Maren', 'warrior');
    const delver = await enlist('dunstan@graumark.test', 'Dunstan Deepdown', 'Dunstan', 'warrior');
    const bearer = await enlist('wenna@graumark.test', 'Wenna Wickbright', 'Wenna', 'hunter');
    const testerEmail = 'probe8@graumark.test';
    const tester = await enlist(testerEmail, 'Probe Ansel', 'Probehold', 'mage');
    const givers: Journey[] = [];
    for (let n = 1; n <= 8; n++) {
      const letterOf = 'ABCDEFGH'[n - 1];
      givers.push(
        await enlist(
          `giver8-${n}@graumark.test`,
          `Giver ${letterOf}ald`,
          `Lamp${letterOf}`,
          'warrior',
        ),
      );
    }
    const [g1, g2, g3, g4, g5, g6, g7, g8] = givers as [
      Journey,
      Journey,
      Journey,
      Journey,
      Journey,
      Journey,
      Journey,
      Journey,
    ];
    // Dunstan and Maren follow the mailed links (trading needs a verified address, 9.).
    for (const [email] of [['dunstan@graumark.test'], ['maren@graumark.test']] as const) {
      const mail = mailer.last(email, 'verify_email');
      expect(mail, `${email} got a verification letter`).toBeDefined();
      const v = await app.inject({
        method: 'POST',
        url: '/api/auth/verify-email',
        payload: { token: tokenIn(mail!) },
      });
      expect(v.statusCode, v.body).toBe(200);
    }
    // The owner's CLI marks the test account (D.4).
    const testerHandle = (await playerOf(tester)).account.handle;
    expect(await setTestAccount(db, testerHandle, true)).toMatchObject({ to: true });

    const warden = { gravewardenDefeated: true, cryptTierCleared: 3, ashenWardenDefeated: true };
    await seed(marcher, {
      level: 40,
      classId: 'warrior',
      gold: caps.gold! + 2_000,
      progress: warden,
      kit: { itemLevel: 39, tag: 'phase8-marches' },
      materials: giverStock,
    });
    await seed(delver, {
      level: 50,
      classId: 'warrior',
      gold: caps.gold! + GUILD_CREATE_COST + 12_000 + 6_000,
      progress: { ...warden, cryptTierCleared: 4, forgeTyrantDefeated: true },
      kit: { itemLevel: 47, tag: 'phase8-deep' },
      materials: { ironOre: giverStock.ironOre + 80, soulShard: giverStock.soulShard + 16 },
    });
    const giverGold: Record<number, number> = {
      0: caps.gold! + 31_000, // g1: also offers past the treasury's daily cap
      4: caps.gold! + GUILD_CREATE_COST + 500, // g5 founds the Ashen Oath
      7: caps.gold! + GUILD_CREATE_COST + 1_500, // g8 founds a guild that disbands
    };
    for (const [n, g] of givers.entries()) {
      await seed(g, {
        level: 12,
        classId: 'warrior',
        gold: giverGold[n] ?? caps.gold! + 500,
        materials: giverStock,
      });
    }

    // 3. Guilds on day 0. The Lantern Wardens: Dunstan leads, Maren is officer, g1–g3 and the
    // test account join. The Ashen Oath: g5 leads, g6 and g7 join. The Short Watch: g8 alone.
    type GuildBody = { guild: { handle: string } };
    const found = async (j: Journey, name: string, tag: string) => {
      const res = await j.keyed('/api/guilds', {
        characterId: j.characterId,
        name,
        tag,
        emblem: 'flame',
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json<GuildBody>().guild.handle;
    };
    const displayOf = async (j: Journey) => (await playerOf(j)).account.displayName;
    const invite = async (leader: Journey, j: Journey, handle: string) => {
      pause();
      const sent = await leader.api('POST', '/api/guild/invites', {
        name: (await displayOf(j)).toLowerCase(),
      });
      expect(sent.statusCode, sent.body).toBe(200);
      const took = await j.api('POST', `/api/guilds/${handle}/invite/accept`);
      expect(took.statusCode, took.body).toBe(200);
    };
    const wardens = await found(delver, 'The Lantern Wardens', 'lnw');
    for (const j of [marcher, g1, g2, g3, tester]) await invite(delver, j, wardens);
    const marcherHandle = (await playerOf(marcher)).account.handle;
    expect(
      (await delver.api('POST', `/api/guild/members/${marcherHandle}/promote`)).statusCode,
    ).toBe(200);
    const oath = await found(g5, 'The Ashen Oath', 'oth');
    for (const j of [g6, g7]) await invite(g5, j, oath);
    const shortWatch = await found(g8, 'The Short Watch', 'shw');
    for (const j of [delver, g5, g8]) {
      baselines.set(
        j.characterId,
        await holdingsBaseline(database, j.characterId, baselines.get(j.characterId)),
      );
    }

    // 4. The calendar (8.3, 8.3b): paused until the owner sets the rotation and turns it on.
    const admin = async (method: 'GET' | 'POST', url: string, body?: object) => {
      const res = await owner.api(method, url, body);
      expect(res.statusCode, res.body).toBe(200);
      return res.json<Calendar>();
    };
    expect((await admin('GET', '/api/admin/events')).calendar.paused).toBe(true);
    // A player gets the admin 404 (before any validation).
    expect(
      (await marcher.api('POST', '/api/admin/events/calendar', { paused: false })).statusCode,
    ).toBe(404);
    await admin('POST', '/api/admin/events/calendar', {
      rotation: [
        { definitionId: 'lanternProcession', days: 28 },
        { definitionId: 'harvestOfBones', days: 7 },
      ],
      gapDays: 2,
    });
    // A multi-week event never gets fewer days than its weeks (8.3b).
    const short = await owner.api('POST', '/api/admin/events/calendar', {
      rotation: [{ definitionId: 'lanternProcession', days: 21 }],
    });
    expect(short.statusCode).toBe(400);
    expect(short.json<Err>().error.code).toBe('length_too_short');
    await admin('POST', '/api/admin/events/calendar', { paused: false });
    const tick = () => runEventJobs(db, now());
    const made = await tick();
    expect(made.created).not.toBeNull();
    expect((await tick()).created).toBeNull();
    const firstPlan = await admin('GET', '/api/admin/events');
    expect(firstPlan.next).toMatchObject({ definitionId: 'lanternProcession', source: 'calendar' });
    const procession = firstPlan.next!.number;
    const S = Date.parse(firstPlan.next!.startsAt);
    // The first Monday 00:00 UTC on or after the next full hour.
    expect(S).toBe(ceilToMonday(new Date(Math.ceil(clock.now() / HOUR) * HOUR)).getTime());
    expect(new Date(S).getUTCDay()).toBe(1);
    expect(S).toBe(D0 + 7 * DAY - 6 * HOUR);
    expect((await readiness()).event).not.toBe('not_set');

    // 5. Day 1: the owner finishes the town's first three projects (CLI); the lanterns open.
    clock.set(D0 + DAY);
    type World = { flags: Record<string, boolean>; era: { id: string } };
    const world = async () => (await marcher.api('GET', '/api/world')).json<World>();
    expect((await world()).era.id).toBe('longDusk');
    for (const id of ['restoreWarehouse', 'clearAshenPass', 'forgewardOutpost'] as const) {
      expect(await completeProject(db, id, now())).toMatch(/completed|already complete/);
    }
    app.worldState.invalidate();
    expect((await world()).era.id).toBe('forgewardAge');
    // The Deep and the Throne are shut until the lanterns are lit.
    const deepRefused = await delver.api('POST', `${delver.base}/activity`, {
      areaId: 'hollowDeep',
    });
    expect(deepRefused.statusCode).toBe(409);
    const throneDoor = await delver.api('POST', `${delver.base}/dungeon`, {
      dungeonId: 'hollowThrone',
      tier: 1,
    });
    expect(throneDoor.statusCode).toBe(409);
    // The test account may not give (D.4).
    const testGift = await tester.keyed('/api/community/projects/deepLanterns/contribute', {
      characterId: tester.characterId,
      stageId: posts.id,
      offer: [{ resource: 'gold', amount: 1 }],
    });
    expect(testGift.statusCode).toBe(403);
    expect(testGift.json<Err>().error.code).toBe('test_account');
    const tenGivers = [delver, marcher, ...givers];
    expect(tenGivers).toHaveLength(10);
    for (const [n, g] of tenGivers.entries()) {
      const res = await g.keyed('/api/community/projects/deepLanterns/contribute', {
        characterId: g.characterId,
        stageId: posts.id,
        offer: posts.needs.map((x) => ({ resource: x.resource, amount: caps[x.resource]! + 5 })),
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json<{
        accepted: { resource: string; amount: number }[];
        limited: Record<string, string>;
        stagesCompleted: string[];
      }>();
      expect(Object.fromEntries(body.accepted.map((a) => [a.resource, a.amount]))).toEqual(caps);
      const by = n === 9 ? 'stage' : 'cap';
      expect(body.limited).toEqual({ gold: by, ironOre: by, soulShard: by });
      expect(body.stagesCompleted).toEqual(n === 9 ? [posts.id] : []);
      if (n === 0) {
        const again = await g.keyed('/api/community/projects/deepLanterns/contribute', {
          characterId: g.characterId,
          stageId: posts.id,
          offer: [{ resource: 'gold', amount: 1 }],
        });
        expect(again.statusCode).toBe(409);
        expect(again.json<Err>().error.code).toBe('contribution_capped');
      }
    }
    // The last two stages by the owner's test-setup command (refused as production first).
    expect(await advanceStage(db, 'deepLanterns', now(), { production: true })).toMatch(/^Refused/);
    for (let i = 0; i < 2; i++)
      await advanceStage(db, 'deepLanterns', now(), { production: false });
    app.worldState.invalidate();
    const lit = await world();
    expect(lit.flags.deepLanternsLit).toBe(true);
    expect(lit.era.id).toBe('lanternVigil');
    const chain = (
      await db
        .select({ data: auditLog.data })
        .from(auditLog)
        .where(eq(auditLog.event, 'world.era_change'))
        .orderBy(auditLog.id)
    ).map((e) => e.data as { from: string; to: string });
    expect(chain.map((c) => c.to)).toEqual([
      'ashenSiege',
      'rekindling',
      'forgewardAge',
      'lanternVigil',
    ]);
    for (let n = 1; n < chain.length; n++) expect(chain[n]!.from).toBe(chain[n - 1]!.to);

    // 6. The Pale Marches (8.1): Maren beats the Tyrant in Depths gear, then farms tier 5.
    const marches = await playHollowReachStep(app, database, marcher, now);
    expect(marches.tyrantRuns).toBeGreaterThanOrEqual(1);
    expect(marches.kills).toBeGreaterThan(0);
    await rest(marcher);

    // 7. The Hollow Deep and the Hollow Sovereign (8.2): Dunstan farms the Deep, the Sovereign
    // falls, the hoard is bound and the crown shard becomes Crownforged Work.
    const deep = await playHollowDeepStep(app, database, delver, now, { lit: true });
    expect(deep.era).toBe('lanternVigil');
    expect(deep.crafted).toBe(true);
    await rest(delver);
    const crafted = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.event, 'forge.craft'), eq(auditLog.characterId, delver.characterId)));
    const crown = crafted.map((r) => r.data as { recipeId?: string; gold?: number });
    expect(crown.some((c) => c.recipeId === 'crownforgedWork')).toBe(true);
    // One more Throne run once the hoard's cooldown is over (it is boss-only: every drop is the
    // hoard's), pinned to a seed whose replay drops an item worth a letter.
    clock.set(clock.now() + 21 * HOUR);
    {
      const start = await delver.api('POST', `${delver.base}/dungeon`, {
        dungeonId: 'hollowThrone',
        tier: 1,
      });
      expect(start.statusCode, start.body).toBe(201);
      const [run] = await db
        .select()
        .from(dungeonRuns)
        .where(eq(dungeonRuns.characterId, delver.characterId))
        .orderBy(desc(dungeonRuns.startedAt))
        .limit(1);
      const pack = (await delver.inventory()).inventory.length;
      let secret: string | null = null;
      let endsAt = run!.endsAt.getTime();
      for (let i = 0; i < 3_000 && !secret; i++) {
        const candidate = `phase8-exit:drop:${i}`;
        const r = replayRun({ ...run!, seedSecret: candidate }, pack, null);
        if ([...r.items, ...r.overCapacity].some((x) => isDropWorthSeeing(x))) {
          secret = candidate;
          endsAt = Math.max(endsAt, run!.startedAt.getTime() + r.durationMs);
        }
      }
      expect(secret, 'a Throne seed with a drop worth a letter').not.toBeNull();
      await db.update(dungeonRuns).set({ seedSecret: secret! }).where(eq(dungeonRuns.id, run!.id));
      clock.set(endsAt);
      expect((await delver.api('POST', `${delver.base}/dungeon/settle`)).statusCode).toBe(200);
      const claim = await delver.keyed(`${delver.base}/dungeon/claim`);
      expect(claim.statusCode, claim.body).toBe(200);
    }

    // 8. The guild hall (8.4): Dunstan funds the treasury after the no-refund notice, Maren (the
    // officer) buys and hangs the guild's name colour; a member may not buy; the daily cap trims a
    // big gift; the Short Watch gives and disbands, and its treasury is forfeit.
    const hall = await playGuildHallStep(app, database, delver, {
      guildHandle: wardens,
      companion: marcher,
      invite: town.invite,
      strangerEmail: 'hallguest8@graumark.test',
      baseline: baselines.get(delver.characterId)!,
    });
    expect(hall.colour).toBe('guild-colour.forge-gold');
    await rest(delver);
    const memberBuy = await g1.api(
      'POST',
      '/api/guild/hall/buy',
      { upgradeId: 'guild-colour.grave-green' },
      { 'idempotency-key': randomUUID() },
    );
    expect(memberBuy.statusCode).toBe(403);
    const testerBuy = await tester.api(
      'POST',
      '/api/guild/hall/buy',
      { upgradeId: 'guild-colour.grave-green' },
      { 'idempotency-key': randomUUID() },
    );
    expect(testerBuy.statusCode).toBe(403);
    const big = await g1.keyed('/api/guild/hall/contribute', {
      characterId: g1.characterId,
      offer: [{ resource: 'gold', amount: 30_000 }],
      acknowledgeNoRefund: true,
    });
    expect(big.statusCode, big.body).toBe(200);
    const bigBody = big.json<{
      accepted: { resource: string; amount: number }[];
      limited: Record<string, string>;
    }>();
    expect(bigBody.accepted).toEqual([{ resource: 'gold', amount: 23_800 }]);
    expect(bigBody.limited).toEqual({ gold: 'cap' });
    const watchGift = await g8.keyed('/api/guild/hall/contribute', {
      characterId: g8.characterId,
      offer: [{ resource: 'gold', amount: 1_000 }],
      acknowledgeNoRefund: true,
    });
    expect(watchGift.statusCode, watchGift.body).toBe(200);
    const disband = await g8.api('POST', '/api/guild/disband', { name: 'The Short Watch' });
    expect(disband.statusCode, disband.body).toBe(200);
    expect(await auditCount('guild.treasury_forfeit')).toBe(1);
    expect((await g7.api('GET', `/api/guilds/${shortWatch}/hall`)).statusCode).toBe(404);

    // 9. Duels and trades for the inbox (8.5). Dunstan and Maren are old friends with verified
    // mail (a month of play, seeded); the test account befriends Maren too.
    const marcherPlayer = await playerOf(marcher);
    const delverPlayer = await playerOf(delver);
    const befriend = async (a: Journey, b: Journey) => {
      pause();
      const req = await a.api('POST', '/api/friends/requests', {
        handle: (await playerOf(b)).account.handle,
      });
      expect(req.statusCode, req.body).toBe(200);
      const ok = await b.api(
        'POST',
        `/api/friends/requests/${(await playerOf(a)).account.handle}/accept`,
      );
      expect(ok.statusCode, ok.body).toBe(200);
    };
    await befriend(delver, marcher);
    await befriend(tester, marcher);
    const defence = await marcher.keyed('/api/arena/defence', { characterId: marcher.characterId });
    expect(defence.statusCode, defence.body).toBe(200);
    const defenceId = defence.json<{ defence: { defenceId: string } }>().defence.defenceId;
    for (const j of [delver, tester]) {
      pause();
      const fight = await j.keyed('/api/arena/duels', {
        characterId: j.characterId,
        defenceId,
        kind: 'friendly',
      });
      expect(fight.statusCode, fight.body).toBe(201);
    }
    // A month of play (seeded: the accounts' age).
    for (const j of [delver, marcher]) {
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
      .where(
        and(
          eq(friendships.status, 'friends'),
          inArray(friendships.accountLow, [marcherPlayer.account.id, delverPlayer.account.id]),
          inArray(friendships.accountHigh, [marcherPlayer.account.id, delverPlayer.account.id]),
        ),
      );
    // The owner opens gold trades in the admin panel (production stays closed).
    const tradingView = async () =>
      (await owner.api('GET', '/api/mod/settings/trading')).json<{
        settings: Record<string, unknown>;
        version: number;
      }>();
    const putTrading = async (patch: (s: Record<string, unknown>) => Record<string, unknown>) => {
      const v = await tradingView();
      const res = await owner.api(
        'PUT',
        '/api/admin/settings/trading',
        { expectedVersion: v.version, settings: patch(structuredClone(v.settings)) },
        { 'idempotency-key': randomUUID() },
      );
      expect(res.statusCode, res.body).toBe(200);
    };
    const tradingDefaults = (await tradingView()).settings;
    await putTrading((s) => ({
      ...s,
      trading: true,
      trade: { ...(s.trade as object), gold: true },
    }));
    pause();
    const offer = await delver.keyed('/api/trading/offers', {
      to: marcherPlayer.account.handle,
      characterId: delver.characterId,
      give: { gold: 100 },
    });
    expect(offer.statusCode, offer.body).toBe(201);
    const offerId = offer.json<{ id: string }>().id;
    pause();
    const accepted = await marcher.keyed(`/api/trading/offers/${offerId}/accept`, {
      characterId: marcher.characterId,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    pause();
    const open = await delver.keyed('/api/trading/offers', {
      to: marcherPlayer.account.handle,
      characterId: delver.characterId,
      give: { gold: 50 },
    });
    expect(open.statusCode, open.body).toBe(201);
    // Trading closes again: the open offer is voided and its gold returned.
    await putTrading(() => structuredClone(tradingDefaults));

    // 10. The Lantern Procession, run by the calendar: Wenna joins at its first moment and farms
    // the Fields until a week-1 task is done; weeks 2–4 open on their boundaries.
    for (const j of [marcher, delver, bearer, tester, ...givers]) await rest(j);
    clock.set(S);
    const eventOf = async () => {
      const r = await bearer.api('GET', `${bearer.base}/event`);
      expect(r.statusCode, r.body).toBe(200);
      return r.json<HeroEvent>();
    };
    expect((await eventOf()).current).toMatchObject({ number: procession, week: 1, weeks: 4 });
    expect((await bearer.api('POST', `${bearer.base}/event/join`)).statusCode).toBe(201);
    const farm = await bearer.api('POST', `${bearer.base}/activity`, { areaId: 'abandonedFields' });
    expect(farm.statusCode, farm.body).toBe(201);
    const wick = 1; // "Wick and Frame": 150 Timber, Ashwort, Raw Hide or Iron Ore.
    let mine = await eventOf();
    for (let i = 0; i < 20 && !mine.hero?.quests[wick]?.done; i++) {
      await bearer.settle();
      mine = await eventOf();
    }
    expect(mine.hero?.quests[wick]?.done, 'Wick and Frame done').toBe(true);
    expect(mine.track?.granted).toContainEqual(
      expect.objectContaining({ tier: 1, cosmeticId: 'title-colour.wick-amber' }),
    );
    await rest(bearer);
    const weekOpens = async (week: number, t: number) => {
      const tasks = (q: HeroEvent) => q.hero!.quests.slice((week - 1) * 3, week * 3);
      clock.set(t - 1);
      expect(tasks(await eventOf()).every((q) => !q.open)).toBe(true);
      clock.set(t);
      const e = await eventOf();
      expect(e.current?.week).toBe(week);
      expect(tasks(e).filter((q) => q.open).length).toBeGreaterThanOrEqual(2);
      // Earlier weeks stay open to the end.
      expect(e.hero!.quests.slice(0, 2).every((q) => q.open)).toBe(true);
    };
    await weekOpens(2, S + 7 * DAY);

    // Guild churn, between the weeks: g3 leaves the Wardens on day 20 and joins the Oath (its
    // day-1 gift stays behind); g4 joins the Wardens on day 27 (counted at the archive, no
    // honours: under 14 days).
    clock.set(D0 + 20 * DAY);
    expect((await g3.api('POST', '/api/guild/leave')).statusCode).toBe(200);
    await invite(g5, g3, oath);
    await weekOpens(3, S + 14 * DAY);
    clock.set(D0 + 27 * DAY);
    await invite(delver, g4, wardens);
    await weekOpens(4, S + 21 * DAY);

    // 11. Quality of life (8.5) on Wenna in week 4: several Tavern rewards claimed at once (a retry
    // pays nothing twice), a preset shared as a code and used, the inbox read.
    const qol = await playQualityOfLifeStep(database, bearer);
    expect(qol.claimed).toBeGreaterThan(0);
    await rest(bearer);
    // Malicious codes are refused and change nothing.
    const filterBefore = (await bearer.api('GET', `${bearer.base}/loot-filter`)).json();
    for (const code of [
      'wf1.AAAA.0000',
      'wf9.e30.abcd',
      `wf1.${'A'.repeat(5_000)}.abcd`,
      'wf1.eyJfX3Byb3RvX18iOnt9fQ.abcd',
      '<script>',
    ]) {
      const res = await bearer.api('POST', `${bearer.base}/loot-filter`, { code });
      expect(res.statusCode, code).toBe(400);
    }
    expect((await bearer.api('GET', `${bearer.base}/loot-filter`)).json()).toEqual(filterBefore);

    // 12. The Procession ends on its own (28 days): closed once; the calendar puts the Harvest on
    // the first Monday 00:00 at least the two-day gap later, once. The owner pauses it again.
    const processionEnd = S + 28 * DAY;
    clock.set(processionEnd + 1_000);
    expect((await eventOf()).current).toBeNull();
    clock.set(processionEnd + 10 * MIN);
    const closing = await tick();
    expect(closing.closed).toEqual([procession]);
    expect(closing.created).not.toBeNull();
    expect((await tick()).closed).toEqual([]);
    expect((await tick()).created).toBeNull();
    const rotated = await admin('GET', '/api/admin/events');
    expect(rotated.next).toMatchObject({ definitionId: 'harvestOfBones', source: 'calendar' });
    expect(rotated.next!.startsAt).toBe(
      ceilToMonday(new Date(processionEnd + 2 * DAY)).toISOString(),
    );
    expect(new Date(rotated.next!.startsAt).getUTCDay()).toBe(1);
    expect(
      (await admin('POST', '/api/admin/events/calendar', { paused: true })).calendar.paused,
    ).toBe(true);
    expect(await auditCount('event.close')).toBe(1);
    const tierGrants = await auditCount('event.reward');
    // Each tier once: one audit row per stored grant (Wenna is the one participant; the farming
    // of week 4 may have earned her another tier), each tier at most once.
    const grants = await db
      .select()
      .from(eventTrackGrants)
      .where(eq(eventTrackGrants.event, procession));
    expect(tierGrants).toBe(grants.length);
    expect(new Set(grants.map((g) => `${g.accountId}|${g.tier}`)).size).toBe(grants.length);
    expect(grants.map((g) => g.tier)).toContain(1);

    // 13. The season ends (day 40): archived and awarded once (players' and guilds'), equal to
    // game-core's; the churn rules; the formula versions are the current ones and the sweep
    // recomputes every hero.
    clock.set(seasonEnd + 10 * MIN);
    const jobs = await runSeasonJobs(db, now(), now());
    expect(jobs.archived).toContain(season);
    expect((await runSeasonJobs(db, now(), now())).archived).toEqual([]);
    const testAccountId = (await playerOf(tester)).account.id;
    const standings = await db
      .select()
      .from(seasonStandings)
      .where(eq(seasonStandings.season, season));
    expect(standings.some((s) => s.accountId === testAccountId)).toBe(false);
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
    // The guild roll's final standings: the Wardens and the Oath; the Short Watch (disbanded)
    // never; awards equal to game-core's over the stored standings.
    const guildIds = new Map<string, string>();
    for (const h of [wardens, oath, shortWatch]) {
      const [r] = await queryRows<{ id: string }>(
        db,
        sql`select id from guilds where handle = ${h}`,
      );
      guildIds.set(h, r!.id);
    }
    const final = await db
      .select()
      .from(guildSeasonStandings)
      .where(eq(guildSeasonStandings.season, season));
    expect(final.map((f) => f.guildId).sort()).toEqual(
      [guildIds.get(wardens)!, guildIds.get(oath)!].sort(),
    );
    const guildAwards = await db
      .select()
      .from(guildAwardRows)
      .where(eq(guildAwardRows.season, season));
    const gShape = (x: { guildId: string; rank: number; tier: string }) =>
      `${x.guildId}|${x.rank}|${x.tier}`;
    expect(guildAwards.map(gShape).sort()).toEqual(
      guildSeasonAwards(final.map((f) => ({ guildId: f.guildId, rank: f.rank })))
        .map(gShape)
        .sort(),
    );
    // Who counted and who is honoured (8.4's churn rules), from the archived roster.
    const roster = await db
      .select()
      .from(guildSeasonRosters)
      .where(eq(guildSeasonRosters.season, season));
    const accountOf = async (j: Journey) => (await playerOf(j)).account.id;
    expect(roster.some((r) => r.accountId === testAccountId)).toBe(false);
    const honourIds = new Set(
      (
        await queryRows<{ account_id: string }>(
          db,
          sql`select account_id from cosmetic_unlocks where source = ${'guildSeason:' + season}`,
        )
      ).map((r) => r.account_id),
    );
    const wardensHonoured = [delver, marcher, g1, g2];
    const oathHonoured = [g5, g6, g7];
    // The archived honour roll is exactly these seven (the roster of 8.4).
    const ids = async (js: Journey[]) => (await Promise.all(js.map(accountOf))).sort();
    expect(roster.map((r) => r.accountId).sort()).toEqual(
      await ids([...wardensHonoured, ...oathHonoured]),
    );
    for (const j of [...wardensHonoured, ...oathHonoured]) {
      expect(honourIds.has(await accountOf(j)), (await displayOf(j)) + ' honoured').toBe(true);
    }
    // The late joiner (13 days), the hopper (old gifts stay behind), the test account: none.
    for (const j of [g4, g3, tester, g8]) {
      expect(honourIds.has(await accountOf(j)), (await displayOf(j)) + ' not honoured').toBe(false);
    }
    const wardensTier = guildAwards.find((a) => a.guildId === guildIds.get(wardens))!.tier;
    const cosmeticsOfDunstan = await db
      .select({ id: cosmeticUnlocks.cosmeticId })
      .from(cosmeticUnlocks)
      .where(
        and(
          eq(cosmeticUnlocks.accountId, delverPlayer.account.id),
          eq(cosmeticUnlocks.source, `guildSeason:${season}`),
        ),
      );
    expect(cosmeticsOfDunstan.map((c) => c.id).sort()).toEqual(
      [...guildSeasonCosmeticsEarned(wardensTier as 'champion')].sort(),
    );
    // Exactly once: another run of the jobs grants nothing more.
    const honourCount = async () =>
      (
        await queryRows<{ n: number }>(
          db,
          sql`select count(*)::int as n from cosmetic_unlocks where source = ${'guildSeason:' + season}`,
        )
      )[0]!.n;
    const honoursOnce = await honourCount();
    await runSeasonJobs(db, now(), now());
    expect(await honourCount()).toBe(honoursOnce);
    expect(
      await db.select().from(guildAwardRows).where(eq(guildAwardRows.season, season)),
    ).toHaveLength(guildAwards.length);
    expect((await checkGuildSeasons(db)).wrong).toEqual([]);
    expect(GUILD_SEASON_RULES).toMatchObject({ countAfterDays: 7, honourAfterDays: 14 });

    // The boards: the versions in force are the current ones (Power 3, PvE Progress 6).
    expect(FORMULA_VERSIONS).toMatchObject({ power: 3, pveProgress: 6 });
    expect(await app.formulaVersions.at(now())).toEqual(FORMULA_VERSIONS);
    await sweepLeaderboards(snapshotDeps(app), now(), { batch: 200, cursor: null });
    const players = [marcher, delver, bearer, ...givers];
    for (const j of [marcher, delver, bearer]) {
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
      const board = (await marcher.api('GET', `/api/leaderboards/${metric}?limit=100`)).json<{
        board: { formulaVersion: number; entries: { player: { handle: string } }[] };
      }>().board;
      expect(board.formulaVersion).toBe(FORMULA_VERSIONS[metric as 'level']);
      expect(board.entries.some((e) => e.player.handle === testerHandle)).toBe(false);
    }
    const recompute = await checkLeaderboards(cliDeps(db), 200, now());
    expect(recompute.problems.filter((p) => p.kind === 'wrong')).toEqual([]);

    // 14. The inbox: an entry from every source, each to the right account.
    await sweepTrades(db, now(), activityOptions);
    const inboxOf = async (j: Journey) => {
      const res = await j.api('GET', '/api/inbox?limit=200');
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{ entries: InboxEntry[] }>().entries;
    };
    const kinds = async (j: Journey) => new Set((await inboxOf(j)).map((e) => e.kind));
    const marcherKinds = await kinds(marcher);
    const delverKinds = await kinds(delver);
    for (const k of ['trade.received', 'trade.released', 'trade.voided', 'duel.defence']) {
      expect(marcherKinds.has(k), `Maren: ${k}`).toBe(true);
    }
    for (const k of ['drop', 'trade.accepted', 'trade.voided', 'guild.honours']) {
      expect(delverKinds.has(k), `Dunstan: ${k}`).toBe(true);
    }
    expect((await kinds(bearer)).has('event.reward')).toBe(true);
    for (const j of players) {
      const k = await kinds(j);
      for (const town of ['world.stage', 'world.era', 'release']) expect(k.has(town)).toBe(true);
    }
    const seasonHonoured = new Set(awarded.map((a) => a.accountId));
    for (const j of players) {
      const id = await accountOf(j);
      if (seasonHonoured.has(id)) expect((await kinds(j)).has('season.honours')).toBe(true);
    }
    expect(seasonHonoured.size).toBeGreaterThan(0);
    // Privacy: the test account's duel reached no one (one duel letter, Dunstan's); no entry
    // anywhere names another player's account or hero (the guard below), and only the owner sees
    // their own inbox.
    const duelLetters = (await inboxOf(marcher)).filter((e) => e.kind === 'duel.defence');
    expect(duelLetters).toHaveLength(1);
    const foreignRead = await marcher.api('POST', '/api/inbox/read', {
      ids: (await inboxOf(delver)).slice(0, 3).map((e) => e.id),
    });
    expect(foreignRead.statusCode, foreignRead.body).toBe(200);
    expect(foreignRead.json<{ marked: number }>().marked).toBe(0);
    const testerLetters = await db
      .select()
      .from(accountNotifications)
      .where(eq(accountNotifications.accountId, testAccountId));
    expect(testerLetters.some((e) => e.kind === 'guild.honours')).toBe(false);

    // 15. Everything held and recorded agrees; nothing leaked; one test account.
    for (const j of [marcher, delver, ...givers]) {
      await expectHoldingsMatchAudit(database, j.characterId, baselines.get(j.characterId));
    }
    await expectHoldingsMatchAudit(database, bearer.characterId);
    expect((await reconcileWithAudit(db)).filter((x) => !x.ok)).toEqual([]);
    expect(leaks).toEqual([]);
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
    expect(sum('event.reward')).toBe(tierGrants);
    expect(sum('world.era')).toBe(chain.length);

    const record = JSON.stringify({
      tyrantRuns: marches.tyrantRuns,
      throneRuns: deep.throneRuns,
      wickTallies: mine.track!.tallies,
      batchClaimed: qol.claimed,
      eras: chain.map((c) => c.to),
      seasonAwards: awarded.length,
      guildAwards: guildAwards.map((a) => a.tier),
      checks: report.reconcile!.length,
      watched,
      days: Math.round((clock.now() - D0) / DAY),
    });
    console.info(record);
    if (process.env.E2E_RECORD) appendFileSync(process.env.E2E_RECORD, `${record}\n`);
  }, 900_000);
});
