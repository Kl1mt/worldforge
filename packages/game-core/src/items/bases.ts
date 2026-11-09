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

export const ITEM_TIERS = [1, 2, 3, 4] as const;

export type ItemTier = (typeof ITEM_TIERS)[number];

export interface ItemBaseDefinition {
  id: string;
  name: string;
  slot: ItemSlotKind;
  /** Asset id in the web asset registry (`apps/web/src/content/assets.ts`). */
  icon: string;
  /** Classes allowed to equip this base. Armor and jewelry are usable by all classes (GDD §7.1). */
  classes: readonly ClassId[];
  /**
   * Content tier (ticket 2.1): 1 = Phase 1 / Abandoned Fields, 2 = Crowwood to Blackwater,
   * 3 = Blackwater, the Nameless Crypt, the Sunken Abbey and the Ashen Pass, 4 = the Cinderwastes
   * (ticket 6.1). Higher tiers have stronger implicit
   * stats at the same item level; area loot tables weight tiers by area.
   */
  tier: ItemTier;
  /** Lowest item level at which this base can drop. */
  minItemLevel: number;
  stats: readonly ItemBaseStat[];
  /**
   * Boss-exclusive, Mythic or set piece base (tickets 2.5, 3.2, 3.3): only the loot table that
   * names it (or the Mythic roll, `MYTHIC_ITEMS`, or the set roll, `ITEM_SETS`) drops it; tier-wide
   * area tables skip it.
   */
  unique?: boolean;
}

const ALL_CLASSES = CLASS_IDS;

/**
 * Item bases. Tier 1 are the Phase 1 bases, one per curated item icon
 * (`apps/web/public/assets/items/`). Tiers 2 and 3 (ticket 2.1) add one base per slot kind that
 * has art and per weapon family, each with its own icon (ticket A.4). Shoulders, legs and relic have no art yet, so they have no bases and cannot drop.
 */
