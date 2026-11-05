import type { ClassId } from '../classes.js';
import type { ItemStatId } from '../stats.js';
import type { ItemBaseDefinition, ItemSlotKind } from './bases.js';

/**
 * One value band of an affix. Bands with a higher `minItemLevel` unlock on higher item
 * levels; that is how affix strength scales with item level (GDD §7.3).
 */
export interface AffixTier {
  tier: number;
  minItemLevel: number;
  /** Relative chance among the tiers an item level unlocks. */
  weight: number;
  min: number;
  max: number;
}

export interface AffixDefinition {
  id: string;
  stat: ItemStatId;
  /** Tooltip label, e.g. "+{value} Armor". */
  label: string;
  /**
   * Value granularity. Values are additive in the stat's own unit: flat stats use step 1,
   * fractions (crit chance 0.02 = 2 %, gold find 0.05 = +5 %, attack speed in attacks/s)
   * use 0.005 or 0.01. How combat combines them is the stat system's concern, not loot's.
   */
  step: number;
  /** Relative chance to be picked among the affixes valid for a slot. */
  weight: number;
  slots: readonly ItemSlotKind[];
  tiers: readonly AffixTier[];
  /**
   * Class compatibility (ticket 3.1): when set, the affix rolls only on items dropped for one of
   * these classes, and only on bases that class can use. Unset = every class.
   */
  classes?: readonly ClassId[];
  /**
   * Content-tier gate (ticket 3.1): the affix rolls only on bases of at least this tier
   * (`ItemBaseDefinition.tier`). Unset = every tier.
   */
  minBaseTier?: number;
}

const ARMOR_SLOTS = ['head', 'shoulders', 'chest', 'hands', 'legs', 'feet'] as const;

/**
 * Class-flavoured affixes (ticket 3.1): one per class, strengthening that class's auto-skill
 * (`AUTO_SKILLS`) through `skillDamage`. Each rolls only for its own class.
 */
const CLASS_SKILL_AFFIXES: readonly AffixDefinition[] = (
  [
    ['warrior', 'rage-heavy-strike', 'Rage-fuelled Heavy Strike'],
    ['mage', 'mana-firebolt', 'Mana-surged Firebolt'],
    ['hunter', 'focus-aimed-shot', 'Focused Aimed Shot'],
    ['warlock', 'soul-shadow-bolt', 'Soul-fed Shadow Bolt'],
  ] as const
).map(([classId, id, name]): AffixDefinition => ({
  id,
  stat: 'skillDamage',
  label: `+{value} ${name} damage`,
  step: 0.01,
  weight: 30,
  slots: ['weapon', 'offhand', 'hands', 'neck', 'relic'],
  classes: [classId],
  tiers: [
    { tier: 1, minItemLevel: 1, weight: 100, min: 0.05, max: 0.1 },
    { tier: 2, minItemLevel: 10, weight: 50, min: 0.11, max: 0.16 },
    { tier: 3, minItemLevel: 20, weight: 25, min: 0.17, max: 0.24 },
  ],
}));

