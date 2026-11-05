import type { RarityId } from '../rarity.js';

/**
 * Caps on secondary modifiers summed from equipment (GDD §6.2: "These need caps or diminishing
 * returns"). Applied before the value reaches `rollLoot`.
 */
export interface ModifierCaps {
  /** Maximum total gold find as a fraction (1 = +100 %). */
  goldFind: number;
  /** Ticket 3.1. Maximum total item find (scales the per-kill item drop chance). */
  itemFind: number;
  /** Ticket 3.1. Maximum total XP gain. */
  xpGain: number;
  /** Ticket 3.1. Maximum total resource yield (scales units per gathering find). */
  resourceYield: number;
  /** Ticket 3.1. Maximum total boss damage. */
  bossDamage: number;
  /** Ticket 3.1. Maximum total auto-skill damage bonus. */
  skillDamage: number;
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
  modifierCaps: {
    goldFind: 1,
    itemFind: 0.5,
    xpGain: 0.3,
    resourceYield: 0.5,
    bossDamage: 0.25,
    skillDamage: 0.25,
  },
  inventory: {
    capacity: 60,
    salvage: {
      base: 0.5,
      perItemLevel: 0.15,
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
