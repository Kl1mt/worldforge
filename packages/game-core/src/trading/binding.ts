import type { RolledAffix } from '../loot/generate.js';
import type { ItemAwakening } from '../items/awakening-state.js';
import type { ItemVariantId } from '../items/model.js';
import { activeVariant } from '../items/variants.js';
import type { RarityId } from '../rarity.js';

/**
 * Item binding (ticket T.1, docs/TRADING.md "1. Item binding"). Pure rules: which items could ever
 * be offered to another player, and which of those the owner's switches allow right now.
 *
 * Two layers, kept apart on purpose:
 * - **The binding state** (`binding`): `account` (account-bound, for good) or `equip` (bind on
 *   equip: still fresh, binds when worn or forged). It follows from the item alone (rarity, variant,
 *   source, state) through the tables below and never reads a switch. It is stored on the item row
 *   and only ever moves from `equip` to `account`.
 * - **Tradeable now** (`tradeable`): a bind-on-equip item whose switches are all on (the master
 *   switch, "Trade: items", and every category the item is in). Switches open and close a category
 *   without touching any item: turning one off and on again gives every item back exactly its old
 *   answer. The switches are stored server-side by T.2; until then everything is off.
 *
 * Offering rules that are not about the item's binding (locked, stored, held, in escrow,
 * eligibility, caps, provenance) belong to the trade tickets (T.4, T.5).
 */

/** The stored binding state. */
export const ITEM_BINDINGS = ['account', 'equip'] as const;
export type ItemBinding = (typeof ITEM_BINDINGS)[number];

export function isItemBinding(value: unknown): value is ItemBinding {
  return typeof value === 'string' && (ITEM_BINDINGS as readonly string[]).includes(value);
}

/** Where an item came from, as far as binding is concerned. */
export const ITEM_BINDING_SOURCES = [
  'farming',
  'crypt',
  'hoard',
  'craft',
  'quest',
  'contract',
  'merchant',
  'unknown',
] as const;
export type ItemBindingSource = (typeof ITEM_BINDING_SOURCES)[number];

/**
 * The binding source of a stored `item_instances.source`: `farming`, `dungeon:<id>` (a crypt or
 * Watch chamber), `hoard:<id>` (a boss hoard, ticket T.1), `forge` (crafted), `quest`, `contract`,
 * `merchant`. Anything else (test fixtures, a future source nobody classified) is `unknown`, which
 * binds: a new source has to be added here on purpose before its items can be traded.
 */
export function itemBindingSource(source: string): ItemBindingSource {
  if (source === 'farming') return 'farming';
  if (source.startsWith('dungeon:')) return 'crypt';
  if (source.startsWith('hoard:')) return 'hoard';
  if (source === 'forge') return 'craft';
  if (source === 'quest') return 'quest';
  if (source === 'contract') return 'contract';
  if (source === 'merchant') return 'merchant';
  return 'unknown';
}

/** The stored `source` of a boss-hoard drop of a dungeon (ticket T.1). */
export function hoardSource(dungeonId: string): string {
  return `hoard:${dungeonId}`;
}

/** What a source does: follow the rarity table, or always bind. */
export const SOURCE_BINDING: Readonly<Record<ItemBindingSource, 'rarity' | 'account'>> = {
  farming: 'rarity',
  crypt: 'rarity',
  craft: 'rarity',
  hoard: 'account',
  quest: 'account',
  contract: 'account',
  merchant: 'account',
  unknown: 'account',
};

/** What a rarity does on a source that follows the rarity table. */
export const RARITY_BINDING: Readonly<Record<RarityId, ItemBinding>> = {
  common: 'account',
  uncommon: 'account',
  rare: 'account',
  epic: 'equip',
  legendary: 'equip',
  mythic: 'equip',
};

/** The trading categories, each with its own switch ("Tradeable: …"). */
export const TRADE_CATEGORIES = [
  'epic',
  'legendary',
  'set',
  'mythic',
  'void',
  'prismatic',
] as const;
export type TradeCategory = (typeof TRADE_CATEGORIES)[number];

/**
 * The switches binding reads (docs/TRADING.md "Admin switches"). T.2 stores them server-side
 * (`tradingSwitchesOf(settings)`); the other switches (materials, gold, the shelf) don't concern
 * items' binding.
 */
export interface TradingSwitches {
  /** "Trading" (master). */
  trading: boolean;
  /** "Trade: items". */
  items: boolean;
  /** "Tradeable: …", one per category. */
  categories: Readonly<Record<TradeCategory, boolean>>;
}

/**
 * The defaults of the "Admin switches" table (ticket T.2, `DEFAULT_TRADING_SETTINGS`): the master
 * switch and "Trade: items" off, so nothing is tradeable; Epic, Legendary and set pieces on (they
 * only matter once the master is on), Mythic, Void and Prismatic (ticket 6.4) off.
 */
