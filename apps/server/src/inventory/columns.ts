import type { GeneratedItem, ItemVariantId } from '@worldforge/game-core';

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
