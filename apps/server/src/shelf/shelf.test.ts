import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, asc, eq, like } from 'drizzle-orm';
import { DEFAULT_ACTIVITY_CONFIG, DEFAULT_SHELF_CONFIG } from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import {
  accountShelfMaterials,
  accounts,
  activities,
  auditLog,
  characterMaterials,
  characters,
  itemInstances,
  sanctions,
  telemetryDaily,
  worldFlags,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { createTestDatabase } from '../test/db.js';
import { insertCharacter, insertItem } from '../test/heroes.js';
import { insertAccount, type TestAccount } from '../test/social.js';
import { openWarehouse, warehouseCalls } from '../test/warehouse.js';
import { ALL_SHELF_OFF, ALL_SHELF_ON, setShelfSwitches, shelfCalls } from '../test/shelf.js';
import { reconcileWithAudit } from '../telemetry/report.js';
import { expectShelfMatchesAudit } from '../e2e/journey.js';
import type { SettleResponse } from '../activity/routes.js';
import type { ShelfMoveResponse, ShelfView } from './routes.js';
import { rehomeShelfItemsForDeletion } from './deletion.js';
import { withTransaction } from '../db/transaction.js';

const HOUR = 3_600_000;
const PACK = DEFAULT_ACTIVITY_CONFIG.inventory.capacity;
const CAP = DEFAULT_SHELF_CONFIG.itemCapacity;
let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.parse('2031-06-01T12:00:00Z');
let s: ReturnType<typeof shelfCalls>;
let w: ReturnType<typeof warehouseCalls>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({
    database,
    auth: { accountRateLimit: { requests: 100_000, actions: 100_000, windowMs: 60_000 } },
    activity: { ...DEFAULT_ACTIVITY_OPTIONS, now: () => new Date(nowMs) },
  });
  await app.ready();
  s = shelfCalls(app);
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

/** An account with two heroes (the shelf's whole point), the first one active. */
async function account(gold = 0) {
  const who = await insertAccount(db());
  const a = await insertCharacter(db(), who.id, {
    level: 10,
    name: `Ash${randomUUID().slice(0, 6)}`,
  });
  const b = await insertCharacter(db(), who.id, {
    level: 12,
    name: `Bea${randomUUID().slice(0, 6)}`,
  });
  await db().update(accounts).set({ activeCharacterId: a.id }).where(eq(accounts.id, who.id));
  if (gold) await db().update(characters).set({ gold }).where(eq(characters.id, a.id));
  return { who, a: a.id, b: b.id, aName: a.name, bName: b.name };
}
async function giveMaterials(characterId: string, bundle: Record<string, number>) {
  for (const [materialId, quantity] of Object.entries(bundle)) {
    await db()
      .insert(characterMaterials)
      .values({ characterId, materialId: materialId as never, quantity });
  }
}
async function itemRow(id: string) {
  return (await db().select().from(itemInstances).where(eq(itemInstances.id, id)))[0]!;
}
async function goldOf(id: string) {
  return (await db().select().from(characters).where(eq(characters.id, id)))[0]!.gold;
}
async function shelfGoldOf(accountId: string) {
  return (await db().select().from(accounts).where(eq(accounts.id, accountId)))[0]!.shelfGold;
}
async function materialOf(characterId: string, materialId: string) {
  const [row] = await db()
    .select()
    .from(characterMaterials)
    .where(
      and(
        eq(characterMaterials.characterId, characterId),
        eq(characterMaterials.materialId, materialId as never),
      ),
    );
  return row?.quantity ?? 0;
}
async function shelfAudits(accountId: string) {
  return (
    db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.accountId, accountId), like(auditLog.event, 'shelf.%')))
      // Requests here run one after another: each transaction starts after the last commits.
      .orderBy(asc(auditLog.createdAt), asc(auditLog.id))
  );
}
async function shelfMoves() {
  const rows = await db()
    .select()
    .from(telemetryDaily)
    .where(eq(telemetryDaily.metric, 'shelf.move'));
  return rows.reduce<Record<string, number>>((acc, r) => {
    const k = `${r.dim1}:${r.dim2}`;
    acc[k] = (acc[k] ?? 0) + Number(r.amount);
    return acc;
  }, {});
}

describe('shelf: the Warehouse gate', () => {
  beforeEach(async () => {
    await db().delete(worldFlags);
    app.worldState.invalidate();
    await setShelfSwitches(app, db(), ALL_SHELF_ON);
  });

  it('answers warehouse_closed on every route before any ownership check', async () => {
    const acc = await account(1_000);
    const item = await insertItem(db(), acc.a);
    const stranger = await insertAccount(db());
    for (const r of [
      await s.get(acc.who.token, acc.a),
      await s.move(acc.who.token, acc.a, 'deposit', { itemIds: [item.id], gold: 10 }),
      await s.move(acc.who.token, acc.a, 'withdraw', { gold: 10 }),
      await s.get(stranger.token, acc.a),
    ]) {
      expect(r.statusCode, r.body).toBe(409);
      expect(code(r)).toBe('warehouse_closed');
    }
    expect(await itemRow(item.id)).toMatchObject({ onShelf: false, shelfAccountId: null });
    expect(await shelfAudits(acc.who.id)).toEqual([]);
  });
});

