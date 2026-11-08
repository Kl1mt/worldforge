import { refreshAchievements } from '../achievements/award.js';
import type { FastifyInstance } from 'fastify';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  CORE_STAT_IDS,
  EQUIPMENT_SLOT_IDS,
  checkEquip,
  DEFAULT_TRADING_SWITCHES,
  ITEM_BINDINGS,
  itemBinding,
  type ItemBinding,
  type ItemBindingReason,
  type TradingSwitches,
  defaultEquipSlot,
  deriveEquippedStats,
  itemFitsSlot,
  findItemBase,
  type EquipmentSlotId,
  type ItemVariantId,
  type RarityId,
  type RolledAffix,
  type StatBlock,
} from '@worldforge/game-core';
import { characters, itemInstances, type Character, type ItemInstance } from '../db/schema.js';
import { constraintOf, sqlStateOf, withTransaction } from '../db/transaction.js';
import type { Transaction } from '../db/types.js';
import { writeAudit } from '../db/audit.js';
import { recordTelemetry } from '../telemetry/record.js';
import { disposalCounts } from '../telemetry/counts.js';
import { ApiError } from '../errors.js';
import { settleActivityTx, type ActivityOptions } from '../activity/settle.js';
import { isPackItem, itemInWarehouse } from './location.js';

export { isPackItem, itemInWarehouse, packItemsWhere } from './location.js';

/**
 * Inventory & equipment (ticket 1.7, GDD §7.1, §14 steps 4–5). Items are created only by the
 * server (loot, ticket 1.6); clients send intents and ids. Every change runs in one transaction
 * that locks the character row, so operations on one character are serialized and an item can
 * only ever be in one place. The partial unique index on (character_id, equipped_slot) is the
 * database-level backstop for "one item per slot".
 */

/** The public item shape (docs/API_CONVENTIONS.md). */
export interface ItemView {
  id: string;
  baseId: string;
  rarityId: RarityId;
  itemLevel: number;
  affixes: RolledAffix[];
  equippedSlot: EquipmentSlotId | null;
  source: string;
  createdAt: string;
  /** Item model v2 (ticket 3.1): Phase 3 state, at its defaults until the owning ticket. */
  upgradeLevel: number;
  variant: ItemVariantId | null;
  effectId: string | null;
  /** The Legendary effect's rolled strength, 0…1 (ticket 3.2; null for Mythics and others). */
  effectRoll: number | null;
  setId: string | null;
  mythicId: string | null;
  locked: boolean;
  /**
   * Ticket T.1 (docs/TRADING.md "1. Item binding"): `account` (account-bound) or `equip` (binds
   * when worn or forged), why, and whether it may be traded under the current switches (always
   * false until trading opens).
   */
  binding: ItemBinding;
  bindingReason: ItemBindingReason;
  tradeable: boolean;
}

export interface InventoryView {
  /** Equipped items in canonical slot order. */
  equipped: ItemView[];
  /** Unequipped items in the pack (not the warehouse, ticket 4.7), oldest first. */
  inventory: ItemView[];
  /** Effective stats with the equipped items, derived server-side. */
  stats: StatBlock;
}

/**
 * The item as the client sees it. `switches` are the stored trading switches
 * (`app.gameSettings.tradingSwitches()`, ticket T.2), so `tradeable` matches the admin panel.
 */
export function itemView(i: ItemInstance, switches: Readonly<TradingSwitches>): ItemView {
  return {
    id: i.id,
    baseId: i.baseId,
    rarityId: i.rarityId,
    itemLevel: i.itemLevel,
    affixes: i.affixes,
    equippedSlot: i.equippedSlot ?? null,
    source: i.source,
    createdAt: i.createdAt.toISOString(),
    upgradeLevel: i.upgradeLevel,
    variant: i.variant ?? null,
    effectId: i.effectId ?? null,
    effectRoll: i.effectRoll ?? null,
    setId: i.setId ?? null,
    mythicId: i.mythicId ?? null,
    locked: i.locked,
    ...bindingView(i, switches),
  };
}

