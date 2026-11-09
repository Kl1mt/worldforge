import type { FastifyInstance } from 'fastify';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  WAREHOUSE_UNLOCK,
  isUnlocked,
  maxWarehouseLevel,
  nextWarehouseUpgrade,
  planWarehouseMove,
  warehouseCapacity,
  type WarehouseMoveDirection,
  type TradingSwitches,
} from '@worldforge/game-core';
import { characters, itemInstances, type Character, type ItemInstance } from '../db/schema.js';
import type { Executor, Transaction } from '../db/types.js';
import { withTransaction } from '../db/transaction.js';
import { writeAudit } from '../db/audit.js';
import { ApiError } from '../errors.js';
import type { ActivityOptions } from '../activity/settle.js';
import { characterSchema, characterView, type CharacterView } from '../characters/routes.js';
import { changeGold, insufficientGold, itemIdsBodySchema } from '../economy/shared.js';
import { idempotentTransaction } from '../idempotency/index.js';
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
} from '../inventory/routes.js';
import { isPackItem, itemInOffer, itemOnShelf } from '../inventory/location.js';
import { recordTelemetry } from '../telemetry/record.js';
import { goldOut } from '../telemetry/counts.js';

/**
 * The Graumark Warehouse (ticket 4.7, GDD §4.2, `docs/WAREHOUSE.md`): per-character storage. An
 * item moves by flipping `item_instances.in_warehouse` on the same row, so its id, lock, forge
 * state and audit history stay with it. Every route first checks the world flag
 * `warehouseRestored` (ticket 4.6, through the cached world state; a flag is never removed, so a
 * stale cache can only answer "closed" for up to its TTL) and answers `409 warehouse_closed` until
 * the town has restored the building.
 *
 * Moves lock the character (settling its activity first, like every inventory change), then its
 * items, and are all or nothing. They move no value, so they need no `Idempotency-Key` (a repeated
 * move finds the items already moved and changes nothing), but they are audited. Upgrades spend
 * gold: `Idempotency-Key`, audited, telemetry.
 */

export interface WarehouseView {
  characterId: string;
  level: number;
  maxLevel: number;
  capacity: number;
  /** Stored items, oldest first. */
  items: ItemView[];
  /** The next upgrade, or null at the top. */
  nextUpgrade: { toLevel: number; gold: number; slots: number; capacity: number } | null;
  gold: number;
  pack: { count: number; capacity: number };
}

export interface WarehouseMoveResponse {
  warehouse: WarehouseView;
  inventory: InventoryView;
  /** Items that changed sides (the others were there already). */
  moved: number;
}

export interface WarehouseUpgradeResponse {
  warehouse: WarehouseView;
  character: CharacterView;
  goldSpent: number;
}

const warehouseSchema = {
  type: 'object',
  required: [
    'characterId',
    'level',
    'maxLevel',
    'capacity',
    'items',
    'nextUpgrade',
    'gold',
    'pack',
  ],
  properties: {
    characterId: { type: 'string' },
    level: { type: 'integer' },
    maxLevel: { type: 'integer' },
    capacity: { type: 'integer' },
    items: { type: 'array', items: itemSchema },
    nextUpgrade: {
      type: ['object', 'null'],
      required: ['toLevel', 'gold', 'slots', 'capacity'],
      properties: {
        toLevel: { type: 'integer' },
        gold: { type: 'integer' },
        slots: { type: 'integer' },
        capacity: { type: 'integer' },
      },
    },
    gold: { type: 'integer' },
    pack: {
      type: 'object',
      required: ['count', 'capacity'],
      properties: { count: { type: 'integer' }, capacity: { type: 'integer' } },
    },
  },
} as const;

const moveResponseSchema = {
  type: 'object',
  required: ['warehouse', 'inventory', 'moved'],
  properties: {
    warehouse: warehouseSchema,
    inventory: inventoryResponseSchema,
    moved: { type: 'integer' },
  },
} as const;

const upgradeResponseSchema = {
  type: 'object',
  required: ['warehouse', 'character', 'goldSpent'],
  properties: {
    warehouse: warehouseSchema,
    character: characterSchema,
    goldSpent: { type: 'integer' },
  },
} as const;

const upgradeBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['level'],
  properties: {
    /** The level the client saw; a different stored level refuses (`409 level_changed`). */
    level: { type: 'integer', minimum: 0, maximum: maxWarehouseLevel() },
  },
} as const;

/** The not-open-yet answer, the same on every route (and before any ownership check). */
export const warehouseClosed = () =>
  new ApiError(
    409,
    'warehouse_closed',
    'The Warehouse is not open yet. The town must restore it first (Town works).',
    { flag: 'warehouseRestored', projectId: 'restoreWarehouse' },
  );