describe('shelf: moving each kind between two heroes', () => {
  beforeAll(async () => {
    await openWarehouse(app, db());
  });
  beforeEach(async () => {
    await setShelfSwitches(app, db(), ALL_SHELF_ON);
  });

  it('items: the same row moves from one hero to the other, binding and lock kept', async () => {
    const acc = await account();
    const sword = await insertItem(db(), acc.a, { rarityId: 'epic', locked: true });
    const ring = await insertItem(db(), acc.a, { baseId: 'longsword', rarityId: 'rare' });
    await db()
      .update(itemInstances)
      .set({ binding: 'equip', source: 'farming' })
      .where(eq(itemInstances.id, sword.id));
    const before = await itemRow(sword.id);

    const dep = await s.move(acc.who.token, acc.a, 'deposit', { itemIds: [sword.id, ring.id] });
    expect(dep.statusCode, dep.body).toBe(200);
    const body = dep.json<ShelfMoveResponse>();
    expect(body.moved).toEqual({ items: 2, gold: 0, materials: [] });
    expect(body.shelf.items.map((i) => i.id).sort()).toEqual([sword.id, ring.id].sort());
    expect(body.shelf.items[0]!.placedBy).toEqual({ characterId: acc.a, name: acc.aName });
    // Neither in the pack, nor in the warehouse, nor worn.
    expect(body.inventory.inventory).toEqual([]);
    expect(body.shelf.hero.pack.count).toBe(0);
    const warehouse = await w.get(acc.who.token, acc.a);
    expect(warehouse.json<{ items: unknown[] }>().items).toEqual([]);
    expect(await itemRow(sword.id)).toEqual({
      ...before,
      onShelf: true,
      shelfAccountId: acc.who.id,
    });

    // The other hero sees the same shelf and takes the sword out.
    const view = (await s.get(acc.who.token, acc.b)).json<ShelfView>();
    expect(view.items).toHaveLength(2);
    expect(view.characterId).toBe(acc.b);
    const out = await s.move(acc.who.token, acc.b, 'withdraw', { itemIds: [sword.id] });
    expect(out.statusCode, out.body).toBe(200);
    const taken = out.json<ShelfMoveResponse>();
    expect(taken.inventory.inventory.map((i) => i.id)).toEqual([sword.id]);
    expect(taken.inventory.inventory[0]).toMatchObject({ locked: true, binding: 'equip' });
    // Same row: id, seed, forge state, binding and trade count as before; only the owner changed.
    expect(await itemRow(sword.id)).toEqual({ ...before, characterId: acc.b });

    const audits = await shelfAudits(acc.who.id);
    expect(audits.map((a) => [a.event, a.characterId])).toEqual([
      ['shelf.deposit', acc.a],
      ['shelf.withdraw', acc.b],
    ]);
    expect(audits[0]!.data).toMatchObject({
      kind: 'items',
      amount: 2,
      fromCharacterId: acc.a,
      toCharacterId: null,
      shelfItemsAfter: 2,
    });
    expect(audits[1]!.data).toMatchObject({
      kind: 'items',
      amount: 1,
      fromCharacterId: null,
      toCharacterId: acc.b,
      // Both heroes: who had placed it, and who took it.
      items: [
        {
          itemId: sword.id,
          fromCharacterId: acc.a,
          rarityId: 'epic',
          locked: true,
          binding: 'equip',
        },
      ],
      shelfItemsAfter: 1,
    });
    await expectShelfMatchesAudit(database, acc.who.id);
  });

  it('gold: leaves one hero onto the account and arrives at the other', async () => {
    const acc = await account(1_000);
    const dep = await s.move(acc.who.token, acc.a, 'deposit', { gold: 400 });
    expect(dep.statusCode, dep.body).toBe(200);
    expect(dep.json<ShelfMoveResponse>()).toMatchObject({
      character: { id: acc.a, gold: 600 },
      shelf: { gold: 400, hero: { gold: 600 } },
      moved: { gold: 400, items: 0 },
    });
    expect(await shelfGoldOf(acc.who.id)).toBe(400);
    const out = await s.move(acc.who.token, acc.b, 'withdraw', { gold: 150 });
    expect(out.statusCode, out.body).toBe(200);
    expect(out.json<ShelfMoveResponse>()).toMatchObject({
      character: { id: acc.b, gold: 150 },
      shelf: { gold: 250 },
    });
    expect([await goldOf(acc.a), await goldOf(acc.b), await shelfGoldOf(acc.who.id)]).toEqual([
      600, 150, 250,
    ]);
    // Never more than is there.
    const over = await s.move(acc.who.token, acc.b, 'withdraw', { gold: 251 });
    expect(over.statusCode).toBe(422);
    expect(over.json()).toMatchObject({
      error: { code: 'insufficient_gold', details: { needed: 251, available: 250 } },
    });
    expect(code(await s.move(acc.who.token, acc.a, 'deposit', { gold: 601 }))).toBe(
      'insufficient_gold',
    );
    const audits = await shelfAudits(acc.who.id);
    expect(audits.map((a) => a.data)).toEqual([
      {
        kind: 'gold',
        amount: 400,
        fromCharacterId: acc.a,
        toCharacterId: null,
        gold: 400,
        goldAfter: 600,
        shelfGoldAfter: 400,
      },
      {
        kind: 'gold',
        amount: 150,
        fromCharacterId: null,
        toCharacterId: acc.b,
        gold: 150,
        goldAfter: 150,
        shelfGoldAfter: 250,
      },
    ]);
    await expectShelfMatchesAudit(database, acc.who.id);
  });

  it('materials: stacks leave one hero and arrive at the other', async () => {
    const acc = await account();
    await giveMaterials(acc.a, { timber: 30, soulShard: 5 });
    const dep = await s.move(acc.who.token, acc.a, 'deposit', {
      materials: { timber: 12, soulShard: 5 },
    });
    expect(dep.statusCode, dep.body).toBe(200);
    expect(dep.json<ShelfMoveResponse>().shelf.materials).toEqual([
      { materialId: 'timber', quantity: 12 },
      { materialId: 'soulShard', quantity: 5 },
    ]);
    const out = await s.move(acc.who.token, acc.b, 'withdraw', { materials: { soulShard: 2 } });
    expect(out.statusCode, out.body).toBe(200);
    expect(out.json<ShelfMoveResponse>().shelf.hero.materials).toEqual([
      { materialId: 'soulShard', quantity: 2 },
    ]);
    expect(await materialOf(acc.a, 'timber')).toBe(18);
    expect(await materialOf(acc.a, 'soulShard')).toBe(0);
    expect(await materialOf(acc.b, 'soulShard')).toBe(2);
    expect(
      code(await s.move(acc.who.token, acc.b, 'withdraw', { materials: { soulShard: 4 } })),
    ).toBe('insufficient_materials');
    expect(code(await s.move(acc.who.token, acc.a, 'deposit', { materials: { ironOre: 1 } }))).toBe(
      'insufficient_materials',
    );
    const audits = await shelfAudits(acc.who.id);
    expect(audits[0]!.data).toEqual({
      kind: 'materials',
      amount: 17,
      fromCharacterId: acc.a,
      toCharacterId: null,
      materials: { timber: 12, soulShard: 5 },
      materialsAfter: { timber: 18, soulShard: 0 },
      shelfMaterialsAfter: { timber: 12, soulShard: 5 },
    });
    await expectShelfMatchesAudit(database, acc.who.id);
  });

  it('one request may carry every kind: one audit row and one count per kind', async () => {
    const acc = await account(500);
    await giveMaterials(acc.a, { ironOre: 9 });
    const item = await insertItem(db(), acc.a);
    const movesBefore = await shelfMoves();
    const dep = await s.move(acc.who.token, acc.a, 'deposit', {
      itemIds: [item.id],
      gold: 50,
      materials: { ironOre: 4 },
    });
    expect(dep.statusCode, dep.body).toBe(200);
    // One row per kind (ids within one millisecond aren't ordered, so compare as a set).
    expect(
      (await shelfAudits(acc.who.id)).map((a) => (a.data as { kind: string }).kind).sort(),
    ).toEqual(['gold', 'items', 'materials']);
    const after = await shelfMoves();
    const delta = (k: string) => (after[k] ?? 0) - (movesBefore[k] ?? 0);
    expect([delta('deposit:items'), delta('deposit:materials'), delta('deposit:gold')]).toEqual([
      1, 4, 50,
    ]);
    // A material id outside content, a negative amount or an empty body is refused.
    expect((await s.move(acc.who.token, acc.a, 'deposit', { gold: -1 })).statusCode).toBe(400);
    expect(
      (await s.move(acc.who.token, acc.a, 'deposit', { materials: { mithril: 1 } as never }))
        .statusCode,
    ).toBe(400);
    const empty = await s.move(acc.who.token, acc.a, 'deposit', {});
    expect(empty.statusCode).toBe(400);
    expect(code(empty)).toBe('nothing_to_move');
  });

  it('needs an Idempotency-Key, and a replay moves nothing twice', async () => {
    const acc = await account(1_000);
    const noKey = await s.move(acc.who.token, acc.a, 'deposit', { gold: 100 }, null);
    expect(noKey.statusCode).toBe(400);
    expect(await goldOf(acc.a)).toBe(1_000);
    const key = randomUUID();
    const first = await s.move(acc.who.token, acc.a, 'deposit', { gold: 100 }, key);
    expect(first.statusCode, first.body).toBe(200);
    const replay = await s.move(acc.who.token, acc.a, 'deposit', { gold: 100 }, key);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    expect(await goldOf(acc.a)).toBe(900);
    expect(await shelfGoldOf(acc.who.id)).toBe(100);
    // The same key with another body is a conflict.
    expect(code(await s.move(acc.who.token, acc.a, 'deposit', { gold: 5 }, key))).toBe(
      'idempotency_conflict',
    );
    expect(await shelfAudits(acc.who.id)).toHaveLength(1);
  });

  it('is per account: another account sees its own empty shelf and reaches none of this', async () => {
    const acc = await account(1_000);
    const item = await insertItem(db(), acc.a);
    await s.move(acc.who.token, acc.a, 'deposit', { itemIds: [item.id], gold: 300 });
    const other = await account();
    // Its own heroes see its own (empty) shelf.
    const view = (await s.get(other.who.token, other.a)).json<ShelfView>();
    expect(view).toMatchObject({ items: [], gold: 0, materials: [] });
    // Someone else's hero is the not-found 404.
    expect((await s.get(other.who.token, acc.a)).statusCode).toBe(404);
    expect((await s.move(other.who.token, acc.b, 'withdraw', { gold: 1 })).statusCode).toBe(404);
    // An item on another account's shelf is not on this one.
    const r = await s.move(other.who.token, other.a, 'withdraw', { itemIds: [item.id] });
    expect(r.statusCode).toBe(404);
    expect(await shelfGoldOf(acc.who.id)).toBe(300);
    expect(await itemRow(item.id)).toMatchObject({ onShelf: true, characterId: acc.a });
  });
});

