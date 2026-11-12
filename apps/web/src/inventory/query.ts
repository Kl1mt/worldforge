import {
  ITEM_SETS,
  ITEM_SLOT_KINDS,
  RARITIES,
  RARITY_IDS,
  compareRarity,
  gearItemPoints,
  type ItemSlotKind,
  type RarityId,
} from '@worldforge/game-core';
import { statDefinition } from '../lib/format';
import { slotName, targetSlot, type EquippedMap, type ItemView } from '../game/items';

/**
 * Inventory search, sorting and filters (ticket 8.5, docs/LOOT.md "Finding items"). Pure and
 * client-side over the items a screen already has: no request, no server load. The Pack, the
 * Warehouse and the account shelf use it; each screen remembers its own last choice
 * (`loadItemQuery` / `saveItemQuery`, localStorage).
 */

export const ITEM_SORTS = ['newest', 'rarity', 'itemLevel', 'slot', 'score'] as const;
export type ItemSort = (typeof ITEM_SORTS)[number];

export const SORT_LABELS: Record<ItemSort, string> = {
  newest: 'Newest',
  rarity: 'Rarity',
  itemLevel: 'Item level',
  slot: 'Slot',
  score: 'Better than worn',
};

/** A yes/no filter: `any` shows both. */
export type Either = 'any' | 'yes' | 'no';

export interface ItemQuery {
  /** Words to find in the name, affixes, effect, set, variant, slot or rarity (all must match). */
  text: string;
  sort: ItemSort;
  slot: ItemSlotKind | 'any';
  rarity: RarityId | 'any';
  variant: 'any' | 'void' | 'prismatic' | 'none';
  locked: Either;
  /** `yes` = tradeable (binds when worn), `no` = account-bound. */
  tradeable: Either;
  /** Received in a trade and still on hold. */
  held: Either;
  awakened: Either;
}

export const DEFAULT_ITEM_QUERY: Readonly<ItemQuery> = {
  text: '',
  sort: 'newest',
  slot: 'any',
  rarity: 'any',
  variant: 'any',
  locked: 'any',
  tradeable: 'any',
  held: 'any',
  awakened: 'any',
};

/** Longest search text kept (a pasted essay is cut). */
export const ITEM_QUERY_TEXT_MAX = 60;

const SET_NAME = new Map(ITEM_SETS.map((s) => [s.id, s.name]));
const RARITY_NAME = new Map(RARITIES.map((r) => [r.id, r.name]));

function statName(line: ItemView['affixes'][number]): string {
  if (line.label) return line.label;
  try {
    return statDefinition(line.stat).name;
  } catch {
    return line.stat;
  }
}

/** Everything a search may match, lower-cased. */
export function searchText(item: ItemView): string {
  const parts = [
    item.name,
    RARITY_NAME.get(item.rarity) ?? item.rarity,
    item.slot ? slotName(item.slot) : '',
    ...item.affixes.map(statName),
    item.effect ? `${item.effect.name} ${item.effect.text}` : '',
    item.setId ? (SET_NAME.get(item.setId) ?? '') : '',
    item.variant ? item.variant.name : '',
    item.awakened ? 'awakened' : '',
    item.engraving ? item.engraving.text : '',
  ];
  return parts.join(' \n ').toLowerCase();
}

function either(flag: Either, value: boolean): boolean {
  return flag === 'any' || (flag === 'yes') === value;
}

/** Whether the item is received in a trade and still held at `nowMs`. */
export function isHeld(item: ItemView, nowMs: number): boolean {
  return item.heldUntil !== undefined && Date.parse(item.heldUntil) > nowMs;
}

/** Tradeable: it carries no account binding (an item without binding info counts as bound). */
export function isTradeable(item: ItemView): boolean {
  return item.binding?.kind === 'open';
}

export function matchesItemQuery(item: ItemView, q: ItemQuery, nowMs: number): boolean {
  if (q.slot !== 'any' && item.slot !== q.slot) return false;
  if (q.rarity !== 'any' && item.rarity !== q.rarity) return false;
  if (
    q.variant === 'none'
      ? item.variant !== null
      : q.variant !== 'any' && item.variant?.id !== q.variant
  ) {
    return false;
  }
  if (!either(q.locked, item.locked)) return false;
  if (!either(q.tradeable, isTradeable(item))) return false;
  if (!either(q.held, isHeld(item, nowMs))) return false;
  if (!either(q.awakened, item.awakened !== null)) return false;
  const words = q.text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = searchText(item);
  return words.every((w) => hay.includes(w));
}

function points(item: Pick<ItemView, 'itemLevel' | 'rarity' | 'upgradeLevel' | 'variant'>): number {
  return gearItemPoints({
    itemLevel: item.itemLevel,
    rarityId: item.rarity,
    upgradeLevel: item.upgradeLevel,
    variant: item.variant?.id ?? null,
  }).points;
}

