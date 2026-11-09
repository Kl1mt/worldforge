import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import {
  DEFAULT_TRADING_SETTINGS,
  type MaterialId,
  type RarityId,
  type TradingSettings,
} from '@worldforge/game-core';
import {
  accounts,
  characterMaterials,
  characters,
  friendships,
  gameSettings,
  itemInstances,
  type Character,
} from '../db/schema.js';
import type { Database } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { TRADING_SETTINGS_KEY } from '../settings/store.js';
import { pairOf } from '../social/relations.js';
import { insertCharacter } from './heroes.js';
import { insertAccount, type TestAccount } from './social.js';

/** Test helpers for trade offers (ticket T.5). */

const DAY = 86_400_000;

/** Trading fully open: the master, every kind, every category (Mythic and Void too). */
export const ALL_TRADING_ON: TradingSettings = {
  ...structuredClone(DEFAULT_TRADING_SETTINGS),
  trading: true,
  trade: { items: true, materials: true, gold: true },
  tradeable: { epic: true, legendary: true, set: true, mythic: true, void: true },
  shelf: { items: true, materials: true, gold: true },
};

/** Stores trading settings directly (the admin route is T.2's) and drops the cache. */
export async function setTradingSettings(
  app: FastifyInstance,
  db: Database,
  settings: TradingSettings = ALL_TRADING_ON,
) {
  const stored = settings as unknown as Record<string, unknown>;
  await db
    .insert(gameSettings)
    .values({ key: TRADING_SETTINGS_KEY, value: stored, version: 1, updatedAt: new Date() })
    .onConflictDoUpdate({ target: gameSettings.key, set: { value: stored } });
  app.gameSettings.invalidate();
}

export interface Trader extends TestAccount {
  hero: Character;
}

/** An account that meets every trading requirement, with one level-20 hero and some gold. */
export async function insertTrader(
  db: Database,
  now: Date,
  { gold = 10_000, name }: { gold?: number; name?: string } = {},
): Promise<Trader> {
  const a = await insertAccount(db, { now, ...(name ? { name } : {}) });
  await db
    .update(accounts)
    .set({ createdAt: new Date(now.getTime() - 30 * DAY), emailVerifiedAt: now })
    .where(eq(accounts.id, a.id));
  const hero = await insertCharacter(db, a.id, { level: 20 });
  const [withGold] = await db
    .update(characters)
    .set({ gold })
    .where(eq(characters.id, hero.id))
    .returning();
  return { ...a, hero: withGold! };
}

/** Friends accepted `days` ago. */
export async function befriendSince(
  db: Database,
  a: TestAccount,
  b: TestAccount,
  now: Date,
  days = 30,
) {
  const { low, high } = pairOf(a.id, b.id);
  await db.insert(friendships).values({
    accountLow: low,
    accountHigh: high,
    status: 'friends',
    requestedBy: a.id,
    createdAt: new Date(now.getTime() - (days + 1) * DAY),
    acceptedAt: new Date(now.getTime() - days * DAY),
  });
}

/** A fresh, tradeable item (a farming drop of an Epic rarity or better). */
export async function insertTradeItem(
  db: Database,
  characterId: string,
  {
    rarityId = 'epic',
    variant = null,
    setId = null,
    locked = false,
    unprovenanced = false,
  }: {
    rarityId?: RarityId;
    variant?: 'void' | null;
    setId?: string | null;
    locked?: boolean;
    unprovenanced?: boolean;
  } = {},
) {
  const [row] = await db
    .insert(itemInstances)
    .values({
      id: uuidv7(),
      characterId,
      baseId: 'longsword',
      rarityId,
      itemLevel: 20,
      affixes: [],
      seed: 7,
      source: 'farming',
      binding: 'equip',
      variant,
      setId,
      locked,
      unprovenanced,
    })
    .returning();
  return row!;
}

export async function giveMaterials(
  db: Database,
  characterId: string,
  materials: Partial<Record<MaterialId, number>>,
) {
  for (const [materialId, quantity] of Object.entries(materials)) {
    await db
      .insert(characterMaterials)
      .values({
        characterId,
        materialId: materialId as MaterialId,
        quantity: quantity!,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [characterMaterials.characterId, characterMaterials.materialId],
        set: { quantity: sql`${characterMaterials.quantity} + ${quantity!}` },
      });
  }
}

export interface Side {
  itemIds?: string[];
  gold?: number;
  materials?: Partial<Record<MaterialId, number>>;
}

export function tradeCalls(app: FastifyInstance) {
  const cookies = (t: TestAccount) => ({ [SESSION_COOKIE]: t.token });
  const post = (who: TestAccount, url: string, payload: object, key: string | null) =>
    app.inject({
      method: 'POST',
      url,
      payload,
      headers: key ? { 'idempotency-key': key } : {},
      cookies: cookies(who),
    });
  return {
    send: (
      who: Trader,
      to: TestAccount,
      body: { give?: Side; ask?: Side; receiverCharacterId?: string; characterId?: string },
      key: string | null = randomUUID(),
    ) =>
      post(
        who,
        '/api/trading/offers',
        { to: to.handle, characterId: body.characterId ?? who.hero.id, ...body },
        key,
      ),
    act: (
      who: TestAccount,
      offerId: string,
      action: 'cancel' | 'decline' | 'accept',
      body: object = {},
      key: string | null = randomUUID(),
    ) => post(who, `/api/trading/offers/${offerId}/${action}`, body, key),
    get: (who: TestAccount, url: string, headers: Record<string, string> = {}) =>
      app.inject({ method: 'GET', url, cookies: cookies(who), headers }),
  };
}

/** Ticket T.6: the moderators' trade routes. */
export function modTradeCalls(app: FastifyInstance) {
  const cookies = (t: TestAccount) => ({ [SESSION_COOKIE]: t.token });
  return {
    get: (who: TestAccount | null, url: string) =>
      app.inject({ method: 'GET', url, ...(who ? { cookies: cookies(who) } : {}) }),
    reverse: (
      who: TestAccount | null,
      offerId: string,
      body: object = { reason: 'Reversed in a test.' },
      key: string | null = randomUUID(),
    ) =>
      app.inject({
        method: 'POST',
        url: `/api/mod/trades/${offerId}/reverse`,
        payload: body,
        headers: key ? { 'idempotency-key': key } : {},
        ...(who ? { cookies: cookies(who) } : {}),
      }),
  };
}