describe('shelf: capacity', () => {
  beforeAll(async () => {
    await openWarehouse(app, db());
  });
  beforeEach(async () => {
    await setShelfSwitches(app, db(), ALL_SHELF_ON);
  });

  it(`holds ${CAP} items for the whole account, all or nothing`, async () => {
    const acc = await account();
    const fromA = await Promise.all(Array.from({ length: CAP - 2 }, () => insertItem(db(), acc.a)));
    const fromB = await Promise.all(Array.from({ length: 3 }, () => insertItem(db(), acc.b)));
    expect(
      (await s.move(acc.who.token, acc.a, 'deposit', { itemIds: fromA.map((i) => i.id) }))
        .statusCode,
    ).toBe(200);
    const full = await s.move(acc.who.token, acc.b, 'deposit', { itemIds: fromB.map((i) => i.id) });
    expect(full.statusCode).toBe(422);
    expect(full.json()).toMatchObject({
      error: { code: 'shelf_full', details: { capacity: CAP, free: 2, needed: 3 } },
    });
    for (const i of fromB) expect((await itemRow(i.id)).onShelf).toBe(false);
    expect(
      (
        await s.move(acc.who.token, acc.b, 'deposit', {
          itemIds: fromB.slice(0, 2).map((i) => i.id),
        })
      ).statusCode,
    ).toBe(200);
    // Gold and materials take no item place.
    await db().update(characters).set({ gold: 10 }).where(eq(characters.id, acc.b));
    expect((await s.move(acc.who.token, acc.b, 'deposit', { gold: 10 })).statusCode).toBe(200);
  });

  it('a withdrawal needs free pack slots below the capacity (like the warehouse)', async () => {
    const acc = await account();
    const items = await Promise.all(Array.from({ length: 3 }, () => insertItem(db(), acc.a)));
    await s.move(acc.who.token, acc.a, 'deposit', { itemIds: items.map((i) => i.id) });
    for (let i = 0; i < PACK - 2; i++) await insertItem(db(), acc.b);
    const r = await s.move(acc.who.token, acc.b, 'withdraw', { itemIds: items.map((i) => i.id) });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({
      error: { code: 'inventory_full', details: { capacity: PACK, free: 2, needed: 3 } },
    });
    expect(
      (
        await s.move(acc.who.token, acc.b, 'withdraw', {
          itemIds: items.slice(0, 2).map((i) => i.id),
        })
      ).statusCode,
    ).toBe(200);
  });
});

