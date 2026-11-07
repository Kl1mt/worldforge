import type { UnlockRule } from '../world/unlocks.js';

/**
 * The Graumark Warehouse (ticket 4.7, GDD §4.2): per-character storage beside the pack. Pure rules;
 * the server applies them under the character lock. Items in the warehouse stay the same item rows
 * (a location marker), so identity, locks, forge state and audit history are kept.
 *
 * The building opens for everyone with the world flag `warehouseRestored` (the first community
 * project, ticket 4.6). Storage is per character: there is no transfer between characters.
 */

/** The building's unlock: no level, only the world flag. Closed when the caller passes no flags. */
export const WAREHOUSE_UNLOCK: UnlockRule = { level: 1, worldFlag: 'warehouseRestored' };

export interface WarehouseUpgrade {
  /** Slots this upgrade adds. */
  slots: number;
  /** Gold it costs (a sink: nothing is refunded). */
  gold: number;
}

export interface WarehouseConfig {
  /** Slots of a fresh warehouse (upgrade level 0). */
  baseCapacity: number;
  /** Upgrades in order; `upgrades[n]` takes level n to n + 1. */
  upgrades: readonly WarehouseUpgrade[];
  /** Items one move request may name (single and bulk). */
  maxMovePerRequest: number;
}

/**
 * Numbers: 30 slots to start (half a pack), +15 per upgrade up to 120 (two packs). The first step
 * costs about three hours of early farming gold; the last ones are late-game sinks (the Abbey pays
 * ~1,650 gold an hour at realistic play, `docs/ECONOMY.md`). All of it is data for B.3 to tune.
 */
export const DEFAULT_WAREHOUSE_CONFIG: WarehouseConfig = {
  baseCapacity: 30,
  upgrades: [
    { slots: 15, gold: 1_000 },
    { slots: 15, gold: 3_000 },
    { slots: 15, gold: 7_500 },
    { slots: 15, gold: 15_000 },
    { slots: 15, gold: 30_000 },
    { slots: 15, gold: 50_000 },
  ],
  maxMovePerRequest: 100,
};

function checkLevel(level: number, config: WarehouseConfig): void {
  if (!Number.isInteger(level) || level < 0 || level > config.upgrades.length) {
    throw new RangeError(`Invalid warehouse level: ${level}`);
  }
}

/** The highest upgrade level. */
export function maxWarehouseLevel(config: WarehouseConfig = DEFAULT_WAREHOUSE_CONFIG): number {
  return config.upgrades.length;
}

/** Slots of a warehouse at `level` (0 = never upgraded). */
export function warehouseCapacity(
  level: number,
  config: WarehouseConfig = DEFAULT_WAREHOUSE_CONFIG,
): number {
  checkLevel(level, config);
  return config.upgrades.slice(0, level).reduce((s, u) => s + u.slots, config.baseCapacity);
}

/** The next upgrade from `level` (with the level and capacity it leads to), or null at the top. */
export function nextWarehouseUpgrade(
  level: number,
  config: WarehouseConfig = DEFAULT_WAREHOUSE_CONFIG,
): (WarehouseUpgrade & { toLevel: number; capacity: number }) | null {
  checkLevel(level, config);
  const up = config.upgrades[level];
  if (!up) return null;
  return { ...up, toLevel: level + 1, capacity: warehouseCapacity(level + 1, config) };
}

export type WarehouseMoveDirection = 'deposit' | 'withdraw';

/** Where an item is, as the move rules see it. */
export interface WarehouseMoveItem {
  id: string;
  equipped: boolean;
  inWarehouse: boolean;
}

export type WarehouseMoveRefusal =
  | { kind: 'not_found'; itemId: string }
  | { kind: 'item_equipped'; itemId: string }
  | { kind: 'warehouse_full'; capacity: number; free: number; needed: number }
  | { kind: 'inventory_full'; capacity: number; free: number; needed: number };

export type WarehouseMovePlan =
  { ok: true; move: string[]; unchanged: string[] } | { ok: false; refusal: WarehouseMoveRefusal };

/**
 * Plans moving `itemIds` (a character's items) into or out of the warehouse. All or nothing:
 * an unknown id, an equipped item or too little room on the receiving side refuses the whole
 * request. Locked and valuable items move like any other. An item already on the receiving side
 * is left as it is (idempotent, like unequip). Deposits need room in the warehouse; withdrawals
 * need free pack slots below the pack's capacity (a pack already over capacity, B.2, takes none).
 */
export function planWarehouseMove(input: {
  direction: WarehouseMoveDirection;
  itemIds: readonly string[];
  items: readonly WarehouseMoveItem[];
  packCapacity: number;
  warehouseCapacity: number;
}): WarehouseMovePlan {
  const byId = new Map(input.items.map((i) => [i.id, i]));
  const move: string[] = [];
  const unchanged: string[] = [];
  for (const id of input.itemIds) {
    const item = byId.get(id);
    if (!item) return { ok: false, refusal: { kind: 'not_found', itemId: id } };
    if (item.equipped) return { ok: false, refusal: { kind: 'item_equipped', itemId: id } };
    const there = input.direction === 'deposit' ? item.inWarehouse : !item.inWarehouse;
    (there ? unchanged : move).push(id);
  }
  const stored = input.items.filter((i) => i.inWarehouse).length;
  const packed = input.items.filter((i) => !i.inWarehouse && !i.equipped).length;
  if (input.direction === 'deposit') {
    const free = Math.max(0, input.warehouseCapacity - stored);
    if (move.length > free) {
      return {
        ok: false,
        refusal: {
          kind: 'warehouse_full',
          capacity: input.warehouseCapacity,
          free,
          needed: move.length,
        },
      };
    }
  } else {
    const free = Math.max(0, input.packCapacity - packed);
    if (move.length > free) {
      return {
        ok: false,
        refusal: {
          kind: 'inventory_full',
          capacity: input.packCapacity,
          free,
          needed: move.length,
        },
      };
    }
  }
  return { ok: true, move, unchanged };
}
