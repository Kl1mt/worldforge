/** Equipment slots (GDD §7.1 working proposal). Order is the canonical display order. */
export const EQUIPMENT_SLOT_IDS = [
  'head',
  'shoulders',
  'chest',
  'hands',
  'legs',
  'feet',
  'neck',
  'ring1',
  'ring2',
  'weapon',
  'offhand',
  'relic',
] as const;

export type EquipmentSlotId = (typeof EQUIPMENT_SLOT_IDS)[number];

export type EquipmentSlotGroup = 'armor' | 'jewelry' | 'weapon' | 'relic';

export interface EquipmentSlotDefinition {
  id: EquipmentSlotId;
  name: string;
  group: EquipmentSlotGroup;
}

export const EQUIPMENT_SLOTS: readonly EquipmentSlotDefinition[] = [
  { id: 'head', name: 'Head', group: 'armor' },
  { id: 'shoulders', name: 'Shoulders', group: 'armor' },
  { id: 'chest', name: 'Chest', group: 'armor' },
  { id: 'hands', name: 'Hands', group: 'armor' },
  { id: 'legs', name: 'Legs', group: 'armor' },
  { id: 'feet', name: 'Feet', group: 'armor' },
  { id: 'neck', name: 'Neck', group: 'jewelry' },
  { id: 'ring1', name: 'Ring', group: 'jewelry' },
  { id: 'ring2', name: 'Ring', group: 'jewelry' },
  { id: 'weapon', name: 'Weapon', group: 'weapon' },
  { id: 'offhand', name: 'Off-hand', group: 'weapon' },
  { id: 'relic', name: 'Relic', group: 'relic' },
];

export function isEquipmentSlotId(value: unknown): value is EquipmentSlotId {
  return typeof value === 'string' && (EQUIPMENT_SLOT_IDS as readonly string[]).includes(value);
}
