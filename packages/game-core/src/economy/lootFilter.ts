import { AFFIXES } from '../items/affixes.js';
import { EFFECTS } from '../effects/registry.js';
import type { GeneratedItem } from '../loot/generate.js';
import { RARITY_IDS, compareRarity, isRarityId, type RarityId } from '../rarity.js';
import { DEFAULT_ECONOMY_CONFIG, type EconomyConfig } from './config.js';
import { salvageYield, type SalvageYield } from './forge.js';
import { sellPrice } from './merchant.js';

/**
 * Loot filter (ticket 3.7, docs/LOOT.md "Loot filter"). Per-character rules that decide what
 * happens to a **new drop** after it was rolled: keep it, or sell or salvage it on the spot. The
 * filter never changes what drops (it runs after the roll, on the generated item) and never sees
 * items already owned: equipped, packed or locked items are out of its reach by construction.
 *
 * An item is handled when it is not protected and matches a rule:
 * - **below a rarity:** its rarity is lower than `belowRarity`; or
 * - **wanted affixes / effects:** at least one is listed and the item has none of them.
 *
 * **Protected categories** (`LOOT_FILTER_CATEGORIES`): Legendary (non-set), Mythic, set pieces and
 * Void items are always kept unless the player opted that category in (`include`). An item in
 * several categories (a Void set piece) needs every one of them opted in.
 */

export const LOOT_FILTER_ACTIONS = ['salvage', 'sell'] as const;
export type LootFilterAction = (typeof LOOT_FILTER_ACTIONS)[number];

export const LOOT_FILTER_CATEGORIES = ['legendary', 'mythic', 'set', 'void'] as const;
export type LootFilterCategory = (typeof LOOT_FILTER_CATEGORIES)[number];

/** At most this many wanted affixes and effects each. */
export const LOOT_FILTER_MAX_WANTED = 16;

export interface LootFilterRules {
  /** What a handled drop becomes: forge salvage (materials + a little gold) or the merchant's price. */
  action: LootFilterAction;
  /** Drops of a lower rarity are handled; null = no rarity rule. */
  belowRarity: RarityId | null;
  /** Wanted affix ids: when any are listed (here or in `wantedEffects`), drops with none are handled. */
  wantedAffixes: string[];
  /** Wanted Legendary effect ids (see `wantedAffixes`). */
  wantedEffects: string[];
  /** Protected categories the player allows the filter to handle; default none. */
  include: LootFilterCategory[];
}

/** The rules a new character starts with: nothing is handled. */
export const EMPTY_LOOT_FILTER: Readonly<LootFilterRules> = {
  action: 'salvage',
  belowRarity: null,
  wantedAffixes: [],
  wantedEffects: [],
  include: [],
};

/** Affixes a filter may name (every affix in content). */
export const LOOT_FILTER_AFFIX_IDS: readonly string[] = AFFIXES.map((a) => a.id);
/** Effects a filter may name: the Legendary pool (Mythic signatures are fixed per Mythic). */
export const LOOT_FILTER_EFFECT_IDS: readonly string[] = EFFECTS.filter(
  (e) => e.kind === 'legendary',
).map((e) => e.id);

export type LootFilterItem = Pick<
  GeneratedItem,
  'rarityId' | 'affixes' | 'effectId' | 'setId' | 'mythicId' | 'variant'
>;

/** The protected categories an item belongs to (empty for ordinary items). */
export function lootFilterCategories(item: LootFilterItem): LootFilterCategory[] {
  const out: LootFilterCategory[] = [];
  if (item.rarityId === 'mythic' || item.mythicId) out.push('mythic');
  if (item.setId) out.push('set');
  else if (item.rarityId === 'legendary') out.push('legendary');
  if (item.variant === 'void') out.push('void');
  return out;
}

/** Whether the rules can handle anything at all. */
export function isLootFilterActive(rules: LootFilterRules | null | undefined): boolean {
  if (!rules) return false;
  const rarityRule = rules.belowRarity !== null && rules.belowRarity !== RARITY_IDS[0];
  return rarityRule || rules.wantedAffixes.length > 0 || rules.wantedEffects.length > 0;
}

/** Whether the filter handles this new drop (true = sell or salvage it, false = keep it). */
export function lootFilterHandles(item: LootFilterItem, rules: LootFilterRules): boolean {
  if (lootFilterCategories(item).some((c) => !rules.include.includes(c))) return false;
  if (rules.belowRarity !== null && compareRarity(item.rarityId, rules.belowRarity) < 0) {
    return true;
  }
  if (rules.wantedAffixes.length === 0 && rules.wantedEffects.length === 0) return false;
  const hasAffix = item.affixes.some((a) => rules.wantedAffixes.includes(a.affixId));
  const hasEffect = item.effectId !== undefined && rules.wantedEffects.includes(item.effectId);
  return !hasAffix && !hasEffect;
}

/** What handling an item gives: the merchant's price, or the forge's salvage yield. */
export function lootFilterYield(
  item: Pick<GeneratedItem, 'baseId' | 'rarityId' | 'itemLevel'>,
  action: LootFilterAction,
  config: EconomyConfig = DEFAULT_ECONOMY_CONFIG,
): SalvageYield {
  return action === 'sell'
    ? { gold: sellPrice(item, config), materials: {} }
    : salvageYield(item, config);
}

export type LootFilterProblem =
  | { field: 'action' | 'belowRarity' | 'include'; message: string }
  | { field: 'wantedAffixes' | 'wantedEffects'; message: string; id?: string };

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Checks untrusted rules (an API body, a stored row) and returns them normalised: lists
 * de-duplicated and in content order. Returns the problems instead when any field is invalid.
 */
export function parseLootFilter(
  input: unknown,
): { ok: true; rules: LootFilterRules } | { ok: false; problems: LootFilterProblem[] } {
  const problems: LootFilterProblem[] = [];
  const v = (input ?? {}) as Record<string, unknown>;
  const action = v.action;
  if (!LOOT_FILTER_ACTIONS.includes(action as LootFilterAction)) {
    problems.push({ field: 'action', message: 'Must be "salvage" or "sell".' });
  }
  const below = v.belowRarity ?? null;
  if (below !== null && !isRarityId(below)) {
    problems.push({ field: 'belowRarity', message: 'Unknown rarity.' });
  }
  const lists = [
    ['wantedAffixes', LOOT_FILTER_AFFIX_IDS],
    ['wantedEffects', LOOT_FILTER_EFFECT_IDS],
  ] as const;
  const wanted: Record<string, string[]> = {};
  for (const [field, known] of lists) {
    const list = v[field] ?? [];
    if (!isStringList(list) || list.length > LOOT_FILTER_MAX_WANTED) {
      problems.push({ field, message: `At most ${LOOT_FILTER_MAX_WANTED} ids.` });
      continue;
    }
    const unknown = list.find((id) => !known.includes(id));
    if (unknown !== undefined) problems.push({ field, message: 'Unknown id.', id: unknown });
    wanted[field] = known.filter((id) => list.includes(id));
  }
  const include = v.include ?? [];
  if (
    !isStringList(include) ||
    include.some((c) => !LOOT_FILTER_CATEGORIES.includes(c as LootFilterCategory))
  ) {
    problems.push({ field: 'include', message: 'Unknown category.' });
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    rules: {
      action: action as LootFilterAction,
      belowRarity: below as RarityId | null,
      wantedAffixes: wanted.wantedAffixes!,
      wantedEffects: wanted.wantedEffects!,
      include: LOOT_FILTER_CATEGORIES.filter((c) => (include as string[]).includes(c)),
    },
  };
}
