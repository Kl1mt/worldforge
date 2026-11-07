/**
 * Phase 4 exit criteria, end to end through the HTTP API with a simulated server clock (ticket
 * 4.11, GDD §15 Phase 4): players can take part in social systems safely; shared progress is
 * consistent; permissions, moderation and abuse reporting are in place.
 *
 * Several players on one clock, registered through invite-only registration, play the way players
 * would (`./journey.ts`, no database shortcuts). The only steps outside the API are the owner's
 * documented CLI steps: the first invite (`pnpm admin:invite`), the roles (`pnpm admin:role`) and
 * finishing the Ashen Pass project after the players' gifts (`pnpm admin:project complete`).
 *
 * - The owner opens the town invite-only, makes themselves admin and invites the players.
 * - The hero plays Phase 2 to the Sunken Abbey, reports a mocking name (a moderator forces a
 *   rename), befriends a companion and blocks a pest, shows an achievement on a profile, founds a
 *   guild, runs its chat; a member's taunt is reported, the moderator mutes them (they see why) and
 *   hides the line.
 * - Five players farm on one clock and give daily shares until the Warehouse is restored (no one
 *   gives more than the cap; every stage has several givers); the hero uses the Warehouse.
 * - A guild boss week: attempts, a stage broken, rewards claimed, a leaver keeps theirs, a late
 *   joiner earns nothing for it.
 * - The players give to the Ashen Pass; the owner finishes it; the hero farms the pass and fights
 *   the Warden's Watch.
 * - The admin panel's read paths; nobody else reaches them.
 *
 * Valid means: every hero's gold, items and materials match the audit log; `reconcileWithAudit`
 * and the real `pnpm report:telemetry -- --reconcile` on this run's database match in every check;
 * and no response ever carried another player's email, account id or hero id (checked on every
 * response of the run).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray } from 'drizzle-orm';
import { COMMUNITY_PROJECTS, getDungeonTier, type ClassId } from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { accountAchievements, accounts, communityContributions } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { createPgliteDatabase } from '../test/db.js';
import { reconcileWithAudit, type RollupRow, type TelemetryReport } from '../telemetry/report.js';
import {
  HOUR,
  contributeShare,
  expectHoldingsMatchAudit,
  openInviteOnlyTown,
  playAdminPanelStep,
  playAshenPassStep,
  playChatModerationStep,
  playFriendsStep,
  playGuildBossWeek,
  playGuildChatStep,
  playGuildStep,
  playProfileStep,
  playSafetyStep,
  playWarehouseStep,
  playerOf,
  startJourney,
  townVisit,
} from './journey.js';

const CAP = 3 * HOUR;
/** Safety nets (game hours of the hero): the Phase 2 part (≈ 32 h) and the whole run. */
const PHASE2_HOURS = 90;
const MAX_HOURS = 400;
/** Town visits (2 h each) before the run gives up on the Warehouse and the levels. */
const MAX_TOWN_VISITS = 12 * 21;
const HELPER_LEVEL = 12;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

let dataDir: string;
let database: DatabaseHandle;
let app: FastifyInstance;
// A Monday morning: the guild boss week below falls inside one week of the run.
let nowMs = Date.parse('2026-11-02T06:00:00Z');
const clock = { now: () => nowMs, set: (ms: number) => void (nowMs = ms) };
const now = () => new Date(nowMs);
/**
 * A few minutes between two social steps, as a player takes them: the social writes stay under
 * 4.1's per-account class (12 a minute) at its defaults. Far below the 3 h offline cap.
 */
const pause = () => clock.set(clock.now() + 2 * 60_000);

