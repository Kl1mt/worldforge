import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { itemInstances, type ItemInstance } from '../db/schema.js';
import { ApiError } from '../errors.js';

/**
 * Where an item is (ticket 4.7). An item row is worn (`equipped_slot` set), in the pack, in its
 * character's warehouse (`in_warehouse`) or, since T.3, on its account's shared shelf (`on_shelf`).
 * Kept free of route imports so settlement can use it.
 */

/**
 * Ticket 4.7: an item in the pack (not equipped, not in the warehouse, and since T.3 not on the
 * account shelf). Every pack-capacity count, sell/salvage/discard pick and the pack listing go
 * through this predicate (or `packItemsWhere`). Since T.5 an item in a trade offer's escrow is
 * not in the pack either.
 */
export const isPackItem = (
  i: Pick<ItemInstance, 'equippedSlot' | 'inWarehouse' | 'onShelf'> & {
    escrowOfferId?: string | null;
  },
): boolean => i.equippedSlot === null && !i.inWarehouse && !i.onShelf && !i.escrowOfferId;

/** SQL form of `isPackItem` for one character's items. */
export function packItemsWhere(characterId: string): SQL {
  return and(
    eq(itemInstances.characterId, characterId),
    isNull(itemInstances.equippedSlot),
    eq(itemInstances.inWarehouse, false),
    eq(itemInstances.onShelf, false),
    isNull(itemInstances.escrowOfferId),
  )!;
}

/** Ticket 4.7: a stored item must come back to the pack before anything else can use it. */
export const itemInWarehouse = (itemId: string) =>
  new ApiError(409, 'item_in_warehouse', 'This item is in the warehouse. Take it out first.', {
    itemId,
  });

/** Ticket T.3: an item on the account shelf must be taken out to a hero before anything uses it. */
export const itemOnShelf = (itemId: string) =>
  new ApiError(
    409,
    'item_on_shelf',
    'This item is on the account shelf. Take it out to a hero first.',
    { itemId },
  );

/**
 * The location refusals for an action on a hero's item (trade escrow, shelf, warehouse), in that
 * order. Equip,
 * sell, salvage, discard, lock and every Forge action call it.
 */
export function assertItemInReach(
  item: Pick<ItemInstance, 'id' | 'inWarehouse' | 'onShelf'> & { escrowOfferId?: string | null },
): void {
  if (item.escrowOfferId) throw itemInOffer(item.id);
  if (item.onShelf) throw itemOnShelf(item.id);
  if (item.inWarehouse) throw itemInWarehouse(item.id);
}

/** Ticket T.5: an item in an open trade offer is in escrow until the offer ends. */
export const itemInOffer = (itemId: string) =>
  new ApiError(
    409,
    'item_in_offer',
    'This item is in a trade offer. Cancel the offer to get it back.',
    { itemId },
  );

/**
 * Ticket T.5 (docs/TRADING.md "Cooldowns"): an item received in a trade is held for 72 hours. It
 * can be worn, but not sold, salvaged, discarded, forged, stored in the Warehouse, shelved or
 * traded until `hold_until` passes the transaction's clock.
 */
export function assertItemNotHeld(item: Pick<ItemInstance, 'id' | 'holdUntil'>, now: Date): void {
  if (item.holdUntil && item.holdUntil.getTime() > now.getTime()) {
    throw new ApiError(
      409,
      'item_held',
      'This item was received in a trade and is held for 72 hours. You can wear it meanwhile.',
      { itemId: item.id, holdUntil: item.holdUntil.toISOString() },
    );
  }
}
