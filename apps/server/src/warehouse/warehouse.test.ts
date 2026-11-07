import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, like } from 'drizzle-orm';
import { DEFAULT_ACTIVITY_CONFIG, warehouseCapacity } from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import {
  accounts,
  activities,
  dungeonRuns,
  auditLog,
  characters,
  itemInstances,
  telemetryDaily,
  worldFlags,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { insertCharacter, insertItem } from '../test/heroes.js';
import { insertAccount, type TestAccount } from '../test/social.js';
import { openWarehouse, warehouseCalls } from '../test/warehouse.js';
import { makeCryptReady } from '../test/dungeon.js';
import { completeProject } from '../community/project-cli.js';
import { reconcileWithAudit } from '../telemetry/report.js';
import type { SettleResponse } from '../activity/routes.js';
import type { InventoryView } from '../inventory/routes.js';
import type { WarehouseMoveResponse, WarehouseUpgradeResponse, WarehouseView } from './routes.js';

const HOUR = 3_600_000;
const PACK = DEFAULT_ACTIVITY_CONFIG.inventory.capacity;
let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.parse('2031-05-01T12:00:00Z');
let w: ReturnType<typeof warehouseCalls>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({
    database,
    auth: { accountRateLimit: { requests: 100_000, actions: 100_000, windowMs: 60_000 } },
    activity: { ...DEFAULT_ACTIVITY_OPTIONS, now: () => new Date(nowMs) },
  });
  await app.ready();
  w = warehouseCalls(app);
});

afterAll(async () => {
  await app.close();
  await database.close();
});

const db = () => database.db;
const code = (r: { json: () => unknown }) => (r.json() as { error: { code: string } }).error.code;
const call = (
  who: TestAccount,
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  payload?: object,
  key?: string,
) =>
  app.inject({
    method,
    url,
    ...(payload ? { payload } : {}),
    headers: key ? { 'idempotency-key': key } : {},
    cookies: { [SESSION_COOKIE]: who.token },
  });

async function hero(gold = 0) {
  const who = await insertAccount(db());
  const c = await insertCharacter(db(), who.id, { level: 10 });
  await db().update(accounts).set({ activeCharacterId: c.id }).where(eq(accounts.id, who.id));
  if (gold) await db().update(characters).set({ gold }).where(eq(characters.id, c.id));
  return { who, id: c.id };
}
async function itemRows(characterId: string) {
  return db()
    .select()
    .from(itemInstances)
    .where(eq(itemInstances.characterId, characterId))
    .orderBy(itemInstances.id);
}
async function warehouseAudits() {
  return db().select().from(auditLog).where(like(auditLog.event, 'warehouse.%'));
}
async function goldOf(id: string) {
  return (await db().select().from(characters).where(eq(characters.id, id)))[0]!.gold;
}

describe('warehouse: closed until the town restores it', () => {
  beforeEach(async () => {
    await db().delete(worldFlags);
    app.worldState.invalidate();
  });

  it('answers warehouse_closed on every route and changes nothing', async () => {
    const h = await hero(50_000);
    const item = await insertItem(db(), h.id);
    const before = await itemRows(h.id);
    const audits = (await warehouseAudits()).length;
    const responses = [
      await w.get(h.who.token, h.id),
      await w.move(h.who.token, h.id, 'deposit', [item.id]),
      await w.move(h.who.token, h.id, 'withdraw', [item.id]),
      await w.upgrade(h.who.token, h.id, 0),
    ];
    for (const r of responses) {
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json()).toMatchObject({
        error: {
          code: 'warehouse_closed',
          details: { flag: 'warehouseRestored', projectId: 'restoreWarehouse' },
        },
      });
    }
    // Another account's character gets the same answer (nothing to probe while closed).
    const stranger = await insertAccount(db());
    expect(code(await w.get(stranger.token, h.id))).toBe('warehouse_closed');
    expect(await itemRows(h.id)).toEqual(before);
    expect(await goldOf(h.id)).toBe(50_000);
    expect((await warehouseAudits()).length).toBe(audits);
    // No session is still 401.
    const anon = await app.inject({ method: 'GET', url: `/api/characters/${h.id}/warehouse` });
    expect(anon.statusCode).toBe(401);
  });

  it('opens when the Restore the Graumark Warehouse project completes', async () => {
    const h = await hero();
    expect(code(await w.get(h.who.token, h.id))).toBe('warehouse_closed');
    // The owner CLI finishes the project through the same path as the last contribution.
    await completeProject(db(), 'restoreWarehouse', new Date(nowMs));
    app.worldState.invalidate();
    const r = await w.get(h.who.token, h.id);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json<WarehouseView>()).toMatchObject({
      level: 0,
      capacity: warehouseCapacity(0),
      items: [],
      nextUpgrade: { toLevel: 1, gold: 1_000 },
      pack: { count: 0, capacity: PACK },
    });
  });
});

