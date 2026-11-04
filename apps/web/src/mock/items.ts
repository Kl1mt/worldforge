/**
 * Mock item data for the Phase 0 visual prototype. Not gameplay content: real items,
 * affixes and loot tables arrive data-driven in game-core during Phase 1.
 */
import type { CoreStatId, EquipmentSlotId, RarityId } from '@worldforge/game-core';
import type { ItemAssetId } from '../content/assets';

/** Rings fit either ring slot, so items name a slot kind rather than a slot id. */
export type ItemSlotKind = Exclude<EquipmentSlotId, 'ring1' | 'ring2'> | 'ring';

export interface StatLine {
  stat: CoreStatId;
  value: number;
}

export interface MockItem {
  uid: string;
  icon: ItemAssetId;
  name: string;
  /** Base type shown under the name, e.g. "Iron Longsword". */
  baseType: string;
  rarity: RarityId;
  slot: ItemSlotKind;
  itemLevel: number;
  /** Implicit stats of the base type. */
  base: StatLine[];
  affixes: StatLine[];
  /** Legendary and Mythic items carry a unique effect (GDD §7.4). */
  unique?: string;
  flavor?: string;
}

export function slotKindOf(slot: EquipmentSlotId): ItemSlotKind {
  return slot === 'ring1' || slot === 'ring2' ? 'ring' : slot;
}

export const EQUIPPED: Partial<Record<EquipmentSlotId, MockItem>> = {
  head: {
    uid: 'eq-head',
    icon: 'item.iron-helm',
    name: 'Reeve’s Closed Helm',
    baseType: 'Iron Helm',
    rarity: 'uncommon',
    slot: 'head',
    itemLevel: 10,
    base: [{ stat: 'armor', value: 46 }],
    affixes: [{ stat: 'health', value: 38 }],
  },
  chest: {
    uid: 'eq-chest',
    icon: 'item.chainmail',
    name: 'Ringmail of the Ditch',
    baseType: 'Chainmail',
    rarity: 'rare',
    slot: 'chest',
    itemLevel: 11,
    base: [{ stat: 'armor', value: 112 }],
    affixes: [
      { stat: 'health', value: 64 },
      { stat: 'resistance', value: 9 },
    ],
  },
  hands: {
    uid: 'eq-hands',
    icon: 'item.iron-gauntlets',
    name: 'Iron Gauntlets',
    baseType: 'Gauntlets',
    rarity: 'common',
    slot: 'hands',
    itemLevel: 8,
    base: [{ stat: 'armor', value: 24 }],
    affixes: [],
  },
  feet: {
    uid: 'eq-feet',
    icon: 'item.leather-boots',
    name: 'Mudwalker Boots',
    baseType: 'Leather Boots',
    rarity: 'uncommon',
    slot: 'feet',
    itemLevel: 9,
    base: [{ stat: 'armor', value: 18 }],
    affixes: [{ stat: 'attackSpeed', value: 0.05 }],
  },
  neck: {
    uid: 'eq-neck',
    icon: 'item.bone-amulet',
    name: 'Knucklebone Charm',
    baseType: 'Bone Amulet',
    rarity: 'epic',
    slot: 'neck',
    itemLevel: 12,
    base: [],
    affixes: [
      { stat: 'critChance', value: 3 },
      { stat: 'critDamage', value: 18 },
      { stat: 'health', value: 40 },
    ],
  },
  ring1: {
    uid: 'eq-ring1',
    icon: 'item.brass-ring',
    name: 'Tithe Ring',
    baseType: 'Brass Ring',
    rarity: 'rare',
    slot: 'ring',
    itemLevel: 11,
    base: [],
    affixes: [
      { stat: 'physicalDamage', value: 6 },
      { stat: 'critChance', value: 2 },
    ],
  },
  weapon: {
    uid: 'eq-weapon',
    icon: 'item.longsword',
    name: 'Graumark Longsword',
    baseType: 'Iron Longsword',
    rarity: 'rare',
    slot: 'weapon',
    itemLevel: 12,
    base: [
      { stat: 'physicalDamage', value: 31 },
      { stat: 'attackSpeed', value: 1.2 },
    ],
    affixes: [
      { stat: 'physicalDamage', value: 7 },
      { stat: 'critDamage', value: 15 },
    ],
  },
  offhand: {
    uid: 'eq-offhand',
    icon: 'item.heater-shield',
    name: 'Militia Heater',
    baseType: 'Heater Shield',
    rarity: 'uncommon',
    slot: 'offhand',
    itemLevel: 10,
    base: [{ stat: 'armor', value: 70 }],
    affixes: [{ stat: 'resistance', value: 6 }],
  },
};