export function warehouseView(
  character: Character,
  items: readonly ItemInstance[],
  packCapacity: number,
  switches: Readonly<TradingSwitches>,
): WarehouseView {
  const level = character.warehouseLevel;
  const next = nextWarehouseUpgrade(level);
  return {
    characterId: character.id,
    level,
    maxLevel: maxWarehouseLevel(),
    capacity: warehouseCapacity(level),
    items: items.filter((i) => i.inWarehouse).map((i) => itemView(i, switches)),
    nextUpgrade: next
      ? { toLevel: next.toLevel, gold: next.gold, slots: next.slots, capacity: next.capacity }
      : null,
    gold: character.gold,
    pack: { count: items.filter(isPackItem).length, capacity: packCapacity },
  };
}

async function ownedCharacter(
  db: Executor,
  accountId: string,
  characterId: string,
): Promise<Character> {
  const [character] = await db
    .select()
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.accountId, accountId)));
  if (!character) throw characterNotFound();
  return character;
}

const itemNotFound = (itemId: string) =>
  new ApiError(404, 'not_found', 'No such item.', { itemId });

export async function registerWarehouse(
  app: FastifyInstance,
  activity: ActivityOptions,
): Promise<void> {
  const packCapacity = activity.rules.inventory.capacity;

  /** The gate: the building is open once the town has restored it (world flag). */
  async function requireOpen(): Promise<void> {
    const world = await app.worldState.flags();
    if (!isUnlocked(WAREHOUSE_UNLOCK, { level: 1, world }, { gravewardenDefeated: false })) {
      throw warehouseClosed();
    }
  }

  app.get<{ Params: { characterId: string } }>(
    '/characters/:characterId/warehouse',
    {
      preHandler: app.requireAccount,
      schema: { params: characterParamsSchema, response: { 200: warehouseSchema } },
    },
    async (request): Promise<WarehouseView> => {
      const switches = await app.gameSettings.tradingSwitches();
      await requireOpen();
      const accountId = request.auth!.account.id;
      const { characterId } = request.params;
      return withTransaction(app.db, async (tx) => {
        const character = await ownedCharacter(tx, accountId, characterId);
        const items = await tx
          .select()
          .from(itemInstances)
          .where(eq(itemInstances.characterId, characterId))
          .orderBy(asc(itemInstances.createdAt), asc(itemInstances.id));
        return warehouseView(character, items, packCapacity, switches);
      });
    },
  );

  async function move(
    tx: Transaction,
    direction: WarehouseMoveDirection,
    accountId: string,
    characterId: string,
    itemIds: readonly string[],
    switches: Readonly<TradingSwitches>,
  ): Promise<WarehouseMoveResponse> {
    // Settle first (ticket 1.9): drops of the window so far are placed with the pack as it was.
    const character = await lockOwnedCharacter(tx, accountId, characterId, activity);
    const now = activity.now();
    const items = await loadItems(tx, characterId);
    // Ticket T.3: an item on the account shelf is neither in the pack nor in the warehouse.
    const shelved = items.find((i) => i.onShelf && itemIds.includes(i.id));
    if (shelved) throw itemOnShelf(shelved.id);
    // Ticket T.5: an item in a trade offer's escrow is out of reach until the offer ends.
    const offered = items.find((i) => i.escrowOfferId && itemIds.includes(i.id));
    if (offered) throw itemInOffer(offered.id);
    // Ticket T.5: an item received in a trade stays on the hero (in the pack or worn) for its
    // 72-hour hold, so a reversal always finds it there. Taking items out is never refused.
    if (direction === 'deposit') {
      const held = items.find(
        (i) => itemIds.includes(i.id) && i.holdUntil && i.holdUntil.getTime() > now.getTime(),
      );
      if (held) {
        throw new ApiError(
          409,
          'item_held',
          'This item was received in a trade and is held for 72 hours. It can go into the warehouse once the hold ends.',
          { itemId: held.id, holdUntil: held.holdUntil!.toISOString() },
        );
      }
    }
    const plan = planWarehouseMove({
      direction,
      itemIds,
      items: items
        .filter((i) => !i.onShelf && !i.escrowOfferId)
        .map((i) => ({
          id: i.id,
          equipped: i.equippedSlot !== null,
          inWarehouse: i.inWarehouse,
        })),
      packCapacity,
      warehouseCapacity: warehouseCapacity(character.warehouseLevel),
    });
    if (!plan.ok) {
      const r = plan.refusal;
      switch (r.kind) {
        case 'not_found':
          throw itemNotFound(r.itemId);
        case 'item_equipped':
          throw new ApiError(409, 'item_equipped', 'Unequip this item first.', {
            itemId: r.itemId,
          });
        case 'warehouse_full':
          throw new ApiError(422, 'warehouse_full', 'Not enough room in the warehouse.', {
            capacity: r.capacity,
            free: r.free,
            needed: r.needed,
          });
        case 'inventory_full':
          throw new ApiError(422, 'inventory_full', 'Not enough room in your pack.', {
            capacity: r.capacity,
            free: r.free,
            needed: r.needed,
          });
      }
    }
    const toWarehouse = direction === 'deposit';
    if (plan.move.length > 0) {
      // The where clause re-checks the side and "not equipped" (and the table's check forbids a
      // stored worn item): a row that changed under us rolls the whole move back.
      const updated = await tx
        .update(itemInstances)
        .set({ inWarehouse: toWarehouse })
        .where(
          and(
            eq(itemInstances.characterId, characterId),
            inArray(itemInstances.id, plan.move),
            eq(itemInstances.inWarehouse, !toWarehouse),
            sql`${itemInstances.equippedSlot} is null`,
            sql`${itemInstances.escrowOfferId} is null`,
            ...(toWarehouse
              ? [sql`(${itemInstances.holdUntil} is null or ${itemInstances.holdUntil} <= ${now})`]
              : []),
          ),
        )
        .returning({ id: itemInstances.id });
      if (updated.length !== plan.move.length) {
        throw new ApiError(409, 'conflict', 'The pack changed meanwhile. Try again.');
      }
      const moving = new Set(plan.move);
      for (const i of items) if (moving.has(i.id)) i.inWarehouse = toWarehouse;
      await writeAudit(tx, {
        event: `warehouse.${direction}`,
        accountId,
        characterId,
        data: {
          items: items
            .filter((i) => moving.has(i.id))
            .map((i) => ({
              itemId: i.id,
              baseId: i.baseId,
              rarityId: i.rarityId,
              itemLevel: i.itemLevel,
              locked: i.locked,
            })),
          stored: items.filter((i) => i.inWarehouse).length,
          packed: items.filter(isPackItem).length,
        },
      });
      recordTelemetry(tx, now, [
        { metric: 'warehouse.move', dims: [direction], amount: plan.move.length },
      ]);
    }
    return {
      warehouse: warehouseView(character, items, packCapacity, switches),
      inventory: inventoryView(character, items, switches),
      moved: plan.move.length,
    };
  }

  for (const direction of ['deposit', 'withdraw'] as const) {
    app.post<{ Params: { characterId: string }; Body: { itemIds: string[] } }>(
      `/characters/:characterId/warehouse/${direction}`,
      {
        preHandler: app.requireAccount,
        schema: {
          params: characterParamsSchema,
          body: itemIdsBodySchema,
          response: { 200: moveResponseSchema },
        },
      },
      async (request) => {
        const switches = await app.gameSettings.tradingSwitches();
        await requireOpen();
        const accountId = request.auth!.account.id;
        const { characterId } = request.params;
        return withTransaction(app.db, (tx) =>
          move(tx, direction, accountId, characterId, request.body.itemIds, switches),
        );
      },
    );
  }

  app.post<{ Params: { characterId: string }; Body: { level: number } }>(
    '/characters/:characterId/warehouse/upgrade',
    {
      preHandler: app.requireAccount,
      schema: {
        params: characterParamsSchema,
        body: upgradeBodySchema,
        response: { 200: upgradeResponseSchema },
      },
    },
    async (request, reply) => {
      const switches = await app.gameSettings.tradingSwitches();
      await requireOpen();
      const accountId = request.auth!.account.id;
      const { characterId } = request.params;
      return idempotentTransaction(
        app,
        request,
        reply,
        { now: activity.now },
        async (tx): Promise<WarehouseUpgradeResponse> => {
          // Settle first so gold earned offline counts (settle before spending).
          const locked = await lockOwnedCharacter(tx, accountId, characterId, activity);
          const now = activity.now();
          const from = locked.warehouseLevel;
          if (request.body.level !== from) {
            throw new ApiError(409, 'level_changed', 'The warehouse was upgraded meanwhile.', {
              level: from,
            });
          }
          const next = nextWarehouseUpgrade(from);
          if (!next) {
            throw new ApiError(409, 'warehouse_max_level', 'The warehouse is fully extended.', {
              level: from,
            });
          }
          if (locked.gold < next.gold) throw insufficientGold(next.gold, locked.gold);
          const paid = await changeGold(tx, locked, -next.gold, now);
          // The level moves only from the level checked under the lock (a backstop).
          const [character] = await tx
            .update(characters)
            .set({ warehouseLevel: next.toLevel })
            .where(and(eq(characters.id, characterId), eq(characters.warehouseLevel, from)))
            .returning();
          if (!character) throw new Error('unreachable: warehouse level moved under the lock');
          await writeAudit(tx, {
            event: 'warehouse.upgrade',
            accountId,
            characterId,
            data: {
              fromLevel: from,
              toLevel: next.toLevel,
              capacity: next.capacity,
              gold: next.gold,
              goldAfter: paid.gold,
            },
          });
          recordTelemetry(tx, now, [
            { metric: 'warehouse.upgrade', dims: [`level${next.toLevel}`] },
            ...goldOut('warehouse_upgrade', '', next.gold),
          ]);
          const items = await tx
            .select()
            .from(itemInstances)
            .where(eq(itemInstances.characterId, characterId))
            .orderBy(asc(itemInstances.createdAt), asc(itemInstances.id));
          return {
            warehouse: warehouseView(character, items, packCapacity, switches),
            character: characterView(character),
            goldSpent: next.gold,
          };
        },
      );
    },
  );
}
