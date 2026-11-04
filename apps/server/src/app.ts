import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { getGameContent } from '@worldforge/game-core';
import { registerErrorHandling } from './errors.js';
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
}

export function buildApp({ database, ...options }: AppOptions): FastifyInstance {
  const app = Fastify(options);
  app.decorate('db', database.db);
  registerErrorHandling(app);

  void app.register(
    async (api) => {
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
