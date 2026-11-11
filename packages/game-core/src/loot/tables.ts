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
 * hoard) a share of the Legendary rolls at item level 14+ becomes a set piece (`ITEM_SETS`).
 * Ticket B.2: a third (was half), with Legendary rolls 1.5 × as likely there (`LEGENDARY_WEIGHT`):
 * set pieces drop as often as before, plain Legendaries as often as before 3.3 took half of them.
 */
export const SET_SHARE = 1 / 3;

/** Ticket B.2: the Legendary weight multiplier of the late-game sources (see `SET_SHARE`). */
export const LEGENDARY_WEIGHT = 1.5;

/**
 * Ticket 3.5: in the same late-game sources, a Legendary or Mythic (set pieces included) is Void
 * this often (capped by `DEFAULT_LOOT_CONFIG.maxVoidChance`). See docs/EFFECTS.md for the rates.
 */
export const VOID_CHANCE = 0.1;

/**
 * Ticket 6.3: the Heroic crypt's top-rarity odds. Legendary rolls weigh × 2.5 (the late-game
 * sources × 1.5) and a Legendary or Mythic is Void 15 % of the time (the cap,
 * `DEFAULT_LOOT_CONFIG.maxVoidChance`). Item levels and affix tiers stay inside today's bands.
 */
export const HEROIC_LEGENDARY_WEIGHT = 2.5;
export const HEROIC_VOID_CHANCE = 0.15;

/**
 * Ticket 6.4: in Ashen-tier and newer content (the Ashen Pass and the Warden's Watch, the Ashfall
 * Verge, the Cinder Depths and the Tyrant's Forge, the Heroic crypt), a Legendary or Mythic (set
 * pieces included) that did not become Void is Prismatic this often: 5 % (4.5 % of all such
 * rolls, against Void's 10 %), in the Heroic crypt 7.5 % (6.4 %, against 15 %). Capped by
 * `DEFAULT_LOOT_CONFIG.maxPrismaticChance`. Older sources never drop it. See docs/EFFECTS.md.
 */
export const PRISMATIC_CHANCE = 0.05;
export const HEROIC_PRISMATIC_CHANCE = 0.075;

/** Ticket 6.4: the tables that roll Prismatic (each source of the Ashen tier and newer). */
export const PRISMATIC_TABLE_IDS = [
  'ashenPass',
  'ashenWarden',
  'ashfallVerge',
  'cinderDepths',
  'forgeTyrant',
  'namelessCryptIV',
  'gravewardenIV',
  // Ticket 8.1: the Hollow Reach.
  'paleMarches',
] as const;

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
  /**
   * Tier IV, Heroic (ticket 6.3): no slot, set or effect is favoured; its tables raise the odds of
   * the top rarities instead (`HEROIC_LEGENDARY_WEIGHT`, `HEROIC_VOID_CHANCE`, its boss weights).
   */
  4: {
    id: 'crypt-iv',
    name: 'Heroic spoils',
    description:
      'Legendaries, Mythics, set pieces, Void and Prismatic items drop far more often than in Tier III, at the item levels of the Cinderwastes.',
  },
} as const satisfies Record<1 | 2 | 3 | 4, LootFocus>;

/** Ticket 4.8: the loot focus of the Ashen Warden's hoard (docs/DUNGEONS.md, "The Warden's Watch"). */
export const ASHEN_WARDEN_FOCUS = {
  id: 'ashen-warden',
  name: 'The Warden’s armoury',
  description: 'Weapons and off-hands drop three times as often.',
  slots: ['weapon', 'offhand'],
  slotWeight: 3,
} as const satisfies LootFocus;