describe('shelf: switches', () => {
  beforeAll(async () => {
    await openWarehouse(app, db());
  });

  it('defaults off: every deposit is refused in plain words, nothing moves', async () => {
    await setShelfSwitches(app, db(), ALL_SHELF_OFF);
    const acc = await account(100);
    await giveMaterials(acc.a, { timber: 3 });
    const item = await insertItem(db(), acc.a);
    const view = (await s.get(acc.who.token, acc.a)).json<ShelfView>();
    expect(view.deposits).toEqual(ALL_SHELF_OFF);
    for (const [kind, body] of [
      ['items', { itemIds: [item.id] }],
      ['materials', { materials: { timber: 1 } }],
      ['gold', { gold: 1 }],
    ] as const) {
      const r = await s.move(acc.who.token, acc.a, 'deposit', body);
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json()).toMatchObject({ error: { code: 'shelf_paused', details: { kind } } });
      expect(r.json<{ error: { message: string } }>().error.message).toContain(
        'can still be taken out',
      );
    }
    expect(await goldOf(acc.a)).toBe(100);
    expect(await materialOf(acc.a, 'timber')).toBe(3);
    expect((await itemRow(item.id)).onShelf).toBe(false);
    expect(await shelfAudits(acc.who.id)).toEqual([]);
  });

  it('each kind opens on its own; withdrawals always work once a switch is off', async () => {
    const acc = await account(500);
    await giveMaterials(acc.a, { timber: 10 });
    const item = await insertItem(db(), acc.a);
    for (const kind of ['items', 'materials', 'gold'] as const) {
      await setShelfSwitches(app, db(), { ...ALL_SHELF_OFF, [kind]: true });
      const body =
        kind === 'items'
          ? { itemIds: [item.id] }
          : kind === 'materials'
            ? { materials: { timber: 4 } }
            : { gold: 200 };
      const ok = await s.move(acc.who.token, acc.a, 'deposit', body);
      expect(ok.statusCode, ok.body).toBe(200);
      // The other two kinds are still refused.
      for (const other of ['items', 'materials', 'gold'] as const) {
        if (other === kind) continue;
        const otherBody =
          other === 'items'
            ? { itemIds: [item.id] }
            : other === 'materials'
              ? { materials: { timber: 1 } }
              : { gold: 1 };
        expect(code(await s.move(acc.who.token, acc.a, 'deposit', otherBody))).toBe('shelf_paused');
      }
    }
    // Everything off again: withdrawals of every kind still go through, to the other hero.
    await setShelfSwitches(app, db(), ALL_SHELF_OFF);
    const out = await s.move(acc.who.token, acc.b, 'withdraw', {
      itemIds: [item.id],
      materials: { timber: 4 },
      gold: 200,
    });
    expect(out.statusCode, out.body).toBe(200);
    expect(out.json<ShelfMoveResponse>()).toMatchObject({
      moved: { items: 1, gold: 200, materials: [{ materialId: 'timber', quantity: 4 }] },
      shelf: { items: [], gold: 0, materials: [], deposits: ALL_SHELF_OFF },
    });
    await expectShelfMatchesAudit(database, acc.who.id);
  });

  it('a switch turned off is honoured at once by the instance that saved it', async () => {
    const acc = await account(100);
    await setShelfSwitches(app, db(), ALL_SHELF_ON);
    expect((await s.move(acc.who.token, acc.a, 'deposit', { gold: 10 })).statusCode).toBe(200);
    await setShelfSwitches(app, db(), { ...ALL_SHELF_ON, gold: false });
    expect(code(await s.move(acc.who.token, acc.a, 'deposit', { gold: 10 }))).toBe('shelf_paused');
  });
});

