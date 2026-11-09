import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHELF_CONFIG,
  NO_HELD_VALUE,
  bundleTotal,
  cleanBundle,
  isHeldItem,
  planShelfDeposit,
  planShelfWithdraw,
  type ShelfHeroItem,
} from './shelf.js';

const NOW = Date.parse('2031-05-01T12:00:00Z');
const ON = { items: true, materials: true, gold: true };
const OFF = { items: false, materials: false, gold: false };
const item = (id: string, over: Partial<ShelfHeroItem> = {}): ShelfHeroItem => ({
  id,
  equipped: false,
  inWarehouse: false,
  onShelf: false,
  holdUntilMs: null,
  ...over,
});

const deposit = (over: Partial<Parameters<typeof planShelfDeposit>[0]> = {}) =>
  planShelfDeposit({
    request: { itemIds: [], gold: 0, materials: {} },
    heroItems: [item('a'), item('b')],
    heroGold: 500,
    heroMaterials: { timber: 10 },
    held: NO_HELD_VALUE,
    shelfItemCount: 0,
    switches: ON,
    nowMs: NOW,
    ...over,
  });

const withdraw = (over: Partial<Parameters<typeof planShelfWithdraw>[0]> = {}) =>
  planShelfWithdraw({
    request: { itemIds: [], gold: 0, materials: {} },
    shelfItemIds: ['a', 'b'],
    shelfGold: 300,
    shelfMaterials: { timber: 4 },
    packCount: 0,
    packCapacity: 60,
    ...over,
  });

describe('shelf config', () => {
  it('starts with 20 item places', () => {
    expect(DEFAULT_SHELF_CONFIG.itemCapacity).toBe(20);
  });
});

describe('planShelfDeposit', () => {
  it('moves each kind and reports the kinds in order', () => {
    const plan = deposit({ request: { itemIds: ['a', 'a'], gold: 100, materials: { timber: 3 } } });
    expect(plan).toEqual({
      ok: true,
      move: {
        itemIds: ['a'],
        gold: 100,
        materials: { timber: 3 },
        kinds: ['items', 'materials', 'gold'],
      },
    });
  });

  it('refuses an empty request', () => {
    expect(deposit()).toEqual({ ok: false, refusal: { kind: 'nothing_to_move' } });
    expect(deposit({ request: { itemIds: [], gold: 0, materials: { timber: 0 } } })).toMatchObject({
      ok: false,
      refusal: { kind: 'nothing_to_move' },
    });
  });

  it('refuses each kind while its switch is off', () => {
    for (const [what, request] of [
      ['items', { itemIds: ['a'], gold: 0, materials: {} }],
      ['materials', { itemIds: [], gold: 0, materials: { timber: 1 } }],
      ['gold', { itemIds: [], gold: 1, materials: {} }],
    ] as const) {
      expect(deposit({ request, switches: OFF })).toEqual({
        ok: false,
        refusal: { kind: 'shelf_paused', what },
      });
      expect(deposit({ request, switches: { ...OFF, [what]: true } }).ok).toBe(true);
    }
    // One kind off refuses a mixed request as a whole.
    expect(
      deposit({
        request: { itemIds: ['a'], gold: 1, materials: {} },
        switches: { ...ON, gold: false },
      }),
    ).toEqual({ ok: false, refusal: { kind: 'shelf_paused', what: 'gold' } });
  });

  it('refuses items that are foreign, worn, stored, shelved or held', () => {
    const items = [
      item('worn', { equipped: true }),
      item('stored', { inWarehouse: true }),
      item('shelved', { onShelf: true }),
      item('held', { holdUntilMs: NOW + 1 }),
      item('released', { holdUntilMs: NOW }),
    ];
    const one = (id: string) =>
      deposit({ heroItems: items, request: { itemIds: [id], gold: 0, materials: {} } });
    expect(one('nope')).toMatchObject({ refusal: { kind: 'not_found', itemId: 'nope' } });
    expect(one('worn')).toMatchObject({ refusal: { kind: 'item_equipped' } });
    expect(one('stored')).toMatchObject({ refusal: { kind: 'item_in_warehouse' } });
    expect(one('shelved')).toMatchObject({ refusal: { kind: 'item_on_shelf' } });
    expect(one('held')).toMatchObject({ refusal: { kind: 'item_held', holdUntilMs: NOW + 1 } });
    // The hold ends at `hold_until` exactly (the transaction's clock).
    expect(one('released').ok).toBe(true);
  });

  it('respects the shelf capacity, all or nothing', () => {
    const items = Array.from({ length: 5 }, (_, n) => item(`i${n}`));
    const ids = items.map((i) => i.id);
    expect(
      deposit({
        heroItems: items,
        shelfItemCount: 17,
        request: { itemIds: ids, gold: 0, materials: {} },
      }),
    ).toEqual({ ok: false, refusal: { kind: 'shelf_full', capacity: 20, free: 3, needed: 5 } });
    expect(
      deposit({
        heroItems: items,
        shelfItemCount: 15,
        request: { itemIds: ids, gold: 0, materials: {} },
      }).ok,
    ).toBe(true);
  });

  it('never takes more gold or materials than the hero holds minus what is held', () => {
    expect(deposit({ request: { itemIds: [], gold: 501, materials: {} } })).toMatchObject({
      refusal: { kind: 'insufficient_gold', needed: 501, available: 500, held: 0 },
    });
    expect(
      deposit({
        request: { itemIds: [], gold: 401, materials: {} },
        held: { gold: 100, materials: {} },
      }),
    ).toMatchObject({ refusal: { kind: 'insufficient_gold', available: 400, held: 100 } });
    expect(
      deposit({
        request: { itemIds: [], gold: 400, materials: {} },
        held: { gold: 100, materials: {} },
      }).ok,
    ).toBe(true);
    expect(
      deposit({
        request: { itemIds: [], gold: 0, materials: { timber: 8 } },
        held: { gold: 0, materials: { timber: 3 } },
      }),
    ).toMatchObject({
      refusal: { kind: 'insufficient_materials', materialId: 'timber', available: 7, held: 3 },
    });
    expect(deposit({ request: { itemIds: [], gold: 0, materials: { ironOre: 1 } } })).toMatchObject(
      { refusal: { kind: 'insufficient_materials', materialId: 'ironOre', available: 0 } },
    );
  });
});

