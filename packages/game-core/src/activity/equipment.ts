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
}

/** Combines the equipped items into combat stats and capped secondary modifiers. */
export function equipmentModifiers(
  items: readonly Pick<GeneratedItem, 'baseId' | 'rarityId' | 'itemLevel' | 'affixes'>[],
  caps: ModifierCaps = DEFAULT_ACTIVITY_CONFIG.modifierCaps,
  config: LootConfig = DEFAULT_LOOT_CONFIG,
): EquipmentModifiers {
  const stats: EquipmentStatContribution[] = [];
  const uncapped = emptySecondaryModifiers();
  for (const item of items) {
    const c = itemContribution(item, config);
    stats.push(c.stats);
    for (const id of SECONDARY_STAT_IDS) uncapped[id] += c.secondary[id];
  }
  const capped = capSecondaryModifiers(uncapped, caps);
  return { ...capped, stats, uncapped, goldFindUncapped: uncapped.goldFind };
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