describe('shelf: held value and other refusals', () => {
  beforeAll(async () => {
    await openWarehouse(app, db());
  });
  beforeEach(async () => {
    await setShelfSwitches(app, db(), ALL_SHELF_ON);
  });

  it('refuses an item held from a trade until the hold ends (the transaction clock)', async () => {
    const acc = await account();
    const item = await insertItem(db(), acc.a, { rarityId: 'legendary' });
    const until = new Date(nowMs + HOUR);
    await db().update(itemInstances).set({ holdUntil: until }).where(eq(itemInstances.id, item.id));
    const r = await s.move(acc.who.token, acc.a, 'deposit', { itemIds: [item.id] });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({
      error: { code: 'item_held', details: { itemId: item.id, holdUntil: until.toISOString() } },
    });
    expect((await itemRow(item.id)).onShelf).toBe(false);
    nowMs += HOUR;
    expect((await s.move(acc.who.token, acc.a, 'deposit', { itemIds: [item.id] })).statusCode).toBe(
      200,
    );
  });

  it('refuses worn, stored, already shelved and foreign items, all or nothing', async () => {
    const acc = await account();
    const loose = await insertItem(db(), acc.a);
    const worn = await insertItem(db(), acc.a, { equippedSlot: 'weapon' });
    const stored = await insertItem(db(), acc.a, { inWarehouse: true });
    const theirs = await insertItem(db(), acc.b);
    const dep = (id: string) =>
      s.move(acc.who.token, acc.a, 'deposit', { itemIds: [loose.id, id] });
    expect(code(await dep(worn.id))).toBe('item_equipped');
    expect(code(await dep(stored.id))).toBe('item_in_warehouse');
    // The other hero's item is that hero's to deposit (same account, still a 404 here).
    expect((await dep(theirs.id)).statusCode).toBe(404);
    expect((await dep(randomUUID())).statusCode).toBe(404);
    expect((await itemRow(loose.id)).onShelf).toBe(false);
    expect(
      (await s.move(acc.who.token, acc.a, 'deposit', { itemIds: [loose.id] })).statusCode,
    ).toBe(200);
    expect(code(await s.move(acc.who.token, acc.a, 'deposit', { itemIds: [loose.id] }))).toBe(
      'item_on_shelf',
    );
    // Taking out what isn't on the shelf: 404.
    expect(
      (await s.move(acc.who.token, acc.a, 'withdraw', { itemIds: [worn.id] })).statusCode,
    ).toBe(404);
  });

  it('still works under a mute: the shelf reaches no one', async () => {
    const acc = await account(100);
    const mod = await insertAccount(db(), { role: 'moderator' });
    await db()
      .insert(sanctions)
      .values({
        id: uuidv7(),
        subjectId: acc.who.id,
        issuedBy: mod.id,
        kind: 'mute',
        reason: 'Test mute',
        createdAt: new Date(nowMs - 1000),
        expiresAt: new Date(nowMs + 30 * 24 * HOUR),
      });
    expect((await s.move(acc.who.token, acc.a, 'deposit', { gold: 100 })).statusCode).toBe(200);
    expect((await s.move(acc.who.token, acc.b, 'withdraw', { gold: 100 })).statusCode).toBe(200);
  });
});