describe('warehouse: moving items', () => {
  beforeAll(async () => {
    await openWarehouse(app, db());
  });

  it('moves locked and valuable items both ways, single and bulk, keeping the same rows', async () => {
    const h = await hero();
    const legendary = await insertItem(db(), h.id, { rarityId: 'legendary', locked: true });
    const common = await insertItem(db(), h.id);
    const upgraded = await insertItem(db(), h.id, { upgradeLevel: 4 });
    const before = await itemRows(h.id);

    const dep = await w.move(h.who.token, h.id, 'deposit', [legendary.id, common.id, upgraded.id]);
    expect(dep.statusCode, dep.body).toBe(200);
    const body = dep.json<WarehouseMoveResponse>();
    expect(body.moved).toBe(3);
    expect(body.inventory.inventory).toEqual([]);
    expect(body.warehouse.items.map((i) => i.id).sort()).toEqual(
      [legendary.id, common.id, upgraded.id].sort(),
    );
    expect(body.warehouse.pack).toEqual({ count: 0, capacity: PACK });
    // Same rows: identity, lock, forge state and seed are kept; only the marker moved.
    const stored = await itemRows(h.id);
    expect(stored.map(({ inWarehouse: _, ...r }) => r)).toEqual(
      before.map(({ inWarehouse: _, ...r }) => r),
    );
    expect(stored.every((i) => i.inWarehouse)).toBe(true);

    // The pack view no longer lists them.
    const inv = await call(h.who, 'GET', `/api/characters/${h.id}/inventory`);
    expect(inv.json<InventoryView>().inventory).toEqual([]);

    // Repeating a move changes nothing (and audits nothing).
    const audits = (await warehouseAudits()).length;
    const again = await w.move(h.who.token, h.id, 'deposit', [common.id]);
    expect(again.json<WarehouseMoveResponse>().moved).toBe(0);
    expect((await warehouseAudits()).length).toBe(audits);

    const back = await w.move(h.who.token, h.id, 'withdraw', [legendary.id]);
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json<WarehouseMoveResponse>().inventory.inventory.map((i) => i.id)).toEqual([
      legendary.id,
    ]);
    expect(back.json<WarehouseMoveResponse>().inventory.inventory[0]!.locked).toBe(true);

    const rows = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.characterId, h.id), like(auditLog.event, 'warehouse.%')))
      .orderBy(auditLog.id);
    expect(rows.map((r) => [r.event, (r.data as { items: unknown[] }).items.length])).toEqual([
      ['warehouse.deposit', 3],
      ['warehouse.withdraw', 1],
    ]);
  });

  it('refuses equipped items, other characters’ items and unknown ids, all or nothing', async () => {
    const h = await hero();
    const worn = await insertItem(db(), h.id, { equippedSlot: 'weapon' });
    const loose = await insertItem(db(), h.id);
    const other = await hero();
    const theirs = await insertItem(db(), other.id);

    const r1 = await w.move(h.who.token, h.id, 'deposit', [loose.id, worn.id]);
    expect(r1.statusCode).toBe(409);
    expect(code(r1)).toBe('item_equipped');
    const r2 = await w.move(h.who.token, h.id, 'deposit', [loose.id, theirs.id]);
    expect(r2.statusCode).toBe(404);
    const r3 = await w.move(h.who.token, h.id, 'deposit', [randomUUID()]);
    expect(r3.statusCode).toBe(404);
    // Someone else's character: 404, like every character route.
    expect((await w.move(other.who.token, h.id, 'deposit', [loose.id])).statusCode).toBe(404);
    expect((await w.get(other.who.token, h.id)).statusCode).toBe(404);
    expect((await itemRows(h.id)).every((i) => !i.inWarehouse)).toBe(true);
    expect((await itemRows(other.id)).every((i) => !i.inWarehouse)).toBe(true);
  });

  it('holds its capacity at the boundary, and withdrawals need free pack slots', async () => {
    const h = await hero();
    const cap = warehouseCapacity(0);
    for (let i = 0; i < cap - 1; i++) await insertItem(db(), h.id, { inWarehouse: true });
    const a = await insertItem(db(), h.id);
    const b = await insertItem(db(), h.id);

    const full = await w.move(h.who.token, h.id, 'deposit', [a.id, b.id]);
    expect(full.statusCode).toBe(422);
    expect(full.json()).toMatchObject({
      error: { code: 'warehouse_full', details: { capacity: cap, free: 1, needed: 2 } },
    });
    const one = await w.move(h.who.token, h.id, 'deposit', [a.id]);
    expect(one.json<WarehouseMoveResponse>().warehouse.items).toHaveLength(cap);
    expect(code(await w.move(h.who.token, h.id, 'deposit', [b.id]))).toBe('warehouse_full');

    // A full pack takes nothing back.
    for (let i = 0; i < PACK - 1; i++) await insertItem(db(), h.id);
    const stored = (await itemRows(h.id)).filter((i) => i.inWarehouse).map((i) => i.id);
    const out = await w.move(h.who.token, h.id, 'withdraw', stored.slice(0, 2));
    expect(out.statusCode).toBe(422);
    expect(code(out)).toBe('inventory_full');
    expect(code(await w.move(h.who.token, h.id, 'withdraw', stored.slice(0, 1)))).toBe(
      'inventory_full',
    );
  });

  it('takes valuables kept beyond a full pack (the B.2 follow-up)', async () => {
    const h = await hero();
    for (let i = 0; i < PACK; i++) await insertItem(db(), h.id);
    const over = [];
    for (let i = 0; i < 3; i++) over.push(await insertItem(db(), h.id, { rarityId: 'legendary' }));
    const r = await w.move(
      h.who.token,
      h.id,
      'deposit',
      over.map((i) => i.id),
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json<WarehouseMoveResponse>().warehouse.pack).toEqual({ count: PACK, capacity: PACK });
  });
});

