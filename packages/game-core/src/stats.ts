/** Core character stats (GDD §6.2). Secondary modifiers (gold find, boss damage, …) come later. */
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
