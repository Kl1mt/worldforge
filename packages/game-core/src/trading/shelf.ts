import { MATERIAL_IDS, type MaterialId } from '../world/materials.js';
import type { MaterialBundle } from '../economy/forge.js';
import type { TradeKind } from './settings.js';

/**
 * The shared account shelf (ticket T.3, docs/TRADING.md "3. The shared account shelf"): a second
 * tab in the Warehouse that moves items, materials and gold between the heroes of one account.
 * Pure rules; the server applies them under the account's shelf lock and the hero's lock.
 *
 * - **Items** stay the same item rows (4.7's "marker, not a copy"): a shelf marker and the account
 *   id on the row. Moving one neither binds it nor counts as a trade.
 * - **Materials and gold** on the shelf belong to the account. Depositing takes them from one hero,
 *   withdrawing gives them to any hero of the account.
 * - **Switches** (T.2 "Shelf: items / materials / gold"): a kind that is switched off takes no
 *   deposits. **Withdrawals are always allowed**, so nothing is ever trapped.
 * - **Held value** (received in a trade under 72 hours ago, T.5) can't go onto the shelf until the
 *   hold ends, so a reversal can always find it.
 * - **No caps:** moving value between your own heroes counts toward nothing.
 */

export interface ShelfConfig {
  /** Item places on the shelf (shared by every hero of the account). */
  itemCapacity: number;
  /** Items one request may name (the same bound as a warehouse move). */
  maxItemsPerRequest: number;
  /** Gold one request may move (a sanity bound on the body, not a cap). */
  maxGoldPerRequest: number;
  /** Units of one material one request may move (a sanity bound on the body). */
  maxMaterialPerRequest: number;
}

/**
 * 20 item places to start (TRADING.md §3; upgrades are a later sink, B.3 sets their prices).
 * Materials and gold are unlimited, like a hero's own stacks and purse.
 */
export const DEFAULT_SHELF_CONFIG: ShelfConfig = {
  itemCapacity: 20,
  maxItemsPerRequest: 100,
  maxGoldPerRequest: 1_000_000_000,
  maxMaterialPerRequest: 1_000_000_000,
};

export type ShelfDirection = 'deposit' | 'withdraw';

/** What one request moves; any kind may be empty, but not all of them. */
export interface ShelfMoveRequest {
  itemIds: readonly string[];
  gold: number;
  materials: MaterialBundle;
}

/** A hero's item as the deposit rules see it. */
export interface ShelfHeroItem {
  id: string;
  equipped: boolean;
  inWarehouse: boolean;
  onShelf: boolean;
  /** T.1's `hold_until` (epoch ms), or null. */
  holdUntilMs: number | null;
}

/**
 * Held value on a hero (T.5 writes it: gold and materials received in a trade under 72 h ago).
 * Until T.5 it is always empty; the server's seam returns it.
 */
export interface HeldValue {
  gold: number;
  materials: MaterialBundle;
}

export const NO_HELD_VALUE: Readonly<HeldValue> = Object.freeze({ gold: 0, materials: {} });

export type ShelfRefusal =
  | { kind: 'nothing_to_move' }
  | { kind: 'shelf_paused'; what: TradeKind }
  | { kind: 'not_found'; itemId: string }
  | { kind: 'item_equipped'; itemId: string }
  | { kind: 'item_in_warehouse'; itemId: string }
  | { kind: 'item_on_shelf'; itemId: string }
  | { kind: 'item_held'; itemId: string; holdUntilMs: number }
  | { kind: 'shelf_full'; capacity: number; free: number; needed: number }
  | { kind: 'inventory_full'; capacity: number; free: number; needed: number }
  | { kind: 'insufficient_gold'; needed: number; available: number; held: number }
  | {
      kind: 'insufficient_materials';
      materialId: MaterialId;
      needed: number;
      available: number;
      held: number;
    };

export interface ShelfMove {
  itemIds: string[];
  gold: number;
  materials: MaterialBundle;
  /** The kinds this move touches, in `TRADE_KINDS` order. */
  kinds: TradeKind[];
}

export type ShelfPlan = { ok: true; move: ShelfMove } | { ok: false; refusal: ShelfRefusal };

/** Only positive, known materials, in `MATERIAL_IDS` order. */
export function cleanBundle(bundle: Readonly<Record<string, number | undefined>>): MaterialBundle {
  const out: MaterialBundle = {};
  for (const id of MATERIAL_IDS) {
    const n = bundle[id];
    if (typeof n === 'number' && Number.isInteger(n) && n > 0) out[id] = n;
  }
  return out;
}

/** Sum of a bundle's units. */
export function bundleTotal(bundle: Readonly<MaterialBundle>): number {
  return Object.values(bundle).reduce<number>((s, n) => s + (n ?? 0), 0);
}

/** True while `hold_until` lies after `nowMs` (the transaction's clock: the window rule). */
export function isHeldItem(item: Pick<ShelfHeroItem, 'holdUntilMs'>, nowMs: number): boolean {
  return item.holdUntilMs !== null && item.holdUntilMs > nowMs;
}

