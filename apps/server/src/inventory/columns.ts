import type { GeneratedItem } from '@worldforge/game-core';

/**
 * The effect and set columns of a freshly generated item (tickets 3.2, 3.3), for inserts that
 * list columns. Persist the rolled result, not only the seed (docs/DATA_MODEL.md).
 */
export function itemEffectColumns(item: GeneratedItem): {
  effectId: string | null;
  effectRoll: number | null;
  mythicId: string | null;
  setId: string | null;
} {
  return {
    effectId: item.effectId ?? null,
    effectRoll: item.effectRoll ?? null,
    mythicId: item.mythicId ?? null,
    setId: item.setId ?? null,
  };
}
