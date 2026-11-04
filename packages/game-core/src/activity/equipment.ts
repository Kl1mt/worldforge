import type { EquipmentStatContribution } from '../combat/characterStats.js';
import { findAffix } from '../items/affixes.js';
import { DEFAULT_LOOT_CONFIG, type LootConfig } from '../loot/config.js';
import { getImplicitStats, type GeneratedItem } from '../loot/generate.js';
import { DEFAULT_ACTIVITY_CONFIG, type ModifierCaps } from './config.js';

/** What one item adds to the character: core stats for combat plus secondary modifiers. */
export interface ItemContribution {
  stats: EquipmentStatContribution;
  goldFind: number;
}

/** Sums an item's implicit stats and affixes (all additive, in the stat's own unit). */
export function itemContribution(
  item: Pick<GeneratedItem, 'baseId' | 'rarityId' | 'itemLevel' | 'affixes'>,
  config: LootConfig = DEFAULT_LOOT_CONFIG,
): ItemContribution {
  const stats: EquipmentStatContribution = {};
  let goldFind = 0;
  for (const s of getImplicitStats(item, config)) stats[s.stat] = (stats[s.stat] ?? 0) + s.value;
  for (const a of item.affixes) {
    const def = findAffix(a.affixId);
    if (!def || !Number.isFinite(a.value)) continue;
    if (def.stat === 'goldFind') goldFind += a.value;
    else stats[def.stat] = (stats[def.stat] ?? 0) + a.value;
  }
  return { stats, goldFind };
}

export interface EquipmentModifiers {
  /** One contribution per item, ready for `deriveCharacterStats` / `simulateFarmingAggregate`. */
  stats: EquipmentStatContribution[];
  /** Total gold find, clamped to `[0, caps.goldFind]`. */
  goldFind: number;
  /** Gold find before the cap, for display. */
  goldFindUncapped: number;
}

/** Combines the equipped items into combat stats and capped secondary modifiers. */
export function equipmentModifiers(
  items: readonly Pick<GeneratedItem, 'baseId' | 'rarityId' | 'itemLevel' | 'affixes'>[],
  caps: ModifierCaps = DEFAULT_ACTIVITY_CONFIG.modifierCaps,
  config: LootConfig = DEFAULT_LOOT_CONFIG,
): EquipmentModifiers {
  const stats: EquipmentStatContribution[] = [];
  let goldFind = 0;
  for (const item of items) {
    const c = itemContribution(item, config);
    stats.push(c.stats);
    goldFind += c.goldFind;
  }
  return {
    stats,
    goldFind: Math.min(caps.goldFind, Math.max(0, goldFind)),
    goldFindUncapped: goldFind,
  };
}
