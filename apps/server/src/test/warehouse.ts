import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { worldFlags } from '../db/schema.js';
import type { Database } from '../db/types.js';
import { SESSION_COOKIE } from '../auth/index.js';

/** Test helpers for the warehouse (ticket 4.7). */

/** Sets the `warehouseRestored` world flag directly (the project path is tested separately). */
export async function openWarehouse(app: FastifyInstance, db: Database, now = new Date()) {
  await db
    .insert(worldFlags)
    .values({ flagId: 'warehouseRestored', projectId: 'restoreWarehouse', setAt: now })
    .onConflictDoNothing();
  app.worldState.invalidate();
}

export function warehouseCalls(app: FastifyInstance) {
  const as = (token: string) => ({ [SESSION_COOKIE]: token });
  return {
    get: (token: string, characterId: string) =>
      app.inject({
        method: 'GET',
        url: `/api/characters/${characterId}/warehouse`,
        cookies: as(token),
      }),
    move: (
      token: string,
      characterId: string,
      direction: 'deposit' | 'withdraw',
      itemIds: string[],
    ) =>
      app.inject({
        method: 'POST',
        url: `/api/characters/${characterId}/warehouse/${direction}`,
        payload: { itemIds },
        cookies: as(token),
      }),
    upgrade: (token: string, characterId: string, level: number, key: string = randomUUID()) =>
      app.inject({
        method: 'POST',
        url: `/api/characters/${characterId}/warehouse/upgrade`,
        payload: { level },
        headers: { 'idempotency-key': key },
        cookies: as(token),
      }),
  };
}
