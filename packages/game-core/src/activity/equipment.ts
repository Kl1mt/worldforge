import type { EquipmentStatContribution } from '../combat/characterStats.js';
import { DEFAULT_LOOT_CONFIG, type LootConfig } from '../loot/config.js';
import type { GeneratedItem } from '../loot/generate.js';
import {
  emptySecondaryModifiers,
  itemSecondaryModifiers,
  itemStatContribution,
  type SecondaryModifiers,
} from '../equipment.js';
import { SECONDARY_STAT_IDS } from '../stats.js';
import { DEFAULT_ACTIVITY_CONFIG, type ModifierCaps } from './config.js';
import type { ClassId } from '../classes.js';
import { combineEffects, emptyCombatEffects, itemEffectInstances } from '../effects/resolve.js';
import { DEFAULT_EFFECT_CAPS } from '../effects/registry.js';
import type { CombatEffects, EffectCaps, EffectInstance } from '../effects/types.js';

/**
 * An equipped item as the rules read it: the persisted `GeneratedItem` columns, plus the effect
 * columns (ticket 3.2; null or absent = none). Database rows fit as they are.
 */
export type EquippedItem = Pick<GeneratedItem, 'baseId' | 'rarityId' | 'itemLevel' | 'affixes'> & {
  effectId?: string | null;
  effectRoll?: number | null;
  mythicId?: string | null;
  /** Ticket 3.3: the set of a set piece (`set_id`). Counted by `setBonusInstances`. */
  setId?: string | null;
};

/** What one item adds to the character: core stats for combat plus secondary modifiers. */
export interface ItemContribution {
  stats: EquipmentStatContribution;
  secondary: SecondaryModifiers;
}

/** Sums an item's implicit stats and affixes (all additive, in the stat's own unit). */
export function itemContribution(
  item: Pick<GeneratedItem, 'baseId' | 'rarityId' | 'itemLevel' | 'affixes'>,
  config: LootConfig = DEFAULT_LOOT_CONFIG,
): ItemContribution {
  // One source of truth for item → stats: the equipment bridge (ticket 1.7).
  return {
    stats: itemStatContribution(item, config),
    secondary: itemSecondaryModifiers(item),
  };
}

/** Equipped secondary modifiers, each clamped to `[0, cap]` (ticket 3.1). */
export interface EquipmentModifiers extends SecondaryModifiers {
  /** One contribution per item, ready for `deriveCharacterStats` / `simulateFarmingAggregate`. */
  stats: EquipmentStatContribution[];
  /** The sums before the caps, for display. */
  uncapped: SecondaryModifiers;
  /** Gold find before the cap, for display (same as `uncapped.goldFind`). */
  goldFindUncapped: number;
  /** Effect instances of the equipped items (and `extraEffects`), before combining. */
  effectInstances: EffectInstance[];
  /** Combined, capped effects for combat (ticket 3.2); all zero without a class or effects. */
  effects: CombatEffects;
}

/** Options of `equipmentModifiers` beyond the caps. */
export interface EquipmentEffectOptions {
  /** The wearer's class: class effects only count for it. Without it no effect is combined. */
  classId?: ClassId;
  /** Effects from outside single items: the set bonuses (ticket 3.3, `setBonusInstances`). */
  extraEffects?: readonly EffectInstance[];
  effectCaps?: EffectCaps;
}

/** Combines the equipped items into combat stats and capped secondary modifiers. */
export function equipmentModifiers(
  items: readonly EquippedItem[],
  caps: ModifierCaps = DEFAULT_ACTIVITY_CONFIG.modifierCaps,
  config: LootConfig = DEFAULT_LOOT_CONFIG,
  options: EquipmentEffectOptions = {},
): EquipmentModifiers {
  const stats: EquipmentStatContribution[] = [];
  const uncapped = emptySecondaryModifiers();
  const effectInstances: EffectInstance[] = [];
  for (const item of items) {
    const c = itemContribution(item, config);
    stats.push(c.stats);
    for (const id of SECONDARY_STAT_IDS) uncapped[id] += c.secondary[id];
    effectInstances.push(...itemEffectInstances(item));
  }
  effectInstances.push(...(options.extraEffects ?? []));
  const capped = capSecondaryModifiers(uncapped, caps);
  const effects =
    options.classId !== undefined
      ? combineEffects(effectInstances, options.classId, options.effectCaps ?? DEFAULT_EFFECT_CAPS)
      : emptyCombatEffects();
  return {
    ...capped,
    stats,
    uncapped,
    goldFindUncapped: uncapped.goldFind,
    effectInstances,
    effects,
  };
}

/** Clamps every secondary modifier to `[0, cap]`. */
export function capSecondaryModifiers(
  values: SecondaryModifiers,
  caps: ModifierCaps = DEFAULT_ACTIVITY_CONFIG.modifierCaps,
): SecondaryModifiers {
  const out = emptySecondaryModifiers();
  for (const id of SECONDARY_STAT_IDS) {
    const v = Number.isFinite(values[id]) ? values[id] : 0;
    out[id] = Math.min(caps[id], Math.max(0, v));
  }
  return out;
}
