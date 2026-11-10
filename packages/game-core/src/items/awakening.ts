/**
 * Ticket 6.5: Item Awakening, the evaluation prototype (GDD §8.2, docs/AWAKENING.md). **Switched
 * off** (`DEFAULT_AWAKENING_SETTINGS.enabled` is false) and not exported from the package index:
 * no server route, setting, column or UI reads it. While off, `awakenItem` refuses every item, so
 * nothing can carry an awakening and every existing number is unchanged (`noEffects.test.ts`).
 *
 * Two options are modelled so the balance tool can compare them (`tools/balance/awakening.ts`):
 * - **(a) `affixSlot`:** one more affix than the rarity rolls (a Legendary or set piece 4 → 5, a
 *   Mythic 5 → 6), picked by the player from the slot's pool (any affix the item doesn't carry),
 *   at the highest tier the item level unlocks. Combat reads it as any affix.
 * - **(b) `effect`:** the item's own effect counts × `effectStrength` (a Legendary effect or a
 *   Mythic signature; magnitudes only, under the registry caps), and a set piece's awakening counts
 *   toward its set: a bonus of n pieces is awakened when n distinct worn pieces are.
 *
 * Eligibility (both): Legendary or Mythic rarity (set pieces are Legendary-rarity) at +10, item
 * level ≥ `minItemLevel`, not yet awakened. Option (b) needs something to awaken (an effect or a
 * set). Void and Prismatic items are eligible; the variant is untouched.
 */
import type { ClassId } from '../classes.js';
import { DEFAULT_LOOT_CONFIG } from '../loot/config.js';
import type { RolledAffix } from '../loot/generate.js';
import type { RarityId } from '../rarity.js';
import type { EquippedItem } from '../activity/equipment.js';
import type { ItemVariantId } from './model.js';
import { MAX_UPGRADE_LEVEL } from './model.js';
import { affixAllowedOn, findAffix, tiersForItemLevel } from './affixes.js';
import { findItemBase } from './bases.js';
import type { AwakeningOptionId, ItemAwakening } from './awakening-state.js';

export {
  AWAKENING_OPTION_IDS,
  MAX_AWAKENED_EFFECT_STRENGTH,
  awakenedEffectStrength,
  type AwakeningOptionId,
  type ItemAwakening,
} from './awakening-state.js';

/** What one awakening costs (docs/AWAKENING.md "Costs and sinks"). */
export interface AwakeningCost {
  /** Tyrant's Embers (ticket 6.2; one per Forge Tyrant hoard, untradeable). */
  tyrantsEmber: number;
  /** Gravewarden's Seals (one per crypt hoard, every tier incl. Heroic). */
  gravewardenSeal: number;
  /** Gold at item level 20; scaled by the Forge's `(itemLevel + 5) / 25`. */
  goldAtItemLevel20: number;
  soulShard: number;
}

/** The typed switch and the numbers of the prototype. Not stored, not exposed. */
export interface AwakeningSettings {
  /** Off: every awakening is refused (the default; only the owner's yes in 6.5b turns it on). */
  enabled: boolean;
  /** Which option an awakening applies. */
  option: AwakeningOptionId;
  /** Rarities that may awaken (set pieces are Legendary-rarity). */
  rarities: readonly RarityId[];
  /** The upgrade level the item must have. */
  upgradeLevel: number;
  /** The lowest item level that may awaken (23: the Ashen tier, where Prismatic starts). */
  minItemLevel: number;
  /** Option (b): the factor on the item's own effect (and its set's bonuses). */
  effectStrength: number;
  /**
   * Option (a): the share of a full affix the extra slot rolls (1 = a full affix of the top tier;
   * 0.5 = half its value, on the affix's step grid, at least one step).
   */
  affixValueShare: number;
  cost: AwakeningCost;
}

export const DEFAULT_AWAKENING_SETTINGS: Readonly<AwakeningSettings> = Object.freeze({
  enabled: false,
  option: 'effect',
  rarities: Object.freeze(['legendary', 'mythic'] as RarityId[]),
  upgradeLevel: MAX_UPGRADE_LEVEL,
  minItemLevel: 23,
  // The recommended tuning (docs/AWAKENING.md "Recommendation"): option (b) at × 1.1, the
  // runner-up (a) at half an affix. Both keep an awakened older kit level with a plain kit of the
  // next area's drops.
  effectStrength: 1.1,
  affixValueShare: 0.5,
  cost: Object.freeze({
    tyrantsEmber: 3,
    gravewardenSeal: 2,
    goldAtItemLevel20: 15_000,
    soulShard: 30,
  }),
});

/** An item as the prototype reads it (an `EquippedItem` with the columns awakening looks at). */
export type AwakenableItem = EquippedItem & {
  variant?: ItemVariantId | null;
};

export type AwakeningRefusal =
  | 'disabled'
  | 'rarity'
  | 'upgrade_level'
  | 'item_level'
  | 'already_awakened'
  | 'nothing_to_awaken'
  | 'unknown_base'
  | 'affix_missing'
  | 'affix_not_allowed'
  | 'affix_present';

