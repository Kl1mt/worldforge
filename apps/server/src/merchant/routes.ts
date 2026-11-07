import { refreshAchievements } from '../achievements/award.js';
import type { FastifyInstance } from 'fastify';
import { and, asc, eq, like } from 'drizzle-orm';
import {
  AREA_IDS,
  areaStock,
  isAreaUnlocked,
  merchantDay,
  merchantRestockAt,
  merchantStock,
  parseOfferId,
  sellPrice,
  type AreaId,
} from '@worldforge/game-core';
import { characters, itemInstances, merchantPurchases, type Character } from '../db/schema.js';
import type { Executor } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { writeAudit } from '../db/audit.js';
import { recordTelemetry } from '../telemetry/record.js';
import { disposalCounts, dropCounts, goldIn, goldOut } from '../telemetry/counts.js';
import { ApiError } from '../errors.js';
import type { ActivityOptions } from '../activity/settle.js';
import { characterView, type CharacterView } from '../characters/routes.js';
import {
  characterNotFound,
  characterParamsSchema,
  inventoryResponseSchema,
  inventoryView,
  itemSchema,
  itemView,
  loadItems,
  lockOwnedCharacter,
  type InventoryView,
  type ItemView,
  isPackItem,
} from '../inventory/routes.js';
import { idempotentTransaction } from '../idempotency/index.js';
import {
  changeGold,
  characterSchema,
  deleteItems,
  insufficientGold,
  inventoryFull,
  itemIdsBodySchema,
  itemPreviewSchema,
  pickInventoryItems,
  type ItemPreview,
} from '../economy/shared.js';

/**
 * The Merchant (ticket 2.6, GDD §4.2): sells a small daily stock of basic gear per unlocked area
 * and buys the character's items. Stock and prices come from game-core; the client sends offer
 * and item ids only. Buy and sell need an `Idempotency-Key`, lock the character row and settle
 * its activity first (like every inventory change, ticket 1.9), and are audited.
 */

export interface MerchantOfferView {
  offerId: string;
  areaId: AreaId;
  item: ItemPreview;
  price: number;
  /** Bought already today. */
  soldOut: boolean;
}

export interface MerchantResponse {
  characterId: string;
  /** The merchant's day (UTC date); offers are valid on this day only. */
  day: string;
  restocksAt: string;
  gold: number;
  offers: MerchantOfferView[];
  /** What the merchant pays for each unequipped item. */
  sellPrices: { itemId: string; price: number }[];
}

export interface BuyResponse {
  character: CharacterView;
  item: ItemView;
  inventory: InventoryView;
}

export interface SellResponse {
  character: CharacterView;
  goldGained: number;
  inventory: InventoryView;
}

function unlockedAreas(character: Character): AreaId[] {
  return AREA_IDS.filter((id) =>
    isAreaUnlocked(id, { level: character.level }, character.progress),
  );
}

async function boughtToday(db: Executor, characterId: string, day: string): Promise<Set<string>> {
  const rows = await db
    .select({ offerId: merchantPurchases.offerId })
    .from(merchantPurchases)
    .where(
      and(
        eq(merchantPurchases.characterId, characterId),
        like(merchantPurchases.offerId, `${day}.%`),
      ),
    );
  return new Set(rows.map((r) => r.offerId));
}

const merchantResponseSchema = {
  type: 'object',
  required: ['characterId', 'day', 'restocksAt', 'gold', 'offers', 'sellPrices'],
  properties: {
    characterId: { type: 'string' },
    day: { type: 'string' },
    restocksAt: { type: 'string' },
    gold: { type: 'integer' },
    offers: {
      type: 'array',
      items: {
        type: 'object',
        required: ['offerId', 'areaId', 'item', 'price', 'soldOut'],
        properties: {
          offerId: { type: 'string' },
          areaId: { type: 'string' },
          item: itemPreviewSchema,
          price: { type: 'integer' },
          soldOut: { type: 'boolean' },
        },
      },
    },
    sellPrices: {
      type: 'array',
      items: {
        type: 'object',
        required: ['itemId', 'price'],
        properties: { itemId: { type: 'string' }, price: { type: 'integer' } },
      },
    },
  },
} as const;

const buyResponseSchema = {
  type: 'object',
  required: ['character', 'item', 'inventory'],
  properties: { character: characterSchema, item: itemSchema, inventory: inventoryResponseSchema },
} as const;

const sellResponseSchema = {
  type: 'object',
  required: ['character', 'goldGained', 'inventory'],
  properties: {
    character: characterSchema,
    goldGained: { type: 'integer' },
    inventory: inventoryResponseSchema,
  },
} as const;

const buyBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['offerId'],
  properties: { offerId: { type: 'string', minLength: 1, maxLength: 64 } },
} as const;

