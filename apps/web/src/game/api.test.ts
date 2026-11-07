import { describe, expect, it } from 'vitest';
import { activityApi, describeGameFailure, inventoryApi, warehouseApi, worldApi } from './api';

function recorder() {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return Response.json({});
  }) as unknown as typeof fetch;
  return { calls, f };
}

const C = '01900000-0000-7000-8000-000000000000';
const I = '01900000-0000-7000-8000-0000000000aa';

describe('game api', () => {
  it('sends intents and ids only, never rewards', async () => {
    const { calls, f } = recorder();
    await activityApi.start(C, 'abandonedFields', f);
    await activityApi.settle(C, f);
    await activityApi.stop(C, f);
    await inventoryApi.equip(C, I, undefined, f);
    await inventoryApi.equip(C, I, 'ring2', f);
    await inventoryApi.unequip(C, I, f);
    await inventoryApi.discard(C, I, f);
    expect(calls).toEqual([
      { url: `/api/characters/${C}/activity`, method: 'POST', body: { areaId: 'abandonedFields' } },
      { url: `/api/characters/${C}/activity/settle`, method: 'POST', body: undefined },
      { url: `/api/characters/${C}/activity/stop`, method: 'POST', body: undefined },
      { url: `/api/characters/${C}/items/${I}/equip`, method: 'POST', body: undefined },
      { url: `/api/characters/${C}/items/${I}/equip`, method: 'POST', body: { slot: 'ring2' } },
      { url: `/api/characters/${C}/items/${I}/unequip`, method: 'POST', body: undefined },
      { url: `/api/characters/${C}/items/${I}`, method: 'DELETE', body: undefined },
    ]);
  });

  it('reads state with GET', async () => {
    const { calls, f } = recorder();
    await activityApi.get(C, {}, f);
    await inventoryApi.get(C, {}, f);
    await worldApi.get(C, {}, f);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET /api/characters/${C}/activity`,
      `GET /api/characters/${C}/inventory`,
      `GET /api/characters/${C}/world`,
    ]);
  });
});

describe('describeGameFailure', () => {
  it('maps server codes to player-facing text', () => {
    expect(describeGameFailure({ code: 'wrong_class' })).toMatch(/class cannot use/);
    expect(describeGameFailure({ code: 'item_equipped' })).toMatch(/Take the item off/);
    expect(describeGameFailure({ code: 'area_locked' })).toMatch(/not ready/);
    expect(describeGameFailure({ code: 'network' })).toMatch(/cannot be reached/);
    expect(describeGameFailure({ code: 'something_new' })).toMatch(/on our side/);
  });
});

describe('warehouse api (ticket 4.7)', () => {
  it('sends item ids and the seen level only; upgrades carry an Idempotency-Key', async () => {
    const calls: { url: string; method: string; body: unknown; key: string | null }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        method: init.method ?? 'GET',
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        key: new Headers(init.headers).get('idempotency-key'),
      });
      return Response.json({});
    }) as unknown as typeof fetch;
    await warehouseApi.get(C, {}, f);
    await warehouseApi.move(C, 'deposit', [I], f);
    await warehouseApi.move(C, 'withdraw', [I], f);
    await warehouseApi.upgrade(C, 2, 'k-1', f);
    expect(calls).toEqual([
      { url: `/api/characters/${C}/warehouse`, method: 'GET', body: undefined, key: null },
      {
        url: `/api/characters/${C}/warehouse/deposit`,
        method: 'POST',
        body: { itemIds: [I] },
        key: null,
      },
      {
        url: `/api/characters/${C}/warehouse/withdraw`,
        method: 'POST',
        body: { itemIds: [I] },
        key: null,
      },
      {
        url: `/api/characters/${C}/warehouse/upgrade`,
        method: 'POST',
        body: { level: 2 },
        key: 'k-1',
      },
    ]);
  });

  it('explains the warehouse refusals in plain words', () => {
    expect(describeGameFailure({ code: 'warehouse_closed' })).toMatch(/not open yet/);
    expect(describeGameFailure({ code: 'item_in_warehouse' })).toMatch(/Take it out first/);
    expect(describeGameFailure({ code: 'warehouse_full' })).toMatch(/no room/);
  });
});