export const AFFIXES: readonly AffixDefinition[] = [
  {
    id: 'physical-damage',
    stat: 'physicalDamage',
    label: '+{value} Physical Damage',
    step: 1,
    weight: 100,
    slots: ['weapon', 'offhand', 'hands', 'chest', 'ring', 'neck', 'relic'],
    tiers: [
      { tier: 1, minItemLevel: 1, weight: 100, min: 2, max: 4 },
      { tier: 2, minItemLevel: 8, weight: 60, min: 5, max: 8 },
      { tier: 3, minItemLevel: 16, weight: 30, min: 9, max: 14 },
      { tier: 4, minItemLevel: 25, weight: 15, min: 15, max: 22 },
    ],
  },
  {
    id: 'magic-damage',
    stat: 'magicDamage',
    label: '+{value} Magic Damage',
    step: 1,
    weight: 100,
    slots: ['weapon', 'hands', 'chest', 'ring', 'neck', 'relic'],
    tiers: [
      { tier: 1, minItemLevel: 1, weight: 100, min: 2, max: 4 },
      { tier: 2, minItemLevel: 8, weight: 60, min: 5, max: 8 },
      { tier: 3, minItemLevel: 16, weight: 30, min: 9, max: 14 },
      { tier: 4, minItemLevel: 25, weight: 15, min: 15, max: 22 },
    ],
  },
  {
    id: 'attack-speed',
    stat: 'attackSpeed',
    label: '+{value} Attack Speed',
    step: 0.01,
    weight: 60,
    slots: ['weapon', 'hands', 'feet', 'ring'],
    tiers: [
      { tier: 1, minItemLevel: 1, weight: 100, min: 0.02, max: 0.04 },
      { tier: 2, minItemLevel: 10, weight: 50, min: 0.05, max: 0.07 },
      { tier: 3, minItemLevel: 20, weight: 25, min: 0.08, max: 0.1 },
    ],
  },
  {
    id: 'crit-chance',
    stat: 'critChance',
    label: '+{value} Critical Chance',
    step: 0.005,
    weight: 60,
    slots: ['weapon', 'offhand', 'head', 'hands', 'ring', 'neck', 'relic'],
    tiers: [
      { tier: 1, minItemLevel: 1, weight: 100, min: 0.01, max: 0.02 },
      { tier: 2, minItemLevel: 10, weight: 50, min: 0.025, max: 0.035 },
      { tier: 3, minItemLevel: 20, weight: 25, min: 0.04, max: 0.05 },
    ],
  },
  {
    id: 'crit-damage',
    stat: 'critDamage',
    label: '+{value} Critical Damage',
    step: 0.01,
    weight: 60,
    slots: ['weapon', 'hands', 'ring', 'neck', 'relic'],
    tiers: [
      { tier: 1, minItemLevel: 1, weight: 100, min: 0.05, max: 0.1 },
      { tier: 2, minItemLevel: 10, weight: 50, min: 0.11, max: 0.18 },
      { tier: 3, minItemLevel: 20, weight: 25, min: 0.19, max: 0.26 },
    ],
  },
  {
    id: 'health',
    stat: 'health',
    label: '+{value} Health',
    step: 1,
    weight: 100,
    slots: [...ARMOR_SLOTS, 'offhand', 'ring', 'neck', 'relic'],
    tiers: [
      { tier: 1, minItemLevel: 1, weight: 100, min: 8, max: 15 },
      { tier: 2, minItemLevel: 8, weight: 60, min: 16, max: 30 },
      { tier: 3, minItemLevel: 16, weight: 30, min: 31, max: 50 },
      { tier: 4, minItemLevel: 25, weight: 15, min: 51, max: 80 },
    ],
  },
  {
    id: 'armor',
    stat: 'armor',
    label: '+{value} Armor',
    step: 1,
    weight: 100,
    slots: [...ARMOR_SLOTS, 'offhand'],
    tiers: [
      { tier: 1, minItemLevel: 1, weight: 100, min: 3, max: 6 },
      { tier: 2, minItemLevel: 8, weight: 60, min: 7, max: 12 },
      { tier: 3, minItemLevel: 16, weight: 30, min: 13, max: 20 },
      { tier: 4, minItemLevel: 25, weight: 15, min: 21, max: 32 },
    ],
  },
  {
    id: 'resistance',
    stat: 'resistance',
    label: '+{value} Resistance',
    step: 1,
    weight: 80,
    slots: [...ARMOR_SLOTS, 'offhand', 'ring', 'neck', 'relic'],
    tiers: [
      { tier: 1, minItemLevel: 1, weight: 100, min: 2, max: 4 },
      { tier: 2, minItemLevel: 8, weight: 60, min: 5, max: 9 },
      { tier: 3, minItemLevel: 16, weight: 30, min: 10, max: 15 },
      { tier: 4, minItemLevel: 25, weight: 15, min: 16, max: 24 },
    ],
  },
  {
    id: 'gold-find',
    stat: 'goldFind',
    label: '+{value} Gold Find',
    step: 0.01,
    weight: 40,
    slots: ['head', 'hands', 'feet', 'ring', 'neck', 'relic'],
    tiers: [
      { tier: 1, minItemLevel: 1, weight: 100, min: 0.03, max: 0.06 },
      { tier: 2, minItemLevel: 10, weight: 50, min: 0.07, max: 0.1 },
      { tier: 3, minItemLevel: 20, weight: 25, min: 0.11, max: 0.15 },
    ],
  },
  {
    id: 'item-find',
    stat: 'itemFind',
    label: '+{value} Item Find',
    step: 0.01,
    weight: 30,
    slots: ['head', 'hands', 'feet', 'ring', 'neck', 'relic'],
    minBaseTier: 2,
    tiers: [
      { tier: 1, minItemLevel: 1, weight: 100, min: 0.03, max: 0.06 },
      { tier: 2, minItemLevel: 10, weight: 50, min: 0.07, max: 0.1 },
      { tier: 3, minItemLevel: 20, weight: 25, min: 0.11, max: 0.15 },
    ],
  },
  {
    id: 'xp-gain',
    stat: 'xpGain',
    label: '+{value} Experience Gain',
    step: 0.01,
    weight: 30,
    slots: ['head', 'ring', 'neck', 'relic'],
    tiers: [
      { tier: 1, minItemLevel: 1, weight: 100, min: 0.02, max: 0.04 },
      { tier: 2, minItemLevel: 10, weight: 50, min: 0.05, max: 0.07 },
      { tier: 3, minItemLevel: 20, weight: 25, min: 0.08, max: 0.1 },
    ],
  },
  {
    id: 'resource-yield',
    stat: 'resourceYield',
    label: '+{value} Resource Yield',
    step: 0.01,
    weight: 30,
    slots: ['chest', 'hands', 'feet', 'ring', 'relic'],
    tiers: [
      { tier: 1, minItemLevel: 1, weight: 100, min: 0.03, max: 0.06 },
      { tier: 2, minItemLevel: 10, weight: 50, min: 0.07, max: 0.1 },
      { tier: 3, minItemLevel: 20, weight: 25, min: 0.11, max: 0.15 },
    ],
  },
  {
    id: 'boss-damage',
    stat: 'bossDamage',
    label: '+{value} Boss Damage',
    step: 0.01,
    weight: 40,
    slots: ['weapon', 'offhand', 'ring', 'neck', 'relic'],
    minBaseTier: 2,
    tiers: [
      { tier: 1, minItemLevel: 1, weight: 100, min: 0.03, max: 0.06 },
      { tier: 2, minItemLevel: 12, weight: 50, min: 0.07, max: 0.1 },
      { tier: 3, minItemLevel: 20, weight: 25, min: 0.11, max: 0.15 },
    ],
  },
  ...CLASS_SKILL_AFFIXES,
];