/** Ticket 6.2: the loot focus of the Forge Tyrant's hoard (docs/DUNGEONS.md, "The Tyrant's Forge"). */
export const FORGE_TYRANT_FOCUS = {
  id: 'forge-tyrant',
  name: 'The Tyrant’s anvil',
  description: 'Helms, chest pieces, gloves and boots drop twice as often.',
  slots: ['head', 'chest', 'hands', 'feet'],
  slotWeight: 2,
} as const satisfies LootFocus;

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
    legendaryWeight: LEGENDARY_WEIGHT,
    voidChance: VOID_CHANCE,
    itemDropChance: 0.06,
    itemLevel: { min: 16, max: 23 },
    entries: tierEntries({ 2: 1, 3: 2 }),
  },
  {
    id: 'namelessCrypt',
    affixTierBias: 0.6,
    setShare: SET_SHARE,
    legendaryWeight: LEGENDARY_WEIGHT,
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
    legendaryWeight: LEGENDARY_WEIGHT,
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
    legendaryWeight: LEGENDARY_WEIGHT,
    voidChance: VOID_CHANCE,
    itemDropChance: 0.18,
    itemLevel: { min: 20, max: 25 },
    entries: tierEntries({ 3: 1 }),
    focus: CRYPT_LOOT_FOCI[3],
  },
  // Ticket 6.3: the Heroic chambers. Item levels 31–37 (foes 32–36 ± 1, inside the Verge's 29–35 and the Depths'
  // 35–41), tier-3 and tier-4 bases, the Heroic top-rarity odds and Mythics.
  {
    id: 'namelessCryptIV',
    affixTierBias: 1,
    mythics: true,
    setShare: SET_SHARE,
    legendaryWeight: HEROIC_LEGENDARY_WEIGHT,
    voidChance: HEROIC_VOID_CHANCE,
    prismaticChance: HEROIC_PRISMATIC_CHANCE,
    itemDropChance: 0.18,
    itemLevel: { min: 31, max: 37 },
    entries: tierEntries({ 3: 1, 4: 2 }),
    focus: CRYPT_LOOT_FOCI[4],
  },
  // Ticket 4.8: the Ashen Pass (levels 24–28). Tier-3 bases only, at item levels above every other
  // source (23–29: tier-4 affixes unlock at 25), with the crypt II chambers' affix bias. Legendary,
  // set, Mythic and Void odds are the Abbey's: the Pass pays in item level, affix depth and gold
  // (× 1.6 per kill: its foes take longer to kill, so a kill pays more).
  {
    id: 'ashenPass',
    affixTierBias: 0.8,
    goldMultiplier: 1.6,
    mythics: true,
    setShare: SET_SHARE,
    legendaryWeight: LEGENDARY_WEIGHT,
    voidChance: VOID_CHANCE,
    prismaticChance: PRISMATIC_CHANCE,
    itemDropChance: 0.06,
    itemLevel: { min: 23, max: 29 },
    entries: tierEntries({ 3: 1 }),
  },
  // Ticket 6.1: the Ashfall Verge (the Cinderwastes, levels 28–34). Tier-4 bases only, item levels
  // 29–35 (tier-5 affixes from 31, never below 30), the Pass's late-game odds and a deeper affix
  // bias; gold × 2.3 (its foes take longer to kill than the Pass's).
  {
    id: 'ashfallVerge',
    affixTierBias: 1,
    goldMultiplier: 2.3,
    mythics: true,
    setShare: SET_SHARE,
    legendaryWeight: LEGENDARY_WEIGHT,
    voidChance: VOID_CHANCE,
    prismaticChance: PRISMATIC_CHANCE,
    itemDropChance: 0.06,
    itemLevel: { min: 29, max: 35 },
    entries: tierEntries({ 4: 1 }),
  },
  // Ticket 6.2: the Cinder Depths (levels 34–40). The Verge's table one band higher: tier-4 bases,
  // item levels 35–41 (more tier-5 affixes), the same late-game odds and affix bias.
  {
    id: 'cinderDepths',
    affixTierBias: 1,
    goldMultiplier: 3,
    mythics: true,
    setShare: SET_SHARE,
    legendaryWeight: LEGENDARY_WEIGHT,
    voidChance: VOID_CHANCE,
    prismaticChance: PRISMATIC_CHANCE,
    itemDropChance: 0.06,
    itemLevel: { min: 35, max: 41 },
    entries: tierEntries({ 4: 1 }),
  },
  // Ticket 8.1: the Pale Marches (the Hollow Reach, levels 40–46). Tier-5 bases only, item levels
  // 41–47 (tier-6 affixes from 43, never below 42), the late-game odds and the Depths' affix bias;
  // gold × 3.9 (its foes take longer to kill than the Depths').
  {
    id: 'paleMarches',
    affixTierBias: 1,
    goldMultiplier: 3.9,
    mythics: true,
    setShare: SET_SHARE,
    legendaryWeight: LEGENDARY_WEIGHT,
    voidChance: VOID_CHANCE,
    prismaticChance: PRISMATIC_CHANCE,
    itemDropChance: 0.06,
    itemLevel: { min: 41, max: 47 },
    entries: tierEntries({ 5: 1 }),
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
    legendaryWeight: LEGENDARY_WEIGHT,
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
    legendaryWeight: LEGENDARY_WEIGHT,
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
    legendaryWeight: LEGENDARY_WEIGHT,
    voidChance: VOID_CHANCE,
    itemDropChance: 1,
    itemLevel: { min: 23, max: 25 },
    entries: [...tierEntries({ 3: 1 }), ...BOSS_EXCLUSIVE],
    focus: CRYPT_LOOT_FOCI[3],
  },
  // Ticket 6.3: the Heroic Gravewarden's hoard: item levels 34–36, tier-3 and tier-4 bases and his
  // exclusives, the best affix bias, the Heroic odds.
  {
    id: 'gravewardenIV',
    affixTierBias: 1.4,
    mythics: true,
    setShare: SET_SHARE,
    legendaryWeight: HEROIC_LEGENDARY_WEIGHT,
    voidChance: HEROIC_VOID_CHANCE,
    prismaticChance: HEROIC_PRISMATIC_CHANCE,
    itemDropChance: 1,
    itemLevel: { min: 34, max: 36 },
    entries: [...tierEntries({ 3: 1, 4: 2 }), ...BOSS_EXCLUSIVE],
    focus: CRYPT_LOOT_FOCI[4],
  },
  // Ticket 4.8: the Ashen Warden's hoard (the Warden's Watch). Tier-3 bases at the top item levels
  // (27–29), the best affix bias, and its armoury as the loot focus: weapons and off-hands.
  {
    id: 'ashenWarden',
    affixTierBias: 1.4,
    mythics: true,
    setShare: SET_SHARE,
    legendaryWeight: LEGENDARY_WEIGHT,
    voidChance: VOID_CHANCE,
    prismaticChance: PRISMATIC_CHANCE,
    itemDropChance: 1,
    itemLevel: { min: 27, max: 29 },
    entries: tierEntries({ 3: 1 }),
    focus: ASHEN_WARDEN_FOCUS,
  },
  // Ticket 6.2: the Forge Tyrant's hoard (the Tyrant's Forge). Tier-4 bases at the Depths' top
  // item levels (39–41), the best affix bias, and his anvil as the loot focus: armour pieces.
  {
    id: 'forgeTyrant',
    affixTierBias: 1.4,
    mythics: true,
    setShare: SET_SHARE,
    legendaryWeight: LEGENDARY_WEIGHT,
    voidChance: VOID_CHANCE,
    prismaticChance: PRISMATIC_CHANCE,
    itemDropChance: 1,
    itemLevel: { min: 39, max: 41 },
    entries: tierEntries({ 4: 1 }),
    focus: FORGE_TYRANT_FOCUS,
  },
];
