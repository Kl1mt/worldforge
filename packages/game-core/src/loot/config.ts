import type { RarityId } from '../rarity.js';
import { ITEM_BASES, type ItemSlotKind } from '../items/bases.js';
import { AREA_LOOT_TABLES, BOSS_LOOT_TABLES } from './tables.js';

export interface RarityRule {
  /**
   * Relative drop weight when an item drops. 0 disables the rarity (it never rolls).
   * Weights need not sum to anything; probabilities are weight / total.
   */
  weight: number;
  /** Number of random affixes (capped by the affixes available for the slot). */
  affixCount: number;
  /** Multiplier on the base's implicit stats. */
  statMultiplier: number;
  /**
   * Ticket 3.1: affix tiers unlock this many item levels early on this rarity (an Epic of item
   * level 18 can roll tiers that normally need level 20).
   */
  affixLevelBonus: number;
  /**
   * Ticket 3.1: shifts affix tier weights toward higher tiers. A tier's weight is multiplied by
   * `(1 + bias)^(tier − 1)`, where bias is this plus the loot table's `affixTierBias`.
   */
  affixTierBias: number;
}

export interface GoldRule {
  /** Chance per kill that gold drops at all. */
  dropChance: number;
  /** Amount range at source level 1. */
  min: number;
  max: number;
  /** Amount grows by this fraction per source level above 1. */
  growthPerLevel: number;
}

/**
 * Ticket 3.6: what a source favours, so a player can plan toward a build instead of farming
 * blind. Any combination of a set, a slot group and an effect family. A focus only reweights draws
 * the generator makes anyway (the base pick, the set-piece pick, the Legendary effect pick), so it
 * never adds or removes a draw: every drop path stays deterministic and split-invariant.
 */
export interface LootFocus {
  /** Stable id, e.g. `crypt-i`. */
  id: string;
  /** Short label for the UI, e.g. "Rings and amulets". */
  name: string;
  /** One line for the UI. */
  description: string;
  /** Set pieces: a set-piece roll here picks only pieces of these sets (`ITEM_SETS` ids). */
  sets?: readonly string[];
  /** Slot group: bases of these slot kinds weigh `slotWeight` × as much. */
  slots?: readonly ItemSlotKind[];
  slotWeight?: number;
  /** Effect family: these Legendary effects weigh `effectWeight` × as much. */
  effects?: readonly string[];
  effectWeight?: number;
}

export interface LootTableEntry {
  baseId: string;
  weight: number;
}

export interface LootTableDefinition {
  id: string;
  /** Chance per kill that one item drops. */
  itemDropChance: number;
  /** Inclusive range the rolled item level is clamped to (after `LootConfig` clamping). */
  itemLevel?: { min: number; max: number };
  entries: readonly LootTableEntry[];
  /**
   * Ticket 3.1: higher-tier areas and the crypt roll better affixes. Added to the rarity's
   * `affixTierBias`. Default 0.
   */
  affixTierBias?: number;
  /**
   * Ticket 4.8: multiplies the kill gold rolled here (after the roll, so no extra draw). Default 1.
   * The Ashen Pass's foes take longer to kill; this keeps its gold per hour above the Abbey's.
   */
  goldMultiplier?: number;
  /**
   * Ticket 3.2: a Mythic rarity roll here picks a named Mythic (`MYTHIC_ITEMS`). Only late-game
   * sources set it; elsewhere a Mythic roll becomes a Legendary.
   */
  mythics?: boolean;
  /**
   * Ticket 3.3: the share (0…1) of Legendary rolls here that become a set piece (`ITEM_SETS`)
   * instead. Only late-game sources set it. Default 0.
   */
  setShare?: number;
  /**
   * Ticket B.2: multiplies the Legendary rarity weight of rolls here (default 1). The late-game
   * sources use `LEGENDARY_WEIGHT` so that, with `SET_SHARE` pieces taken from those rolls, plain
   * Legendaries drop about as often as before ticket 3.3 (docs/LOOT.md).
   */
  legendaryWeight?: number;
  /**
   * Ticket 3.5: the chance (0…1) that a Legendary or Mythic here (set pieces included) is Void,
   * clamped to `LootConfig.maxVoidChance`. Only late-game sources set it. Default 0.
   */
  voidChance?: number;
  /** Ticket 3.6: the table's loot focus (dungeon tiers and their bosses). */
  focus?: LootFocus;
  /**
   * Ticket 6.3: the week's boss modifier's small focus, on top of `focus` (a boss hoard only). Its
   * slot and effect weights multiply those of `focus`; it never limits set pieces. Absent = none.
   */
  modifierFocus?: LootFocus;
}

