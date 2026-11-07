import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { itemInstances, type ItemInstance } from '../db/schema.js';
import { ApiError } from '../errors.js';

/**
 * Where an item is (ticket 4.7). An item row is worn (`equipped_slot` set), in the pack, or in its
 * character's warehouse (`in_warehouse`). Kept free of route imports so settlement can use it.
 */

/**
 * Ticket 4.7: an item in the pack (not equipped, not in the warehouse). Every pack-capacity count,
 * sell/salvage/discard pick and the pack listing go through this predicate (or `packItemsWhere`).
 */
export const isPackItem = (i: Pick<ItemInstance, 'equippedSlot' | 'inWarehouse'>): boolean =>
  i.equippedSlot === null && !i.inWarehouse;

/** SQL form of `isPackItem` for one character's items. */
export function packItemsWhere(characterId: string): SQL {
  return and(
    eq(itemInstances.characterId, characterId),
    isNull(itemInstances.equippedSlot),
    eq(itemInstances.inWarehouse, false),
  )!;
}

/** Ticket 4.7: a stored item must come back to the pack before anything else can use it. */
export const itemInWarehouse = (itemId: string) =>
  new ApiError(409, 'item_in_warehouse', 'This item is in the warehouse. Take it out first.', {
    itemId,
  });