export const INVENTORY_CAPACITY = 40;

export const INVENTORY: MockItem[] = [
  {
    uid: 'inv-01',
    icon: 'item.plate-cuirass',
    name: 'Cuirass of the Last Levy',
    baseType: 'Plate Cuirass',
    rarity: 'epic',
    slot: 'chest',
    itemLevel: 14,
    base: [{ stat: 'armor', value: 168 }],
    affixes: [
      { stat: 'health', value: 92 },
      { stat: 'physicalDamage', value: 5 },
      { stat: 'resistance', value: 4 },
    ],
    flavor: 'Stamped with the crest of a lord nobody remembers.',
  },
  {
    uid: 'inv-02',
    icon: 'item.longsword-notched',
    name: 'Gravewake',
    baseType: 'Notched Longsword',
    rarity: 'mythic',
    slot: 'weapon',
    itemLevel: 15,
    base: [
      { stat: 'physicalDamage', value: 38 },
      { stat: 'attackSpeed', value: 1.15 },
    ],
    affixes: [
      { stat: 'physicalDamage', value: 14 },
      { stat: 'critChance', value: 5 },
      { stat: 'critDamage', value: 40 },
    ],
    unique: 'Killing blows raise a grave-mist that deals 30% of the hit to nearby foes.',
    flavor: 'Every notch is a name.',
  },
  {
    uid: 'inv-03',
    icon: 'item.horned-helm',
    name: 'Crown of the Hollow Reeve',
    baseType: 'Horned Helm',
    rarity: 'legendary',
    slot: 'head',
    itemLevel: 14,
    base: [{ stat: 'armor', value: 58 }],
    affixes: [
      { stat: 'health', value: 70 },
      { stat: 'critChance', value: 2.5 },
    ],
    unique: 'Gain 1 Rage whenever an enemy within reach dies.',
  },
  {
    uid: 'inv-04',
    icon: 'item.round-shield',
    name: 'Barn-Door Buckler',
    baseType: 'Round Shield',
    rarity: 'common',
    slot: 'offhand',
    itemLevel: 7,
    base: [{ stat: 'armor', value: 52 }],
    affixes: [],
  },
  {
    uid: 'inv-05',
    icon: 'item.leather-gloves',
    name: 'Harvester’s Grips',
    baseType: 'Leather Gloves',
    rarity: 'rare',
    slot: 'hands',
    itemLevel: 12,
    base: [{ stat: 'armor', value: 16 }],
    affixes: [
      { stat: 'attackSpeed', value: 0.08 },
      { stat: 'critChance', value: 1.5 },
    ],
  },
  {
    uid: 'inv-06',
    icon: 'item.iron-ring',
    name: 'Iron Band',
    baseType: 'Iron Ring',
    rarity: 'uncommon',
    slot: 'ring',
    itemLevel: 9,
    base: [],
    affixes: [{ stat: 'armor', value: 20 }],
  },
  {
    uid: 'inv-07',
    icon: 'item.leather-jerkin',
    name: 'Leather Jerkin',
    baseType: 'Leather Jerkin',
    rarity: 'common',
    slot: 'chest',
    itemLevel: 6,
    base: [{ stat: 'armor', value: 60 }],
    affixes: [],
  },
  {
    uid: 'inv-08',
    icon: 'item.skull-staff',
    name: 'Scarecrow’s Crook',
    baseType: 'Skull Staff',
    rarity: 'rare',
    slot: 'weapon',
    itemLevel: 13,
    base: [
      { stat: 'magicDamage', value: 34 },
      { stat: 'attackSpeed', value: 0.9 },
    ],
    affixes: [
      { stat: 'magicDamage', value: 9 },
      { stat: 'resistance', value: 7 },
    ],
  },
  {
    uid: 'inv-09',
    icon: 'item.hunting-bow',
    name: 'Poacher’s Bow',
    baseType: 'Hunting Bow',
    rarity: 'uncommon',
    slot: 'weapon',
    itemLevel: 10,
    base: [
      { stat: 'physicalDamage', value: 24 },
      { stat: 'attackSpeed', value: 1.4 },
    ],
    affixes: [{ stat: 'critChance', value: 2 }],
  },
  {
    uid: 'inv-10',
    icon: 'item.leather-boots',
    name: 'Worn Boots',
    baseType: 'Leather Boots',
    rarity: 'common',
    slot: 'feet',
    itemLevel: 5,
    base: [{ stat: 'armor', value: 12 }],
    affixes: [],
  },
  {
    uid: 'inv-11',
    icon: 'item.chainmail',
    name: 'Chainmail',
    baseType: 'Chainmail',
    rarity: 'common',
    slot: 'chest',
    itemLevel: 8,
    base: [{ stat: 'armor', value: 96 }],
    affixes: [],
  },
  {
    uid: 'inv-12',
    icon: 'item.bone-amulet',
    name: 'Amulet of Small Bones',
    baseType: 'Bone Amulet',
    rarity: 'uncommon',
    slot: 'neck',
    itemLevel: 9,
    base: [],
    affixes: [{ stat: 'resistance', value: 8 }],
  },
  {
    uid: 'inv-13',
    icon: 'item.iron-gauntlets',
    name: 'Thresher Gauntlets',
    baseType: 'Gauntlets',
    rarity: 'epic',
    slot: 'hands',
    itemLevel: 13,
    base: [{ stat: 'armor', value: 30 }],
    affixes: [
      { stat: 'physicalDamage', value: 8 },
      { stat: 'attackSpeed', value: 0.1 },
      { stat: 'health', value: 35 },
    ],
  },
  {
    uid: 'inv-14',
    icon: 'item.brass-ring',
    name: 'Brass Ring',
    baseType: 'Brass Ring',
    rarity: 'common',
    slot: 'ring',
    itemLevel: 6,
    base: [],
    affixes: [{ stat: 'health', value: 15 }],
  },
  {
    uid: 'inv-15',
    icon: 'item.iron-helm',
    name: 'Iron Helm',
    baseType: 'Iron Helm',
    rarity: 'common',
    slot: 'head',
    itemLevel: 7,
    base: [{ stat: 'armor', value: 38 }],
    affixes: [],
  },
  {
    uid: 'inv-16',
    icon: 'item.heater-shield',
    name: 'Shield of the Mill Guard',
    baseType: 'Heater Shield',
    rarity: 'rare',
    slot: 'offhand',
    itemLevel: 12,
    base: [{ stat: 'armor', value: 82 }],
    affixes: [
      { stat: 'health', value: 44 },
      { stat: 'resistance', value: 10 },
    ],
  },
  {
    uid: 'inv-17',
    icon: 'item.longsword',
    name: 'Rusted Longsword',
    baseType: 'Iron Longsword',
    rarity: 'common',
    slot: 'weapon',
    itemLevel: 5,
    base: [
      { stat: 'physicalDamage', value: 20 },
      { stat: 'attackSpeed', value: 1.2 },
    ],
    affixes: [],
  },
];