/** The binding fields of the item view (ticket T.1). */
export function bindingView(
  i: ItemInstance,
  switches: Readonly<TradingSwitches> = DEFAULT_TRADING_SWITCHES,
): Pick<ItemView, 'binding' | 'bindingReason' | 'tradeable'> {
  const b = itemBinding(i, switches);
  return { binding: b.binding, bindingReason: b.reason, tradeable: b.tradeable };
}

export function inventoryView(
  character: Character,
  items: readonly ItemInstance[],
  switches: Readonly<TradingSwitches>,
): InventoryView {
  const slotOrder = (s: EquipmentSlotId) => EQUIPMENT_SLOT_IDS.indexOf(s);
  const equipped = items
    .filter((i) => i.equippedSlot !== null)
    .sort((a, b) => slotOrder(a.equippedSlot!) - slotOrder(b.equippedSlot!));
  const inventory = items.filter(isPackItem);
  // Items whose base no longer exists in content can't contribute; they stay listed.
  const usable = equipped.filter((i) => findItemBase(i.baseId) !== undefined);
  return {
    equipped: equipped.map((i) => itemView(i, switches)),
    inventory: inventory.map((i) => itemView(i, switches)),
    stats: deriveEquippedStats(character.classId, character.level, usable),
  };
}

export const itemSchema = {
  type: 'object',
  required: [
    'id',
    'baseId',
    'rarityId',
    'itemLevel',
    'affixes',
    'equippedSlot',
    'source',
    'createdAt',
    'upgradeLevel',
    'variant',
    'effectId',
    'effectRoll',
    'setId',
    'mythicId',
    'locked',
    'binding',
    'bindingReason',
    'tradeable',
  ],
  properties: {
    id: { type: 'string' },
    baseId: { type: 'string' },
    rarityId: { type: 'string' },
    itemLevel: { type: 'integer' },
    affixes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['affixId', 'tier', 'value'],
        properties: {
          affixId: { type: 'string' },
          tier: { type: 'integer' },
          value: { type: 'number' },
          improvements: { type: 'integer' },
          rerolled: { type: 'boolean' },
        },
      },
    },
    equippedSlot: { type: ['string', 'null'] },
    source: { type: 'string' },
    createdAt: { type: 'string' },
    upgradeLevel: { type: 'integer' },
    variant: { type: ['string', 'null'] },
    effectId: { type: ['string', 'null'] },
    effectRoll: { type: ['number', 'null'] },
    setId: { type: ['string', 'null'] },
    mythicId: { type: ['string', 'null'] },
    locked: { type: 'boolean' },
    binding: { type: 'string', enum: [...ITEM_BINDINGS] },
    bindingReason: { type: 'string' },
    tradeable: { type: 'boolean' },
  },
} as const;

export const inventoryResponseSchema = {
  type: 'object',
  required: ['equipped', 'inventory', 'stats'],
  properties: {
    equipped: { type: 'array', items: itemSchema },
    inventory: { type: 'array', items: itemSchema },
    stats: {
      type: 'object',
      required: [...CORE_STAT_IDS],
      properties: Object.fromEntries(CORE_STAT_IDS.map((id) => [id, { type: 'number' }])),
    },
  },
} as const;

export const characterParamsSchema = {
  type: 'object',
  required: ['characterId'],
  properties: { characterId: { type: 'string', format: 'uuid' } },
} as const;

const itemParamsSchema = {
  type: 'object',
  required: ['characterId', 'itemId'],
  properties: {
    characterId: { type: 'string', format: 'uuid' },
    itemId: { type: 'string', format: 'uuid' },
  },
} as const;

const equipBodySchema = {
  type: ['object', 'null'],
  additionalProperties: false,
  properties: { slot: { type: 'string', enum: [...EQUIPMENT_SLOT_IDS] } },
} as const;