export const ITEM_BASES: readonly ItemBaseDefinition[] = [
  // Weapons — class-restricted.
  {
    id: 'longsword-notched',
    name: 'Notched Longsword',
    slot: 'weapon',
    icon: 'item.longsword-notched',
    classes: ['warrior'],
    tier: 1,
    minItemLevel: 1,
    stats: [{ stat: 'physicalDamage', base: 4, perLevel: 1.4 }],
  },
  {
    id: 'longsword',
    name: 'Longsword',
    slot: 'weapon',
    icon: 'item.longsword',
    classes: ['warrior'],
    tier: 1,
    minItemLevel: 5,
    stats: [{ stat: 'physicalDamage', base: 6, perLevel: 1.6 }],
  },
  {
    id: 'skull-staff',
    name: 'Skull Staff',
    slot: 'weapon',
    icon: 'item.skull-staff',
    classes: ['mage', 'warlock'],
    tier: 1,
    minItemLevel: 1,
    stats: [{ stat: 'magicDamage', base: 5, perLevel: 1.5 }],
  },
  {
    id: 'hunting-bow',
    name: 'Hunting Bow',
    slot: 'weapon',
    icon: 'item.hunting-bow',
    classes: ['hunter'],
    tier: 1,
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
    tier: 1,
    minItemLevel: 1,
    stats: [{ stat: 'armor', base: 4, perLevel: 1.2 }],
  },
  {
    id: 'heater-shield',
    name: 'Heater Shield',
    slot: 'offhand',
    icon: 'item.heater-shield',
    classes: ['warrior'],
    tier: 1,
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
    tier: 1,
    minItemLevel: 1,
    stats: [{ stat: 'armor', base: 3, perLevel: 1 }],
  },
  {
    id: 'horned-helm',
    name: 'Horned Helm',
    slot: 'head',
    icon: 'item.horned-helm',
    classes: ALL_CLASSES,
    tier: 1,
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
    tier: 1,
    minItemLevel: 1,
    stats: [{ stat: 'armor', base: 2, perLevel: 0.8 }],
  },
  {
    id: 'iron-gauntlets',
    name: 'Iron Gauntlets',
    slot: 'hands',
    icon: 'item.iron-gauntlets',
    classes: ALL_CLASSES,
    tier: 1,
    minItemLevel: 5,
    stats: [{ stat: 'armor', base: 3, perLevel: 1.1 }],
  },
  {
    id: 'leather-jerkin',
    name: 'Leather Jerkin',
    slot: 'chest',
    icon: 'item.leather-jerkin',
    classes: ALL_CLASSES,
    tier: 1,
    minItemLevel: 1,
    stats: [{ stat: 'armor', base: 4, perLevel: 1.4 }],
  },
  {
    id: 'chainmail',
    name: 'Chainmail',
    slot: 'chest',
    icon: 'item.chainmail',
    classes: ALL_CLASSES,
    tier: 1,
    minItemLevel: 3,
    stats: [{ stat: 'armor', base: 6, perLevel: 2 }],
  },
  {
    id: 'plate-cuirass',
    name: 'Plate Cuirass',
    slot: 'chest',
    icon: 'item.plate-cuirass',
    classes: ALL_CLASSES,
    tier: 1,
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
    tier: 1,
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
    tier: 1,
    minItemLevel: 1,
    stats: [{ stat: 'resistance', base: 2, perLevel: 0.6 }],
  },
  {
    id: 'iron-ring',
    name: 'Iron Ring',
    slot: 'ring',
    icon: 'item.iron-ring',
    classes: ALL_CLASSES,
    tier: 1,
    minItemLevel: 3,
    stats: [{ stat: 'health', base: 6, perLevel: 2 }],
  },
  {
    id: 'bone-amulet',
    name: 'Bone Amulet',
    slot: 'neck',
    icon: 'item.bone-amulet',
    classes: ALL_CLASSES,
    tier: 1,
    minItemLevel: 1,
    stats: [
      { stat: 'resistance', base: 2, perLevel: 0.6 },
      { stat: 'health', base: 4, perLevel: 1.5 },
    ],
  }, // — Tier 2 (ticket 2.1; icons from A.4).
  {
    id: 'bastard-sword',
    name: 'Grave-Iron Bastard Sword',
    slot: 'weapon',
    icon: 'item.bastard-sword',
    classes: ['warrior'],
    tier: 2,
    minItemLevel: 9,
    stats: [{ stat: 'physicalDamage', base: 9, perLevel: 1.8 }],
  },
  {
    id: 'bog-oak-staff',
    name: 'Bog-Oak Staff',
    slot: 'weapon',
    icon: 'item.bog-oak-staff',
    classes: ['mage', 'warlock'],
    tier: 2,
    minItemLevel: 9,
    stats: [{ stat: 'magicDamage', base: 8, perLevel: 1.8 }],
  },
  {
    id: 'crowwood-longbow',
    name: 'Crowwood Longbow',
    slot: 'weapon',
    icon: 'item.crowwood-longbow',
    classes: ['hunter'],
    tier: 2,
    minItemLevel: 9,
    stats: [{ stat: 'physicalDamage', base: 8, perLevel: 1.75 }],
  },
  {
    id: 'kite-shield',
    name: 'Iron-Bound Kite Shield',
    slot: 'offhand',
    icon: 'item.kite-shield',
    classes: ['warrior'],
    tier: 2,
    minItemLevel: 9,
    stats: [
      { stat: 'armor', base: 8, perLevel: 1.7 },
      { stat: 'resistance', base: 3, perLevel: 0.6 },
    ],
  },
  {
    id: 'barbute',
    name: 'Barbute',
    slot: 'head',
    icon: 'item.barbute',
    classes: ALL_CLASSES,
    tier: 2,
    minItemLevel: 9,
    stats: [
      { stat: 'armor', base: 5, perLevel: 1.4 },
      { stat: 'health', base: 6, perLevel: 2.2 },
    ],
  },
  {
    id: 'brigandine',
    name: 'Brigandine',
    slot: 'chest',
    icon: 'item.brigandine',
    classes: ALL_CLASSES,
    tier: 2,
    minItemLevel: 10,
    stats: [
      { stat: 'armor', base: 10, perLevel: 2.9 },
      { stat: 'health', base: 8, perLevel: 2.4 },
    ],
  },
  {
    id: 'ringmail-gloves',
    name: 'Ringmail Gloves',
    slot: 'hands',
    icon: 'item.ringmail-gloves',
    classes: ALL_CLASSES,
    tier: 2,
    minItemLevel: 9,
    stats: [
      { stat: 'armor', base: 4, perLevel: 1.3 },
      { stat: 'resistance', base: 1, perLevel: 0.3 },
    ],
  },
  {
    id: 'iron-shod-boots',
    name: 'Iron-Shod Boots',
    slot: 'feet',
    icon: 'item.iron-shod-boots',
    classes: ALL_CLASSES,
    tier: 2,
    minItemLevel: 9,
    stats: [{ stat: 'armor', base: 4, perLevel: 1.2 }],
  },
  {
    id: 'raven-talisman',
    name: 'Raven Talisman',
    slot: 'neck',
    icon: 'item.raven-talisman',
    classes: ALL_CLASSES,
    tier: 2,
    minItemLevel: 9,
    stats: [
      { stat: 'resistance', base: 3, perLevel: 0.8 },
      { stat: 'health', base: 6, perLevel: 1.8 },
    ],
  },
  {
    id: 'grave-gold-ring',
    name: 'Grave-Gold Ring',
    slot: 'ring',
    icon: 'item.grave-gold-ring',
    classes: ALL_CLASSES,
    tier: 2,
    minItemLevel: 9,
    stats: [
      { stat: 'resistance', base: 3, perLevel: 0.8 },
      { stat: 'health', base: 4, perLevel: 1.2 },
    ],
  },
  // — Tier 3 (ticket 2.1; icons from A.4).
  {
    id: 'knights-greatsword',
    name: 'Knight’s Greatsword',
    slot: 'weapon',
    icon: 'item.knights-greatsword',
    classes: ['warrior'],
    tier: 3,
    minItemLevel: 15,
    stats: [{ stat: 'physicalDamage', base: 13, perLevel: 2 }],
  },
  {
    id: 'drowned-crozier',
    name: 'Drowned Crozier',
    slot: 'weapon',
    icon: 'item.drowned-crozier',
    classes: ['mage', 'warlock'],
    tier: 3,
    minItemLevel: 15,
    stats: [{ stat: 'magicDamage', base: 12, perLevel: 2 }],
  },
  {
    id: 'horn-recurve',
    name: 'Horn Recurve',
    slot: 'weapon',
    icon: 'item.horn-recurve',
    classes: ['hunter'],
    tier: 3,
    minItemLevel: 15,
    stats: [{ stat: 'physicalDamage', base: 12, perLevel: 1.95 }],
  },
  {
    id: 'tower-shield',
    name: 'Abbey Tower Shield',
    slot: 'offhand',
    icon: 'item.tower-shield',
    classes: ['warrior'],
    tier: 3,
    minItemLevel: 15,
    stats: [
      { stat: 'armor', base: 11, perLevel: 2 },
      { stat: 'resistance', base: 4, perLevel: 0.8 },
    ],
  },
  {
    id: 'great-helm',
    name: 'Great Helm',
    slot: 'head',
    icon: 'item.great-helm',
    classes: ALL_CLASSES,
    tier: 3,
    minItemLevel: 15,
    stats: [
      { stat: 'armor', base: 7, perLevel: 1.6 },
      { stat: 'health', base: 8, perLevel: 2.6 },
    ],
  },
  {
    id: 'knights-plate',
    name: 'Fallen Knight’s Plate',
    slot: 'chest',
    icon: 'item.knights-plate',
    classes: ALL_CLASSES,
    tier: 3,
    minItemLevel: 16,
    stats: [
      { stat: 'armor', base: 13, perLevel: 3.2 },
      { stat: 'health', base: 10, perLevel: 2.8 },
    ],
  },
  {
    id: 'plated-gauntlets',
    name: 'Plated Gauntlets',
    slot: 'hands',
    icon: 'item.plated-gauntlets',
    classes: ALL_CLASSES,
    tier: 3,
    minItemLevel: 15,
    stats: [
      { stat: 'armor', base: 5, perLevel: 1.5 },
      { stat: 'resistance', base: 2, perLevel: 0.4 },
    ],
  },
  {
    id: 'plate-sabatons',
    name: 'Plate Sabatons',
    slot: 'feet',
    icon: 'item.plate-sabatons',
    classes: ALL_CLASSES,
    tier: 3,
    minItemLevel: 15,
    stats: [
      { stat: 'armor', base: 5, perLevel: 1.5 },
      { stat: 'health', base: 4, perLevel: 1.5 },
    ],
  },
  {
    id: 'abbey-pendant',
    name: 'Abbey Pendant',
    slot: 'neck',
    icon: 'item.abbey-pendant',
    classes: ALL_CLASSES,
    tier: 3,
    minItemLevel: 15,
    stats: [
      { stat: 'resistance', base: 4, perLevel: 0.9 },
      { stat: 'health', base: 8, perLevel: 2.2 },
    ],
  },
  {
    id: 'abbey-signet',
    name: 'Abbey Signet',
    slot: 'ring',
    icon: 'item.abbey-signet',
    classes: ALL_CLASSES,
    tier: 3,
    minItemLevel: 15,
    stats: [
      { stat: 'resistance', base: 4, perLevel: 0.9 },
      { stat: 'health', base: 6, perLevel: 1.8 },
    ],
  },
  // Boss-exclusive bases (ticket 2.5): drop only from the Gravewarden's hoard. Each has its own
  // icon (ticket A.5).
  {
    id: 'gravewardens-cowl',
    name: 'Gravewarden’s Cowl',
    slot: 'head',
    icon: 'item.gravewardens-cowl',
    classes: ALL_CLASSES,
    tier: 3,
    minItemLevel: 14,
    unique: true,
    stats: [
      { stat: 'armor', base: 8, perLevel: 1.8 },
      { stat: 'resistance', base: 6, perLevel: 1.2 },
      { stat: 'health', base: 12, perLevel: 3 },
    ],
  },
  {
    id: 'seal-of-the-nameless',
    name: 'Seal of the Nameless',
    slot: 'ring',
    icon: 'item.seal-of-the-nameless',
    classes: ALL_CLASSES,
    tier: 3,
    minItemLevel: 14,
    unique: true,
    stats: [
      { stat: 'armor', base: 4, perLevel: 1 },
      { stat: 'resistance', base: 4, perLevel: 1 },
      { stat: 'health', base: 10, perLevel: 2.4 },
    ],
  },
  {
    id: 'wardens-bone-chain',
    name: 'Warden’s Bone Chain',
    slot: 'neck',
    icon: 'item.wardens-bone-chain',
    classes: ALL_CLASSES,
    tier: 3,
    minItemLevel: 14,
    unique: true,
    stats: [
      { stat: 'armor', base: 5, perLevel: 1.2 },
      { stat: 'resistance', base: 5, perLevel: 1.2 },
      { stat: 'health', base: 10, perLevel: 2.6 },
    ],
  },

  // Named Mythic bases (ticket 3.2, `MYTHIC_ITEMS`): only a Mythic roll in a late-game table
  // drops them. Stronger implicit stats than tier 3. Their own icons since ticket A.6.
  {
    id: 'crown-of-the-hollow-king',
    name: 'Crown of the Hollow King',
    slot: 'head',
    icon: 'item.crown-of-the-hollow-king',
    classes: ALL_CLASSES,
    tier: 3,
    minItemLevel: 15,
    unique: true,
    stats: [
      { stat: 'armor', base: 9, perLevel: 2 },
      { stat: 'resistance', base: 6, perLevel: 1.3 },
      { stat: 'health', base: 12, perLevel: 3.2 },
    ],
  },
  {
    id: 'gravecallers-edge',
    name: 'Gravecaller’s Edge',
    slot: 'weapon',
    icon: 'item.gravecallers-edge',
    classes: ['warrior'],
    tier: 3,
    minItemLevel: 15,
    unique: true,
    stats: [{ stat: 'physicalDamage', base: 15, perLevel: 2.3 }],
  },
  {
    id: 'starfall-sceptre',
    name: 'Starfall Sceptre',
    slot: 'weapon',
    icon: 'item.starfall-sceptre',
    classes: ['mage'],
    tier: 3,
    minItemLevel: 15,
    unique: true,
    stats: [{ stat: 'magicDamage', base: 14, perLevel: 2.3 }],
  },
  {
    id: 'widowmaker',
    name: 'Widowmaker',
    slot: 'weapon',
    icon: 'item.widowmaker',
    classes: ['hunter'],
    tier: 3,
    minItemLevel: 15,
    unique: true,
    stats: [{ stat: 'physicalDamage', base: 14, perLevel: 2.25 }],
  },
  {
    id: 'heart-of-the-abyss',
    name: 'Heart of the Abyss',
    slot: 'weapon',
    icon: 'item.heart-of-the-abyss',
    classes: ['warlock'],
    tier: 3,
    minItemLevel: 15,
    unique: true,
    stats: [{ stat: 'magicDamage', base: 14, perLevel: 2.3 }],
  },
  {
    id: 'ring-of-endless-hunger',
    name: 'Ring of Endless Hunger',
    slot: 'ring',
    icon: 'item.ring-of-endless-hunger',
    classes: ALL_CLASSES,
    tier: 3,
    minItemLevel: 15,
    unique: true,
    stats: [
      { stat: 'resistance', base: 5, perLevel: 1 },
      { stat: 'health', base: 8, perLevel: 2.2 },
    ],
  },

  // Set piece bases (ticket 3.3, `ITEM_SETS`): only a set roll in a late-game table drops them.
  // Stats like the tier-3 base of their slot, tilted to the set's theme. Their own icons since
  // ticket A.6.
  {
    id: 'vigil-helm',
    name: 'Helm of the Drowned Vigil',
    slot: 'head',
    icon: 'item.vigil-helm',
    classes: ALL_CLASSES,
    tier: 3,
    minItemLevel: 14,
    unique: true,
    stats: [
      { stat: 'armor', base: 7, perLevel: 1.6 },
      { stat: 'health', base: 8, perLevel: 2.6 },
    ],
  },
  {
    id: 'vigil-hauberk',
    name: 'Hauberk of the Drowned Vigil',
    slot: 'chest',
    icon: 'item.vigil-hauberk',
    classes: ALL_CLASSES,
    tier: 3,
    minItemLevel: 14,
    unique: true,
    stats: [
      { stat: 'armor', base: 13, perLevel: 3.2 },
      { stat: 'health', base: 10, perLevel: 2.8 },
    ],
  },
  {
    id: 'vigil-gauntlets',
    name: 'Gauntlets of the Drowned Vigil',
    slot: 'hands',
    icon: 'item.vigil-gauntlets',
    classes: ALL_CLASSES,
    tier: 3,
    minItemLevel: 14,
    unique: true,
    stats: [
      { stat: 'armor', base: 5, perLevel: 1.5 },
      { stat: 'resistance', base: 2, perLevel: 0.4 },
    ],
  },
  {
    id: 'vigil-sabatons',
    name: 'Sabatons of the Drowned Vigil',
    slot: 'feet',
    icon: 'item.vigil-sabatons',
    classes: ALL_CLASSES,
    tier: 3,
    minItemLevel: 14,
    unique: true,
    stats: [
      { stat: 'armor', base: 5, perLevel: 1.5 },
      { stat: 'health', base: 4, perLevel: 1.5 },
    ],
  },
  {
    id: 'vigil-oath-chain',
    name: 'Oath-Chain of the Drowned Vigil',
    slot: 'neck',
    icon: 'item.vigil-oath-chain',
    classes: ALL_CLASSES,
    tier: 3,
    minItemLevel: 14,
    unique: true,
    stats: [
      { stat: 'resistance', base: 4, perLevel: 0.9 },
      { stat: 'health', base: 8, perLevel: 2.2 },
    ],
  },
  {
    id: 'vigil-seal',
    name: 'Seal of the Drowned Vigil',
    slot: 'ring',
    icon: 'item.vigil-seal',
    classes: ALL_CLASSES,
    tier: 3,
    minItemLevel: 14,
    unique: true,
    stats: [
      { stat: 'resistance', base: 4, perLevel: 0.9 },
      { stat: 'health', base: 6, perLevel: 1.8 },
    ],
  },
  {
    id: 'choir-cowl',
    name: 'Cowl of the Ashen Choir',
    slot: 'head',
    icon: 'item.choir-cowl',
    classes: ALL_CLASSES,
    tier: 3,
    minItemLevel: 14,
    unique: true,
    stats: [
      { stat: 'armor', base: 4, perLevel: 1 },
      { stat: 'resistance', base: 4, perLevel: 0.9 },
      { stat: 'health', base: 8, perLevel: 2.6 },
    ],
  },
  {
    id: 'choir-vestments',
    name: 'Vestments of the Ashen Choir',
    slot: 'chest',
    icon: 'item.choir-vestments',
    classes: ALL_CLASSES,
    tier: 3,
    minItemLevel: 14,
    unique: true,
    stats: [
      { stat: 'armor', base: 8, perLevel: 2 },
      { stat: 'resistance', base: 5, perLevel: 1.2 },
      { stat: 'health', base: 10, perLevel: 2.8 },
    ],
  },
  {
    id: 'choir-wraps',
    name: 'Wraps of the Ashen Choir',
    slot: 'hands',
    icon: 'item.choir-wraps',
    classes: ALL_CLASSES,
    tier: 3,
    minItemLevel: 14,
    unique: true,
    stats: [
      { stat: 'armor', base: 3, perLevel: 0.9 },
      { stat: 'resistance', base: 3, perLevel: 0.8 },
    ],
  },
  {
    id: 'choir-slippers',
    name: 'Slippers of the Ashen Choir',
    slot: 'feet',
    icon: 'item.choir-slippers',
    classes: ALL_CLASSES,
    tier: 3,
    minItemLevel: 14,
    unique: true,
    stats: [
      { stat: 'armor', base: 3, perLevel: 0.9 },
      { stat: 'resistance', base: 2, perLevel: 0.5 },
      { stat: 'health', base: 4, perLevel: 1.5 },
    ],
  },
  {
    id: 'choir-censer-chain',
    name: 'Censer-Chain of the Ashen Choir',
    slot: 'neck',
    icon: 'item.choir-censer-chain',
    classes: ALL_CLASSES,
    tier: 3,
    minItemLevel: 14,
    unique: true,
    stats: [
      { stat: 'resistance', base: 4, perLevel: 0.9 },
      { stat: 'health', base: 8, perLevel: 2.2 },
    ],
  },
  {
    id: 'choir-band',
    name: 'Band of the Ashen Choir',
    slot: 'ring',
    icon: 'item.choir-band',
    classes: ALL_CLASSES,
    tier: 3,
    minItemLevel: 14,
    unique: true,
    stats: [
      { stat: 'resistance', base: 4, perLevel: 0.9 },
      { stat: 'health', base: 6, perLevel: 1.8 },
    ],
  },
  {
    id: 'bloodmoon-grips',
    name: 'Grips of the Bloodmoon Hunt',
    slot: 'hands',
    icon: 'item.bloodmoon-grips',
    classes: ALL_CLASSES,
    tier: 3,
    minItemLevel: 14,
    unique: true,
    stats: [
      { stat: 'armor', base: 4, perLevel: 1.2 },
      { stat: 'resistance', base: 2, perLevel: 0.5 },
      { stat: 'health', base: 3, perLevel: 1 },
    ],
  },
  {
    id: 'bloodmoon-treads',
    name: 'Treads of the Bloodmoon Hunt',
    slot: 'feet',
    icon: 'item.bloodmoon-treads',
    classes: ALL_CLASSES,
    tier: 3,
    minItemLevel: 14,
    unique: true,
    stats: [
      { stat: 'armor', base: 4, perLevel: 1.2 },
      { stat: 'health', base: 5, perLevel: 1.6 },
    ],
  },
  {
    id: 'bloodmoon-fang',
    name: 'Fang of the Bloodmoon Hunt',
    slot: 'neck',
    icon: 'item.bloodmoon-fang',
    classes: ALL_CLASSES,
    tier: 3,
    minItemLevel: 14,
    unique: true,
    stats: [
      { stat: 'resistance', base: 4, perLevel: 0.9 },
      { stat: 'health', base: 8, perLevel: 2.2 },
    ],
  },
  {
    id: 'bloodmoon-loop',
    name: 'Loop of the Bloodmoon Hunt',
    slot: 'ring',
    icon: 'item.bloodmoon-loop',
    classes: ALL_CLASSES,
    tier: 3,
    minItemLevel: 14,
    unique: true,
    stats: [
      { stat: 'resistance', base: 4, perLevel: 0.9 },
      { stat: 'health', base: 6, perLevel: 1.8 },
    ],
  },
  // Ticket 6.1: tier 4, the Cinderwastes (from item level 29). Appended after every earlier base
  // so tier-wide tables and stored seeds keep their order. Each beats its tier-3 counterpart at the
  // same item level by about a tenth; the icons are A.11's follow-up (the web shows the tier-3
  // counterpart's art until they land, `apps/web/src/content/assets.ts`).
  {
    id: 'cinderforged-blade',
    name: 'Cinderforged Blade',
    slot: 'weapon',
    icon: 'item.cinderforged-blade',
    classes: ['warrior'],
    tier: 4,
    minItemLevel: 29,
    stats: [{ stat: 'physicalDamage', base: 17, perLevel: 2.2 }],
  },
  {
    id: 'emberheart-scepter',
    name: 'Emberheart Scepter',
    slot: 'weapon',
    icon: 'item.emberheart-scepter',
    classes: ['mage', 'warlock'],
    tier: 4,
    minItemLevel: 29,
    stats: [{ stat: 'magicDamage', base: 16, perLevel: 2.2 }],
  },
  {
    id: 'slagbone-bow',
    name: 'Slagbone Bow',
    slot: 'weapon',
    icon: 'item.slagbone-bow',
    classes: ['hunter'],
    tier: 4,
    minItemLevel: 29,
    stats: [{ stat: 'physicalDamage', base: 16, perLevel: 2.15 }],
  },
  {
    id: 'obsidian-bulwark',
    name: 'Obsidian Bulwark',
    slot: 'offhand',
    icon: 'item.obsidian-bulwark',
    classes: ['warrior'],
    tier: 4,
    minItemLevel: 29,
    stats: [
      { stat: 'armor', base: 14, perLevel: 2.2 },
      { stat: 'resistance', base: 5, perLevel: 0.9 },
    ],
  },
  {
    id: 'revenant-visage',
    name: 'Revenant’s Visage',
    slot: 'head',
    icon: 'item.revenant-visage',
    classes: ALL_CLASSES,
    tier: 4,
    minItemLevel: 29,
    stats: [
      { stat: 'armor', base: 9, perLevel: 1.75 },
      { stat: 'health', base: 10, perLevel: 2.85 },
    ],
  },
  {
    id: 'ashplate-hauberk',
    name: 'Ashplate Hauberk',
    slot: 'chest',
    icon: 'item.ashplate-hauberk',
    classes: ALL_CLASSES,
    tier: 4,
    minItemLevel: 29,
    stats: [
      { stat: 'armor', base: 16, perLevel: 3.5 },
      { stat: 'health', base: 12, perLevel: 3.1 },
    ],
  },
  {
    id: 'slagiron-gauntlets',
    name: 'Slag-Iron Gauntlets',
    slot: 'hands',
    icon: 'item.slagiron-gauntlets',
    classes: ALL_CLASSES,
    tier: 4,
    minItemLevel: 29,
    stats: [
      { stat: 'armor', base: 6, perLevel: 1.65 },
      { stat: 'resistance', base: 2, perLevel: 0.45 },
    ],
  },
  {
    id: 'cinderstride-greaves',
    name: 'Cinderstride Greaves',
    slot: 'feet',
    icon: 'item.cinderstride-greaves',
    classes: ALL_CLASSES,
    tier: 4,
    minItemLevel: 29,
    stats: [
      { stat: 'armor', base: 6, perLevel: 1.65 },
      { stat: 'health', base: 5, perLevel: 1.65 },
    ],
  },
  {
    id: 'ember-reliquary',
    name: 'Ember Reliquary',
    slot: 'neck',
    icon: 'item.ember-reliquary',
    classes: ALL_CLASSES,
    tier: 4,
    minItemLevel: 29,
    stats: [
      { stat: 'resistance', base: 5, perLevel: 1 },
      { stat: 'health', base: 10, perLevel: 2.4 },
    ],
  },
  {
    id: 'wispfire-band',
    name: 'Wispfire Band',
    slot: 'ring',
    icon: 'item.wispfire-band',
    classes: ALL_CLASSES,
    tier: 4,
    minItemLevel: 29,
    stats: [
      { stat: 'resistance', base: 5, perLevel: 1 },
      { stat: 'health', base: 7, perLevel: 2 },
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
