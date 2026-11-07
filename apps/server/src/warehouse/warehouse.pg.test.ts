/**
 * Real-PostgreSQL races for the warehouse (ticket 4.7, docs/WAREHOUSE.md "Races"). Runs when
 * `DATABASE_URL` is set, skipped otherwise (CI sets `REQUIRE_PG_TESTS=1`). Every move locks the
 * character (settling first), then its items; sell, salvage, discard, the forge and settlement take
 * the same character lock. Each race runs a few rounds in varied orders and asserts only what holds
 * in every order: an item is in exactly one place, taken at most once, value moves once and
 * reconciles with the audit log, the warehouse never exceeds its capacity, and nothing is retried.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import {
  DEFAULT_ACTIVITY_CONFIG,
  sellPrice,
  salvageYield,
  warehouseCapacity,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { accounts, activities, auditLog, characters, itemInstances } from '../db/schema.js';
import { transactionStats } from '../db/transaction.js';
import type { DatabaseHandle } from '../db/types.js';
import { reconcileWithAudit } from '../telemetry/report.js';
import { createPostgresTestDatabase } from '../test/db.js';
import { fund } from '../test/community.js';
import { insertCharacter, insertItem } from '../test/heroes.js';
import { insertAccount, type TestAccount } from '../test/social.js';
import { openWarehouse } from '../test/warehouse.js';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === '1') {
  throw new Error('REQUIRE_PG_TESTS=1 but DATABASE_URL is not set');
}

const ROUNDS = 3;
const HOUR = 3_600_000;
const PACK = DEFAULT_ACTIVITY_CONFIG.inventory.capacity;

function shuffled<T>(xs: T[], round: number): T[] {
  const out = [...xs];
  let seed = 7 + round * 41;
  for (let i = out.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe.skipIf(!url)('real PostgreSQL: the warehouse races safely', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let nowMs = Date.parse('2031-06-01T10:00:00Z');

  beforeAll(async () => {
    database = await createPostgresTestDatabase(url!, { poolMax: 30 });
    app = buildApp({
      database,
      auth: { accountRateLimit: { requests: 100_000, actions: 100_000, windowMs: 60_000 } },
      activity: { ...DEFAULT_ACTIVITY_OPTIONS, now: () => new Date(nowMs) },
    });
    await app.ready();
    await openWarehouse(app, database.db);
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  const db = () => database.db;
  const send = (
    who: TestAccount,
    method: 'POST' | 'DELETE',
    url: string,
    payload?: object,
    keyed = false,
  ) =>
    app.inject({
      method,
      url,
      ...(payload ? { payload } : {}),
      headers: keyed ? { 'idempotency-key': randomUUID() } : {},
      cookies: { [SESSION_COOKIE]: who.token },
    });

  /** A level-10 hero farming the Fields since `nowMs`, with a fixed seed (same outcome each round). */
  async function farmer(seed: string) {
    const who = await insertAccount(db());
    const c = await insertCharacter(db(), who.id, { level: 10 });
    await db().update(accounts).set({ activeCharacterId: c.id }).where(eq(accounts.id, who.id));
    const start = await send(who, 'POST', `/api/characters/${c.id}/activity`, {
      areaId: 'abandonedFields',
    });
    expect(start.statusCode, start.body).toBe(201);
    await db().update(activities).set({ seedSecret: seed }).where(eq(activities.characterId, c.id));
    return { who, id: c.id };
  }
  const events = (characterId: string, event: string) =>
    db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.characterId, characterId), eq(auditLog.event, event)))
      .orderBy(auditLog.id);
  const goldOf = async (id: string) =>
    (await db().select().from(characters).where(eq(characters.id, id)))[0]!.gold;
  const rewardGold = async (id: string) =>
    (await events(id, 'activity.reward')).reduce(
      (s, r) => s + Number((r.data as { gold?: number }).gold ?? 0),
      0,
    );

  it('deposit, withdraw, sell, salvage, discard, forge and settle racing on one item', async () => {
    const retries = transactionStats.retries;
    for (let round = 0; round < ROUNDS; round++) {
      const h = await farmer(`wh-one-${round}`);
      await fund(db(), h.id, { gold: 100_000, materials: { timber: 1_000, rawHide: 1_000 } });
      const item = await insertItem(db(), h.id, { baseId: 'longsword' });
      nowMs += HOUR;
      const c = `/api/characters/${h.id}`;
      const ops = shuffled(
        [
          ['deposit', () => send(h.who, 'POST', `${c}/warehouse/deposit`, { itemIds: [item.id] })],
          [
            'withdraw',
            () => send(h.who, 'POST', `${c}/warehouse/withdraw`, { itemIds: [item.id] }),
          ],
          ['deposit', () => send(h.who, 'POST', `${c}/warehouse/deposit`, { itemIds: [item.id] })],
          ['sell', () => send(h.who, 'POST', `${c}/merchant/sell`, { itemIds: [item.id] }, true)],
          [
            'salvage',
            () => send(h.who, 'POST', `${c}/forge/salvage`, { itemIds: [item.id] }, true),
          ],
          ['discard', () => send(h.who, 'DELETE', `${c}/items/${item.id}`)],
          ['forge', () => send(h.who, 'POST', `${c}/forge/upgrade`, { itemId: item.id }, true)],
          ['forge', () => send(h.who, 'POST', `${c}/forge/upgrade`, { itemId: item.id }, true)],
          ['settle', () => send(h.who, 'POST', `${c}/activity/settle`)],
        ] as const,
        round,
      );
      const results = await Promise.all(ops.map(([, op]) => op()));
      const outcome = ops.map(([name], i) => ({ name, r: results[i]! }));
      for (const { name, r } of outcome) {
        const label = `${name} ${r.statusCode} ${r.statusCode === 200 ? '' : r.json().error.code}`;
        expect(
          [
            'deposit 200 ',
            'withdraw 200 ',
            'sell 200 ',
            'salvage 200 ',
            'discard 200 ',
            'forge 200 ',
            'settle 200 ',
            // A stored item refuses everything but a withdrawal.
            'sell 409 item_in_warehouse',
            'salvage 409 item_in_warehouse',
            'discard 409 item_in_warehouse',
            'forge 409 item_in_warehouse',
            // Gone already.
            'deposit 404 not_found',
            'withdraw 404 not_found',
            'sell 404 not_found',
            'salvage 404 not_found',
            'discard 404 not_found',
            'forge 404 not_found',
          ],
          `round ${round}`,
        ).toContain(label);
      }
      const sold = await events(h.id, 'merchant.sell');
      const salvaged = await events(h.id, 'forge.salvage');
      const discarded = await events(h.id, 'item.discard');
      const taken = sold.length + salvaged.length + discarded.length;
      expect(taken, `round ${round}`).toBeLessThanOrEqual(1);
      const [row] = await db().select().from(itemInstances).where(eq(itemInstances.id, item.id));
      // In exactly one place: gone if taken, otherwise where the last audited move left it.
      if (taken === 1) {
        expect(row).toBeUndefined();
      } else {
        expect(row).toBeDefined();
        const moves = [
          ...(await events(h.id, 'warehouse.deposit')),
          ...(await events(h.id, 'warehouse.withdraw')),
        ].sort((a, b) => (a.id < b.id ? -1 : 1));
        const last = moves.at(-1)?.event;
        expect(row!.inWarehouse).toBe(last === 'warehouse.deposit');
        expect(row!.equippedSlot).toBeNull();
      }
      // Each forge attempt that answered 200 drew once and is audited once.
      const forged = await events(h.id, 'forge.upgrade');
      expect(outcome.filter((o) => o.name === 'forge' && o.r.statusCode === 200)).toHaveLength(
        forged.length,
      );
      if (row) expect(row.forgeCounter).toBe(forged.length);
      // The hour was credited once (whichever request settled it), and gold reconciles.
      expect(await events(h.id, 'activity.reward')).toHaveLength(1);
      const forgeGold = forged.reduce((s, r) => s + Number((r.data as { gold: number }).gold), 0);
      const gain = sold.length ? sellPrice(item) : salvaged.length ? salvageYield(item).gold : 0;
      expect(await goldOf(h.id)).toBe(100_000 + (await rewardGold(h.id)) - forgeGold + gain);
    }
    expect((await reconcileWithAudit(db())).filter((x) => !x.ok)).toEqual([]);
    expect(transactionStats.retries - retries).toBe(0);
  });

  it('a stored item racing sells, salvages, discards, forge work and settles: nothing touches it', async () => {
    const retries = transactionStats.retries;
    for (let round = 0; round < ROUNDS; round++) {
      const h = await farmer(`wh-stored-${round}`);
      await fund(db(), h.id, { gold: 100_000, materials: { timber: 1_000, rawHide: 1_000 } });
      const item = await insertItem(db(), h.id, { baseId: 'longsword', inWarehouse: true });
      const other = await insertItem(db(), h.id);
      nowMs += HOUR;
      const c = `/api/characters/${h.id}`;
      const ops = shuffled(
        [
          () => send(h.who, 'POST', `${c}/merchant/sell`, { itemIds: [item.id] }, true),
          () => send(h.who, 'POST', `${c}/forge/salvage`, { itemIds: [item.id] }, true),
          () => send(h.who, 'POST', `${c}/merchant/sell`, { itemIds: [item.id, other.id] }, true),
          () => send(h.who, 'DELETE', `${c}/items/${item.id}`),
          () => send(h.who, 'POST', `${c}/forge/upgrade`, { itemId: item.id }, true),
          () => send(h.who, 'POST', `${c}/items/${item.id}/equip`, {}),
          () => send(h.who, 'POST', `${c}/activity/settle`),
          () => send(h.who, 'POST', `${c}/warehouse/deposit`, { itemIds: [other.id] }),
        ],
        round,
      );
      await Promise.all(ops.map((op) => op()));
      const [row] = await db().select().from(itemInstances).where(eq(itemInstances.id, item.id));
      expect(row).toEqual(item);
      for (const event of ['merchant.sell', 'forge.salvage', 'item.discard', 'forge.upgrade']) {
        expect(await events(h.id, event), event).toEqual([]);
      }
      expect(await goldOf(h.id)).toBe(100_000 + (await rewardGold(h.id)));
      const [moved] = await db().select().from(itemInstances).where(eq(itemInstances.id, other.id));
      expect(moved!.inWarehouse).toBe(true);
    }
    expect(transactionStats.retries - retries).toBe(0);
  });

  it('bulk deposits racing settles at the capacity boundary give the same result in every order', async () => {
    const retries = transactionStats.retries;
    const cap = warehouseCapacity(0);
    const outcomes: unknown[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      // A full pack and a warehouse with 10 free slots, then two hours of farming unsettled.
      const h = await farmer('wh-bulk');
      for (let i = 0; i < PACK; i++) await insertItem(db(), h.id);
      for (let i = 0; i < cap - 10; i++) await insertItem(db(), h.id, { inWarehouse: true });
      const loose = (
        await db().select().from(itemInstances).where(eq(itemInstances.characterId, h.id))
      )
        .filter((i) => !i.inWarehouse)
        .map((i) => i.id)
        .sort();
      const first = loose.slice(0, 6);
      const second = loose.slice(6, 12);
      const third = loose.slice(12, 16);
      nowMs += 2 * HOUR;
      const c = `/api/characters/${h.id}`;
      const ops = shuffled(
        [
          ['a', () => send(h.who, 'POST', `${c}/warehouse/deposit`, { itemIds: first })],
          ['b', () => send(h.who, 'POST', `${c}/warehouse/deposit`, { itemIds: second })],
          ['c', () => send(h.who, 'POST', `${c}/warehouse/deposit`, { itemIds: third })],
          ['s', () => send(h.who, 'POST', `${c}/activity/settle`)],
          ['s', () => send(h.who, 'POST', `${c}/activity/settle`)],
        ] as const,
        round,
      );
      const results = await Promise.all(ops.map(([, op]) => op()));
      // 6 + 6 + 4 = 16 > 10 free slots: the deposits that fit in the order they ran succeed, the
      // others are refused whole. Never above capacity, never a partial move.
      const deposits = ops
        .map(([name], i) => ({ name, r: results[i]! }))
        .filter((o) => o.name !== 's');
      for (const d of deposits) {
        expect([200, 422], d.r.body).toContain(d.r.statusCode);
        if (d.r.statusCode === 422) expect(d.r.json().error.code).toBe('warehouse_full');
      }
      const rows = await db()
        .select()
        .from(itemInstances)
        .where(eq(itemInstances.characterId, h.id));
      const stored = rows.filter((i) => i.inWarehouse);
      expect(stored.length).toBeLessThanOrEqual(cap);
      const moved = deposits
        .filter((d) => d.r.statusCode === 200)
        .reduce((s, d) => s + d.r.json<{ moved: number }>().moved, 0);
      expect(stored.length).toBe(cap - 10 + moved);
      const audited = [...(await events(h.id, 'warehouse.deposit'))].reduce(
        (s, r) => s + (r.data as { items: unknown[] }).items.length,
        0,
      );
      expect(audited).toBe(moved);
      for (const group of [first, second, third]) {
        const there = group.filter((id) => stored.some((s) => s.id === id)).length;
        expect([0, group.length]).toContain(there);
      }
      // Every request settles first, so the two hours are credited once, before any move: the
      // farming outcome is the same in every order (same seed, same window, full pack).
      const rewards = await events(h.id, 'activity.reward');
      expect(rewards).toHaveLength(1);
      const reward = rewards[0]!.data as Record<string, unknown>;
      const packed = rows.filter((i) => !i.inWarehouse && i.equippedSlot === null).length;
      outcomes.push({
        reward: JSON.parse(
          JSON.stringify(reward).replace(/"(id|itemId)":"[0-9a-f-]{36}"/g, '"$1":"x"'),
        ) as unknown,
        total: packed + stored.length,
        gold: await goldOf(h.id),
      });
    }
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(outcomes[2]).toEqual(outcomes[0]);
    expect((await reconcileWithAudit(db())).filter((x) => !x.ok)).toEqual([]);
    expect(transactionStats.retries - retries).toBe(0);
  });

  it('withdrawals racing into a pack with few free slots never overfill it', async () => {
    const retries = transactionStats.retries;
    for (let round = 0; round < ROUNDS; round++) {
      const who = await insertAccount(db());
      const c = await insertCharacter(db(), who.id, { level: 10 });
      for (let i = 0; i < PACK - 3; i++) await insertItem(db(), c.id);
      const stored = [];
      for (let i = 0; i < 8; i++)
        stored.push((await insertItem(db(), c.id, { inWarehouse: true })).id);
      const results = await Promise.all(
        shuffled(
          stored.map(
            (id) => () =>
              send(who, 'POST', `/api/characters/${c.id}/warehouse/withdraw`, { itemIds: [id] }),
          ),
          round,
        ).map((op) => op()),
      );
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(3);
      expect(results.filter((r) => r.statusCode === 422)).toHaveLength(5);
      const back = await db()
        .select()
        .from(itemInstances)
        .where(and(inArray(itemInstances.id, stored), eq(itemInstances.inWarehouse, false)));
      expect(back).toHaveLength(3);
      expect(await events(c.id, 'warehouse.withdraw')).toHaveLength(3);
    }
    expect(transactionStats.retries - retries).toBe(0);
  });
});
