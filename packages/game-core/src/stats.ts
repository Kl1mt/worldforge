/** Core character stats (GDD §6.2). Secondary modifiers (gold find, boss damage, …) are below. */
export const CORE_STAT_IDS = [
  'health',
  'physicalDamage',
  'magicDamage',
  'attackSpeed',
  'critChance',
  'critDamage',
  'armor',
  'resistance',
] as const;

export type CoreStatId = (typeof CORE_STAT_IDS)[number];

export type StatFormat = 'flat' | 'percent' | 'perSecond';

export interface StatDefinition {
  id: CoreStatId;
  name: string;
  description: string;
  format: StatFormat;
}

export const CORE_STATS: readonly StatDefinition[] = [
  {
    id: 'health',
    name: 'Health',
    description: 'How much damage the character can survive.',
    format: 'flat',
  },
  {
    id: 'physicalDamage',
    name: 'Physical Damage',
    description: 'Base physical damage output.',
    format: 'flat',
  },
  {
    id: 'magicDamage',
    name: 'Magic Damage',
    description: 'Base magical damage output.',
    format: 'flat',
  },
  {
    id: 'attackSpeed',
    name: 'Attack Speed',
    description: 'Attacks per second.',
    format: 'perSecond',
  },
  {
    id: 'critChance',
    name: 'Critical Chance',
    description: 'Chance that a hit is critical.',
    format: 'percent',
  },
  {
    id: 'critDamage',
    name: 'Critical Damage',
    description: 'Damage multiplier applied to critical hits.',
    format: 'percent',
  },
  {
    id: 'armor',
    name: 'Armor',
    description: 'Mitigation against physical damage.',
    format: 'flat',
  },
  {
    id: 'resistance',
    name: 'Resistance',
    description: 'Mitigation against elemental and other damage types.',
    format: 'flat',
  },
];

export function isCoreStatId(value: unknown): value is CoreStatId {
  return typeof value === 'string' && (CORE_STAT_IDS as readonly string[]).includes(value);
}

/**
 * Secondary modifiers (GDD §6.2: "boss damage, experience gain, gold find, item find, resource
 * yield, and class-specific stats"). They come only from item affixes, are fractions (0.05 = +5 %)
 * and are summed over the equipped items, then capped (`ModifierCaps`, ticket 3.1). They are not
 * part of the `StatBlock`; each one is applied by the system it modifies:
 * - `goldFind`: gold dropped by kills and boss purses;
 * - `itemFind`: the per-kill item drop chance (not the boss's fixed item count);
 * - `xpGain`: XP per kill (farming and dungeons);
 * - `resourceYield`: units per gathering find (not undead combat drops);
 * - `bossDamage`: damage dealt to `boss`-rank enemies;
 * - `skillDamage`: the class auto-skill's damage multiplier (class-flavoured affixes).
 */
export const SECONDARY_STAT_IDS = [
  'goldFind',
  'itemFind',
  'xpGain',
  'resourceYield',
  'bossDamage',
  'skillDamage',
] as const;

export type SecondaryStatId = (typeof SECONDARY_STAT_IDS)[number];

/** Every stat an item can modify. */
export type ItemStatId = CoreStatId | SecondaryStatId;

export interface SecondaryStatDefinition {
  id: SecondaryStatId;
  name: string;
  description: string;
  format: 'percent';
}

export const SECONDARY_STATS: readonly SecondaryStatDefinition[] = [
  {
    id: 'goldFind',
    name: 'Gold Find',
    description: 'More gold from kills and boss purses.',
    format: 'percent',
  },
  {
    id: 'itemFind',
    name: 'Item Find',
    description: 'Higher chance that a kill drops an item.',
    format: 'percent',
  },
  {
    id: 'xpGain',
    name: 'Experience Gain',
    description: 'More experience per kill.',
    format: 'percent',
  },
  {
    id: 'resourceYield',
    name: 'Resource Yield',
    description: 'More units per gathering find.',
    format: 'percent',
  },
  {
    id: 'bossDamage',
    name: 'Boss Damage',
    description: 'More damage against bosses.',
    format: 'percent',
  },
  {
    id: 'skillDamage',
    name: 'Skill Damage',
    description: "More damage from the class's auto-skill.",
    format: 'percent',
  },
];

export function isSecondaryStatId(value: unknown): value is SecondaryStatId {
  return typeof value === 'string' && (SECONDARY_STAT_IDS as readonly string[]).includes(value);
}

/** Tooltip groups (ticket 3.1): how item stats are listed together. */
export const STAT_GROUP_IDS = ['offence', 'defence', 'utility'] as const;

export type StatGroupId = (typeof STAT_GROUP_IDS)[number];

const STAT_GROUPS: Readonly<Record<ItemStatId, StatGroupId>> = {
  physicalDamage: 'offence',
  magicDamage: 'offence',
  attackSpeed: 'offence',
  critChance: 'offence',
  critDamage: 'offence',
  bossDamage: 'offence',
  skillDamage: 'offence',
  health: 'defence',
  armor: 'defence',
  resistance: 'defence',
  goldFind: 'utility',
  itemFind: 'utility',
  xpGain: 'utility',
  resourceYield: 'utility',
};

export function statGroup(id: ItemStatId): StatGroupId {
  return STAT_GROUPS[id];
}
