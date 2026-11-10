/**
 * Item Awakening (GDD §8.2, docs/AWAKENING.md). Ticket 6.5 evaluated it; **ticket 6.5b ships option
 * (b), the awakened effect, at × 1.1** (owner decision 2026-11-10). The 6.5 switch is gone: the rule
 * is live, its numbers are data (`DEFAULT_AWAKENING_SETTINGS`), and the only writers are the
 * Forge's awaken action and the admin grant on test accounts (the server).
 *
 * - **(b) `effect` (shipped):** the item's own effect counts × `effectStrength` (a Legendary effect
 *   or a Mythic signature; magnitudes only, under the registry caps), and a set piece's awakening
 *   counts toward its set: a bonus of n pieces is awakened when n distinct worn pieces are.
 * - **(a) `affixSlot` (evaluation only):** one more affix than the rarity rolls. Kept so
 *   `tools/balance/awakening.ts` can still compare the options; `validateItem` refuses it, so no
 *   stored item can carry it.
 *
 * Eligibility: Legendary or Mythic rarity (set pieces are Legendary-rarity) at +10, item level ≥
 * `minItemLevel`, not yet awakened, with something to awaken (an effect or a set). Void and
 * Prismatic items are eligible; the variant is untouched. Rerolls and improvements stay allowed
 * afterwards (they never touch the effect). Permanent: never undone or moved to another item.
 */
import type { ClassId } from '../classes.js';
import { DEFAULT_LOOT_CONFIG } from '../loot/config.js';
import type { RolledAffix } from '../loot/generate.js';
import type { RarityId } from '../rarity.js';
import { equipmentModifiers, type EquippedItem } from '../activity/equipment.js';
import { describeEffect, itemEffectInstances } from '../effects/resolve.js';
import type { CombatEffects } from '../effects/types.js';
import type { ItemVariantId } from './model.js';
import { MAX_UPGRADE_LEVEL } from './model.js';
import { affixAllowedOn, findAffix, tiersForItemLevel } from './affixes.js';
import { findItemBase } from './bases.js';
import { findSet, setBonusInstances, wornSets } from './sets.js';
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

/** The numbers of the rule (data; docs/AWAKENING.md "As built"). */
export interface AwakeningSettings {
  /** Which option an awakening applies (`effect`; `affixSlot` only in the evaluation tools). */
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
  option: 'effect',
  rarities: Object.freeze(['legendary', 'mythic'] as RarityId[]),
  upgradeLevel: MAX_UPGRADE_LEVEL,
  minItemLevel: 23,
  // The owner's choice (docs/AWAKENING.md "As built"): option (b) at × 1.1. The runner-up (a) at
  // half an affix stays for the evaluation tool. Both keep an awakened older kit level with a plain
  // kit of the next area's drops.
  effectStrength: 1.1,
  affixValueShare: 0.5,
  cost: Object.freeze({
    tyrantsEmber: 3,
    gravewardenSeal: 2,
    goldAtItemLevel20: 15_000,
    soulShard: 30,
  }),
});

/** An item as awakening reads it (an `EquippedItem` with the columns awakening looks at). */
export type AwakenableItem = EquippedItem & {
  variant?: ItemVariantId | null;
};

export type AwakeningRefusal =
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

/** The awakened item, or why not. Pure: the input is never changed. Option (a) needs `choice`. */
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

/** The settings with overrides, for the evaluation (tests and `tools/balance/`). */
export function evaluationSettings(overrides: Partial<AwakeningSettings> = {}): AwakeningSettings {
  return { ...DEFAULT_AWAKENING_SETTINGS, ...overrides };
}

/** The awakening the shipped rule writes (option (b) at the settings' strength). */
export function shippedAwakening(
  settings: Readonly<AwakeningSettings> = DEFAULT_AWAKENING_SETTINGS,
): Extract<ItemAwakening, { option: 'effect' }> {
  return { option: 'effect', effectStrength: settings.effectStrength };
}

/** Fields `awakeningErrors` reads. */
export interface AwakeningCheckInput {
  rarityId: RarityId;
  itemLevel: number;
  effectId?: string | null;
  setId?: string | null;
  awakening?: unknown;
  /** Checked when given (the generator's item has no upgrade level; the scoring check passes it). */
  upgradeLevel?: number | null;
}

/**
 * Problems with a stored awakening (for `validateItem` and the scoring check): it must be the
 * shipped option (b) at the settings' strength, on an eligible item. Empty without an awakening.
 */
