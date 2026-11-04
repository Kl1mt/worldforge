/** Starting classes (GDD §5.2). Mechanics (skills, weapon rules) are added in later phases. */
export const CLASS_IDS = ['warrior', 'mage', 'hunter', 'warlock'] as const;

export type ClassId = (typeof CLASS_IDS)[number];

export const RESOURCE_IDS = ['rage', 'mana', 'focus', 'soulFragments'] as const;

export type ResourceId = (typeof RESOURCE_IDS)[number];

export type DamageType = 'physical' | 'magic';

export interface ResourceDefinition {
  id: ResourceId;
  name: string;
}

export interface ClassDefinition {
  id: ClassId;
  name: string;
  resource: ResourceId;
  primaryDamage: DamageType;
  identity: string;
}

export const RESOURCES: readonly ResourceDefinition[] = [
  { id: 'rage', name: 'Rage' },
  { id: 'mana', name: 'Mana' },
  { id: 'focus', name: 'Focus' },
  { id: 'soulFragments', name: 'Soul Fragments' },
];

export const CLASSES: readonly ClassDefinition[] = [
  {
    id: 'warrior',
    name: 'Warrior',
    resource: 'rage',
    primaryDamage: 'physical',
    identity: 'Physical melee damage and forceful attacks.',
  },
  {
    id: 'mage',
    name: 'Mage',
    resource: 'mana',
    primaryDamage: 'magic',
    identity: 'Elemental and arcane magic.',
  },
  {
    id: 'hunter',
    name: 'Hunter',
    resource: 'focus',
    primaryDamage: 'physical',
    identity: 'Ranged attacks, speed, and critical-hit interactions.',
  },
  {
    id: 'warlock',
    name: 'Warlock',
    resource: 'soulFragments',
    primaryDamage: 'magic',
    identity: 'Shadow magic and damage-over-time effects.',
  },
];

export function isClassId(value: unknown): value is ClassId {
  return typeof value === 'string' && (CLASS_IDS as readonly string[]).includes(value);
}

export function getClass(id: ClassId): ClassDefinition {
  const def = CLASSES.find((c) => c.id === id);
  if (!def) throw new Error(`Unknown class: ${id}`);
  return def;
}