describe('warehouse: stored items are out of reach', () => {
  beforeAll(async () => {
    await openWarehouse(app, db());
  });

  it('refuses sell, salvage, discard, equip, lock and the forge on a stored item', async () => {
    const h = await hero(100_000);
    const item = await insertItem(db(), h.id, { baseId: 'longsword' });
    await w.move(h.who.token, h.id, 'deposit', [item.id]);
    const base = `/api/characters/${h.id}`;
    const attempts = [
      await call(h.who, 'POST', `${base}/merchant/sell`, { itemIds: [item.id] }, randomUUID()),
      await call(h.who, 'POST', `${base}/forge/salvage`, { itemIds: [item.id] }, randomUUID()),
      await call(h.who, 'DELETE', `${base}/items/${item.id}`),
      await call(h.who, 'POST', `${base}/items/${item.id}/equip`, {}),
      await call(h.who, 'POST', `${base}/items/${item.id}/unequip`),
      await call(h.who, 'POST', `${base}/items/${item.id}/lock`, {}),
      await call(h.who, 'POST', `${base}/forge/upgrade`, { itemId: item.id }, randomUUID()),
      await call(h.who, 'GET', `${base}/forge/items/${item.id}`),
    ];
    for (const r of attempts) {
      expect(r.statusCode, r.body).toBe(409);
      expect(code(r)).toBe('item_in_warehouse');
    }
    const [row] = await db().select().from(itemInstances).where(eq(itemInstances.id, item.id));
    expect(row).toMatchObject({ inWarehouse: true, locked: false, forgeCounter: 0 });
    expect(await goldOf(h.id)).toBe(100_000);
    // Lists that offer pack items leave it out.
    const merchant = await call(h.who, 'GET', `${base}/merchant`);
    expect(merchant.json<{ sellPrices: unknown[] }>().sellPrices).toEqual([]);
    const forge = await call(h.who, 'GET', `${base}/forge`);
    expect(forge.json<{ salvage: unknown[] }>().salvage).toEqual([]);
  });

  it('stored items take no pack slot (merchant purchase at the boundary)', async () => {
    const h = await hero(1_000_000);
    for (let i = 0; i < PACK - 1; i++) await insertItem(db(), h.id);
    for (let i = 0; i < 5; i++) await insertItem(db(), h.id, { inWarehouse: true });
    const stock = await call(h.who, 'GET', `/api/characters/${h.id}/merchant`);
    const [first, second] = stock.json<{ offers: { offerId: string }[] }>().offers;
    const buy = (offerId: string) =>
      call(h.who, 'POST', `/api/characters/${h.id}/merchant/buy`, { offerId }, randomUUID());
    const r = await buy(first!.offerId);
    expect(r.statusCode, r.body).toBe(200);
    // Now the pack is full; the stored items still don't matter, the pack does.
    expect(code(await buy(second!.offerId))).toBe('inventory_full');
  });
});

