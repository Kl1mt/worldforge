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
import { registerSafety } from './social/routes.js';
import { registerProfiles } from './social/profiles.js';
import { registerModeration } from './social/moderation.js';
import { registerFriends } from './social/friends.js';
import { registerGuilds } from './social/guilds.js';
import { registerGuildChat } from './social/guild-chat.js';
import { registerGuildBoss } from './guild-boss/routes.js';
import { registerLegal, type LegalOptions } from './legal/routes.js';
import { registerAdmin, type AdminOptions } from './admin/routes.js';
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
import { WorldStateCache } from './community/world-state.js';
import { GameSettingsCache, SettingsEvents } from './settings/store.js';
import { SanctionEvents } from './social/sanctions.js';
import { RelationEvents } from './social/relations.js';
import { registerSettingsRead } from './settings/routes.js';
import type { Database, DatabaseHandle } from './db/types.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Drizzle database. Route handlers use this (or a transaction from `withTransaction`). */
    db: Database;
  }
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
      await registerWorld(api);
      await registerMaterials(api);
      await registerDungeons(api, activityOptions);
      await registerMerchant(api, activityOptions);
      await registerForge(api, activityOptions);
      await registerQuests(api, activityOptions);
      await registerLootFilter(api, activityOptions);
      await registerSafety(api);
      await registerProfiles(api);
      await registerModeration(api);
      await registerSettingsRead(api);
      await registerFriends(api);
      await registerGuilds(api, activityOptions);
      await registerGuildChat(api);
      await registerGuildBoss(api, activityOptions);
      await registerCommunity(api, activityOptions);
      await registerWarehouse(api, activityOptions);
      await registerShelf(api, activityOptions);
      await registerTrading(api);
      await registerTradeOffers(api, activityOptions);
      await registerTradeModeration(api, activityOptions);
      await registerLegal(api, legal ?? {});
      await registerAdmin(api, { gameNow: activityOptions.now, ...admin });
      await registerScores(api, activityOptions.now);
      await registerLeaderboards(api, { now: activityOptions.now, ...leaderboards });
      await registerSeasons(api, { now: activityOptions.now });
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
 * are skipped. Also prunes expired idempotency keys (ticket 2.6), sessions and mail tokens
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
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let lastPrune = 0;
  let sweepCursor: string | null = null;
  app.addHook('onReady', async () => {
    timer = setInterval(() => {
      if (running) return;
      running = true;
      settleDueActivities(app.db, options, { olderThanMs: intervalMs })
        .then((n) => {
          if (n > 0) app.log.info({ settled: n }, 'scheduled settlement');
        })
        .catch((err: unknown) => app.log.error({ err }, 'scheduled settlement failed'))
        .then(async () => {
          // Expired idempotency keys (ticket 2.6): at most once an hour.
          const now = options.now();
          if (now.getTime() - lastPrune < PRUNE_EVERY_MS) return;
          lastPrune = now.getTime();
          const n = await pruneIdempotencyKeys(app.db, now);
          if (n > 0) app.log.info({ pruned: n }, 'pruned idempotency keys');
          // Ticket 5.7: expired and long-revoked sessions, expired mail tokens (real clock).
          const auth = await pruneAuthRows(app.db, authNow());
          if (auth.sessions > 0 || auth.tokens > 0)
            app.log.info(auth, 'pruned sessions and tokens');
        })
        .catch((err: unknown) => app.log.error({ err }, 'idempotency and session pruning failed'))
        .then(async () => {
          // Ticket 5.2: the leaderboard sweep (backfill, then a rotation over every hero).
          const out = await sweepLeaderboards(snapshotDeps(app), options.now(), {
            batch: LEADERBOARD_SWEEP_BATCH,
            cursor: sweepCursor,
          });
          sweepCursor = out.cursor;
          if (out.updated > 0) app.log.info({ updated: out.updated }, 'leaderboard sweep');
        })
        .catch((err: unknown) => app.log.error({ err }, 'leaderboard sweep failed'))
        .then(async () => {
          // Ticket 5.3: the next season, then every ended season's archive and awards.
          const out = await runSeasonJobs(app.db, options.now(), authNow());
          if (out.created !== null || out.archived.length > 0 || out.awarded.length > 0)
            app.log.info(out, 'season jobs');
        })
        .catch((err: unknown) => app.log.error({ err }, 'season jobs failed'))
        .then(async () => {
          // Ticket T.5: offers past their 48 hours expire, holds past their 72 hours release.
          const out = await sweepTrades(app.db, authNow(), options);
          if (out.expired > 0 || out.released > 0) app.log.info(out, 'trade sweep');
        })
        .catch((err: unknown) => app.log.error({ err }, 'trade sweep failed'))
        .finally(() => {
          running = false;
        });
    }, intervalMs);
    timer.unref();
  });
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
  });
}
