import type { ClassId } from './classes.js';
import {
  SECONDARY_STAT_IDS,
  isCoreStatId,
  isSecondaryStatId,
  type SecondaryStatId,
} from './stats.js';
import type { EquipmentSlotId } from './slots.js';
import { findAffix } from './items/affixes.js';
import {
  canClassUseItem,
  equipmentSlotsForKind,
  findItemBase,
  itemFitsSlot,
} from './items/bases.js';
import { activeVariant, variantAffixValue } from './items/variants.js';
import { DEFAULT_LOOT_CONFIG, type LootConfig } from './loot/config.js';
import { getImplicitStats, type GeneratedItem, type UpgradeLevelField } from './loot/generate.js';
import {
  deriveCharacterStats,
  type EquipmentStatContribution,
  type StatBlock,
} from './combat/characterStats.js';

/**
 * Bridge loot → combat (ticket 1.7): equipped `GeneratedItem`s become the
 * `EquipmentStatContribution`s that `deriveCharacterStats` sums.
 */

/**
 * What one item adds to the character's core stats: its implicit stats (base scaled by item
 * level, rarity and upgrade level, ticket 3.4) plus every affix that modifies a core stat. Affix values are already in the
 * `StatBlock` unit (see `AffixDefinition.step`). Secondary modifiers such as `goldFind` are not
 * part of the stat block and are left out; see `itemSecondaryModifiers`.
 * Throws on an unknown base; unknown affixes are ignored (validate stored items with `validateItem`).
 */
export function itemStatContribution(
  item: Pick<GeneratedItem, 'baseId' | 'rarityId' | 'itemLevel' | 'affixes'> & UpgradeLevelField,
  config: LootConfig = DEFAULT_LOOT_CONFIG,
): EquipmentStatContribution {
  const out: EquipmentStatContribution = {};
  for (const { stat, value } of getImplicitStats(item, config)) {
    out[stat] = (out[stat] ?? 0) + value;
  }
  // Ticket 6.4: a Prismatic item's combat affixes count × its `affixBonus` (stored values unchanged).
  const variant = activeVariant(item);
  for (const rolled of item.affixes) {
    const affix = findAffix(rolled.affixId);
    if (!affix || !isCoreStatId(affix.stat) || !Number.isFinite(rolled.value)) continue;
    const value = variantAffixValue(variant, affix.stat, rolled.value, affix.step);
    out[affix.stat] = (out[affix.stat] ?? 0) + value;
  }
  return out;
}

/** Secondary modifiers as fractions (see `SECONDARY_STAT_IDS`). */
export type SecondaryModifiers = Record<SecondaryStatId, number>;

/** All secondary modifiers at zero. */
export function emptySecondaryModifiers(): SecondaryModifiers {
  return Object.fromEntries(SECONDARY_STAT_IDS.map((id) => [id, 0])) as SecondaryModifiers;
}

/**
 * Secondary modifiers of one item (gold find, item find, XP gain, resource yield, boss damage,
 * skill damage), summed from its affixes. Uncapped; `equipmentModifiers` applies the caps.
 * Ticket 6.4: with the item's rarity and variant given, a Prismatic item's boss and skill damage
 * count × its `affixBonus` (find affixes never do).
 */
export function itemSecondaryModifiers(
  item: Pick<GeneratedItem, 'affixes'> &
    Partial<Pick<GeneratedItem, 'rarityId'>> &
    UpgradeLevelField,
): SecondaryModifiers {
  const out = emptySecondaryModifiers();
  const variant =
    item.rarityId !== undefined
      ? activeVariant({ rarityId: item.rarityId, variant: item.variant ?? null })
      : undefined;
  for (const rolled of item.affixes) {
    const affix = findAffix(rolled.affixId);
    const stat = affix?.stat;
    if (isSecondaryStatId(stat) && Number.isFinite(rolled.value)) {
      out[stat] += variantAffixValue(variant, stat, rolled.value, affix!.step);
    }
  }
  return out;
}

/** A character's effective stats with the given items equipped. */
export function deriveEquippedStats(
  classId: ClassId,
  level: number,
  equipped: readonly (Pick<GeneratedItem, 'baseId' | 'rarityId' | 'itemLevel' | 'affixes'> &
    UpgradeLevelField)[],
  config: LootConfig = DEFAULT_LOOT_CONFIG,
): StatBlock {
  return deriveCharacterStats(
    classId,
    level,
    equipped.map((item) => itemStatContribution(item, config)),
  );
}

export type EquipCheck =
  { ok: true } | { ok: false; reason: 'unknown_base' | 'wrong_slot' | 'wrong_class' };

/** Whether a character of `classId` may put an item of `baseId` into `slotId` (GDD §7.1). */
export function checkEquip(baseId: string, classId: ClassId, slotId: EquipmentSlotId): EquipCheck {
  const base = findItemBase(baseId);
  if (!base) return { ok: false, reason: 'unknown_base' };
  if (!itemFitsSlot(base, slotId)) return { ok: false, reason: 'wrong_slot' };
  if (!canClassUseItem(base, classId)) return { ok: false, reason: 'wrong_class' };
  return { ok: true };
}

/**
 * The slot to equip an item into when the player names none: its only slot, or for rings the
 * first free one of `ring1`/`ring2` (else `ring1`). `occupied` lists the slots in use.
 * Returns `undefined` for an unknown base.
 */
export function defaultEquipSlot(
  baseId: string,
  occupied: ReadonlySet<EquipmentSlotId>,
): EquipmentSlotId | undefined {
  const base = findItemBase(baseId);
  if (!base) return undefined;
  const slots = equipmentSlotsForKind(base.slot);
  return slots.find((s) => !occupied.has(s)) ?? slots[0];
}
