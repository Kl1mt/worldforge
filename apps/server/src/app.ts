import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { getGameContent } from '@worldforge/game-core';
import { registerErrorHandling } from './errors.js';
import { DEFAULT_AUTH_OPTIONS, registerAuth, type AuthOptions } from './auth/index.js';
import { registerCharacters } from './characters/routes.js';
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
import { registerLegal, type LegalOptions } from './legal/routes.js';
import { registerAdmin, type AdminOptions } from './admin/routes.js';
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
}

export function buildApp({
  database,
  auth,
  activity,
  legal,
  admin,
  testRoutes,
  ...options
}: AppOptions): FastifyInstance {
  const app = Fastify({
    // API_CONVENTIONS: unknown body properties are rejected, not silently stripped (Fastify's
    // default is `removeAdditional: true`).
    ajv: { customOptions: { removeAdditional: false } },
    ...options,
  });
  app.decorate('db', database.db);
  registerErrorHandling(app);
  const activityOptions: ActivityOptions = { ...DEFAULT_ACTIVITY_OPTIONS, ...activity };
  registerSettlementScheduler(app, activityOptions);

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
      await registerFriends(api);
      await registerGuilds(api, activityOptions);
      await registerGuildChat(api);
      await registerLegal(api, legal ?? {});
      await registerAdmin(api, admin ?? {});
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

/**
 * Periodically settles activities the client has not settled for one interval, so rewards and the
 * world stay current while players are away. Each run settles at most one batch; overlapping runs
 * are skipped. Also prunes expired idempotency keys (ticket 2.6).
 */
function registerSettlementScheduler(app: FastifyInstance, options: ActivityOptions): void {
  const intervalMs = options.settleIntervalMs;
  if (intervalMs <= 0) return;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let lastPrune = 0;
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
        })
        .catch((err: unknown) => app.log.error({ err }, 'idempotency key pruning failed'))
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
