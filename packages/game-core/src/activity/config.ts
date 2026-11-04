import type { RarityId } from '../rarity.js';

/**
 * Caps on secondary modifiers summed from equipment (GDD §6.2: "These need caps or diminishing
 * returns"). Applied before the value reaches `rollLoot`.
 */
export interface ModifierCaps {
  /** Maximum total gold find as a fraction (1 = +100 %). */
  goldFind: number;
}

export interface InventoryConfig {
  /** Unequipped items a character can hold. Items granted beyond this are salvaged to gold. */
  capacity: number;
  /** Salvage value of an overflow item: `round((base + perItemLevel · itemLevel) · rarity)`, ≥ 1. */
  salvage: {
    base: number;
    perItemLevel: number;
    rarityMultiplier: Readonly<Record<RarityId, number>>;
  };
}

export interface ActivityConfig {
  modifierCaps: ModifierCaps;
  inventory: InventoryConfig;
}

export const DEFAULT_ACTIVITY_CONFIG: ActivityConfig = {
  modifierCaps: { goldFind: 1 },
  inventory: {
    capacity: 60,
    salvage: {
      base: 2,
      perItemLevel: 0.5,
      rarityMultiplier: {
        common: 1,
        uncommon: 2,
        rare: 4,
        epic: 8,
        legendary: 16,
        mythic: 32,
      },
    },
  },
};
