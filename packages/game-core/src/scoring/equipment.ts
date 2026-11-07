import type { ClassId } from '../classes.js';
import type { RarityId } from '../rarity.js';
import { isEquipmentSlotId, type EquipmentSlotId } from '../slots.js';
import { checkEquip } from '../equipment.js';
import { MAX_UPGRADE_LEVEL, type ItemVariantId } from '../items/model.js';
import type { RolledAffix } from '../loot/generate.js';
import type { GeneratedItem } from '../loot/generate.js';
import { validateItem } from '../loot/validate.js';
import type { EquippedItem } from '../activity/equipment.js';

/**
 * An equipped item as scoring reads it: the persisted `item_instances` columns (nulls allowed, as
 * the database returns them) and the slot it is worn in.
 */
export interface ScoredItem {
  slot: string;
  seed: number;
  baseId: string;
  rarityId: RarityId;
  itemLevel: number;
  affixes: readonly RolledAffix[];
  upgradeLevel?: number | null;
  variant?: ItemVariantId | null;
  effectId?: string | null;
  effectRoll?: number | null;
  mythicId?: string | null;
  setId?: string | null;
}

export type ItemRejection =
  /** `validateItem` found a problem: the item could not have come from the generator. */
  | 'invalid_item'
  /** The upgrade level is not a whole number from 0 to `MAX_UPGRADE_LEVEL`. */
  | 'invalid_upgrade'
  /** Not an equipment slot, or the item does not fit it, or the class cannot use it. */
  | 'wrong_slot'
  /** A second item in a slot that already has one: none of them counts. */
  | 'duplicate_slot';

export interface CheckedItem {
  item: ScoredItem;
  slot: EquipmentSlotId | null;
  /** The item as the rules read it, when it counts. */
  equipped: (EquippedItem & GeneratedItem) | null;
  rejection: ItemRejection | null;
}

/** The persisted columns as a `GeneratedItem` (null = absent, as the generator leaves them). */
export function toGeneratedItem(item: ScoredItem): GeneratedItem {
  const out: GeneratedItem = {
    seed: item.seed,
    baseId: item.baseId,
    rarityId: item.rarityId,
    itemLevel: item.itemLevel,
    affixes: item.affixes.map((a) => ({ ...a })),
  };
  if (item.effectId != null) out.effectId = item.effectId;
  if (item.effectRoll != null) out.effectRoll = item.effectRoll;
  if (item.mythicId != null) out.mythicId = item.mythicId;
  if (item.setId != null) out.setId = item.setId;
  if (item.variant != null) out.variant = item.variant;
  return out;
}

function upgradeOk(level: number | null | undefined): boolean {
  if (level === null || level === undefined) return true;
  return Number.isInteger(level) && level >= 0 && level <= MAX_UPGRADE_LEVEL;
}

/**
 * Checks every equipped item before it can count for a score (GDD §16.3, Phase 5 ground rules):
 * valid by `validateItem`, a sane upgrade level, a real slot it fits, usable by the class, and one
 * item per slot. A rejected item counts 0 for Gear Score and is left out of Power. The server's
 * equip rules make most of these impossible; scoring checks them again because a leaderboard is
 * where a forged or corrupted row would pay off.
 */
export function checkEquipment(classId: ClassId, items: readonly ScoredItem[]): CheckedItem[] {
  const perSlot = new Map<string, number>();
  for (const i of items) perSlot.set(i.slot, (perSlot.get(i.slot) ?? 0) + 1);
  return items.map((item): CheckedItem => {
    const slot = isEquipmentSlotId(item.slot) ? item.slot : null;
    const reject = (rejection: ItemRejection): CheckedItem => ({
      item,
      slot,
      equipped: null,
      rejection,
    });
    if (!slot || !checkEquip(item.baseId, classId, slot).ok) return reject('wrong_slot');
    if ((perSlot.get(item.slot) ?? 0) > 1) return reject('duplicate_slot');
    if (!upgradeOk(item.upgradeLevel)) return reject('invalid_upgrade');
    let generated: GeneratedItem;
    try {
      generated = toGeneratedItem(item);
      if (validateItem(generated).length > 0) return reject('invalid_item');
    } catch {
      return reject('invalid_item');
    }
    return {
      item,
      slot,
      equipped: { ...generated, upgradeLevel: item.upgradeLevel ?? 0 },
      rejection: null,
    };
  });
}