/** Every account and hero id and email seen; no response may carry another player's. */
const secrets = new Map<string, string>();
const leaks: string[] = [];

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wf-phase4-e2e-'));
  database = await createPgliteDatabase(join(dataDir, 'db'));
  app = buildApp({
    database,
    auth: { now, registrationMode: 'invite' },
    activity: { ...DEFAULT_ACTIVITY_OPTIONS, offlineCapMs: CAP, now },
  });
  // The privacy guard: collect each account's email and id at registration, each hero's id at
  // creation, and fail on any response that carries one belonging to someone else.
  app.addHook('onSend', async (request, reply, payload) => {
    if (typeof payload !== 'string') return payload;
    const self = request.auth?.account.id;
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

describe('Phase 4 exit criteria', () => {
  it('invites → profiles, friends and blocks → a moderated guild → the town restores the Warehouse → a guild boss week → the Ashen Pass → admin panel → audit and telemetry reconcile', async () => {
    // 1. The owner opens the town invite-only and invites the players.
    const town = await openInviteOnlyTown(app, database, now());
    const invited = (email: string, displayName: string, name: string, classId: ClassId) =>
      startJourney({ app, clock, classId, email, displayName, name, inviteCode: town.invite });
    const hero = await invited('hedda@graumark.test', 'Hedda Brightsteel', 'Hedda', 'warrior');
    const companion = await invited('ysolde@graumark.test', 'Ysolde Ash', 'Ysolde', 'mage');
    const recruit = await invited('brannoc@graumark.test', 'Brannoc Vell', 'Brannoc', 'hunter');
    const taunter = await invited('garrick@graumark.test', 'Garrick Thorne', 'Garrick', 'warlock');
    const latecomer = await invited('mira@graumark.test', 'Mira Fenn', 'Mirafenn', 'warrior');
    const helpers = [companion, recruit, taunter, latecomer];

    // 2. The hero plays Phase 2 alone (the others have not started farming yet).
    expect(await hero.playPhase2(PHASE2_HOURS)).toBe(true);
    const phase2Hours = hero.state.farmedHours;

    // 3. Safety, friends, profiles: a report handled by a moderator, a friendship and a block, an
    // achievement on a profile.
    pause();
    const safety = await playSafetyStep(app, database, hero, { invite: town.invite });
    const companionPlayer = await playerOf(companion);
    pause();
    const friends = await playFriendsStep(app, database, hero, {
      invite: town.invite,
      companion: companionPlayer,
    });
    // The companion shows their presence again (the friends step hid it).
    expect(
      (await companion.api('POST', '/api/account/presence', { hidden: false })).statusCode,
    ).toBe(200);
    pause();
    const profile = await playProfileStep(app, database, hero, { invite: town.invite });

    // 4. A guild with chat, a notice and moderation.
    const recruitPlayer = await playerOf(recruit);
    pause();
    const guild = await playGuildStep(app, database, hero, {
      invite: town.invite,
      companion: companionPlayer,
      recruit: recruitPlayer,
    });
    pause();
    await playGuildChatStep(database, hero, guild);
    const taunterPlayer = await playerOf(taunter);
    pause();
    for (const p of [recruitPlayer, taunterPlayer]) {
      expect(
        (await hero.api('POST', '/api/guild/invites', { handle: p.account.handle })).statusCode,
      ).toBe(200);
      expect(
        (await p.api('POST', `/api/guilds/${guild.guildHandle}/invite/accept`)).statusCode,
      ).toBe(200);
    }
    pause();
    const moderation = await playChatModerationStep(database, {
      leader: await playerOf(hero),
      officer: companionPlayer,
      offender: taunterPlayer,
      moderator: safety.warden,
    });

    // 5. The town restores the Warehouse: five players on one clock, a daily share each.
    for (const h of helpers) await h.farmBestArea();
    const town5 = [hero, ...helpers];
    const given: { who: number; projectId: string; stageId: string; day: string; gold: number }[] =
      [];
    const projectDone = async (id: string) =>
      (await hero.api('GET', '/api/community/projects'))
        .json<{ projects: { id: string; status: string }[] }>()
        .projects.find((p) => p.id === id)!.status === 'complete';
    let visits = 0;
    let warehouseOpen = false;
    while (visits < MAX_TOWN_VISITS) {
      await townVisit(clock, town5);
      visits++;
      for (const [who, h] of town5.entries()) {
        // The hero keeps enough gold for the Warehouse extension it buys later.
        const out = await contributeShare(h, who === 0 ? 2_000 : 0);
        if (out) {
          given.push({
            who,
            projectId: out.projectId,
            stageId: out.stageId,
            day: now().toISOString().slice(0, 10),
            gold: out.accepted.find((a) => a.resource === 'gold')?.amount ?? 0,
          });
        }
      }
      warehouseOpen ||= await projectDone('restoreWarehouse');
      const ready =
        warehouseOpen &&
        hero.state.level >= 24 &&
        helpers.every((h) => h.state.level >= HELPER_LEVEL) &&
        given.some((g) => g.projectId === 'clearAshenPass');
      if (ready) break;
    }
    expect(warehouseOpen, `Warehouse after ${visits} visits`).toBe(true);
    const warehouseDays = new Set(
      given.filter((g) => g.projectId === 'restoreWarehouse').map((g) => g.day),
    ).size;
    // No monopoly: every stage had several givers, and nobody gave more than the cap on any day.
    const warehouse = COMMUNITY_PROJECTS.find((p) => p.id === 'restoreWarehouse')!;
    for (const stage of warehouse.stages) {
      const givers = new Set(given.filter((g) => g.stageId === stage.id).map((g) => g.who));
      expect(givers.size, stage.id).toBeGreaterThanOrEqual(3);
    }
    const rows = await database.db.select().from(communityContributions);
    for (const r of rows) {
      const stage = COMMUNITY_PROJECTS.flatMap((p) => p.stages).find((s) => s.id === r.stageId)!;
      const need = stage.needs.find((n) => n.resource === r.resource)!;
      // The cap starts at a fifth of a need and never passes three fifths (B.3).
      expect(r.amount, `${r.stageId} ${r.day} ${r.resource}`).toBeLessThanOrEqual(
        Math.ceil(need.amount * 0.6),
      );
    }
    // Every contributor wears the Warehouse's mark.
    const contributorIds = [
      ...new Set(rows.filter((r) => r.projectId === 'restoreWarehouse').map((r) => r.accountId)),
    ];
    const marks = await database.db
      .select()
      .from(accountAchievements)
      .where(
        and(
          inArray(accountAchievements.accountId, contributorIds),
          eq(accountAchievements.achievementId, 'warehouseRestorer'),
        ),
      );
    expect(marks).toHaveLength(contributorIds.length);
    expect(contributorIds.length).toBeGreaterThanOrEqual(3);

    // 6. A guild boss week (the helpers are in the guild: the companion officer, the recruit and
    // the taunter members; the latecomer joins after the stage).
    const boss = await playGuildBossWeek(database, {
      leader: hero,
      officer: companion,
      member: recruit,
      idle: taunterPlayer,
      late: latecomer,
    });

    // The helpers are done for the day; from here on only the hero farms.
    for (const h of helpers) {
      expect((await h.api('POST', `${h.base}/activity/stop`)).statusCode).toBe(200);
    }

    // 7. The hero uses the Warehouse the town restored.
    const stored = await playWarehouseStep(app, database, hero, now, 'town');

    // 8. The Ashen Pass: the players' gifts, then the owner finishes the project (CLI); the hero
    // farms the pass and climbs the Warden's Watch.
    const passGivers = new Set(
      given.filter((g) => g.projectId === 'clearAshenPass').map((g) => g.who),
    );
    expect(passGivers.size).toBeGreaterThanOrEqual(1);
    const watchLevel = getDungeonTier('ashenWatch', 1).unlock.level;
    await hero.farmBestArea();
    while (hero.state.level < watchLevel && hero.state.farmedHours < MAX_HOURS) {
      await hero.settle();
      await hero.equipBetterDrops();
      await hero.sellJunk(await hero.inventory());
      await hero.farmBestArea();
    }
    const pass = await playAshenPassStep(app, database, hero, now());
    expect(pass.watch).toHaveLength(1);

    // 9. The admin panel's read paths.
    // Everyone but the owner registered with the players' invite.
    const registered = (await database.db.select({ handle: accounts.handle }).from(accounts))
      .map((a) => a.handle)
      .filter((h) => h !== town.admin.account.handle);
    expect(registered).toHaveLength(10);
    const admin = await playAdminPanelStep(app, database, {
      admin: town.admin,
      others: [safety.warden, companionPlayer, friends.pestPlayer],
      inviteId: town.inviteId,
      registered,
      subject: taunterPlayer,
    });

    // 10. Everything held and recorded agrees.
    for (const h of town5) await expectHoldingsMatchAudit(database, h.characterId);
    expect((await reconcileWithAudit(database.db)).filter((c) => !c.ok)).toEqual([]);
    expect(leaks).toEqual([]);
    expect(secrets.size).toBeGreaterThan(20);

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
    expect(report.reconcile!.filter((c) => !c.ok)).toEqual([]);
    const sum = (
      metric: string,
      match: (d: RollupRow['dims']) => boolean,
      field: 'events' | 'amount' = 'events',
    ) =>
      report.rollups
        .filter((r) => r.metric === metric && match(r.dims))
        .reduce((s, r) => s + r[field], 0);
    expect(sum('community.contribute', () => true)).toBe(given.length);
    expect(sum('community.stage', (d) => d[0] === 'restoreWarehouse')).toBe(
      warehouse.stages.length,
    );
    expect(sum('guild_boss.attempt', () => true)).toBe(boss.attempts);
    expect(sum('guild_boss.attempt', () => true, 'amount')).toBe(boss.counted);
    expect(sum('guild_boss.stage', () => true)).toBe(boss.stages);
    expect(sum('crypt.claim', (d) => d[0] === 'ashenWatch:1')).toBe(1);

    const record = JSON.stringify({
      phase2Hours,
      heroHours: hero.state.farmedHours,
      heroLevel: hero.state.level,
      helperLevels: helpers.map((h) => h.state.level),
      townVisits: visits,
      warehouseDays,
      contributions: given.length,
      boss: { stages: boss.stages, counted: boss.counted, attempts: boss.attempts },
      watch: pass.watch,
      stored: stored.stored,
      profile: profile.achievements,
      moderation: !!moderation.messageId,
      adminChecks: admin.checks,
    });
    console.info(record);
    if (process.env.E2E_RECORD) appendFileSync(process.env.E2E_RECORD, `${record}\n`);
  }, 600_000);
});
