import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { GAME_VERSION, getGameContent } from '@worldforge/game-core';
import { registerErrorHandling } from './errors.js';
import {
  DEFAULT_AUTH_OPTIONS,
  pruneAuthRows,
  registerAuth,
  type AuthOptions,
} from './auth/index.js';
import { registerCharacters } from './characters/routes.js';
import { registerScores } from './scores/routes.js';
import { registerActivities } from './activity/routes.js';
import {
  DEFAULT_ACTIVITY_OPTIONS,
  settleDueActivities,
  type ActivityOptions,
} from './activity/settle.js';
import { registerInventory } from './inventory/routes.js';
import { registerWorld } from './world/routes.js';
import { registerMaterials } from './materials/routes.js';
import { registerDungeons } from './dungeon/routes.js';
import { registerMerchant } from './merchant/routes.js';
import { registerForge } from './forge/routes.js';
import { pruneIdempotencyKeys } from './idempotency/index.js';
import { registerQuests } from './quests/routes.js';
import { registerLootFilter } from './loot-filter/routes.js';
import { registerInbox } from './inbox/routes.js';
import { pruneInboxes } from './inbox/notify.js';
import { registerSafety } from './social/routes.js';
import { registerProfiles } from './social/profiles.js';
import { registerModeration } from './social/moderation.js';
import { registerFriends } from './social/friends.js';
import { registerGuilds } from './social/guilds.js';
import { registerGuildChat } from './social/guild-chat.js';
import { registerGuildBoss } from './guild-boss/routes.js';
import { registerGuildHalls } from './guild-halls/routes.js';
import { registerGuildSeasons } from './guild-seasons/routes.js';
import { registerLegal, type LegalOptions } from './legal/routes.js';
import { registerAdmin, type AdminOptions } from './admin/routes.js';
import { SchedulerState, type SchedulerJob } from './admin/scheduler-state.js';
import { registerCommunity } from './community/routes.js';
import { registerWarehouse } from './warehouse/routes.js';
import { registerShelf } from './shelf/routes.js';
import { registerTrading } from './trading/routes.js';
import { registerTradeOffers } from './trading/offer-routes.js';
import { registerTradeModeration } from './trading/mod-routes.js';
import { sweepTrades } from './trading/offers.js';
import {
  registerLeaderboardRefresh,
  registerLeaderboards,
  snapshotDeps,
} from './leaderboards/routes.js';
import { FormulaVersionSource } from './leaderboards/formulas.js';
import { sweepLeaderboards } from './leaderboards/snapshot.js';
import { registerSeasons } from './seasons/routes.js';
import { registerArena } from './arena/routes.js';
import { runSeasonJobs } from './seasons/model.js';
import { runEventJobs } from './events/model.js';
import { registerEvents } from './events/routes.js';
import { registerCosmetics } from './cosmetics/routes.js';
import { WorldStateCache } from './community/world-state.js';
import { GameSettingsCache, SettingsEvents } from './settings/store.js';
import { SanctionEvents } from './social/sanctions.js';
import { RelationEvents } from './social/relations.js';
import { registerSettingsRead } from './settings/routes.js';
import type { Database, DatabaseHandle } from './db/types.js';
import {
  createMemoryLimitStore,
  createPostgresLimitStore,
  type LimitStore,
} from './shared/limit-store.js';
import { CacheSync } from './shared/cache-sync.js';
import { SchedulerLeader, type LeaderJob } from './shared/leader.js';
import { DEFAULT_LOGIN_THROTTLE } from './auth/login-throttle.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Drizzle database. Route handlers use this (or a transaction from `withTransaction`). */
    db: Database;
    /** Ticket D.4: what the scheduler last did (the admin panel's World tab). */
    schedulerState: SchedulerState;
    /** Ticket 6.9: where every rate limiter keeps its counts (shared across instances). */
    limitStore: LimitStore;
    /** Ticket 6.9: drops this instance's caches when another instance changed them. */
    cacheSync: CacheSync;
    /** Ticket 6.9: which scheduled jobs this instance runs (advisory-lock leader election). */
    schedulerLeader: SchedulerLeader;
  }
}

/** Ticket 6.9: `postgres` (shared across API instances) or `memory` (one instance only). */
export type SharedStateMode = 'postgres' | 'memory';