describe('warehouse: farming never touches it (invariance)', () => {
  beforeAll(async () => {
    await openWarehouse(app, db());
  });

  async function farmer(stored: number) {
    const h = await hero();
    const res = await call(h.who, 'POST', `/api/characters/${h.id}/activity`, {
      areaId: 'abandonedFields',
    });
    expect(res.statusCode, res.body).toBe(201);
    await db()
      .update(activities)
      .set({ seedSecret: 'warehouse-invariance' })
      .where(eq(activities.characterId, h.id));
    // A loot filter that would salvage every common: it must never reach a stored common.
    await db()
      .update(characters)
      .set({
        lootFilter: {
          action: 'salvage',
          belowRarity: 'uncommon',
          wantedAffixes: [],
          wantedEffects: [],
          include: [],
        },
      })
      .where(eq(characters.id, h.id));
    // A nearly full pack, so the capacity rule is at work during the window.
    for (let i = 0; i < PACK - 3; i++) await insertItem(db(), h.id);
    for (let i = 0; i < stored; i++) await insertItem(db(), h.id, { inWarehouse: true });
    return h;
  }

  it('settles exactly as without a warehouse, leaving stored items as they were', async () => {
    const plain = await farmer(0);
    const keeper = await farmer(warehouseCapacity(0));
    const storedBefore = (await itemRows(keeper.id)).filter((i) => i.inWarehouse);
    nowMs += 2 * HOUR;
    const settle = (h: { who: TestAccount; id: string }) =>
      call(h.who, 'POST', `/api/characters/${h.id}/activity/settle`).then((r) =>
        r.json<SettleResponse>(),
      );
    const a = await settle(plain);
    const b = await settle(keeper);
    const strip = (s: SettleResponse['summary']) => ({
      ...s,
      items: s.items.map(({ id: _id, ...rest }) => rest),
    });
    expect(a.summary.settlements).toBeGreaterThan(0);
    // The window hit the pack's capacity, so the capacity rule was at work.
    expect(a.summary.itemsSalvaged).toBeGreaterThan(0);
    expect(strip(b.summary)).toEqual(strip(a.summary));
    expect(b.character.gold).toBe(a.character.gold);
    expect(b.character.experience).toBe(a.character.experience);
    const storedAfter = (await itemRows(keeper.id)).filter((i) => i.inWarehouse);
    expect(storedAfter).toEqual(storedBefore);
    const packed = async (id: string) =>
      (await itemRows(id)).filter((i) => !i.inWarehouse && i.equippedSlot === null).length;
    expect(await packed(keeper.id)).toBe(await packed(plain.id));
  });

  it('a deposit settles first, so the window before it sees the pack as it was', async () => {
    const h = await farmer(0);
    nowMs += HOUR;
    const loose = (await itemRows(h.id)).slice(0, 10).map((i) => i.id);
    const r = await w.move(h.who.token, h.id, 'deposit', loose);
    expect(r.statusCode, r.body).toBe(200);
    const [act] = await db().select().from(activities).where(eq(activities.characterId, h.id));
    expect(act!.settledAt.getTime()).toBe(nowMs);
  });
});

