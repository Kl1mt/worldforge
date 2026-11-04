import { CLASS_IDS, type ClassId } from '../classes.js';
import type { EquipmentSlotId } from '../slots.js';
import type { CoreStatId } from '../stats.js';

/**
 * The kind of slot an item base occupies. Equals `EquipmentSlotId` except that both
 * ring slots share one `ring` kind (a ring fits `ring1` or `ring2`).
 */
export const ITEM_SLOT_KINDS = [
  'head',
  'shoulders',
  'chest',
  'hands',
  'legs',
  'feet',
  'neck',
  'ring',
  'weapon',
  'offhand',
  'relic',
] as const;

export type ItemSlotKind = (typeof ITEM_SLOT_KINDS)[number];

/** Equipment slots an item of the given kind can be equipped into. */
export function equipmentSlotsForKind(kind: ItemSlotKind): readonly EquipmentSlotId[] {
  return kind === 'ring' ? ['ring1', 'ring2'] : [kind];
}

/** Implicit (non-random) stat of a base: `base + perLevel × (itemLevel − 1)`, scaled by rarity. */
export interface ItemBaseStat {
  stat: CoreStatId;
  base: number;
  perLevel: number;
}

export interface ItemBaseDefinition {
  id: string;
  name: string;
  slot: ItemSlotKind;
  /** Asset id in the web asset registry (`apps/web/src/content/assets.ts`). */
  icon: string;
  /** Classes allowed to equip this base. Armor and jewelry are usable by all classes (GDD §7.1). */
  classes: readonly ClassId[];
  /** Lowest item level at which this base can drop. */
  minItemLevel: number;
  stats: readonly ItemBaseStat[];
}

const ALL_CLASSES = CLASS_IDS;

/**
 * Phase 1 item bases: one per curated item icon (`apps/web/public/assets/items/`).
 * Shoulders, legs and relic have no art yet, so they have no bases and cannot drop.
 */