export const DEFAULT_TRADING_SWITCHES: Readonly<TradingSwitches> = Object.freeze({
  trading: false,
  items: false,
  categories: Object.freeze({
    epic: true,
    legendary: true,
    set: true,
    mythic: false,
    void: false,
    prismatic: false,
  }),
});

/** The item fields binding reads (the `item_instances` columns of the same names). */
export interface ItemBindingInput {
  rarityId: RarityId;
  variant?: ItemVariantId | null;
  setId?: string | null;
  source: string;
  /** The stored state; null on rows written before T.1 and not yet backfilled. */
  binding?: ItemBinding | null;
  tradedCount?: number;
  firstEquippedAt?: Date | string | null;
  equippedSlot?: string | null;
  upgradeLevel?: number;
  upgradePity?: number;
  rerollCount?: number;
  forgeCounter?: number;
  affixes?: readonly RolledAffix[];
  /** Ticket 6.5b: an awakened item is account-bound for good (docs/AWAKENING.md). */
  awakening?: ItemAwakening | null;
}

/** Why an item is bound (or why it isn't yet). */
export type ItemBindingReason =
  | 'fresh'
  | 'rarity'
  | 'source'
  | 'worn'
  | 'forged'
  | 'traded'
  /** Ticket 6.5b: awakened (never tradeable, whatever the switches). */
  | 'awakened'
  /** Stored as bound with nothing else to show why (kept: binding never goes back). */
  | 'bound';

export interface ItemBindingResult {
  binding: ItemBinding;
  reason: ItemBindingReason;
  /** The categories whose switches a bind-on-equip item needs (empty when account-bound). */
  categories: TradeCategory[];
  /** Whether the item may be offered under these switches (binding only, see the module). */
  tradeable: boolean;
}

/** The trading categories of an item, whatever its binding. */
export function itemTradeCategories(item: {
  rarityId: RarityId;
  variant?: ItemVariantId | null;
  setId?: string | null;
}): TradeCategory[] {
  const out: TradeCategory[] = [];
  if (item.rarityId === 'epic') out.push('epic');
  else if (item.rarityId === 'legendary') out.push(item.setId ? 'set' : 'legendary');
  else if (item.rarityId === 'mythic') out.push('mythic');
  // A variant is a category of its own on top of the rarity (Void 3.5, Prismatic 6.4).
  const variant = activeVariant(item)?.id;
  if (variant === 'void') out.push('void');
  else if (variant === 'prismatic') out.push('prismatic');
  return out;
}

/** Whether any Forge work (upgrade attempt, reroll, improvement) has touched the item. */
export function isForged(
  item: Pick<
    ItemBindingInput,
    'upgradeLevel' | 'upgradePity' | 'rerollCount' | 'forgeCounter' | 'affixes'
  >,
): boolean {
  return (
    (item.upgradeLevel ?? 0) > 0 ||
    (item.upgradePity ?? 0) > 0 ||
    (item.rerollCount ?? 0) > 0 ||
    (item.forgeCounter ?? 0) > 0 ||
    (item.affixes ?? []).some((a) => (a.improvements ?? 0) > 0 || a.rerolled === true)
  );
}

/** Whether the item is or was worn. */
export function isWorn(item: ItemBindingInput): boolean {
  return (
    (item.firstEquippedAt !== null && item.firstEquippedAt !== undefined) ||
    (item.equippedSlot !== null && item.equippedSlot !== undefined)
  );
}

/** The binding state alone (no switches): see the module comment. */
export function itemBindingState(item: ItemBindingInput): {
  binding: ItemBinding;
  reason: ItemBindingReason;
} {
  if (item.awakening) return { binding: 'account', reason: 'awakened' };
  if ((item.tradedCount ?? 0) > 0) return { binding: 'account', reason: 'traded' };
  if (SOURCE_BINDING[itemBindingSource(item.source)] === 'account') {
    return { binding: 'account', reason: 'source' };
  }
  if (RARITY_BINDING[item.rarityId] === 'account') return { binding: 'account', reason: 'rarity' };
  if (isForged(item)) return { binding: 'account', reason: 'forged' };
  if (isWorn(item)) return { binding: 'account', reason: 'worn' };
  if (item.binding === 'account') return { binding: 'account', reason: 'bound' };
  return { binding: 'equip', reason: 'fresh' };
}

/**
 * The item's binding and whether it may be traded under `settings` (docs/TRADING.md "1. Item
 * binding"). Pure; the same answer on the server and in a tooltip.
 */
export function itemBinding(
  item: ItemBindingInput,
  settings: Readonly<TradingSwitches> = DEFAULT_TRADING_SWITCHES,
): ItemBindingResult {
  const state = itemBindingState(item);
  if (state.binding === 'account') return { ...state, categories: [], tradeable: false };
  const categories = itemTradeCategories(item);
  const tradeable =
    settings.trading &&
    settings.items &&
    categories.length > 0 &&
    categories.every((c) => settings.categories[c]);
  return { ...state, categories, tradeable };
}
