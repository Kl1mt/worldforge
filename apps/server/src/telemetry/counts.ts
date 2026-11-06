import type { FilteredDrop, MaterialId, RarityId } from '@worldforge/game-core';
import type { TelemetryCount } from './record.js';

/**
 * Builders for the counts each value path records (ticket 3.8, docs/TELEMETRY.md). Pure: they only
 * turn what the path already computed into counter rows, so telemetry can never change a result.
 */

/** Where an item came from (`item.drop` dim1). */
export type DropSource =
  'farming' | 'crypt' | 'crypt_hoard' | 'quest' | 'contract' | 'merchant' | 'craft';

/** What became of a rolled drop (`item.fate` dim2). */
export type DropFate = 'kept' | 'filter_sold' | 'filter_salvaged' | 'overflow_salvaged';

/** The item fields telemetry reads (a `GeneratedItem` or an `item_instances` row). */
export interface CountedItem {
  rarityId: RarityId | string;
  effectId?: string | null;
  setId?: string | null;
  variant?: string | null;
}

/**
 * `item.drop` / `item.variant` / `item.effect` / `item.set` for items entering the game, with
 * `context` the area id, `<dungeon>:<tier>`, quest id or recipe id.
 */
export function dropCounts(
  source: DropSource,
  context: string,
  items: readonly CountedItem[],
): TelemetryCount[] {
  const out: TelemetryCount[] = [];
  for (const item of items) {
    out.push({ metric: 'item.drop', dims: [source, context, item.rarityId] });
    if (item.variant)
      out.push({ metric: 'item.variant', dims: [source, item.variant, item.rarityId] });
    if (item.effectId)
      out.push({ metric: 'item.effect', dims: [source, item.effectId, item.rarityId] });
    if (item.setId) out.push({ metric: 'item.set', dims: [source, item.setId] });
  }
  return out;
}

/** `item.fate`: one event per item, `amount` the gold it yielded (filter sells/salvages). */
export function fateCounts(
  source: DropSource,
  fate: DropFate,
  items: readonly CountedItem[],
  goldOf: (index: number) => number = () => 0,
): TelemetryCount[] {
  return items.map((item, n) => ({
    metric: 'item.fate',
    dims: [source, fate, item.rarityId],
    amount: goldOf(n),
  }));
}

/** `item.fate` for loot-filter drops, split by action, with each drop's gold. */
export function filteredFateCounts(
  source: DropSource,
  filtered: readonly FilteredDrop[] | undefined,
): TelemetryCount[] {
  return (filtered ?? []).map((f) => ({
    metric: 'item.fate',
    dims: [source, f.action === 'sell' ? 'filter_sold' : 'filter_salvaged', f.item.rarityId],
    amount: f.gold,
  }));
}

/** A rolled drop: counted as a drop and with its fate (all pack-bound drop paths use this). */
export function rolledDropCounts(
  source: DropSource,
  context: string,
  placed: {
    items: readonly CountedItem[];
    salvaged: readonly CountedItem[];
    filtered?: readonly FilteredDrop[] | undefined;
  },
): TelemetryCount[] {
  const filtered = placed.filtered ?? [];
  return [
    ...dropCounts(source, context, [
      ...placed.items,
      ...placed.salvaged,
      ...filtered.map((f) => f.item),
    ]),
    ...fateCounts(source, 'kept', placed.items),
    ...fateCounts(source, 'overflow_salvaged', placed.salvaged),
    ...filteredFateCounts(source, filtered),
  ];
}

export function goldIn(source: string, context: string, gold: number): TelemetryCount[] {
  return gold === 0 ? [] : [{ metric: 'gold.in', dims: [source, context], amount: gold }];
}

export function goldOut(sink: string, context: string, gold: number): TelemetryCount[] {
  return gold === 0 ? [] : [{ metric: 'gold.out', dims: [sink, context], amount: gold }];
}

export function xpIn(source: string, context: string, xp: number): TelemetryCount[] {
  return xp === 0 ? [] : [{ metric: 'xp.in', dims: [source, context], amount: xp }];
}

type Bundle = Partial<Record<MaterialId | string, number>>;

/** `material.in` / `material.out` per material, `amount` the quantity. */
export function materialCounts(
  metric: 'material.in' | 'material.out',
  source: string,
  materials: Bundle | undefined,
): TelemetryCount[] {
  return Object.entries(materials ?? {})
    .filter(([, n]) => (n ?? 0) > 0)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([id, n]) => ({ metric, dims: [source, id], amount: n! }));
}

/** `pack.overflow`: one event per settlement or claim that overflowed, `amount` the items. */
export function overflowCounts(
  source: DropSource,
  context: string,
  items: number,
): TelemetryCount[] {
  return items === 0 ? [] : [{ metric: 'pack.overflow', dims: [source, context], amount: items }];
}

/** Manual merchant sells and forge salvages, per rarity, `amount` the gold. */
export function disposalCounts(
  metric: 'item.sold' | 'item.salvaged' | 'item.discarded',
  items: readonly CountedItem[],
  goldOf: (index: number) => number = () => 0,
): TelemetryCount[] {
  return items.map((item, n) => ({ metric, dims: [item.rarityId], amount: goldOf(n) }));
}
