import {
  AFFIXES,
  EFFECTS,
  LOOT_FILTER_AFFIX_IDS,
  LOOT_FILTER_EFFECT_IDS,
  RARITIES,
  type LootFilterCategory,
  type LootFilterRules,
} from '@worldforge/game-core';
import { formatNumber } from '../lib/format';
import type { LootFilterTally } from './api';
import { materialCounts } from './materials';

/** Loot filter wording shared by the Pack, the return summary and the Chronicle (ticket 3.7). */

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "sold 12 drops for 85 gold; salvaged 4 drops for 9 gold and 6 Timber". Empty when none. */
export function describeFiltered(tally: LootFilterTally | undefined): string {
  if (!tally || tally.sold + tally.salvaged === 0) return '';
  const parts: string[] = [];
  const mats = materialCounts(tally.materials)
    .map((m) => `${formatNumber(m.quantity)} ${m.material.name}`)
    .join(', ');
  if (tally.sold > 0) parts.push(`sold ${plural(tally.sold, 'drop', 'drops')}`);
  if (tally.salvaged > 0) parts.push(`salvaged ${plural(tally.salvaged, 'drop', 'drops')}`);
  return `${parts.join(' and ')} for ${formatNumber(tally.gold)} gold${mats ? ` and ${mats}` : ''}`;
}

/** Display names, in content order. */
export const FILTER_AFFIXES = LOOT_FILTER_AFFIX_IDS.map((id) => {
  const a = AFFIXES.find((x) => x.id === id)!;
  return { id, name: a.label.replace(/^\+\{value\}\s*/, ''), classes: a.classes ?? null };
});
export const FILTER_EFFECTS = LOOT_FILTER_EFFECT_IDS.map((id) => ({
  id,
  name: EFFECTS.find((e) => e.id === id)!.name,
  classId: EFFECTS.find((e) => e.id === id)!.classId ?? null,
}));
export const FILTER_RARITIES = RARITIES.filter((r) => r.id !== 'common');

export const CATEGORY_TEXT: Record<LootFilterCategory, { name: string; hint: string }> = {
  legendary: { name: 'Legendary', hint: 'Legendary items with an effect' },
  mythic: { name: 'Mythic', hint: 'Named Mythic items' },
  set: { name: 'Set pieces', hint: 'Pieces of the item sets' },
  void: { name: 'Void', hint: 'Void Legendaries, Mythics and set pieces' },
  prismatic: { name: 'Prismatic', hint: 'Prismatic Legendaries, Mythics and set pieces' },
};

/** One plain sentence of what the rules do, for the filter panel's summary line. */
export function describeRules(rules: LootFilterRules | null): string {
  if (!rules) return 'Off. Every drop goes to your pack.';
  const verb = rules.action === 'sell' ? 'Sells' : 'Salvages';
  const conditions: string[] = [];
  if (rules.belowRarity && rules.belowRarity !== 'common') {
    const name = RARITIES.find((r) => r.id === rules.belowRarity)!.name;
    conditions.push(`drops below ${name}`);
  }
  const wanted = [
    ...rules.wantedAffixes.map((id) => FILTER_AFFIXES.find((a) => a.id === id)?.name ?? id),
    ...rules.wantedEffects.map((id) => FILTER_EFFECTS.find((e) => e.id === id)?.name ?? id),
  ];
  if (wanted.length > 0) {
    conditions.push(
      `drops without ${wanted.length === 1 ? wanted[0] : `any of ${wanted.length} chosen traits`}`,
    );
  }
  if (conditions.length === 0) return 'Off. No rule is set, so every drop goes to your pack.';
  return `${verb} ${conditions.join(', or ')}.`;
}
