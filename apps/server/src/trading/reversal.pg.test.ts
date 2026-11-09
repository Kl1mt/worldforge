/**
 * Real-PostgreSQL races for trade reversal (ticket T.6, docs/TRADING.md "Test strategy": "reversal
 * vs use when the hold ends"). Runs when `DATABASE_URL` is set, skipped otherwise (CI sets
 * `REQUIRE_PG_TESTS=1`). Every race runs three rounds with alternating orders and growing head
 * starts; only what holds in every order is asserted (one outcome or the other, value conserved,
 * audit = holdings), never which racer wins, and no transaction is retried (a retry would mean a
 * lock-order problem: a deadlock).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import {
  auditLog,
  characters,
  duelDefences,
  itemInstances,
  tradeHolds,
  tradeOffers,
} from '../db/schema.js';
import { ITEM_BASES, canClassUseItem, generateItem } from '@worldforge/game-core';
import { uuidv7 } from '../db/uuid.js';
import { arenaCalls, equipKit } from '../test/arena.js';
import type { DatabaseHandle } from '../db/types.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { transactionStats } from '../db/transaction.js';
import { createPostgresTestDatabase } from '../test/db.js';
import { insertAccount, type TestAccount } from '../test/social.js';
import {
  ALL_TRADING_ON,
  befriendSince,
  insertTradeItem,
  insertTrader,
  modTradeCalls,
  setTradingSettings,
  tradeCalls,
  type Trader,
} from '../test/trading.js';
import { openWarehouse, warehouseCalls } from '../test/warehouse.js';
import { reconcileWithAudit } from '../telemetry/report.js';
import { sweepTrades } from './offers.js';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === '1') {
  throw new Error('REQUIRE_PG_TESTS=1 but DATABASE_URL is not set');
}

const ROUNDS = 3;
const HOUR = 3_600_000;
const START = new Date('2031-06-02T08:00:00.000Z');
let clock = START;
const now = () => clock;
const activity = { ...DEFAULT_ACTIVITY_OPTIONS, now };

const later = async <T>(ms: number, fn: () => Promise<T>): Promise<T> => {
  await new Promise((r) => setTimeout(r, ms));
  return fn();
};

describe.skipIf(!url)('real PostgreSQL: trade reversal under races', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let t: ReturnType<typeof tradeCalls>;
  let mod: ReturnType<typeof modTradeCalls>;
  let moderators: TestAccount[];
  const db = () => database.db;

  beforeAll(async () => {
    database = await createPostgresTestDatabase(url!, { poolMax: 20 });
    app = buildApp({
      database,
      auth: {
        now,
        accountRateLimit: { requests: 100_000, actions: 100_000, windowMs: 60_000 },
        socialWriteLimit: { windows: [{ windowMs: 60_000, max: 10_000 }] },
        tradeWriteLimit: { windows: [{ windowMs: 60_000, max: 10_000 }] },
      },
      activity,
    });
    await app.ready();
    t = tradeCalls(app);
    mod = modTradeCalls(app);
    await setTradingSettings(app, db(), ALL_TRADING_ON);
    await openWarehouse(app, db(), START);
    moderators = [
      await insertAccount(db(), { role: 'moderator', now: START }),
      await insertAccount(db(), { role: 'moderator', now: START }),
    ];
  });
  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  /** Fresh moderators at the current clock (sessions last 30 days; the clock jumps by months). */
  async function staff() {
    moderators = [
      await insertAccount(db(), { role: 'moderator', now: clock }),
      await insertAccount(db(), { role: 'moderator', now: clock }),
    ];
  }

  async function pair(gold = 10_000): Promise<[Trader, Trader]> {
    await staff();
    const a = await insertTrader(db(), clock, { gold });
    const b = await insertTrader(db(), clock, { gold: 0 });
    await befriendSince(db(), a, b, clock);
    return [a, b];
  }

  /** A → B: an Epic and `gold`, accepted at the current clock. */
  async function trade(a: Trader, b: Trader, gold: number) {
    const epic = await insertTradeItem(db(), a.hero.id);
    const sent = await t.send(a, b, { give: { itemIds: [epic.id], ...(gold ? { gold } : {}) } });
    expect(sent.statusCode, sent.body).toBe(201);
    const ok = await t.act(b, sent.json().id, 'accept', { characterId: b.hero.id });
    expect(ok.statusCode, ok.body).toBe(200);
    return { offerId: sent.json().id as string, epic };
  }

  const gold = async (heroId: string) =>
    (await db().select().from(characters).where(eq(characters.id, heroId)))[0]!.gold;
  const item = async (id: string) =>
    (await db().select().from(itemInstances).where(eq(itemInstances.id, id)))[0]!;
  const offer = async (id: string) =>
    (await db().select().from(tradeOffers).where(eq(tradeOffers.id, id)))[0]!;
  const heroCall = (who: Trader, path: string, payload: object) =>
    app.inject({
      method: 'POST',
      url: `/api/characters/${who.hero.id}${path}`,
      payload,
      headers: { 'idempotency-key': randomUUID() },
      cookies: { [SESSION_COOKIE]: who.token },
    });

  async function race<A, B>(round: number, x: () => Promise<A>, y: () => Promise<B>) {
    const head = round * 4;
    return round % 2 === 0
      ? Promise.all([x(), later(head, y)])
      : Promise.all([later(head, x), y()]);
  }

  async function expectReconciled() {
    const checks = await reconcileWithAudit(db());
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  }

  it('reversal vs the hold’s release: reversed, each hold released exactly once', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      clock = new Date(START.getTime() + round * 1000 * HOUR);
      const [a, b] = await pair();
      const { offerId } = await trade(a, b, 600);
      clock = new Date(clock.getTime() + 72 * HOUR + round);
      const retries = transactionStats.retries;
      const [rev] = await race(
        round,
        () => mod.reverse(moderators[0]!, offerId),
        () => sweepTrades(db(), clock, activity, { accountId: b.id }),
      );
      expect(rev.statusCode, rev.body).toBe(200);
      const holds = await db().select().from(tradeHolds).where(eq(tradeHolds.offerId, offerId));
      expect(holds.every((h) => h.releasedAt !== null)).toBe(true);
      const releases = (
        await db().select().from(auditLog).where(eq(auditLog.event, 'trade.release'))
      ).filter((r) => (r.data as { offerId: string }).offerId === offerId);
      expect(releases).toHaveLength(holds.length);
      expect(await gold(b.hero.id)).toBe(0);
      expect(transactionStats.retries).toBe(retries);
    }
    await expectReconciled();
  });

  it('reversal vs spending the received gold after the hold: one of them', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      clock = new Date(START.getTime() + (3000 + round * 1000) * HOUR);
      const [a, b] = await pair();
      // B holds exactly the gift; the first warehouse upgrade costs 1,000.
      const { offerId, epic } = await trade(a, b, 1_000);
      clock = new Date(clock.getTime() + 73 * HOUR);
      const aBefore = await gold(a.hero.id);
      const retries = transactionStats.retries;
      const [rev, spend] = await race(
        round,
        () => mod.reverse(moderators[0]!, offerId),
        () => warehouseCalls(app).upgrade(b.token, b.hero.id, 0),
      );
      expect([rev.statusCode, spend.statusCode].sort(), spend.body).toEqual(
        rev.statusCode === 200 ? [200, 422] : [200, 409],
      );
      if (rev.statusCode === 200) {
        expect(await gold(a.hero.id)).toBe(aBefore + 1_000);
        expect((await item(epic.id)).characterId).toBe(a.hero.id);
      } else {
        expect(rev.json().error.details.reasons.map((r: { check: string }) => r.check)).toEqual([
          'gold_spent',
        ]);
        expect(await gold(a.hero.id)).toBe(aBefore);
        expect((await item(epic.id)).characterId).toBe(b.hero.id);
      }
      expect(await gold(b.hero.id)).toBe(0);
      expect(transactionStats.retries).toBe(retries);
    }
    await expectReconciled();
  });

  it('reversal vs shelving the received item after the hold: one of them', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      clock = new Date(START.getTime() + (6000 + round * 1000) * HOUR);
      const [a, b] = await pair();
      const { offerId, epic } = await trade(a, b, 0);
      clock = new Date(clock.getTime() + 73 * HOUR);
      const retries = transactionStats.retries;
      const [rev, shelf] = await race(
        round,
        () => mod.reverse(moderators[0]!, offerId),
        () => heroCall(b, '/shelf/deposit', { itemIds: [epic.id] }),
      );
      const row = await item(epic.id);
      if (rev.statusCode === 200) {
        expect(shelf.statusCode).toBe(404);
        expect(row).toMatchObject({ characterId: a.hero.id, onShelf: false, tradedCount: 0 });
      } else {
        expect(rev.statusCode).toBe(409);
        expect(shelf.statusCode, shelf.body).toBe(200);
        expect(row).toMatchObject({ characterId: b.hero.id, onShelf: true, tradedCount: 1 });
      }
      expect(transactionStats.retries).toBe(retries);
    }
    await expectReconciled();
  });

  it('two moderators reversing the same trade: exactly one reversal', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      clock = new Date(START.getTime() + (9000 + round * 1000) * HOUR);
      const [a, b] = await pair();
      const { offerId } = await trade(a, b, 400);
      const aBefore = await gold(a.hero.id);
      const retries = transactionStats.retries;
      const [x, y] = await race(
        round,
        () => mod.reverse(moderators[0]!, offerId),
        () => mod.reverse(moderators[1]!, offerId),
      );
      expect([x.statusCode, y.statusCode].sort()).toEqual([200, 409]);
      const loser = x.statusCode === 409 ? x : y;
      expect(loser.json().error.code).toBe('trade_not_reversible');
      expect(await gold(a.hero.id)).toBe(aBefore + 400);
      expect(await gold(b.hero.id)).toBe(0);
      const rows = (
        await db().select().from(auditLog).where(eq(auditLog.event, 'trade.reverse'))
      ).filter((r) => (r.data as { offerId: string }).offerId === offerId);
      expect(rows).toHaveLength(1);
      expect((await offer(offerId)).reversedAt).not.toBeNull();
      expect(transactionStats.retries).toBe(retries);
    }
    await expectReconciled();
  });

  it('reversal vs accepting a new offer that takes the same gold: one of them', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      clock = new Date(START.getTime() + (12000 + round * 1000) * HOUR);
      const [a, b] = await pair();
      const c = await insertTrader(db(), clock);
      await befriendSince(db(), c, b, clock);
      const { offerId } = await trade(a, b, 800);
      clock = new Date(clock.getTime() + 73 * HOUR);
      // C offers B an Epic for B's 800 gold (the gold B received from A).
      const theirs = await insertTradeItem(db(), c.hero.id);
      const ask = await t.send(c, b, {
        give: { itemIds: [theirs.id] },
        ask: { gold: 800 },
      });
      expect(ask.statusCode, ask.body).toBe(201);
      const retries = transactionStats.retries;
      const [rev, acc] = await race(
        round,
        () => mod.reverse(moderators[0]!, offerId),
        () => t.act(b, ask.json().id, 'accept', { characterId: b.hero.id }),
      );
      if (rev.statusCode === 200) {
        expect(acc.statusCode).toBe(422);
        expect((await offer(ask.json().id)).status).toBe('open');
      } else {
        expect(rev.statusCode).toBe(409);
        expect(acc.statusCode, acc.body).toBe(200);
        expect(await gold(c.hero.id)).toBe(10_800);
      }
      expect(await gold(b.hero.id)).toBe(0);
      expect(transactionStats.retries).toBe(retries);
    }
    await expectReconciled();
  });

  it('reversal with a trade restriction vs the subject accepting another offer: no deadlock', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      clock = new Date(START.getTime() + (15000 + round * 1000) * HOUR);
      const [a, b] = await pair();
      const c = await insertTrader(db(), clock);
      await befriendSince(db(), c, b, clock);
      const { offerId } = await trade(a, b, 300);
      const other = await insertTradeItem(db(), c.hero.id);
      const open = await t.send(c, b, { give: { itemIds: [other.id], gold: 50 } });
      expect(open.statusCode, open.body).toBe(201);
      const cBefore = await gold(c.hero.id);
      const retries = transactionStats.retries;
      const [rev, acc] = await race(
        round,
        () =>
          mod.reverse(moderators[0]!, offerId, {
            reason: 'Restricted in a race.',
            sanction: { handle: b.handle, action: 'restrictTrade', durationHours: 24 },
          }),
        () => t.act(b, open.json().id, 'accept', { characterId: b.hero.id }),
      );
      expect(rev.statusCode, rev.body).toBe(200);
      const status = (await offer(open.json().id)).status;
      if (acc.statusCode === 200) {
        expect(status).toBe('accepted');
        expect((await item(other.id)).characterId).toBe(b.hero.id);
      } else {
        expect(status).toBe('void');
        expect((await item(other.id)).characterId).toBe(c.hero.id);
        expect(await gold(c.hero.id)).toBe(cBefore + 50);
      }
      expect(transactionStats.retries).toBe(retries);
    }
    await expectReconciled();
  });
  it('a reversal vs a defence refresh vs a duel against that defence (T.7): the returned item never stays in it', async () => {
    const arena = arenaCalls(app);
    const retries = transactionStats.retries;
    for (let round = 0; round < ROUNDS; round++) {
      const [a, b] = await pair(0);
      // A friend of B who fights B's defence (a friendly duel: no list, no daily limit).
      const c = await insertTrader(db(), clock);
      await befriendSince(db(), b, c, clock);
      await equipKit(db(), b.hero.id, b.hero.classId, 20, 'rare', `t7-b-${round}`);
      await equipKit(db(), c.hero.id, c.hero.classId, 20, 'rare', `t7-c-${round}`);
      const base = ITEM_BASES.find(
        (x) => !x.unique && x.minItemLevel <= 20 && canClassUseItem(x, b.hero.classId),
      )!;
      const gen = generateItem({
        seed: 900_000 + round,
        itemLevel: 20,
        baseId: base.id,
        rarityId: 'epic',
        classId: b.hero.classId,
      })!;
      const [epic] = await db()
        .insert(itemInstances)
        .values({
          id: uuidv7(),
          characterId: a.hero.id,
          seed: gen.seed,
          baseId: gen.baseId,
          rarityId: gen.rarityId,
          itemLevel: gen.itemLevel,
          affixes: gen.affixes,
          source: 'farming',
          binding: 'equip',
        })
        .returning();
      const sent = await t.send(a, b, { give: { itemIds: [epic!.id] } });
      expect(sent.statusCode, sent.body).toBe(201);
      const offerId = sent.json().id as string;
      expect((await t.act(b, offerId, 'accept', { characterId: b.hero.id })).statusCode).toBe(200);
      const equip = await app.inject({
        method: 'POST',
        url: `/api/characters/${b.hero.id}/items/${epic!.id}/equip`,
        payload: {},
        cookies: { [SESSION_COOKIE]: b.token },
      });
      expect(equip.statusCode, equip.body).toBe(200);
      const set = await arena.setDefence(b, b.hero.id);
      expect(set.statusCode, set.body).toBe(200);
      const [defence] = await db()
        .select()
        .from(duelDefences)
        .where(eq(duelDefences.characterId, b.hero.id));
      expect(defence!.snapshot.equipment.some((e) => e.seed === gen.seed)).toBe(true);

      const head = round * 3;
      const jobs = [
        () => mod.reverse(moderators[0]!, offerId),
        () => arena.setDefence(b, b.hero.id),
        () => arena.duel(c, c.hero.id, defence!.id, 'friendly'),
      ];
      const order = [jobs, [jobs[1]!, jobs[2]!, jobs[0]!], [jobs[2]!, jobs[0]!, jobs[1]!]][round]!;
      const results = await Promise.all(order.map((j, i) => later(i * head, j)));
      for (const r of results) expect([200, 201], r.body).toContain(r.statusCode);
      // In every order: the item is back with A, and B's stored defence doesn't hold it (the
      // reversal took it out, or the refresh came after the item left B).
      expect((await item(epic!.id)).characterId).toBe(a.hero.id);
      const [after] = await db()
        .select()
        .from(duelDefences)
        .where(eq(duelDefences.characterId, b.hero.id));
      expect(
        after!.snapshot.equipment.some((e) => e.seed === gen.seed),
        `round ${round}`,
      ).toBe(false);
      await expectReconciled();
    }
    expect(transactionStats.retries - retries).toBe(0);
  });
});
