import { describe, expect, it } from 'vitest';
import { isUnlocked } from '../world/unlocks.js';
import { worldFlagsFrom } from '../world/projects.js';
import {
  DEFAULT_WAREHOUSE_CONFIG,
  WAREHOUSE_UNLOCK,
  maxWarehouseLevel,
  nextWarehouseUpgrade,
  planWarehouseMove,
  warehouseCapacity,
  type WarehouseMoveItem,
} from './warehouse.js';

const progress = { gravewardenDefeated: false };

describe('warehouse (ticket 4.7)', () => {
  it('opens only with the warehouseRestored world flag', () => {
    expect(isUnlocked(WAREHOUSE_UNLOCK, { level: 30 }, progress)).toBe(false);
    expect(isUnlocked(WAREHOUSE_UNLOCK, { level: 1, world: worldFlagsFrom([]) }, progress)).toBe(
      false,
    );
    expect(
      isUnlocked(
        WAREHOUSE_UNLOCK,
        { level: 1, world: worldFlagsFrom(['ashenPassCleared']) },
        progress,
      ),
    ).toBe(false);
    expect(
      isUnlocked(
        WAREHOUSE_UNLOCK,
        { level: 1, world: worldFlagsFrom(['warehouseRestored']) },
        progress,
      ),
    ).toBe(true);
  });

  it('grows from 30 to 120 slots in six upgrades with rising gold costs', () => {
    expect(warehouseCapacity(0)).toBe(30);
    expect(maxWarehouseLevel()).toBe(6);
    expect(warehouseCapacity(6)).toBe(120);
    const costs = DEFAULT_WAREHOUSE_CONFIG.upgrades.map((u) => u.gold);
    for (let i = 1; i < costs.length; i++) expect(costs[i]!).toBeGreaterThan(costs[i - 1]!);
    expect(nextWarehouseUpgrade(0)).toEqual({ slots: 15, gold: 1_000, toLevel: 1, capacity: 45 });
    expect(nextWarehouseUpgrade(6)).toBeNull();
    expect(() => warehouseCapacity(7)).toThrow(RangeError);
    expect(() => warehouseCapacity(-1)).toThrow(RangeError);
    expect(() => nextWarehouseUpgrade(1.5)).toThrow(RangeError);
  });

  const pack = (id: string): WarehouseMoveItem => ({ id, equipped: false, inWarehouse: false });
  const stored = (id: string): WarehouseMoveItem => ({ id, equipped: false, inWarehouse: true });
  const worn = (id: string): WarehouseMoveItem => ({ id, equipped: true, inWarehouse: false });

  it('deposits all or nothing, up to the free warehouse slots', () => {
    const items = [pack('a'), pack('b'), pack('c'), stored('s'), worn('w')];
    const base = { items, packCapacity: 3, warehouseCapacity: 3 };
    expect(planWarehouseMove({ ...base, direction: 'deposit', itemIds: ['a', 'b'] })).toEqual({
      ok: true,
      move: ['a', 'b'],
      unchanged: [],
    });
    expect(planWarehouseMove({ ...base, direction: 'deposit', itemIds: ['a', 'b', 'c'] })).toEqual({
      ok: false,
      refusal: { kind: 'warehouse_full', capacity: 3, free: 2, needed: 3 },
    });
    // Already stored: unchanged, takes no room.
    expect(planWarehouseMove({ ...base, direction: 'deposit', itemIds: ['s', 'a'] })).toEqual({
      ok: true,
      move: ['a'],
      unchanged: ['s'],
    });
    expect(planWarehouseMove({ ...base, direction: 'deposit', itemIds: ['a', 'w'] })).toEqual({
      ok: false,
      refusal: { kind: 'item_equipped', itemId: 'w' },
    });
    expect(planWarehouseMove({ ...base, direction: 'deposit', itemIds: ['x'] })).toEqual({
      ok: false,
      refusal: { kind: 'not_found', itemId: 'x' },
    });
  });

  it('withdraws only into free pack slots (an over-capacity pack takes none)', () => {
    const items = [pack('a'), pack('b'), stored('s'), stored('t'), worn('w')];
    const base = { items, warehouseCapacity: 30 };
    expect(
      planWarehouseMove({ ...base, packCapacity: 3, direction: 'withdraw', itemIds: ['s'] }),
    ).toEqual({ ok: true, move: ['s'], unchanged: [] });
    expect(
      planWarehouseMove({ ...base, packCapacity: 3, direction: 'withdraw', itemIds: ['s', 't'] }),
    ).toEqual({ ok: false, refusal: { kind: 'inventory_full', capacity: 3, free: 1, needed: 2 } });
    expect(
      planWarehouseMove({ ...base, packCapacity: 1, direction: 'withdraw', itemIds: ['s'] }),
    ).toEqual({ ok: false, refusal: { kind: 'inventory_full', capacity: 1, free: 0, needed: 1 } });
    // Withdrawing what is already in the pack changes nothing and needs no room.
    expect(
      planWarehouseMove({ ...base, packCapacity: 1, direction: 'withdraw', itemIds: ['a'] }),
    ).toEqual({ ok: true, move: [], unchanged: ['a'] });
  });

  it('lets an over-capacity pack deposit (the B.2 follow-up)', () => {
    const items = [pack('a'), pack('b'), pack('c'), pack('d')];
    expect(
      planWarehouseMove({
        items,
        packCapacity: 2,
        warehouseCapacity: 30,
        direction: 'deposit',
        itemIds: ['a', 'b', 'c'],
      }),
    ).toMatchObject({ ok: true, move: ['a', 'b', 'c'] });
  });
});