export interface SharedStateOptions {
  /**
   * Where the rate limiters count. `postgres` in production (`SHARED_STATE`, default `postgres`,
   * `src/index.ts`); `buildApp`'s own default is `memory`, so the many apps a test file builds on
   * one database keep their own counts (tests of the shared store pass `postgres`).
   */
  limits?: SharedStateMode;
  /** How often the cache versions are compared (the missed-notify fallback). Default 15 s. */
  cachePollMs?: number;
  /** Tests: never listen for cache notifies (the version fallback only). */
  cacheListen?: boolean;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  uptimeSeconds: number;
  db: 'up' | 'down';
  /** Ticket F.3: the game version of this build (game-core's patch notes). */
  version: string;
}

export interface AppOptions extends FastifyServerOptions {
  /** Database connection. The caller owns its lifecycle (the app does not close it). */
  database: DatabaseHandle;
  /** Session and rate-limit settings; defaults in `DEFAULT_AUTH_OPTIONS`. */
  auth?: Partial<AuthOptions>;
  /** Farming settlement settings; defaults in `DEFAULT_ACTIVITY_OPTIONS` (scheduler off). */
  activity?: Partial<ActivityOptions>;
  /** Legal pages (ticket D.2): the owner's directory; default templates only. */
  legal?: LegalOptions;
  /** Admin panel (ticket D.3): build info for the server status, the reconcile limit. */
  admin?: AdminOptions;
  /**
   * Tests only: extra routes registered inside the `/api` scope after the game routes, so they see
   * its decorators (`requireAccount`, `socialWriteLimit`, …). Used to test shared helpers before a
   * real route uses them.
   */
  testRoutes?: (api: FastifyInstance) => Promise<void> | void;
  /** Ticket 4.6: how long the cached world state is served (default 60 s, docs/COMMUNITY.md). */
  worldStateTtlMs?: number;
  /** Ticket T.2: how long the cached game settings are served (default 60 s), and its clock. */
  settings?: { ttlMs?: number; clock?: () => number };
  /** Ticket 5.2: the board read limit per account (default `DEFAULT_BOARD_READ_LIMIT`). */
  leaderboards?: { readLimit?: { max: number; windowMs: number } };
  /** Ticket 6.9: shared state across API instances (docs/DEPLOY.md "Running two API instances"). */
  shared?: SharedStateOptions;
}