describe('shelf: items on the shelf are out of reach', () => {
  beforeAll(async () => {
    await openWarehouse(app, db());
    await setShelfSwitches(app, db(), ALL_SHELF_ON);
  });

  it('refuses sell, salvage, discard, equip, lock, the Forge and the warehouse', async () => {
    const acc = await account(100_000);
    await db().update(characters).set({ gold: 100_000 }).where(eq(characters.id, acc.b));
    const item = await insertItem(db(), acc.a, { rarityId: 'rare' });
    expect((await s.move(acc.who.token, acc.a, 'deposit', { itemIds: [item.id] })).statusCode).toBe(
      200,
    );
    const before = await itemRow(item.id);
    const attempts = (hero: string) => {
      const base = `/api/characters/${hero}`;
      return [
        () => call(acc.who, 'POST', `${base}/merchant/sell`, { itemIds: [item.id] }, randomUUID()),
        () => call(acc.who, 'POST', `${base}/forge/salvage`, { itemIds: [item.id] }, randomUUID()),
        () => call(acc.who, 'DELETE', `${base}/items/${item.id}`),
        () => call(acc.who, 'POST', `${base}/items/${item.id}/equip`, {}),
        () => call(acc.who, 'POST', `${base}/items/${item.id}/unequip`),
        () => call(acc.who, 'POST', `${base}/items/${item.id}/lock`, {}),
        () => call(acc.who, 'POST', `${base}/forge/upgrade`, { itemId: item.id }, randomUUID()),
        () =>
          call(
            acc.who,
            'POST',
            `${base}/forge/reroll`,
            { itemId: item.id, affixIndex: 0 },
            randomUUID(),
          ),
        () =>
          call(
            acc.who,
            'POST',
            `${base}/forge/improve`,
            { itemId: item.id, affixIndex: 0 },
            randomUUID(),
          ),
        () => call(acc.who, 'GET', `${base}/forge/items/${item.id}`),
        () => w.move(acc.who.token, hero, 'deposit', [item.id]),
        () => w.move(acc.who.token, hero, 'withdraw', [item.id]),
      ];
    };
    // The hero who placed it: `item_on_shelf`.
    for (const attempt of attempts(acc.a)) {
      const r = await attempt();
      expect(r.statusCode, r.body).toBe(409);
      expect(code(r)).toBe('item_on_shelf');
    }
    // The other hero: not theirs until taken out (the not-found 404, or 400 for a bad body).
    for (const attempt of attempts(acc.b)) {
      const r = await attempt();
      expect([404, 400], r.body).toContain(r.statusCode);
    }
    expect(await itemRow(item.id)).toEqual(before);
    expect(await goldOf(acc.a)).toBe(100_000);
    // Lists that offer pack items leave it out.
    const base = `/api/characters/${acc.a}`;
    const merchant = await call(acc.who, 'GET', `${base}/merchant`);
    expect(merchant.json<{ sellPrices: unknown[] }>().sellPrices).toEqual([]);
    const forge = await call(acc.who, 'GET', `${base}/forge`);
    expect(forge.json<{ salvage: unknown[] }>().salvage).toEqual([]);
    const inv = await call(acc.who, 'GET', `${base}/inventory`);
    expect(inv.json<{ inventory: unknown[] }>().inventory).toEqual([]);
  });

  it('shelf items take no pack slot (merchant purchase at the boundary)', async () => {
    const acc = await account(1_000_000);
    const shelved = await Promise.all(Array.from({ length: 5 }, () => insertItem(db(), acc.a)));
    const dep = await s.move(acc.who.token, acc.a, 'deposit', {
      itemIds: shelved.map((i) => i.id),
    });
    expect(dep.statusCode, dep.body).toBe(200);
    for (let i = 0; i < PACK - 1; i++) await insertItem(db(), acc.a);
    const stock = await call(acc.who, 'GET', `/api/characters/${acc.a}/merchant`);
    const [first, second] = stock.json<{ offers: { offerId: string }[] }>().offers;
    const buy = (offerId: string) =>
      call(acc.who, 'POST', `/api/characters/${acc.a}/merchant/buy`, { offerId }, randomUUID());
    expect((await buy(first!.offerId)).statusCode).toBe(200);
    expect(code(await buy(second!.offerId))).toBe('inventory_full');
  });
});

