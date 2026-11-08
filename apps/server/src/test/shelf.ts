import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_TRADING_SETTINGS,
  type MaterialId,
  type TradeKind,
  type TradingSettings,
} from '@worldforge/game-core';
import { gameSettings } from '../db/schema.js';
import type { Database } from '../db/types.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { TRADING_SETTINGS_KEY } from '../settings/store.js';

/** Test helpers for the account shelf (ticket T.3). */

/**
 * Stores the "Shelf: …" switches directly (the admin route is tested in T.2) and drops the cache.
 * Everything else stays at the defaults.
 */
export async function setShelfSwitches(
  app: FastifyInstance,
  db: Database,
  shelf: Partial<Record<TradeKind, boolean>>,
) {
  const value: TradingSettings = {
    ...structuredClone(DEFAULT_TRADING_SETTINGS),
    shelf: { ...DEFAULT_TRADING_SETTINGS.shelf, ...shelf },
  };
  const stored = value as unknown as Record<string, unknown>;
  await db
    .insert(gameSettings)
    .values({ key: TRADING_SETTINGS_KEY, value: stored, version: 1, updatedAt: new Date() })
    .onConflictDoUpdate({ target: gameSettings.key, set: { value: stored } });
  app.gameSettings.invalidate();
}

export const ALL_SHELF_ON = { items: true, materials: true, gold: true } as const;
export const ALL_SHELF_OFF = { items: false, materials: false, gold: false } as const;

export interface ShelfBody {
  itemIds?: readonly string[];
  gold?: number;
  materials?: Partial<Record<MaterialId, number>>;
}

export function shelfCalls(app: FastifyInstance) {
  const as = (token: string) => ({ [SESSION_COOKIE]: token });
  return {
    get: (token: string, characterId: string) =>
      app.inject({
        method: 'GET',
        url: `/api/characters/${characterId}/shelf`,
        cookies: as(token),
      }),
    move: (
      token: string,
      characterId: string,
      direction: 'deposit' | 'withdraw',
      body: ShelfBody,
      key: string | null = randomUUID(),
    ) =>
      app.inject({
        method: 'POST',
        url: `/api/characters/${characterId}/shelf/${direction}`,
        payload: body,
        headers: key ? { 'idempotency-key': key } : {},
        cookies: as(token),
      }),
  };
}
