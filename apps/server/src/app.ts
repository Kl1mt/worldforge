import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { getGameContent } from '@worldforge/game-core';
import { registerErrorHandling } from './errors.js';

export interface HealthResponse {
  status: 'ok';
  uptimeSeconds: number;
}

export function buildApp(options: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify(options);
  registerErrorHandling(app);

  void app.register(
    async (api) => {
      api.get('/health', async (): Promise<HealthResponse> => ({
        status: 'ok',
        uptimeSeconds: Math.round(process.uptime()),
      }));

      // Static, server-owned content definitions. Clients render from these but never submit them.
      api.get('/content', async () => getGameContent());
    },
    { prefix: '/api' },
  );

  return app;
}