describe('shelf: invariance (no PvE number changes, scores count worn gear only)', () => {
  beforeAll(async () => {
    await openWarehouse(app, db());
    await setShelfSwitches(app, db(), ALL_SHELF_ON);
  });

  async function farmer(shelved: number) {
    const acc = await account();
    // Shelved through the API before farming starts (so no settlement runs here).
    if (shelved > 0) {
      const items = await Promise.all(
        Array.from({ length: shelved }, () => insertItem(db(), acc.a)),
      );
      const dep = await s.move(acc.who.token, acc.a, 'deposit', {
        itemIds: items.map((i) => i.id),
      });
      expect(dep.statusCode, dep.body).toBe(200);
    }
    const res = await call(acc.who, 'POST', `/api/characters/${acc.a}/activity`, {
      areaId: 'abandonedFields',
    });
    expect(res.statusCode, res.body).toBe(201);
    await db()
      .update(activities)
      .set({ seedSecret: 'shelf-invariance' })
      .where(eq(activities.characterId, acc.a));
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
      .where(eq(characters.id, acc.a));
    // A nearly full pack, so the capacity rule is at work during the window.
    for (let i = 0; i < PACK - 3; i++) await insertItem(db(), acc.a);
    return acc;
  }

  it('settles exactly as with an empty shelf, leaving shelf items as they were', async () => {
    const plain = await farmer(0);
    const keeper = await farmer(CAP);
    const shelfBefore = await db()
      .select()
      .from(itemInstances)
      .where(eq(itemInstances.shelfAccountId, keeper.who.id))
      .orderBy(itemInstances.id);
    nowMs += 2 * HOUR;
    const settle = (h: Awaited<ReturnType<typeof farmer>>) =>
      call(h.who, 'POST', `/api/characters/${h.a}/activity/settle`).then((r) =>
        r.json<SettleResponse>(),
      );
    const a = await settle(plain);
    const b = await settle(keeper);
    const strip = (x: SettleResponse['summary']) => ({
      ...x,
      items: x.items.map(({ id: _id, ...rest }) => rest),
    });
    expect(a.summary.settlements).toBeGreaterThan(0);
    // Pinned seed: this window hits the pack's capacity, so the capacity rule was at work.
    expect(a.summary.itemsSalvaged).toBeGreaterThan(0);
    expect(strip(b.summary)).toEqual(strip(a.summary));
    expect(b.character.gold).toBe(a.character.gold);
    expect(b.character.experience).toBe(a.character.experience);
    const shelfAfter = await db()
      .select()
      .from(itemInstances)
      .where(eq(itemInstances.shelfAccountId, keeper.who.id))
      .orderBy(itemInstances.id);
    expect(shelfAfter).toEqual(shelfBefore);
  });

  it('5.1 scores count worn gear only: shelving changes no score', async () => {
    const acc = await account();
    await insertItem(db(), acc.a, { rarityId: 'legendary', equippedSlot: 'weapon' });
    const loose = await Promise.all(
      (['epic', 'legendary', 'rare'] as const).map((rarityId) =>
        insertItem(db(), acc.a, { rarityId }),
      ),
    );
    const scores = async (id: string) =>
      (await call(acc.who, 'GET', `/api/characters/${id}/scores`)).json<{ scores: unknown }>();
    const beforeA = await scores(acc.a);
    const beforeB = await scores(acc.b);
    expect(
      (await s.move(acc.who.token, acc.a, 'deposit', { itemIds: loose.map((i) => i.id) }))
        .statusCode,
    ).toBe(200);
    expect(await scores(acc.a)).toEqual(beforeA);
    expect(await scores(acc.b)).toEqual(beforeB);
    expect(
      (await s.move(acc.who.token, acc.b, 'withdraw', { itemIds: loose.map((i) => i.id) }))
        .statusCode,
    ).toBe(200);
    expect(await scores(acc.b)).toEqual(beforeB);
  });
});

