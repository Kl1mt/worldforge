import type { GeneratedItem } from '@worldforge/game-core';

/**
 * The effect columns of a freshly generated item (ticket 3.2), for inserts that list columns.
 * Persist the rolled result, not only the seed (docs/DATA_MODEL.md).
 */
export function itemEffectColumns(item: GeneratedItem): {
  effectId: string | null;
  effectRoll: number | null;
  mythicId: string | null;
} {
  return {
    effectId: item.effectId ?? null,
    effectRoll: item.effectRoll ?? null,
    mythicId: item.mythicId ?? null,
  };
}