export function buildApp({
  database,
  auth,
  activity,
  legal,
  admin,
  testRoutes,
  worldStateTtlMs,
  settings,
  leaderboards,
  shared,
  ...options
}: AppOptions): FastifyInstance {
  const app = Fastify({
    // API_CONVENTIONS: unknown body properties are rejected, not silently stripped (Fastify's
    // default is `removeAdditional: true`).
    ajv: { customOptions: { removeAdditional: false } },
    ...options,
  });
  app.decorate('db', database.db);
  app.decorate('worldState', new WorldStateCache(database.db, worldStateTtlMs));
  // Ticket 6.1: board formula versions in force (a newer one waits for the season's end).
  app.decorate('formulaVersions', new FormulaVersionSource(database.db, worldStateTtlMs));
  app.decorate(
    'gameSettings',
    new GameSettingsCache(database.db, settings?.ttlMs, settings?.clock),
  );
  app.decorate('settingsEvents', new SettingsEvents());
  app.decorate('sanctionEvents', new SanctionEvents());
  app.decorate('relationEvents', new RelationEvents());
  app.decorate('schedulerState', new SchedulerState());
  // Ticket 6.9: the shared limit store, cache sync and scheduler leader.
  app.decorate(
    'limitStore',
    (shared?.limits ?? 'memory') === 'postgres'
      ? createPostgresLimitStore(database.db)
      : createMemoryLimitStore(),
  );
  app.decorate(
    'cacheSync',
    new CacheSync(
      database.db,
      database,
      {
        world: () => app.worldState.invalidate(),
        settings: () => app.gameSettings.invalidate(),
        formulas: () => app.formulaVersions.invalidate(),
      },
      {
        ...(shared?.cachePollMs !== undefined ? { pollMs: shared.cachePollMs } : {}),
        ...(shared?.cacheListen !== undefined ? { listen: shared.cacheListen } : {}),
        log: app.log,
      },
    ),
  );
  app.decorate('schedulerLeader', new SchedulerLeader(database, app.log));
  app.addHook('onReady', async () => {
    await app.cacheSync.start();
  });
  app.addHook('onClose', async () => {
    await app.cacheSync.stop();
    await app.schedulerLeader.close();
  });
  registerErrorHandling(app);
  const activityOptions: ActivityOptions = { ...DEFAULT_ACTIVITY_OPTIONS, ...activity };
  const authNow = auth?.now ?? DEFAULT_AUTH_OPTIONS.now;
  registerSettlementScheduler(app, activityOptions, authNow);
  registerLeaderboardRefresh(app, activityOptions.now);

  void app.register(
    async (api) => {
      await registerAuth(api, { ...DEFAULT_AUTH_OPTIONS, ...auth });
      await registerCharacters(api);
      await registerActivities(api, activityOptions);
      await registerInventory(api, activityOptions);
      await registerWorld(api, activityOptions.now);
      await registerMaterials(api);
      await registerDungeons(api, activityOptions);
      await registerMerchant(api, activityOptions);
      await registerForge(api, activityOptions);
      await registerQuests(api, activityOptions);
      await registerLootFilter(api, activityOptions);
      await registerInbox(api, activityOptions.now);
      await registerSafety(api);
      await registerProfiles(api);
      await registerModeration(api);
      await registerSettingsRead(api);
      await registerFriends(api);
      await registerGuilds(api, activityOptions);
      await registerGuildChat(api);
      await registerGuildBoss(api, activityOptions);
      // Ticket 8.4: guild halls and the guild season roll.
      await registerGuildHalls(api, activityOptions);
      await registerCommunity(api, activityOptions);
      await registerWarehouse(api, activityOptions);
      await registerShelf(api, activityOptions);
      await registerTrading(api);
      await registerTradeOffers(api, activityOptions);
      await registerTradeModeration(api, activityOptions);
      await registerLegal(api, legal ?? {});
      await registerAdmin(api, {
        gameNow: activityOptions.now,
        activity: activityOptions,
        // Ticket 8.6: the Readiness tab reads these (never a secret value).
        mailer: auth?.mailer ?? DEFAULT_AUTH_OPTIONS.mailer,
        legalDir: legal?.dir,
        sharedState: shared?.limits ?? 'memory',
        ...admin,
      });
      await registerScores(api, activityOptions.now);
      await registerLeaderboards(api, { now: activityOptions.now, ...leaderboards });
      await registerSeasons(api, { now: activityOptions.now });
      await registerGuildSeasons(api, activityOptions, { readLimit: leaderboards?.readLimit });
      await registerEvents(api, activityOptions);
      await registerCosmetics(api, { now: activityOptions.now });
      await registerArena(api, activityOptions);
      if (testRoutes) await testRoutes(api);

      api.get('/health', async (request, reply): Promise<HealthResponse> => {
        let db: HealthResponse['db'] = 'up';
        try {
          await database.ping();
        } catch (err) {
          request.log.warn({ err }, 'database health check failed');
          db = 'down';
        }
        // 503 lets load balancers and uptime checks take an instance without a DB out of rotation.
        if (db === 'down') void reply.code(503);
        return {
          status: db === 'up' ? 'ok' : 'degraded',
          uptimeSeconds: Math.round(process.uptime()),
          db,
          version: GAME_VERSION,
        };
      });

      // Static, server-owned content definitions. Clients render from these but never submit them.
      api.get('/content', async () => getGameContent());
    },
    { prefix: '/api' },
  );

  return app;
}

const PRUNE_EVERY_MS = 60 * 60 * 1000;
/** Heroes the leaderboard sweep refreshes per scheduler run (ticket 5.2). */
const LEADERBOARD_SWEEP_BATCH = 200;

/**
 * Periodically settles activities the client has not settled for one interval, so rewards and the
 * world stay current while players are away. Each run settles at most one batch; overlapping runs
 * are skipped. Ticket 6.9: every job runs only on the instance that leads it (`SchedulerLeader`). Also prunes expired idempotency keys (ticket 2.6), sessions and mail tokens
 * (ticket 5.7) and sweeps the leaderboard
 * snapshots (ticket 5.2).
 */