export async function registerMerchant(
  app: FastifyInstance,
  activity: ActivityOptions,
): Promise<void> {
  const capacity = activity.rules.inventory.capacity;

  app.get<{ Params: { characterId: string } }>(
    '/characters/:characterId/merchant',
    {
      preHandler: app.requireAccount,
      schema: { params: characterParamsSchema, response: { 200: merchantResponseSchema } },
    },
    async (request): Promise<MerchantResponse> => {
      const accountId = request.auth!.account.id;
      const { characterId } = request.params;
      const [character] = await app.db
        .select()
        .from(characters)
        .where(and(eq(characters.id, characterId), eq(characters.accountId, accountId)));
      if (!character) throw characterNotFound();
      const now = activity.now();
      const day = merchantDay(now);
      const sold = await boughtToday(app.db, characterId, day);
      const stock = merchantStock({
        characterId,
        classId: character.classId,
        day,
        areaIds: unlockedAreas(character),
      });
      const items = await app.db
        .select()
        .from(itemInstances)
        .where(eq(itemInstances.characterId, characterId))
        .orderBy(asc(itemInstances.createdAt), asc(itemInstances.id));
      return {
        characterId,
        day,
        restocksAt: merchantRestockAt(now).toISOString(),
        gold: character.gold,
        offers: stock.map((o) => ({
          offerId: o.offerId,
          areaId: o.areaId,
          item: {
            baseId: o.item.baseId,
            rarityId: o.item.rarityId,
            itemLevel: o.item.itemLevel,
            affixes: o.item.affixes,
          },
          price: o.price,
          soldOut: sold.has(o.offerId),
        })),
        sellPrices: items.filter(isPackItem).map((i) => ({ itemId: i.id, price: sellPrice(i) })),
      };
    },
  );

  app.post<{ Params: { characterId: string }; Body: { offerId: string } }>(
    '/characters/:characterId/merchant/buy',
    {
      preHandler: app.requireAccount,
      schema: {
        params: characterParamsSchema,
        body: buyBodySchema,
        response: { 200: buyResponseSchema },
      },
    },
    async (request, reply) => {
      const accountId = request.auth!.account.id;
      const { characterId } = request.params;
      const { offerId } = request.body;
      return idempotentTransaction(
        app,
        request,
        reply,
        { now: activity.now },
        async (tx): Promise<BuyResponse> => {
          const locked = await lockOwnedCharacter(tx, accountId, characterId, activity);
          const now = activity.now();
          const parsed = parseOfferId(offerId);
          if (!parsed) throw new ApiError(404, 'not_found', 'No such offer.');
          if (parsed.day !== merchantDay(now)) {
            throw new ApiError(409, 'offer_expired', 'The merchant has restocked since then.');
          }
          if (!isAreaUnlocked(parsed.areaId, { level: locked.level }, locked.progress)) {
            throw new ApiError(404, 'not_found', 'No such offer.');
          }
          const offer = areaStock(characterId, locked.classId, parsed.day, parsed.areaId).find(
            (o) => o.offerId === offerId,
          );
          if (!offer) throw new ApiError(404, 'not_found', 'No such offer.');
          const sold = await tx
            .select({ offerId: merchantPurchases.offerId })
            .from(merchantPurchases)
            .where(
              and(
                eq(merchantPurchases.characterId, characterId),
                eq(merchantPurchases.offerId, offerId),
              ),
            );
          if (sold.length > 0) {
            throw new ApiError(409, 'offer_sold_out', 'You bought this one already today.');
          }
          const items = await loadItems(tx, characterId);
          if (items.filter(isPackItem).length >= capacity) {
            throw inventoryFull(capacity);
          }
          if (locked.gold < offer.price) throw insufficientGold(offer.price, locked.gold);

          const character = await changeGold(tx, locked, -offer.price, now);
          const [row] = await tx
            .insert(itemInstances)
            .values({
              id: uuidv7(),
              characterId,
              ...offer.item,
              source: 'merchant',
              createdAt: now,
            })
            .returning();
          const item = row!;
          await tx
            .insert(merchantPurchases)
            .values({ characterId, offerId, itemId: item.id, price: offer.price, createdAt: now });
          await writeAudit(tx, {
            event: 'merchant.buy',
            accountId,
            characterId,
            data: {
              offerId,
              price: offer.price,
              itemId: item.id,
              baseId: item.baseId,
              rarityId: item.rarityId,
              itemLevel: item.itemLevel,
              seed: item.seed,
              goldAfter: character.gold,
            },
          });
          await refreshAchievements(tx, character, ['maxRarity'], now); // ticket 4.2
          recordTelemetry(tx, now, [
            ...dropCounts('merchant', parsed.areaId, [item]),
            ...goldOut('merchant_buy', item.rarityId, offer.price),
          ]);
          return {
            character: characterView(character),
            item: itemView(item),
            inventory: inventoryView(character, [...items, item]),
          };
        },
      );
    },
  );

  app.post<{ Params: { characterId: string }; Body: { itemIds: string[] } }>(
    '/characters/:characterId/merchant/sell',
    {
      preHandler: app.requireAccount,
      schema: {
        params: characterParamsSchema,
        body: itemIdsBodySchema,
        response: { 200: sellResponseSchema },
      },
    },
    async (request, reply) => {
      const accountId = request.auth!.account.id;
      const { characterId } = request.params;
      const { itemIds } = request.body;
      return idempotentTransaction(
        app,
        request,
        reply,
        { now: activity.now },
        async (tx): Promise<SellResponse> => {
          const locked = await lockOwnedCharacter(tx, accountId, characterId, activity);
          const now = activity.now();
          const items = await loadItems(tx, characterId);
          const selling = pickInventoryItems(items, itemIds);
          const prices = selling.map((i) => sellPrice(i));
          const goldGained = prices.reduce((s, p) => s + p, 0);
          await deleteItems(tx, characterId, itemIds);
          const character = await changeGold(tx, locked, goldGained, now);
          await writeAudit(tx, {
            event: 'merchant.sell',
            accountId,
            characterId,
            data: {
              gold: goldGained,
              goldAfter: character.gold,
              items: selling.map((i, n) => ({
                itemId: i.id,
                baseId: i.baseId,
                rarityId: i.rarityId,
                itemLevel: i.itemLevel,
                seed: i.seed,
                price: prices[n],
              })),
            },
          });
          recordTelemetry(tx, now, [
            ...disposalCounts('item.sold', selling, (n) => prices[n]!),
            ...goldIn('merchant_sell', '', goldGained),
          ]);
          const sold = new Set(itemIds);
          return {
            character: characterView(character),
            goldGained,
            inventory: inventoryView(
              character,
              items.filter((i) => !sold.has(i.id)),
            ),
          };
        },
      );
    },
  );
}