/**
 * The Gear Score points this item would add over what is worn in the slot it would take (its own
 * points when the slot is empty); null when the hero's class cannot wear it or it has no slot.
 * The same per-item formula as the Gear Score board (game-core `gearItemPoints`), display only.
 */
export function scoreOverWorn(
  item: ItemView,
  equipped: EquippedMap,
  classId: string,
): number | null {
  if (!item.slot || !item.classes.includes(classId as never)) return null;
  const slot = targetSlot(item, equipped);
  const worn = slot ? equipped[slot] : undefined;
  return points(item) - (worn && worn.id !== item.id ? points(worn) : 0);
}

const SLOT_ORDER = new Map<string, number>(ITEM_SLOT_KINDS.map((s, i) => [s, i]));

/** The items that match, in the chosen order (ties: newest first, then id; stable). */
export function applyItemQuery(
  items: readonly ItemView[],
  q: ItemQuery,
  ctx: { nowMs: number; equipped?: EquippedMap; classId?: string },
): ItemView[] {
  const newest = (a: ItemView, b: ItemView) =>
    b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
  const score = new Map<string, number>();
  if (q.sort === 'score') {
    for (const i of items) {
      const s = ctx.equipped && ctx.classId ? scoreOverWorn(i, ctx.equipped, ctx.classId) : null;
      score.set(i.id, s ?? Number.NEGATIVE_INFINITY);
    }
  }
  const by: Record<ItemSort, (a: ItemView, b: ItemView) => number> = {
    newest: () => 0,
    rarity: (a, b) => compareRarity(b.rarity, a.rarity) || b.itemLevel - a.itemLevel,
    itemLevel: (a, b) => b.itemLevel - a.itemLevel || compareRarity(b.rarity, a.rarity),
    slot: (a, b) =>
      (SLOT_ORDER.get(a.slot ?? '') ?? 99) - (SLOT_ORDER.get(b.slot ?? '') ?? 99) ||
      compareRarity(b.rarity, a.rarity),
    score: (a, b) => score.get(b.id)! - score.get(a.id)!,
  };
  return items
    .filter((i) => matchesItemQuery(i, q, ctx.nowMs))
    .sort((a, b) => by[q.sort](a, b) || newest(a, b));
}

/** How many filters (besides the text and the sort) narrow the list. */
export function activeFilterCount(q: ItemQuery): number {
  return (['slot', 'rarity', 'variant', 'locked', 'tradeable', 'held', 'awakened'] as const).filter(
    (k) => q[k] !== 'any',
  ).length;
}

const EITHERS: readonly Either[] = ['any', 'yes', 'no'];

/** A stored query read back defensively: unknown or broken fields fall back to the default. */
export function parseItemQuery(raw: unknown): ItemQuery {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(value as T) ? (value as T) : fallback;
  return {
    text: typeof v.text === 'string' ? v.text.slice(0, ITEM_QUERY_TEXT_MAX) : '',
    sort: pick(v.sort, ITEM_SORTS, 'newest'),
    slot: pick(v.slot, ['any', ...ITEM_SLOT_KINDS] as const, 'any'),
    rarity: pick(v.rarity, ['any', ...RARITY_IDS] as const, 'any'),
    variant: pick(v.variant, ['any', 'void', 'prismatic', 'none'] as const, 'any'),
    locked: pick(v.locked, EITHERS, 'any'),
    tradeable: pick(v.tradeable, EITHERS, 'any'),
    held: pick(v.held, EITHERS, 'any'),
    awakened: pick(v.awakened, EITHERS, 'any'),
  };
}

/** The screens that remember their own query. */
export type ItemQueryScreen = 'pack' | 'warehouse' | 'warehouse-pack' | 'shelf' | 'shelf-pack';

const storageKey = (screen: ItemQueryScreen) => `worldforge.itemQuery.${screen}`;

export function loadItemQuery(screen: ItemQueryScreen, storage?: Storage | null): ItemQuery {
  try {
    const raw = (storage ?? globalThis.localStorage)?.getItem(storageKey(screen));
    return raw ? parseItemQuery(JSON.parse(raw)) : { ...DEFAULT_ITEM_QUERY };
  } catch {
    return { ...DEFAULT_ITEM_QUERY };
  }
}

export function saveItemQuery(screen: ItemQueryScreen, q: ItemQuery, storage?: Storage | null) {
  try {
    (storage ?? globalThis.localStorage)?.setItem(storageKey(screen), JSON.stringify(q));
  } catch {
    /* private mode or a full store: the choice is just not remembered */
  }
}