const AFFIXES_BY_ID = new Map(AFFIXES.map((a) => [a.id, a]));

export function findAffix(id: string): AffixDefinition | undefined {
  return AFFIXES_BY_ID.get(id);
}

/** Affixes that may roll on an item of the given slot kind (any class, any tier). */
export function affixesForSlot(slot: ItemSlotKind): readonly AffixDefinition[] {
  return AFFIXES.filter((a) => a.slots.includes(slot));
}

/**
 * Whether an affix may roll on `base` (slot and content tier) for `classId`. Class-restricted
 * affixes need a class that is both in the affix's list and allowed to use the base; without a
 * class (e.g. generic generation) they never roll.
 */
export function affixAllowedOn(
  affix: AffixDefinition,
  base: Pick<ItemBaseDefinition, 'slot' | 'tier' | 'classes'>,
  classId?: ClassId,
): boolean {
  if (!affix.slots.includes(base.slot)) return false;
  if (affix.minBaseTier !== undefined && base.tier < affix.minBaseTier) return false;
  if (affix.classes) {
    return (
      classId !== undefined && affix.classes.includes(classId) && base.classes.includes(classId)
    );
  }
  return true;
}

/**
 * Whether a stored affix is plausible on `base` when the owner's class at drop time is unknown:
 * like `affixAllowedOn`, but a class affix only needs one of its classes to be able to use the base.
 */
export function affixPossibleOn(
  affix: AffixDefinition,
  base: Pick<ItemBaseDefinition, 'slot' | 'tier' | 'classes'>,
): boolean {
  if (!affix.classes) return affixAllowedOn(affix, base);
  return affix.classes.some((c) => affixAllowedOn(affix, base, c));
}

/** The affix pool of a base for a class (slot, content tier and class gates). */
export function affixPoolFor(
  base: Pick<ItemBaseDefinition, 'slot' | 'tier' | 'classes'>,
  classId?: ClassId,
): readonly AffixDefinition[] {
  return AFFIXES.filter((a) => affixAllowedOn(a, base, classId));
}

/**
 * Tiers an affix can roll at the given item level. `levelBonus` (from the rarity, ticket 3.1)
 * unlocks tiers that many item levels early.
 */
export function tiersForItemLevel(
  affix: AffixDefinition,
  itemLevel: number,
  levelBonus = 0,
): readonly AffixTier[] {
  return affix.tiers.filter((t) => t.minItemLevel <= itemLevel + levelBonus);
}
