import {
  itemBindingState,
  type GeneratedItem,
  type ItemBinding,
  type ItemVariantId,
} from '@worldforge/game-core';

/**
 * The effect, set and variant columns of a freshly generated item (tickets 3.2, 3.3, 3.5), for
 * inserts that list columns. Persist the rolled result, not only the seed (docs/DATA_MODEL.md).
 */
export function itemEffectColumns(item: GeneratedItem): {
  effectId: string | null;
  effectRoll: number | null;
  mythicId: string | null;
  setId: string | null;
  variant: ItemVariantId | null;
} {
  return {
    effectId: item.effectId ?? null,
    effectRoll: item.effectRoll ?? null,
    mythicId: item.mythicId ?? null,
    setId: item.setId ?? null,
    variant: item.variant ?? null,
  };
}

/**
 * Ticket T.1: the binding columns of a newly created item (docs/TRADING.md "1. Item binding"):
 * game-core's state for its rarity, variant, set and stored `source`, bound to `accountId` when
 * account-bound. Every insert of an item writes them.
 */
export function itemBindingColumns(
  item: Pick<GeneratedItem, 'rarityId' | 'variant' | 'setId' | 'affixes'>,
  source: string,
  accountId: string,
): { binding: ItemBinding; boundAccountId: string | null } {
  const { binding } = itemBindingState({ ...item, source });
  return { binding, boundAccountId: binding === 'account' ? accountId : null };
}
