import { ITEM_BASES, type ItemTier } from '../items/bases.js';
import type { LootTableDefinition, LootTableEntry } from './config.js';

/** Every base of the tiers given, weighted per tier (a tier left out never drops). */
function tierEntries(weights: Partial<Record<ItemTier, number>>): LootTableEntry[] {
  return ITEM_BASES.flatMap((b) => {
    const weight = b.unique ? undefined : weights[b.tier];
    return weight ? [{ baseId: b.id, weight }] : [];
  });
}

/**
 * Loot tables of the Phase 2 areas and dungeon (ticket 2.1). Higher areas shift the weight to
 * higher tiers; each base is still gated by its `minItemLevel`. The item-level range is the
 * area's enemy levels ± `itemLevelVariance` (1).
 *
 * The Abandoned Fields table equals the Phase 1 `standard` table (balance is ticket B.1).
 */
export const AREA_LOOT_TABLES: readonly LootTableDefinition[] = [
  {
    id: 'abandonedFields',
    itemDropChance: 0.12,
    itemLevel: { min: 1, max: 7 },
    entries: tierEntries({ 1: 1 }),
  },
  {
    id: 'crowwood',
    itemDropChance: 0.12,
    itemLevel: { min: 4, max: 11 },
    entries: tierEntries({ 1: 2, 2: 1 }),
  },
  {
    id: 'oldBurialGrounds',
    itemDropChance: 0.12,
    itemLevel: { min: 8, max: 15 },
    entries: tierEntries({ 1: 1, 2: 2 }),
  },
  {
    id: 'blackwater',
    itemDropChance: 0.12,
    itemLevel: { min: 12, max: 19 },
    entries: tierEntries({ 1: 1, 2: 2, 3: 1 }),
  },
  {
    id: 'sunkenAbbey',
    itemDropChance: 0.12,
    itemLevel: { min: 16, max: 23 },
    entries: tierEntries({ 2: 1, 3: 2 }),
  },
  {
    id: 'namelessCrypt',
    itemDropChance: 0.18,
    itemLevel: { min: 11, max: 17 },
    entries: tierEntries({ 2: 2, 3: 1 }),
  },
];

/**
 * The Gravewarden's hoard (ticket 2.5): the three boss-exclusive bases weigh as much as all
 * tier-3 bases together. Rolled with `DungeonBossLoot.rarityWeights` (better odds than kills).
 */
export const BOSS_LOOT_TABLES: readonly LootTableDefinition[] = [
  {
    id: 'gravewarden',
    itemDropChance: 1,
    itemLevel: { min: 15, max: 17 },
    entries: [
      ...tierEntries({ 3: 1 }),
      { baseId: 'gravewardens-cowl', weight: 4 },
      { baseId: 'seal-of-the-nameless', weight: 4 },
      { baseId: 'wardens-bone-chain', weight: 4 },
    ],
  },
];
