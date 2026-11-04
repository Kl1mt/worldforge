import { and, eq, inArray, sql } from 'drizzle-orm';
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
import { itemSchema } from '../inventory/routes.js';

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
 * equipped one.
 */
export function pickInventoryItems(
  items: readonly ItemInstance[],
  itemIds: readonly string[],
): ItemInstance[] {
  return itemIds.map((id) => {
    const item = items.find((i) => i.id === id);
    if (!item) throw new ApiError(404, 'not_found', 'No such item.', { itemId: id });
    if (item.equippedSlot !== null) {
      throw new ApiError(409, 'item_equipped', 'Unequip this item first.', {
        itemId: id,
        slot: item.equippedSlot,
      });
    }
    return item;
  });
}

export async function deleteItems(
  tx: Transaction,
  characterId: string,
  itemIds: readonly string[],
): Promise<void> {
  await tx
    .delete(itemInstances)
    .where(
      and(eq(itemInstances.characterId, characterId), inArray(itemInstances.id, [...itemIds])),
    );
}

/**
 * Adds `delta` gold (negative spends) and returns the updated row. Call under the character lock
 * after checking affordability; the `gold >= 0` check constraint is the backstop.
 */
export async function changeGold(
  tx: Transaction,
  character: Character,
  delta: number,
  now: Date,
): Promise<Character> {
  const [row] = await tx
    .update(characters)
    .set({
      gold: sql`${characters.gold} + ${delta}`,
      version: sql`${characters.version} + 1`,
      updatedAt: now,
    })
    .where(eq(characters.id, character.id))
    .returning();
  return row!;
}

export function insufficientGold(required: number, held: number): ApiError {
  return new ApiError(422, 'insufficient_gold', 'Not enough gold.', { required, held });
}

export function inventoryFull(capacity: number): ApiError {
  return new ApiError(422, 'inventory_full', 'The pack is full. Sell or salvage something first.', {
    capacity,
  });
}