function kindsOf(itemIds: readonly string[], gold: number, materials: MaterialBundle): TradeKind[] {
  const kinds: TradeKind[] = [];
  if (itemIds.length > 0) kinds.push('items');
  if (bundleTotal(materials) > 0) kinds.push('materials');
  if (gold > 0) kinds.push('gold');
  return kinds;
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Plans a deposit from one hero onto the account's shelf. All or nothing, checked in this order:
 * something to move; each kind's switch (`shelf_paused`); each item (`not_found` for an id that is
 * not this hero's, then equipped, in the warehouse, already on the shelf, held); room on the shelf;
 * the hero's gold and materials minus what is held.
 */
export function planShelfDeposit(input: {
  request: ShelfMoveRequest;
  /** The hero's items (worn, packed, stored; shelf rows it placed are marked `onShelf`). */
  heroItems: readonly ShelfHeroItem[];
  heroGold: number;
  heroMaterials: Readonly<MaterialBundle>;
  held: Readonly<HeldValue>;
  /** Items on the account's shelf now. */
  shelfItemCount: number;
  /** "Shelf: …" switches (T.2), read inside the transaction. */
  switches: Readonly<Record<TradeKind, boolean>>;
  nowMs: number;
  config?: ShelfConfig;
}): ShelfPlan {
  const config = input.config ?? DEFAULT_SHELF_CONFIG;
  const itemIds = unique(input.request.itemIds);
  const materials = cleanBundle(input.request.materials);
  const gold = input.request.gold;
  const kinds = kindsOf(itemIds, gold, materials);
  if (kinds.length === 0) return { ok: false, refusal: { kind: 'nothing_to_move' } };
  for (const k of kinds) {
    if (!input.switches[k]) return { ok: false, refusal: { kind: 'shelf_paused', what: k } };
  }
  const byId = new Map(input.heroItems.map((i) => [i.id, i]));
  for (const id of itemIds) {
    const item = byId.get(id);
    if (!item) return { ok: false, refusal: { kind: 'not_found', itemId: id } };
    if (item.onShelf) return { ok: false, refusal: { kind: 'item_on_shelf', itemId: id } };
    if (item.equipped) return { ok: false, refusal: { kind: 'item_equipped', itemId: id } };
    if (item.inWarehouse) return { ok: false, refusal: { kind: 'item_in_warehouse', itemId: id } };
    if (isHeldItem(item, input.nowMs)) {
      return {
        ok: false,
        refusal: { kind: 'item_held', itemId: id, holdUntilMs: item.holdUntilMs! },
      };
    }
  }
  const free = Math.max(0, config.itemCapacity - input.shelfItemCount);
  if (itemIds.length > free) {
    return {
      ok: false,
      refusal: { kind: 'shelf_full', capacity: config.itemCapacity, free, needed: itemIds.length },
    };
  }
  const heldGold = Math.max(0, input.held.gold);
  if (gold > input.heroGold - heldGold) {
    return {
      ok: false,
      refusal: {
        kind: 'insufficient_gold',
        needed: gold,
        available: Math.max(0, input.heroGold - heldGold),
        held: heldGold,
      },
    };
  }
  for (const [id, n] of Object.entries(materials) as [MaterialId, number][]) {
    const have = input.heroMaterials[id] ?? 0;
    const held = Math.max(0, input.held.materials[id] ?? 0);
    if (n > have - held) {
      return {
        ok: false,
        refusal: {
          kind: 'insufficient_materials',
          materialId: id,
          needed: n,
          available: Math.max(0, have - held),
          held,
        },
      };
    }
  }
  return { ok: true, move: { itemIds, gold, materials, kinds } };
}

/**
 * Plans a withdrawal from the account's shelf to one hero. **Never checks a switch**: anything on
 * the shelf can always be taken out to any hero of the account. All or nothing: an id that is not
 * on this account's shelf (`not_found`), too few free pack slots below the pack's capacity
 * (`inventory_full`, like a warehouse withdrawal), more gold or materials than the shelf holds.
 */
export function planShelfWithdraw(input: {
  request: ShelfMoveRequest;
  /** Ids of the items on the account's shelf. */
  shelfItemIds: readonly string[];
  shelfGold: number;
  shelfMaterials: Readonly<MaterialBundle>;
  /** Items in the hero's pack now (not worn, not stored, not shelved). */
  packCount: number;
  packCapacity: number;
}): ShelfPlan {
  const itemIds = unique(input.request.itemIds);
  const materials = cleanBundle(input.request.materials);
  const gold = input.request.gold;
  const kinds = kindsOf(itemIds, gold, materials);
  if (kinds.length === 0) return { ok: false, refusal: { kind: 'nothing_to_move' } };
  const onShelf = new Set(input.shelfItemIds);
  for (const id of itemIds) {
    if (!onShelf.has(id)) return { ok: false, refusal: { kind: 'not_found', itemId: id } };
  }
  const free = Math.max(0, input.packCapacity - input.packCount);
  if (itemIds.length > free) {
    return {
      ok: false,
      refusal: {
        kind: 'inventory_full',
        capacity: input.packCapacity,
        free,
        needed: itemIds.length,
      },
    };
  }
  if (gold > input.shelfGold) {
    return {
      ok: false,
      refusal: { kind: 'insufficient_gold', needed: gold, available: input.shelfGold, held: 0 },
    };
  }
  for (const [id, n] of Object.entries(materials) as [MaterialId, number][]) {
    const have = input.shelfMaterials[id] ?? 0;
    if (n > have) {
      return {
        ok: false,
        refusal: {
          kind: 'insufficient_materials',
          materialId: id,
          needed: n,
          available: have,
          held: 0,
        },
      };
    }
  }
  return { ok: true, move: { itemIds, gold, materials, kinds } };
}