/** Why an item may not awaken under the settings, or null when it may. */
export function awakeningRefusal(
  item: AwakenableItem,
  settings: Readonly<AwakeningSettings> = DEFAULT_AWAKENING_SETTINGS,
): AwakeningRefusal | null {
  if (!settings.enabled) return 'disabled';
  if (!settings.rarities.includes(item.rarityId)) return 'rarity';
  if ((item.upgradeLevel ?? 0) < settings.upgradeLevel) return 'upgrade_level';
  if (item.itemLevel < settings.minItemLevel) return 'item_level';
  if (item.awakening) return 'already_awakened';
  if (!findItemBase(item.baseId)) return 'unknown_base';
  if (settings.option === 'effect' && !item.effectId && !item.setId) return 'nothing_to_awaken';
  return null;
}

/** The gold, embers, seals and shards one awakening of this item costs. */
export function awakeningCost(
  item: Pick<AwakenableItem, 'itemLevel'>,
  settings: Readonly<AwakeningSettings> = DEFAULT_AWAKENING_SETTINGS,
): { gold: number; tyrantsEmber: number; gravewardenSeal: number; soulShard: number } {
  const c = settings.cost;
  return {
    gold: Math.round((c.goldAtItemLevel20 * (item.itemLevel + 5)) / 25),
    tyrantsEmber: c.tyrantsEmber,
    gravewardenSeal: c.gravewardenSeal,
    soulShard: c.soulShard,
  };
}

/** The player's pick for option (a): the affix and where in its tier's range it lands (0…1). */
export interface AffixSlotChoice {
  affixId: string;
  /** Position in the tier's range (the server would draw it from the item's forge stream). */
  roll: number;
  /** The owner's class (class affixes are only offered to it). */
  classId: ClassId;
}

/** The awakened affix option (a) would add: the top unlocked tier at the item's level. */
export function awakenedAffix(
  item: AwakenableItem,
  choice: AffixSlotChoice,
  valueShare = 1,
): RolledAffix | AwakeningRefusal {
  const base = findItemBase(item.baseId);
  if (!base) return 'unknown_base';
  const affix = findAffix(choice.affixId);
  if (!affix) return 'affix_missing';
  if (!affixAllowedOn(affix, base, choice.classId)) return 'affix_not_allowed';
  if (item.affixes.some((a) => a.affixId === affix.id)) return 'affix_present';
  const rarity = DEFAULT_LOOT_CONFIG.rarities[item.rarityId];
  const tier = tiersForItemLevel(affix, item.itemLevel, rarity.affixLevelBonus).at(-1);
  if (!tier) return 'affix_not_allowed';
  const roll = Number.isFinite(choice.roll) ? Math.min(1, Math.max(0, choice.roll)) : 0;
  const raw = tier.min + roll * (tier.max - tier.min);
  const full = Math.min(tier.max, Math.max(tier.min, Math.round(raw / affix.step) * affix.step));
  const share = Number.isFinite(valueShare) ? Math.min(1, Math.max(0, valueShare)) : 1;
  const value =
    share === 1 ? full : Math.max(affix.step, Math.round((full * share) / affix.step) * affix.step);
  return { affixId: affix.id, tier: tier.tier, value: Number(value.toFixed(4)) };
}

export type AwakenResult =
  | { ok: true; item: AwakenableItem; cost: ReturnType<typeof awakeningCost> }
  | { ok: false; reason: AwakeningRefusal };

/**
 * The awakened item, or why not. Pure: the input is never changed. Option (a) needs `choice`.
 * With the switch off (the default) every item is refused with `disabled`.
 */
export function awakenItem(
  item: AwakenableItem,
  settings: Readonly<AwakeningSettings> = DEFAULT_AWAKENING_SETTINGS,
  choice?: AffixSlotChoice,
): AwakenResult {
  const refusal = awakeningRefusal(item, settings);
  if (refusal) return { ok: false, reason: refusal };
  const cost = awakeningCost(item, settings);
  if (settings.option === 'effect') {
    const awakening: ItemAwakening = { option: 'effect', effectStrength: settings.effectStrength };
    return { ok: true, item: { ...item, awakening }, cost };
  }
  if (!choice) return { ok: false, reason: 'affix_missing' };
  const affix = awakenedAffix(item, choice, settings.affixValueShare);
  if (typeof affix === 'string') return { ok: false, reason: affix };
  const affixes = [...item.affixes, affix];
  const awakening: ItemAwakening = { option: 'affixSlot', affixIndex: affixes.length - 1 };
  return { ok: true, item: { ...item, affixes, awakening }, cost };
}

/** Settings with the switch on, for the evaluation only (tests and `tools/balance/`). */
export function evaluationSettings(
  overrides: Partial<Omit<AwakeningSettings, 'enabled'>> = {},
): AwakeningSettings {
  return { ...DEFAULT_AWAKENING_SETTINGS, ...overrides, enabled: true };
}