describe('shelf: reconciliation', () => {
  beforeAll(async () => {
    await openWarehouse(app, db());
    await setShelfSwitches(app, db(), ALL_SHELF_ON);
  });

  it('rollups match the audit log and what every shelf holds', async () => {
    // Every kind both ways (self-contained: the other tests may run in any order).
    const acc = await account(300);
    await giveMaterials(acc.a, { ashwort: 6 });
    const item = await insertItem(db(), acc.a);
    const all = { itemIds: [item.id], gold: 300, materials: { ashwort: 6 } };
    expect((await s.move(acc.who.token, acc.a, 'deposit', all)).statusCode).toBe(200);
    const part = { itemIds: [item.id], gold: 120, materials: { ashwort: 2 } };
    expect((await s.move(acc.who.token, acc.b, 'withdraw', part)).statusCode).toBe(200);
    expect(await expectShelfMatchesAudit(database, acc.who.id)).toEqual({
      gold: 180,
      items: 0,
      materials: { ashwort: 4 },
    });
    const checks = await reconcileWithAudit(db());
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    const shelf = checks.filter((c) => c.check.startsWith('shelf:'));
    expect(shelf).toHaveLength(9);
    // This file moved every kind both ways.
    for (const c of shelf.filter((c) => /deposited|withdrawn/.test(c.check))) {
      expect(c.audit, c.check).toBeGreaterThan(0);
    }
    const materials = await db().select().from(accountShelfMaterials);
    expect(materials.every((m) => m.quantity >= 0)).toBe(true);
  });
});

/**
 * Ticket T.7: hero deletion doesn't exist; if it comes, shelf items stay on the account. The seam
 * hands a hero's shelf items to another hero of the account, or refuses; the guard below fails if
 * any code deletes a hero row without calling it (and T.5's `voidForDeletion`).
 */
describe('shelf: a hero being deleted (T.7 seam)', () => {
  beforeAll(async () => {
    await openWarehouse(app, db());
  });
  beforeEach(async () => {
    await setShelfSwitches(app, db(), ALL_SHELF_ON);
  });

  it('hands the hero’s shelf items to another hero of the account, still on the shelf', async () => {
    const acc = await account(50);
    const item = await insertItem(db(), acc.a, { rarityId: 'epic' });
    expect(
      (await s.move(acc.who.token, acc.a, 'deposit', { itemIds: [item.id], gold: 50 })).statusCode,
    ).toBe(200);
    const before = await itemRow(item.id);
    const moved = await withTransaction(db(), (tx) =>
      rehomeShelfItemsForDeletion(tx, acc.who.id, acc.a, new Date()),
    );
    expect(moved).toBe(1);
    expect(await itemRow(item.id)).toEqual({ ...before, characterId: acc.b });
    const [row] = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.accountId, acc.who.id), eq(auditLog.event, 'shelf.rehome')));
    expect(row!.data).toMatchObject({
      fromCharacterId: acc.a,
      toCharacterId: acc.b,
      itemIds: [item.id],
    });
    // Still the account's: shelf = audit, and the other hero can take it out.
    expect(await expectShelfMatchesAudit(database, acc.who.id)).toMatchObject({
      items: 1,
      gold: 50,
    });
    const out = await s.move(acc.who.token, acc.b, 'withdraw', { itemIds: [item.id] });
    expect(out.statusCode, out.body).toBe(200);
    expect((await reconcileWithAudit(db())).filter((c) => !c.ok)).toEqual([]);
  });

  it('refuses when no other hero could hold them, and changes nothing', async () => {
    const who = await insertAccount(db());
    const only = await insertCharacter(db(), who.id, {
      level: 10,
      name: `Solo${randomUUID().slice(0, 6)}`,
    });
    const item = await insertItem(db(), only.id, { rarityId: 'epic' });
    expect((await s.move(who.token, only.id, 'deposit', { itemIds: [item.id] })).statusCode).toBe(
      200,
    );
    await expect(
      withTransaction(db(), (tx) => rehomeShelfItemsForDeletion(tx, who.id, only.id, new Date())),
    ).rejects.toMatchObject({ statusCode: 409, code: 'shelf_not_empty' });
    expect((await itemRow(item.id)).characterId).toBe(only.id);
    // A hero with nothing on the shelf has nothing to hand on.
    expect(
      await withTransaction(db(), (tx) =>
        rehomeShelfItemsForDeletion(tx, who.id, randomUUID(), new Date()),
      ),
    ).toBe(0);
  });

  it('guard: no code deletes a hero without the shelf and offer seams', () => {
    const root = join(__dirname, '..');
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) return files(p);
        return p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.includes('/test/') ? [p] : [];
      });
    const deleting = files(root).filter((p) =>
      /\.delete\(characters\)|delete\s+from\s+characters\b/i.test(readFileSync(p, 'utf8')),
    );
    for (const p of deleting) {
      const text = readFileSync(p, 'utf8');
      expect(text, relative(root, p)).toContain('rehomeShelfItemsForDeletion(');
      expect(text, relative(root, p)).toContain('voidForDeletion(');
    }
  });
});
