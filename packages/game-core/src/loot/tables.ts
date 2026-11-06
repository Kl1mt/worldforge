import { ITEM_BASES, type ItemTier } from '../items/bases.js';
import type { LootFocus, LootTableDefinition, LootTableEntry } from './config.js';

/** Every base of the tiers given, weighted per tier (a tier left out never drops). */
function tierEntries(weights: Partial<Record<ItemTier, number>>): LootTableEntry[] {
  return ITEM_BASES.flatMap((b) => {
    const weight = b.unique ? undefined : weights[b.tier];
    return weight ? [{ baseId: b.id, weight }] : [];
  });
}

/**
 * Ticket 3.3: in the late-game sources (the Sunken Abbey, the Nameless Crypt and the Gravewarden's
 * hoard) half of the Legendary rolls at item level 14+ become a set piece (`ITEM_SETS`).
 */
export const SET_SHARE = 0.5;

/**
 * Ticket 3.5: in the same late-game sources, a Legendary or Mythic (set pieces included) is Void
 * this often (capped by `DEFAULT_LOOT_CONFIG.maxVoidChance`). See docs/EFFECTS.md for the rates.
 */
export const VOID_CHANCE = 0.1;

/**
 * Ticket 3.6: the loot focus of each Nameless Crypt tier. A tier's chambers and its Gravewarden
 * share it, so the player knows what a tier is for (docs/DUNGEONS.md, "Targeted loot").
 */
export const CRYPT_LOOT_FOCI = {
  /** Tier I: rings and amulets (every class wears them; the boss's seal and chain are jewelry). */
  1: {
    id: 'crypt-i',
    name: 'Rings and amulets',
    description: 'Rings and amulets drop three times as often.',
    slots: ['ring', 'neck'],
    slotWeight: 3,
  },
  /** Tier II: the martial set. */
  2: {
    id: 'crypt-ii',
    name: 'The Drowned Vigil',
    description: 'Every set piece found here is a piece of the Drowned Vigil.',
    sets: ['drowned-vigil'],
  },
  /** Tier III: the arcane set and the boss-killing effects. */
  3: {
    id: 'crypt-iii',
    name: 'The Ashen Choir and the slayer’s effects',
    description:
      'Every set piece found here is a piece of the Ashen Choir; Legendaries favour Tyrant’s Bane and Headsman’s Due.',
    sets: ['ashen-choir'],
    effects: ['tyrants-bane', 'headsmans-due'],
    effectWeight: 4,
  },
} as const satisfies Record<1 | 2 | 3, LootFocus>;

/**
 * Loot tables of the Phase 2 areas and dungeon (ticket 2.1). Higher areas shift the weight to
 * higher tiers; each base is still gated by its `minItemLevel`. The item-level range is the
 * area's enemy levels ± `itemLevelVariance` (1).
 *
 * Affix tiers (ticket 3.1): each area after the first adds `affixTierBias`, so the same item level
 * rolls better affixes in harder content; the crypt and its boss roll the best.
 *
 * Area kills drop an item 6 % of the time (ticket B.1; the Phase 1 `standard` table keeps 12 %):
 * about 35 items an hour, enough to stay geared without flooding the pack and the gold economy.
 */
export const AREA_LOOT_TABLES: readonly LootTableDefinition[] = [
  {
    id: 'abandonedFields',
    itemDropChance: 0.06,
    itemLevel: { min: 1, max: 7 },
    entries: tierEntries({ 1: 1 }),
  },
  {
    id: 'crowwood',
    affixTierBias: 0.15,
    itemDropChance: 0.06,
    itemLevel: { min: 4, max: 11 },
    entries: tierEntries({ 1: 2, 2: 1 }),
  },
  {
    id: 'oldBurialGrounds',
    affixTierBias: 0.3,
    itemDropChance: 0.06,
    itemLevel: { min: 8, max: 15 },
    entries: tierEntries({ 1: 1, 2: 2 }),
  },
  {
    id: 'blackwater',
    affixTierBias: 0.45,
    itemDropChance: 0.06,
    itemLevel: { min: 12, max: 19 },
    entries: tierEntries({ 1: 1, 2: 2, 3: 1 }),
  },
  {
    id: 'sunkenAbbey',
    affixTierBias: 0.6,
    mythics: true,
    setShare: SET_SHARE,
    voidChance: VOID_CHANCE,
    itemDropChance: 0.06,
    itemLevel: { min: 16, max: 23 },
    entries: tierEntries({ 2: 1, 3: 2 }),
  },
  {
    id: 'namelessCrypt',
    affixTierBias: 0.6,
    setShare: SET_SHARE,
    voidChance: VOID_CHANCE,
    itemDropChance: 0.18,
    itemLevel: { min: 11, max: 17 },
    entries: tierEntries({ 2: 2, 3: 1 }),
    focus: CRYPT_LOOT_FOCI[1],
  },
  // Ticket 3.6: the chambers of the deeper crypt tiers (docs/DUNGEONS.md).
  {
    id: 'namelessCryptII',
    affixTierBias: 0.8,
    setShare: SET_SHARE,
    voidChance: VOID_CHANCE,
    itemDropChance: 0.18,
    itemLevel: { min: 17, max: 22 },
    entries: tierEntries({ 2: 1, 3: 2 }),
    focus: CRYPT_LOOT_FOCI[2],
  },
  {
    id: 'namelessCryptIII',
    affixTierBias: 1,
    setShare: SET_SHARE,
    voidChance: VOID_CHANCE,
    itemDropChance: 0.18,
    itemLevel: { min: 20, max: 25 },
    entries: tierEntries({ 3: 1 }),
    focus: CRYPT_LOOT_FOCI[3],
  },
];

const BOSS_EXCLUSIVE: readonly LootTableEntry[] = [
  { baseId: 'gravewardens-cowl', weight: 4 },
  { baseId: 'seal-of-the-nameless', weight: 4 },
  { baseId: 'wardens-bone-chain', weight: 4 },
];

/**
 * The Gravewarden's hoard (ticket 2.5): the three boss-exclusive bases weigh as much as all
 * tier-3 bases together. Rolled with `DungeonBossLoot.rarityWeights` (better odds than kills).
 */
export const BOSS_LOOT_TABLES: readonly LootTableDefinition[] = [
  {
    id: 'gravewarden',
    affixTierBias: 1,
    mythics: true,
    setShare: SET_SHARE,
    voidChance: VOID_CHANCE,
    itemDropChance: 1,
    itemLevel: { min: 15, max: 17 },
    entries: [...tierEntries({ 3: 1 }), ...BOSS_EXCLUSIVE],
    focus: CRYPT_LOOT_FOCI[1],
  },
  // Ticket 3.6: the Gravewarden of the deeper tiers (same bases, better rolls, its tier's focus).
  {
    id: 'gravewardenII',
    affixTierBias: 1.2,
    mythics: true,
    setShare: SET_SHARE,
    voidChance: VOID_CHANCE,
    itemDropChance: 1,
    itemLevel: { min: 20, max: 22 },
    entries: [...tierEntries({ 3: 1 }), ...BOSS_EXCLUSIVE],
    focus: CRYPT_LOOT_FOCI[2],
  },
  {
    id: 'gravewardenIII',
    affixTierBias: 1.4,
    mythics: true,
    setShare: SET_SHARE,
    voidChance: VOID_CHANCE,
    itemDropChance: 1,
    itemLevel: { min: 23, max: 25 },
    entries: [...tierEntries({ 3: 1 }), ...BOSS_EXCLUSIVE],
    focus: CRYPT_LOOT_FOCI[3],
  },
];