export const ITEM_BASES: readonly ItemBaseDefinition[] = [
  // Weapons — class-restricted.
  {
    id: 'longsword-notched',
    name: 'Notched Longsword',
    slot: 'weapon',
    icon: 'item.longsword-notched',
    classes: ['warrior'],
    minItemLevel: 1,
    stats: [{ stat: 'physicalDamage', base: 4, perLevel: 1.4 }],
  },
  {
    id: 'longsword',
    name: 'Longsword',
    slot: 'weapon',
    icon: 'item.longsword',
    classes: ['warrior'],
    minItemLevel: 5,
    stats: [{ stat: 'physicalDamage', base: 6, perLevel: 1.6 }],
  },
  {
    id: 'skull-staff',
    name: 'Skull Staff',
    slot: 'weapon',
    icon: 'item.skull-staff',
    classes: ['mage', 'warlock'],
    minItemLevel: 1,
    stats: [{ stat: 'magicDamage', base: 5, perLevel: 1.5 }],
  },
  {
    id: 'hunting-bow',
    name: 'Hunting Bow',
    slot: 'weapon',
    icon: 'item.hunting-bow',
    classes: ['hunter'],
    minItemLevel: 1,
    stats: [{ stat: 'physicalDamage', base: 5, perLevel: 1.5 }],
  },
  // Off-hand — shields are warrior-only.
  {
    id: 'round-shield',
    name: 'Round Shield',
    slot: 'offhand',
    icon: 'item.round-shield',
    classes: ['warrior'],
    minItemLevel: 1,
    stats: [{ stat: 'armor', base: 4, perLevel: 1.2 }],
  },
  {
    id: 'heater-shield',
    name: 'Heater Shield',
    slot: 'offhand',
    icon: 'item.heater-shield',
    classes: ['warrior'],
    minItemLevel: 5,
    stats: [
      { stat: 'armor', base: 6, perLevel: 1.5 },
      { stat: 'resistance', base: 2, perLevel: 0.5 },
    ],
  },
  // Armor — all classes.
  {
    id: 'iron-helm',
    name: 'Iron Helm',
    slot: 'head',
    icon: 'item.iron-helm',
    classes: ALL_CLASSES,
    minItemLevel: 1,
    stats: [{ stat: 'armor', base: 3, perLevel: 1 }],
  },
  {
    id: 'horned-helm',
    name: 'Horned Helm',
    slot: 'head',
    icon: 'item.horned-helm',
    classes: ALL_CLASSES,
    minItemLevel: 5,
    stats: [
      { stat: 'armor', base: 4, perLevel: 1.2 },
      { stat: 'health', base: 5, perLevel: 2 },
    ],
  },
  {
    id: 'leather-gloves',
    name: 'Leather Gloves',
    slot: 'hands',
    icon: 'item.leather-gloves',
    classes: ALL_CLASSES,
    minItemLevel: 1,
    stats: [{ stat: 'armor', base: 2, perLevel: 0.8 }],
  },
  {
    id: 'iron-gauntlets',
    name: 'Iron Gauntlets',
    slot: 'hands',
    icon: 'item.iron-gauntlets',
    classes: ALL_CLASSES,
    minItemLevel: 5,
    stats: [{ stat: 'armor', base: 3, perLevel: 1.1 }],
  },
  {
    id: 'leather-jerkin',
    name: 'Leather Jerkin',
    slot: 'chest',
    icon: 'item.leather-jerkin',
    classes: ALL_CLASSES,
    minItemLevel: 1,
    stats: [{ stat: 'armor', base: 4, perLevel: 1.4 }],
  },
  {
    id: 'chainmail',
    name: 'Chainmail',
    slot: 'chest',
    icon: 'item.chainmail',
    classes: ALL_CLASSES,
    minItemLevel: 3,
    stats: [{ stat: 'armor', base: 6, perLevel: 2 }],
  },
  {
    id: 'plate-cuirass',
    name: 'Plate Cuirass',
    slot: 'chest',
    icon: 'item.plate-cuirass',
    classes: ALL_CLASSES,
    minItemLevel: 8,
    stats: [
      { stat: 'armor', base: 8, perLevel: 2.6 },
      { stat: 'health', base: 6, perLevel: 2 },
    ],
  },
  {
    id: 'leather-boots',
    name: 'Leather Boots',
    slot: 'feet',
    icon: 'item.leather-boots',
    classes: ALL_CLASSES,
    minItemLevel: 1,
    stats: [{ stat: 'armor', base: 2, perLevel: 0.9 }],
  },
  // Jewelry — all classes.
  {
    id: 'brass-ring',
    name: 'Brass Ring',
    slot: 'ring',
    icon: 'item.brass-ring',
    classes: ALL_CLASSES,
    minItemLevel: 1,
    stats: [{ stat: 'resistance', base: 2, perLevel: 0.6 }],
  },
  {
    id: 'iron-ring',
    name: 'Iron Ring',
    slot: 'ring',
    icon: 'item.iron-ring',
    classes: ALL_CLASSES,
    minItemLevel: 3,
    stats: [{ stat: 'health', base: 6, perLevel: 2 }],
  },
  {
    id: 'bone-amulet',
    name: 'Bone Amulet',
    slot: 'neck',
    icon: 'item.bone-amulet',
    classes: ALL_CLASSES,
    minItemLevel: 1,
    stats: [
      { stat: 'resistance', base: 2, perLevel: 0.6 },
      { stat: 'health', base: 4, perLevel: 1.5 },
    ],
  },
];

const BASES_BY_ID = new Map(ITEM_BASES.map((b) => [b.id, b]));

export function findItemBase(id: string): ItemBaseDefinition | undefined {
  return BASES_BY_ID.get(id);
}

export function getItemBase(id: string): ItemBaseDefinition {
  const base = BASES_BY_ID.get(id);
  if (!base) throw new Error(`Unknown item base: ${id}`);
  return base;
}

export function canClassUseItem(base: ItemBaseDefinition, classId: ClassId): boolean {
  return base.classes.includes(classId);
}

/** Whether an item of this base may be placed in the given equipment slot (class rules aside). */
export function itemFitsSlot(base: ItemBaseDefinition, slotId: EquipmentSlotId): boolean {
  return equipmentSlotsForKind(base.slot).includes(slotId);
}