describe('warehouse: crypt placement never touches it (invariance)', () => {
  beforeAll(async () => {
    await openWarehouse(app, db());
  });

  it('claims exactly as without a warehouse', async () => {
    const run = async (stored: number) => {
      const h = await hero();
      await makeCryptReady(db(), h.id, 'warrior', 16);
      for (let i = 0; i < PACK - 1; i++) await insertItem(db(), h.id);
      for (let i = 0; i < stored; i++) await insertItem(db(), h.id, { inWarehouse: true });
      const enter = await call(h.who, 'POST', `/api/characters/${h.id}/dungeon`, {
        dungeonId: 'namelessCrypt',
      });
      expect(enter.statusCode, enter.body).toBe(201);
      await db()
        .update(dungeonRuns)
        .set({ seedSecret: 'warehouse-crypt' })
        .where(eq(dungeonRuns.characterId, h.id));
      return h;
    };
    const plain = await run(0);
    const keeper = await run(warehouseCapacity(0));
    const storedBefore = (await itemRows(keeper.id)).filter((i) => i.inWarehouse);
    nowMs += 2 * HOUR;
    const claim = (h: { who: TestAccount; id: string }) =>
      call(h.who, 'POST', `/api/characters/${h.id}/dungeon/claim`, undefined, randomUUID());
    const a = await claim(plain);
    const b = await claim(keeper);
    expect(a.statusCode, a.body).toBe(200);
    type Claim = {
      result: { runId?: string; items: { id?: string }[] };
      character: Record<string, unknown>;
    };
    const strip = ({
      result: { runId: _r, items, ...result },
      character: { id: _i, name: _n, createdAt: _c, ...character },
    }: Claim) => ({
      result,
      items: items.map(({ id: _id, ...i }) => i),
      character,
    });
    const ra = strip(a.json<Claim>());
    expect(strip(b.json<Claim>())).toEqual(ra);
    // The claim met the pack's last free slot: one drop placed, the rest overflowed.
    expect(
      ra.items.length + (ra.result as { itemsSalvaged: number }).itemsSalvaged,
    ).toBeGreaterThan(1);
    expect((await itemRows(keeper.id)).filter((i) => i.inWarehouse)).toEqual(storedBefore);
  });
});

describe('warehouse: upgrades (a gold sink)', () => {
  beforeAll(async () => {
    await openWarehouse(app, db());
  });

  it('spends gold once per key, checks the level the client saw, and stops at the top', async () => {
    const h = await hero(500);
    expect(code(await w.upgrade(h.who.token, h.id, 0))).toBe('insufficient_gold');
    await db().update(characters).set({ gold: 200_000 }).where(eq(characters.id, h.id));

    const key = randomUUID();
    const first = await w.upgrade(h.who.token, h.id, 0, key);
    expect(first.statusCode, first.body).toBe(200);
    const body = first.json<WarehouseUpgradeResponse>();
    expect(body).toMatchObject({
      goldSpent: 1_000,
      character: { gold: 199_000 },
      warehouse: { level: 1, capacity: warehouseCapacity(1), nextUpgrade: { toLevel: 2 } },
    });
    // The same key replays without paying again.
    const replay = await w.upgrade(h.who.token, h.id, 0, key);
    expect(replay.json()).toEqual(body);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(await goldOf(h.id)).toBe(199_000);
    // A new key with the old level is refused: nothing bought twice by a double click.
    const stale = await w.upgrade(h.who.token, h.id, 0);
    expect(stale.statusCode).toBe(409);
    expect(code(stale)).toBe('level_changed');
    // Without a key: 400, nothing spent.
    const noKey = await call(h.who, 'POST', `/api/characters/${h.id}/warehouse/upgrade`, {
      level: 1,
    });
    expect(noKey.statusCode).toBe(400);

    let level = 1;
    let spent = 1_000;
    while (true) {
      const r = await w.upgrade(h.who.token, h.id, level);
      if (r.statusCode !== 200) {
        expect(code(r)).toBe('warehouse_max_level');
        break;
      }
      spent += r.json<WarehouseUpgradeResponse>().goldSpent;
      level += 1;
    }
    expect(level).toBe(6);
    expect(spent).toBe(106_500);
    expect(await goldOf(h.id)).toBe(200_000 - 106_500);
    const view = (await w.get(h.who.token, h.id)).json<WarehouseView>();
    expect(view).toMatchObject({ level: 6, capacity: 120, nextUpgrade: null });

    // Audited and counted: the rollups reconcile with the audit log.
    const audits = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.characterId, h.id), eq(auditLog.event, 'warehouse.upgrade')));
    expect(audits).toHaveLength(6);
    const telemetry = await db().select().from(telemetryDaily);
    expect(
      telemetry
        .filter((t) => t.metric === 'gold.out' && t.dim1 === 'warehouse_upgrade')
        .reduce((s, t) => s + Number(t.amount), 0),
    ).toBeGreaterThanOrEqual(106_500);
    const checks = await reconcileWithAudit(db());
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.filter((c) => c.check.startsWith('warehouse:')).map((c) => c.check)).toEqual([
      'warehouse: items deposited',
      'warehouse: items withdrawn',
      'warehouse: upgrades',
      'warehouse: upgrade gold',
    ]);
  });

  it('does not leak the seed or forge secrets', async () => {
    const h = await hero();
    const item = await insertItem(db(), h.id, { inWarehouse: true });
    const r = await w.get(h.who.token, h.id);
    expect(r.body).not.toContain(item.forgeSecret);
    expect(r.body).not.toContain('forgeCounter');
  });
});
