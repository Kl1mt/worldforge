import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  MATERIAL_IDS,
  type MaterialId,
  type RolledAffix,
  type RarityId,
} from '@worldforge/game-core';
import { characters, itemInstances, type Character, type ItemInstance } from '../db/schema.js';
import type { Transaction } from '../db/types.js';
import { ApiError } from '../errors.js';
import { characterSchema } from '../characters/routes.js';
import { assertItemInReach, itemLocked, itemSchema } from '../inventory/routes.js';
import { heldValueOf } from '../shelf/held.js';
import { assertItemNotHeld } from '../inventory/location.js';

/** Shared pieces of the merchant and forge endpoints (ticket 2.6). */

export interface MaterialStack {
  materialId: MaterialId;
  quantity: number;
}

/** A bundle as a list in content order (positive quantities only). */
export function materialList(bundle: Partial<Record<MaterialId, number>>): MaterialStack[] {
  return MATERIAL_IDS.filter((id) => (bundle[id] ?? 0) > 0).map((materialId) => ({
    materialId,
    quantity: bundle[materialId]!,
  }));
}

/** An item that is not (yet) owned: a merchant offer. */
export interface ItemPreview {
  baseId: string;
  rarityId: RarityId;
  itemLevel: number;
  affixes: RolledAffix[];
}

export const materialListSchema = {
  type: 'array',
  items: {
    type: 'object',
    required: ['materialId', 'quantity'],
    properties: { materialId: { type: 'string' }, quantity: { type: 'integer' } },
  },
} as const;

export const itemPreviewSchema = {
  type: 'object',
  required: ['baseId', 'rarityId', 'itemLevel', 'affixes'],
  properties: {
    baseId: itemSchema.properties.baseId,
    rarityId: itemSchema.properties.rarityId,
    itemLevel: itemSchema.properties.itemLevel,
    affixes: itemSchema.properties.affixes,
  },
} as const;

export { characterSchema };

/** Body of sell and salvage: distinct inventory item ids. */
export const itemIdsBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['itemIds'],
  properties: {
    itemIds: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
      items: { type: 'string', format: 'uuid' },
    },
  },
} as const;

/**
 * The named unequipped items of the character, from rows loaded under the character lock.
 * `404` for an id that is not this character's (ids can't be probed), `409 item_equipped` for an
 * equipped one, `409 item_locked` for a locked one (ticket 3.7). All or nothing.
 */
export function pickInventoryItems(
  items: readonly ItemInstance[],
  itemIds: readonly string[],
  now: Date,
): ItemInstance[] {
  return itemIds.map((id) => {
    const item = items.find((i) => i.id === id);
    if (!item) throw new ApiError(404, 'not_found', 'No such item.', { itemId: id });
    // Ticket 4.7: a stored item is never sold or salvaged until it is back in the pack (T.3: nor
    // one on the account shelf).
    assertItemInReach(item);
    if (item.equippedSlot !== null) {
      throw new ApiError(409, 'item_equipped', 'Unequip this item first.', {
        itemId: id,
        slot: item.equippedSlot,
      });
    }
    // Ticket 3.7: locked items can't be sold or salvaged (or used up any other way).
    if (item.locked) throw itemLocked(id);
    // Ticket T.5: an item received in a trade is held for 72 hours (worn, never sold or salvaged).
    assertItemNotHeld(item, now);
    return item;
  });
}

export async function deleteItems(
  tx: Transaction,
  characterId: string,
  itemIds: readonly string[],
): Promise<void> {
  // `locked = false`, `equipped_slot is null`, `in_warehouse = false` and `on_shelf = false` are a backstop to the checks made under the lock
  // (`pickInventoryItems`): a delete that misses any row rolls the whole action back.
  const deleted = await tx
    .delete(itemInstances)
    .where(
      and(
        eq(itemInstances.characterId, characterId),
        inArray(itemInstances.id, [...itemIds]),
        eq(itemInstances.locked, false),
        isNull(itemInstances.equippedSlot),
        eq(itemInstances.inWarehouse, false),
        eq(itemInstances.onShelf, false),
        isNull(itemInstances.escrowOfferId),
      ),
    )
    .returning({ id: itemInstances.id });
  if (deleted.length !== itemIds.length) {
    throw new ApiError(409, 'conflict', 'The pack changed meanwhile. Try again.');
  }
}

/**
 * Adds `delta` gold (negative spends) and returns the updated row. Call under the character lock
 * after checking affordability; the `gold >= 0` check constraint is the backstop.
 *
 * Ticket T.5: **every gold spend goes through here**, and a spend may not dip into held gold
 * (received in a trade under 72 hours ago, `heldValueOf` at `now`, the transaction's clock): the
 * update only applies while `gold + delta >= held`, otherwise `422 insufficient_gold` with
 * `onHold`. `spend-paths.test.ts` fails if a new path writes a hero's gold another way.
 */
export async function changeGold(
  tx: Transaction,
  character: Character,
  delta: number,
  now: Date,
): Promise<Character> {
  const held = delta < 0 ? (await heldValueOf(tx, character.id, now)).gold : 0;
  const [row] = await tx
    .update(characters)
    .set({
      gold: sql`${characters.gold} + ${delta}`,
      version: sql`${characters.version} + 1`,
      updatedAt: now,
    })
    .where(
      delta < 0 && held > 0
        ? and(eq(characters.id, character.id), sql`${characters.gold} + ${delta} >= ${held}`)
        : eq(characters.id, character.id),
    )
    .returning();
  if (!row) {
    const [current] = await tx
      .select({ gold: characters.gold })
      .from(characters)
      .where(eq(characters.id, character.id));
    throw heldGoldRefusal(-delta, current?.gold ?? 0, held);
  }
  return row;
}

/** `422 insufficient_gold` when the purse has the gold but part of it is held (T.5). */
export function heldGoldRefusal(required: number, gold: number, onHold: number): ApiError {
  return new ApiError(
    422,
    'insufficient_gold',
    'Not enough gold. Gold received in a trade is held for 72 hours before it can be spent.',
    { required, held: gold, onHold, spendable: Math.max(0, gold - onHold) },
  );
}

export function insufficientGold(required: number, held: number): ApiError {
  return new ApiError(422, 'insufficient_gold', 'Not enough gold.', { required, held });
}

export function inventoryFull(capacity: number): ApiError {
  return new ApiError(422, 'inventory_full', 'The pack is full. Sell or salvage something first.', {
    capacity,
  });
}