/** No body, or an empty object (ticket 3.7: lock/unlock take nothing from the client). */
const emptyBodySchema = {
  type: ['object', 'null'],
  additionalProperties: false,
  properties: {},
} as const;

interface ItemParams {
  characterId: string;
  itemId: string;
}

const UNIQUE_VIOLATION = '23505';

/** A locked item refuses sell, salvage and discard (ticket 3.7). */
export const itemLocked = (itemId: string) =>
  new ApiError(409, 'item_locked', 'This item is locked. Unlock it first.', { itemId });

/** Same answer for "doesn't exist" and "another account's": character ids can't be probed. */
export const characterNotFound = () => new ApiError(404, 'not_found', 'No such character.');

/**
 * Locks the character row (serializing inventory changes), checks ownership, and settles its
 * running activity first (ticket 1.9). Without that, a change made now would apply to the whole
 * unsettled window: equip a gold-find set just before settling and hours of farming would count
 * with it, or discard items so earlier drops are not salvaged by the capacity rule.
 */
export async function lockOwnedCharacter(
  tx: Transaction,
  accountId: string,
  characterId: string,
  activity: ActivityOptions,
): Promise<Character> {
  const [character] = await tx
    .select()
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.accountId, accountId)))
    .for('no key update');
  if (!character) throw characterNotFound();
  const settled = await settleActivityTx(tx, characterId, activity, { touch: true });
  return settled?.character ?? character;
}

export async function loadItems(tx: Transaction, characterId: string): Promise<ItemInstance[]> {
  return tx
    .select()
    .from(itemInstances)
    .where(eq(itemInstances.characterId, characterId))
    .orderBy(asc(itemInstances.createdAt), asc(itemInstances.id))
    .for('update');
}

function findItem(items: readonly ItemInstance[], itemId: string): ItemInstance {
  const item = items.find((i) => i.id === itemId);
  // Same answer for "doesn't exist" and "belongs to another character": ids can't be probed.
  if (!item) throw new ApiError(404, 'not_found', 'No such item.');
  // Ticket 4.7: equip, unequip, lock and discard act on the pack and the worn gear only.
  if (item.inWarehouse) throw itemInWarehouse(item.id);
  return item;
}

/**
 * Ticket T.1: the first time an item is worn it becomes account-bound to the wearer's account and
 * remembers when. Later wears change nothing (the earliest time and the first account stay).
 */
async function bindOnWear(
  tx: Transaction,
  item: ItemInstance,
  accountId: string,
  now: Date,
): Promise<Pick<ItemInstance, 'binding' | 'boundAccountId' | 'firstEquippedAt'>> {
  if (item.firstEquippedAt !== null && item.binding === 'account') return item;
  const [row] = await tx
    .update(itemInstances)
    .set({
      binding: 'account',
      boundAccountId: sql`coalesce(${itemInstances.boundAccountId}, ${accountId}::uuid)`,
      firstEquippedAt: sql`coalesce(${itemInstances.firstEquippedAt}, ${now.toISOString()}::timestamptz)`,
    })
    .where(eq(itemInstances.id, item.id))
    .returning({
      binding: itemInstances.binding,
      boundAccountId: itemInstances.boundAccountId,
      firstEquippedAt: itemInstances.firstEquippedAt,
    });
  return row!;
}

async function setSlot(tx: Transaction, itemId: string, slot: EquipmentSlotId | null) {
  await tx.update(itemInstances).set({ equippedSlot: slot }).where(eq(itemInstances.id, itemId));
}

/** Runs an inventory change and maps a slot-index clash (should be unreachable) to 409. */
async function inventoryTransaction<T>(
  app: FastifyInstance,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  try {
    return await withTransaction(app.db, fn);
  } catch (err) {
    if (
      sqlStateOf(err) === UNIQUE_VIOLATION &&
      constraintOf(err) === 'item_instances_equipped_slot_key'
    ) {
      throw new ApiError(409, 'slot_conflict', 'That slot changed meanwhile. Try again.');
    }
    throw err;
  }
}