describe('planShelfWithdraw', () => {
  it('ignores the switches: anything on the shelf can always be taken out', () => {
    // The plan has no switch input at all.
    expect(withdraw({ request: { itemIds: ['a'], gold: 300, materials: { timber: 4 } } })).toEqual({
      ok: true,
      move: {
        itemIds: ['a'],
        gold: 300,
        materials: { timber: 4 },
        kinds: ['items', 'materials', 'gold'],
      },
    });
  });

  it('refuses ids not on the shelf, a full pack and more than the shelf holds', () => {
    expect(withdraw({ request: { itemIds: ['x'], gold: 0, materials: {} } })).toMatchObject({
      refusal: { kind: 'not_found', itemId: 'x' },
    });
    expect(
      withdraw({ packCount: 59, request: { itemIds: ['a', 'b'], gold: 0, materials: {} } }),
    ).toEqual({ ok: false, refusal: { kind: 'inventory_full', capacity: 60, free: 1, needed: 2 } });
    // A pack over capacity (B.2) takes nothing back.
    expect(
      withdraw({ packCount: 61, request: { itemIds: ['a'], gold: 0, materials: {} } }),
    ).toMatchObject({
      refusal: { kind: 'inventory_full', free: 0 },
    });
    // Gold and materials need no pack room.
    expect(withdraw({ packCount: 61, request: { itemIds: [], gold: 10, materials: {} } }).ok).toBe(
      true,
    );
    expect(withdraw({ request: { itemIds: [], gold: 301, materials: {} } })).toMatchObject({
      refusal: { kind: 'insufficient_gold', available: 300 },
    });
    expect(withdraw({ request: { itemIds: [], gold: 0, materials: { timber: 5 } } })).toMatchObject(
      {
        refusal: { kind: 'insufficient_materials', available: 4 },
      },
    );
    expect(withdraw()).toEqual({ ok: false, refusal: { kind: 'nothing_to_move' } });
  });
});

describe('helpers', () => {
  it('cleans and sums bundles', () => {
    expect(cleanBundle({ timber: 2, nope: 4, ashwort: 0, ironOre: -1, rawHide: 1.5 })).toEqual({
      timber: 2,
    });
    expect(bundleTotal({ timber: 2, ironOre: 3 })).toBe(5);
    expect(isHeldItem({ holdUntilMs: null }, NOW)).toBe(false);
  });
});
