import type { RarityId } from '../rarity.js';
import { ITEM_BASES } from '../items/bases.js';
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
}

export interface LootConfig {
  rarities: Readonly<Record<RarityId, RarityRule>>;
  gold: GoldRule;
  /** Item level = source level ± this, clamped to [1, maxItemLevel]. */
  itemLevelVariance: number;
  maxItemLevel: number;
}

/**
 * Phase 1 drop rates. Legendary and Mythic are enabled but have no unique effects yet
 * (GDD §7.4 is Phase 3): they roll as stronger stat items — more affixes and a higher
 * implicit multiplier. Set a weight to 0 to disable a rarity.
 */
export const DEFAULT_LOOT_CONFIG: LootConfig = {
  rarities: {
    common: { weight: 6000, affixCount: 0, statMultiplier: 1 },
    uncommon: { weight: 2600, affixCount: 1, statMultiplier: 1.1 },
    rare: { weight: 1000, affixCount: 2, statMultiplier: 1.2 },
    epic: { weight: 350, affixCount: 3, statMultiplier: 1.35 },
    legendary: { weight: 45, affixCount: 4, statMultiplier: 1.5 },
    mythic: { weight: 5, affixCount: 5, statMultiplier: 1.7 },
  },
  gold: { dropChance: 0.6, min: 1, max: 4, growthPerLevel: 0.15 },
  itemLevelVariance: 1,
  maxItemLevel: 60,
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