export async function registerInventory(
  app: FastifyInstance,
  activity: ActivityOptions,
): Promise<void> {
  app.get<{ Params: { characterId: string } }>(
    '/characters/:characterId/inventory',
    {
      preHandler: app.requireAccount,
      schema: { params: characterParamsSchema, response: { 200: inventoryResponseSchema } },
    },
    async (request) => {
      const switches = await app.gameSettings.tradingSwitches();
      const accountId = request.auth!.account.id;
      const { characterId } = request.params;
      return withTransaction(app.db, async (tx) => {
        const [character] = await tx
          .select()
          .from(characters)
          .where(eq(characters.id, characterId));
        if (!character || character.accountId !== accountId) throw characterNotFound();
        const items = await tx
          .select()
          .from(itemInstances)
          .where(eq(itemInstances.characterId, characterId))
          .orderBy(asc(itemInstances.createdAt), asc(itemInstances.id));
        return inventoryView(character, items, switches);
      });
    },
  );

  app.post<{ Params: ItemParams; Body: { slot?: EquipmentSlotId } | null }>(
    '/characters/:characterId/items/:itemId/equip',
    {
      preHandler: app.requireAccount,
      schema: {
        params: itemParamsSchema,
        body: equipBodySchema,
        response: { 200: inventoryResponseSchema },
      },
    },
    async (request) => {
      const switches = await app.gameSettings.tradingSwitches();
      const accountId = request.auth!.account.id;
      const { characterId, itemId } = request.params;
      const requested = request.body?.slot;
      return inventoryTransaction(app, async (tx) => {
        const character = await lockOwnedCharacter(tx, accountId, characterId, activity);
        const items = await loadItems(tx, characterId);
        const item = findItem(items, itemId);

        const occupied = new Set(
          items
            .filter((i) => i.equippedSlot !== null && i.id !== item.id)
            .map((i) => i.equippedSlot!),
        );
        // Without a slot, an already equipped item stays where it is.
        const slot = requested ?? item.equippedSlot ?? defaultEquipSlot(item.baseId, occupied);
        const check = slot
          ? checkEquip(item.baseId, character.classId, slot)
          : ({ ok: false, reason: 'unknown_base' } as const);
        if (!check.ok) {
          if (check.reason === 'wrong_slot') {
            throw new ApiError(422, 'wrong_slot', 'This item does not fit that slot.', { slot });
          }
          if (check.reason === 'wrong_class') {
            throw new ApiError(422, 'wrong_class', 'Your class cannot use this item.', {
              classId: character.classId,
            });
          }
          throw new ApiError(422, 'item_unusable', 'This item can no longer be equipped.');
        }
        if (!slot) throw new Error('unreachable: equip check passed without a slot');

        if (item.equippedSlot !== slot) {
          const from = item.equippedSlot;
          const occupant = items.find((i) => i.equippedSlot === slot);
          // Free the item's old slot first: the slot index is checked per statement.
          if (from !== null) await setSlot(tx, item.id, null);
          if (occupant) {
            // Rings trade places (ring1 ↔ ring2); anything else goes back to the inventory.
            const base = findItemBase(occupant.baseId);
            const swapTo = from !== null && base && itemFitsSlot(base, from) ? from : null;
            await setSlot(tx, occupant.id, swapTo);
            occupant.equippedSlot = swapTo;
          }
          await setSlot(tx, item.id, slot);
          item.equippedSlot = slot;
          // Ticket T.1: wearing binds (docs/TRADING.md "By state"), in the same transaction.
          Object.assign(item, await bindOnWear(tx, item, accountId, activity.now()));
          // Ticket 4.2: wearing a set's last piece earns its achievement.
          if (item.setId) {
            await refreshAchievements(tx, character, ['fullSetWorn'], activity.now());
          }
        }
        return inventoryView(character, items, switches);
      });
    },
  );

  app.post<{ Params: ItemParams }>(
    '/characters/:characterId/items/:itemId/unequip',
    {
      preHandler: app.requireAccount,
      schema: { params: itemParamsSchema, response: { 200: inventoryResponseSchema } },
    },
    async (request) => {
      const switches = await app.gameSettings.tradingSwitches();
      const accountId = request.auth!.account.id;
      const { characterId, itemId } = request.params;
      return inventoryTransaction(app, async (tx) => {
        const character = await lockOwnedCharacter(tx, accountId, characterId, activity);
        const items = await loadItems(tx, characterId);
        const item = findItem(items, itemId);
        // Idempotent: unequipping an inventory item changes nothing. Inventory capacity is
        // ticket 1.6's rule; unequipping never destroys an item.
        if (item.equippedSlot !== null) {
          await setSlot(tx, item.id, null);
          item.equippedSlot = null;
        }
        return inventoryView(character, items, switches);
      });
    },
  );

  /**
   * Item lock (ticket 3.7): a locked item can't be sold, salvaged or discarded (and the loot filter
   * only ever sees new drops). Both directions are idempotent: locking a locked item changes
   * nothing. Moves no value, so no `Idempotency-Key` and no audit row (like equip).
   */
  for (const [action, locked] of [
    ['lock', true],
    ['unlock', false],
  ] as const) {
    app.post<{ Params: ItemParams }>(
      `/characters/:characterId/items/:itemId/${action}`,
      {
        preHandler: app.requireAccount,
        schema: {
          params: itemParamsSchema,
          body: emptyBodySchema,
          response: { 200: inventoryResponseSchema },
        },
      },
      async (request) => {
        const switches = await app.gameSettings.tradingSwitches();
        const accountId = request.auth!.account.id;
        const { characterId, itemId } = request.params;
        return inventoryTransaction(app, async (tx) => {
          const character = await lockOwnedCharacter(tx, accountId, characterId, activity);
          const items = await loadItems(tx, characterId);
          const item = findItem(items, itemId);
          if (item.locked !== locked) {
            await tx
              .update(itemInstances)
              .set({ locked })
              .where(
                and(eq(itemInstances.id, item.id), eq(itemInstances.characterId, characterId)),
              );
            item.locked = locked;
          }
          return inventoryView(character, items, switches);
        });
      },
    );
  }

  app.delete<{ Params: ItemParams }>(
    '/characters/:characterId/items/:itemId',
    {
      preHandler: app.requireAccount,
      schema: { params: itemParamsSchema, response: { 200: inventoryResponseSchema } },
    },
    async (request) => {
      const switches = await app.gameSettings.tradingSwitches();
      const accountId = request.auth!.account.id;
      const { characterId, itemId } = request.params;
      return inventoryTransaction(app, async (tx) => {
        const character = await lockOwnedCharacter(tx, accountId, characterId, activity);
        const items = await loadItems(tx, characterId);
        const item = findItem(items, itemId);
        if (item.equippedSlot !== null) {
          throw new ApiError(409, 'item_equipped', 'Unequip this item before discarding it.', {
            slot: item.equippedSlot,
          });
        }
        if (item.locked) throw itemLocked(item.id);
        await tx
          .delete(itemInstances)
          .where(and(eq(itemInstances.id, item.id), eq(itemInstances.characterId, characterId)));
        await writeAudit(tx, {
          event: 'item.discard',
          accountId,
          characterId,
          data: {
            itemId: item.id,
            baseId: item.baseId,
            rarityId: item.rarityId,
            itemLevel: item.itemLevel,
            seed: item.seed,
          },
        });
        recordTelemetry(tx, activity.now(), disposalCounts('item.discarded', [item]));
        return inventoryView(
          character,
          items.filter((i) => i.id !== item.id),
          switches,
        );
      });
    },
  );
}