export function awakeningErrors(
  item: AwakeningCheckInput,
  settings: Readonly<AwakeningSettings> = DEFAULT_AWAKENING_SETTINGS,
): string[] {
  const a = item.awakening as Partial<ItemAwakening> | null | undefined;
  if (a === undefined || a === null) return [];
  const errors: string[] = [];
  const strength = (a as { effectStrength?: unknown }).effectStrength;
  if (
    typeof a !== 'object' ||
    a.option !== 'effect' ||
    strength !== settings.effectStrength ||
    Object.keys(a).length !== 2
  ) {
    errors.push(`invalid awakening ${JSON.stringify(a)}`);
  }
  if (!settings.rarities.includes(item.rarityId)) errors.push(`awakened ${item.rarityId} item`);
  if (item.itemLevel < settings.minItemLevel) {
    errors.push(`awakened item below item level ${settings.minItemLevel}`);
  }
  if (!item.effectId && !item.setId) errors.push('awakened item without an effect or a set');
  if (
    item.upgradeLevel !== undefined &&
    item.upgradeLevel !== null &&
    item.upgradeLevel < settings.upgradeLevel
  ) {
    errors.push(`awakened item at +${item.upgradeLevel}`);
  }
  return errors;
}

/** One combat number an awakening moves (the worn kit combined and capped). */
export interface AwakeningChange {
  /** A `CombatEffects` path, e.g. `execute.bonus`. */
  key: string;
  before: number;
  after: number;
}

/** A set's awakening progress: which bonuses an awakening of this piece would wake. */
export interface AwakeningSetProgress {
  setId: string;
  /** Distinct worn pieces of the set (the item included, as if worn). */
  worn: number;
  /** Distinct awakened pieces before and after this awakening. */
  awakenedBefore: number;
  awakenedAfter: number;
  /** Per bonus: the pieces it needs, and whether it is awakened before and after. */
  bonuses: { pieces: number; effectId: string; before: boolean; after: boolean }[];
}

/** What awakening an item would change, for the Forge's quote (before the player pays). */
export interface AwakeningPreview {
  /** The item's own effect text, before and after (null for a set piece). */
  effectBefore: string | null;
  effectAfter: string | null;
  setProgress: AwakeningSetProgress | null;
  /**
   * The worn kit's combined, capped effects that move. Empty: the awakening changes nothing for
   * this hero now (an effect at its cap, a class effect for another class, or a set bonus that
   * needs more awakened pieces).
   */
  changes: AwakeningChange[];
}

function flatten(fx: CombatEffects, prefix = '', out = new Map<string, number>()) {
  for (const [k, v] of Object.entries(fx) as [string, unknown][]) {
    if (typeof v === 'number') out.set(prefix + k, v);
    else if (v && typeof v === 'object') flatten(v as CombatEffects, `${prefix}${k}.`, out);
  }
  return out;
}

/**
 * The before/after quote of awakening `item` for a hero of `classId` wearing `others` (the rest of
 * the kit, without the item's slot). Pure; the same numbers combat reads.
 */
export function awakeningPreview(
  item: AwakenableItem,
  others: readonly EquippedItem[],
  classId: ClassId,
  settings: Readonly<AwakeningSettings> = DEFAULT_AWAKENING_SETTINGS,
): AwakeningPreview {
  const awakened: AwakenableItem = { ...item, awakening: shippedAwakening(settings) };
  const plain: AwakenableItem = { ...item, awakening: null };
  const own = (x: AwakenableItem) => itemEffectInstances(x)[0];
  const ownBefore = own(plain);
  const ownAfter = own(awakened);
  const effects = (kit: readonly EquippedItem[]) =>
    flatten(
      equipmentModifiers(kit, undefined, undefined, {
        classId,
        extraEffects: setBonusInstances(kit),
      }).effects,
    );
  const before = effects([...others, item]);
  const after = effects([...others, awakened]);
  const changes: AwakeningChange[] = [];
  for (const [key, b] of before) {
    const a = after.get(key) ?? b;
    if (Math.abs(a - b) > 1e-9) changes.push({ key, before: b, after: a });
  }
  let setProgress: AwakeningSetProgress | null = null;
  const set = item.setId ? findSet(item.setId) : undefined;
  if (set) {
    const count = (kit: readonly AwakenableItem[]) => {
      const pieces = new Set<string>();
      for (const x of kit) {
        if (x.awakening && x.setId === set.id && set.pieces.includes(x.baseId))
          pieces.add(x.baseId);
      }
      return pieces.size;
    };
    const worn = wornSets([...others, item]).find((w) => w.set.id === set.id)?.pieces.length ?? 1;
    const awakenedBefore = count([...others, item]);
    const awakenedAfter = count([...others, awakened]);
    setProgress = {
      setId: set.id,
      worn,
      awakenedBefore,
      awakenedAfter,
      bonuses: set.bonuses.map((b) => ({
        pieces: b.pieces,
        effectId: b.effectId,
        before: awakenedBefore >= b.pieces && worn >= b.pieces,
        after: awakenedAfter >= b.pieces && worn >= b.pieces,
      })),
    };
  }
  return {
    effectBefore: ownBefore ? describeEffect(ownBefore) : null,
    effectAfter: ownAfter ? describeEffect(ownAfter) : null,
    setProgress,
    changes,
  };
}