export interface LootConfig {
  rarities: Readonly<Record<RarityId, RarityRule>>;
  gold: GoldRule;
  /** Item level = source level ± this, clamped to [1, maxItemLevel]. */
  itemLevelVariance: number;
  maxItemLevel: number;
  /**
   * Ticket 3.5: the hard cap on any table's `voidChance` (GDD §7.5: variant discovery stays
   * strictly capped, also once a progression hook raises it).
   */
  maxVoidChance: number;
}

/**
 * Drop rates. Legendaries roll one effect from the registry (ticket 3.2); a Mythic roll is a
 * named Mythic in a table with `mythics` and a Legendary elsewhere. Set a weight to 0 to disable a
 * rarity.
 */
export const DEFAULT_LOOT_CONFIG: LootConfig = {
  rarities: {
    common: {
      weight: 6000,
      affixCount: 0,
      statMultiplier: 1,
      affixLevelBonus: 0,
      affixTierBias: 0,
    },
    uncommon: {
      weight: 2600,
      affixCount: 1,
      statMultiplier: 1.1,
      affixLevelBonus: 0,
      affixTierBias: 0,
    },
    rare: {
      weight: 1000,
      affixCount: 2,
      statMultiplier: 1.2,
      affixLevelBonus: 0,
      affixTierBias: 0.25,
    },
    epic: {
      weight: 350,
      affixCount: 3,
      statMultiplier: 1.35,
      affixLevelBonus: 2,
      affixTierBias: 0.5,
    },
    legendary: {
      weight: 45,
      affixCount: 4,
      statMultiplier: 1.5,
      affixLevelBonus: 4,
      affixTierBias: 1,
    },
    mythic: {
      weight: 5,
      affixCount: 5,
      statMultiplier: 1.7,
      affixLevelBonus: 6,
      affixTierBias: 1.5,
    },
  },
  gold: { dropChance: 0.2, min: 1, max: 3, growthPerLevel: 0.1 },
  itemLevelVariance: 1,
  maxItemLevel: 60,
  maxVoidChance: 0.15,
};

/**
 * Default table: every Phase 1 (tier 1) base, equally weighted (gated by each base's
 * minItemLevel). Used when no table is given; settlement uses the area's table (ticket 2.1).
 */
export const STANDARD_LOOT_TABLE: LootTableDefinition = {
  id: 'standard',
  itemDropChance: 0.12,
  entries: ITEM_BASES.filter((b) => b.tier === 1).map((b) => ({ baseId: b.id, weight: 1 })),
};

export const LOOT_TABLES: readonly LootTableDefinition[] = [
  STANDARD_LOOT_TABLE,
  ...AREA_LOOT_TABLES,
  ...BOSS_LOOT_TABLES,
];

const LOOT_TABLES_BY_ID = new Map(LOOT_TABLES.map((t) => [t.id, t]));

export function findLootTable(id: string): LootTableDefinition | undefined {
  return LOOT_TABLES_BY_ID.get(id);
}

export function getLootTable(id: string): LootTableDefinition {
  const table = LOOT_TABLES_BY_ID.get(id);
  if (!table) throw new Error(`Unknown loot table: ${id}`);
  return table;
}