function registerSettlementScheduler(
  app: FastifyInstance,
  options: ActivityOptions,
  authNow: () => Date,
): void {
  const intervalMs = options.settleIntervalMs;
  if (intervalMs <= 0) return;
  const state = app.schedulerState;
  state.intervalMs = intervalMs;
  const done = (job: SchedulerJob, ok: boolean, detail: string | null = null) =>
    state.record(job, options.now(), ok, detail);
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let lastPrune = 0;
  let sweepCursor: string | null = null;
  const leader = app.schedulerLeader;
  /**
   * Ticket 6.9: runs one job if this instance leads it (one advisory lock per job); a standby
   * records that another instance runs it.
   */
  const step = async (job: SchedulerJob & LeaderJob, fn: () => Promise<string | null>) => {
    try {
      if (!(await leader.lead(job))) {
        done(job, true, 'standby: another instance runs it');
        return;
      }
      const detail = await fn();
      if (detail !== null) done(job, true, detail);
    } catch (err) {
      done(job, false);
      app.log.error({ err, job }, 'scheduled job failed');
    }
  };
  const tick = async () => {
    state.tick(options.now());
    await step('settlement', async () => {
      const n = await settleDueActivities(app.db, options, { olderThanMs: intervalMs });
      if (n > 0) app.log.info({ settled: n }, 'scheduled settlement');
      return `settled ${n}`;
    });
    // Expired idempotency keys (ticket 2.6): at most once an hour.
    const now = options.now();
    if (now.getTime() - lastPrune >= PRUNE_EVERY_MS) {
      lastPrune = now.getTime();
      await step('pruning', async () => {
        const n = await pruneIdempotencyKeys(app.db, now);
        if (n > 0) app.log.info({ pruned: n }, 'pruned idempotency keys');
        // Ticket 5.7: expired and long-revoked sessions, expired mail tokens (real clock).
        const auth = await pruneAuthRows(app.db, authNow());
        if (auth.sessions > 0 || auth.tokens > 0) app.log.info(auth, 'pruned sessions and tokens');
        // Ticket 6.9: limiter windows that are over and idle login entries (auth clock).
        const limits = await app.limitStore.prune(
          authNow().getTime(),
          DEFAULT_LOGIN_THROTTLE.resetAfterMs,
        );
        // Ticket 8.5: inbox entries past their age or the per-account cap (game clock).
        const inbox = await pruneInboxes(app.db, now);
        return `keys ${n}, sessions ${auth.sessions}, tokens ${auth.tokens}, limits ${limits}, inbox ${inbox}`;
      });
    }
    await step('leaderboardSweep', async () => {
      // Ticket 5.2: the leaderboard sweep (backfill, then a rotation over every hero).
      const out = await sweepLeaderboards(snapshotDeps(app), options.now(), {
        batch: LEADERBOARD_SWEEP_BATCH,
        cursor: sweepCursor,
      });
      sweepCursor = out.cursor;
      if (out.updated > 0) app.log.info({ updated: out.updated }, 'leaderboard sweep');
      return `refreshed ${out.refreshed}, updated ${out.updated}`;
    });
    await step('seasonJobs', async () => {
      // Ticket 5.3: the next season, then every ended season's archive and awards.
      const out = await runSeasonJobs(app.db, options.now(), authNow());
      if (out.created !== null || out.archived.length > 0 || out.awarded.length > 0)
        app.log.info(out, 'season jobs');
      return `archived ${out.archived.length}, awarded ${out.awarded.length}`;
    });
    await step('eventJobs', async () => {
      // Ticket 6.6: close every ended event and sweep its reward track. Ticket 8.3: then the
      // automatic calendar puts the next event on the calendar (on this leader only).
      const out = await runEventJobs(app.db, options.now());
      if (out.closed.length > 0 || out.swept.length > 0 || out.created !== null)
        app.log.info(out, 'event jobs');
      return `closed ${out.closed.length}, swept ${out.swept.length}, created ${out.created ?? 'none'}`;
    });
    await step('tradeSweep', async () => {
      // Ticket T.5: offers past their 48 hours expire, holds past their 72 hours release.
      const out = await sweepTrades(app.db, authNow(), options);
      if (out.expired > 0 || out.released > 0) app.log.info(out, 'trade sweep');
      return `expired ${out.expired}, released ${out.released}`;
    });
  };
  app.addHook('onReady', async () => {
    timer = setInterval(() => {
      if (running) return;
      running = true;
      tick().finally(() => {
        running = false;
      });
    }, intervalMs);
    timer.unref();
  });
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
  });
}
