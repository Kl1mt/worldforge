/**
 * Real-PostgreSQL races for trade offers (ticket T.5, docs/TRADING.md "Test strategy"). Runs when
 * `DATABASE_URL` is set, skipped otherwise (CI sets `REQUIRE_PG_TESTS=1`). Every race runs three
 * rounds with varied orders and growing head starts; only what holds in every order is asserted
 * (one outcome or the other, value conserved, audit = holdings), never which racer wins, and no
 * transaction is retried (a retry would mean a lock-order problem: a deadlock).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, inArray, sql } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { characters, itemInstances, sanctions, tradeHolds, tradeOffers } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { transactionStats, withTransaction } from '../db/transaction.js';
import { createPostgresTestDatabase } from '../test/db.js';
import {
  ALL_TRADING_ON,
  befriendSince,
  giveMaterials,
  insertTradeItem,
  insertTrader,
  setTradingSettings,
  tradeCalls,
  type Trader,
} from '../test/trading.js';
import { loadGameSettings, updateTradingSettings } from '../settings/store.js';
import { openWarehouse } from '../test/warehouse.js';
import { reconcileWithAudit } from '../telemetry/report.js';
import { queryRows } from '../db/query.js';
import { sweepTrades } from './offers.js';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === '1') {
  throw new Error('REQUIRE_PG_TESTS=1 but DATABASE_URL is not set');
}

const ROUNDS = 3;
const HOUR = 3_600_000;
const START = new Date('2031-05-06T08:00:00.000Z');
let clock = START;
const now = () => clock;
const activity = { ...DEFAULT_ACTIVITY_OPTIONS, now };

const later = async <T>(ms: number, fn: () => Promise<T>): Promise<T> => {
  await new Promise((r) => setTimeout(r, ms));
  return fn();
};

describe.skipIf(!url)('real PostgreSQL: trade offers under races', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let t: ReturnType<typeof tradeCalls>;
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
    await setTradingSettings(app, db(), ALL_TRADING_ON);
    await openWarehouse(app, db(), START);
  });
  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  async function pair(): Promise<[Trader, Trader]> {
    const a = await insertTrader(db(), clock);
    const b = await insertTrader(db(), clock);
    await befriendSince(db(), a, b, clock);
    return [a, b];
  }

  /** Gold, material units and items of these heroes, plus what open offers hold in escrow. */
  async function holdings(heroIds: string[]) {
    const [g] = await queryRows<{ n: string }>(
      db(),
      sql`select coalesce(sum(gold), 0)::bigint as n from characters where id in ${heroIds}`,
    );
    const [m] = await queryRows<{ n: string }>(
      db(),
      sql`select coalesce(sum(quantity), 0)::bigint as n from character_materials where character_id in ${heroIds}`,
    );
    const [e] = await queryRows<{ g: string; m: string }>(
      db(),
      sql`select coalesce(sum(case when l.kind = 'gold' then l.amount else 0 end), 0)::bigint as g,
                   coalesce(sum(case when l.kind = 'material' then l.amount else 0 end), 0)::bigint as m
            from trade_offer_lines l join trade_offers o on o.id = l.offer_id
            where o.status = 'open' and l.side = 'give' and o.sender_character_id in ${heroIds}`,
    );
    const items = await db()
      .select({ id: itemInstances.id })
      .from(itemInstances)
      .where(inArray(itemInstances.characterId, heroIds));
    return {
      gold: Number(g!.n) + Number(e!.g),
      materials: Number(m!.n) + Number(e!.m),
      items: items.length,
    };
  }

  async function expectReconciled() {
    const checks = await reconcileWithAudit(db());
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  }

  async function status(offerId: string) {
    return (await db().select().from(tradeOffers).where(eq(tradeOffers.id, offerId)))[0]!.status;
  }

  async function giftOffer(a: Trader, b: Trader) {
    const epic = await insertTradeItem(db(), a.hero.id);
    await giveMaterials(db(), a.hero.id, { timber: 40 });
    const res = await t.send(a, b, {
      give: { itemIds: [epic.id], gold: 400, materials: { timber: 15 } },
    });
    expect(res.statusCode, res.body).toBe(201);
    return { offerId: res.json().id as string, epic };
  }

  it('accept vs cancel: one of them, never both; value conserved', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const [a, b] = await pair();
      const { offerId } = await giftOffer(a, b);
      const before = await holdings([a.hero.id, b.hero.id]);
      const retries = transactionStats.retries;
      const head = round * 4;
      const accept = () => t.act(b, offerId, 'accept', { characterId: b.hero.id });
      const cancel = () => t.act(a, offerId, 'cancel');
      const [acc, can] =
        round % 2 === 0
          ? await Promise.all([accept(), later(head, cancel)])
          : await Promise.all([later(head, accept), cancel()]);
      expect([acc.statusCode, can.statusCode].sort()).toEqual([200, 409]);
      const s = await status(offerId);
      expect(s).toBe(acc.statusCode === 200 ? 'accepted' : 'cancelled');
      expect(await holdings([a.hero.id, b.hero.id])).toEqual(before);
      expect(transactionStats.retries).toBe(retries);
    }
    await expectReconciled();
  });

  it('double accept: exactly one trade', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const [a, b] = await pair();
      const { offerId } = await giftOffer(a, b);
      const retries = transactionStats.retries;
      const results = await Promise.all(
        [0, round * 3].map((d) =>
          later(d, () => t.act(b, offerId, 'accept', { characterId: b.hero.id })),
        ),
      );
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      const holds = await db().select().from(tradeHolds).where(eq(tradeHolds.offerId, offerId));
      expect(holds).toHaveLength(1);
      expect(
        (await db().select().from(characters).where(eq(characters.id, b.hero.id)))[0]!.gold,
      ).toBe(10_400);
      expect(transactionStats.retries).toBe(retries);
    }
    await expectReconciled();
  });

  it('accept vs a switch turned off: accepted or voided, never half', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      await setTradingSettings(app, db(), ALL_TRADING_ON);
      const [a, b] = await pair();
      const { offerId } = await giftOffer(a, b);
      const admin = a.id;
      const before = await holdings([a.hero.id, b.hero.id]);
      const retries = transactionStats.retries;
      const switchOff = async () => {
        const { trading } = await loadGameSettings(db());
        await withTransaction(db(), (tx) =>
          updateTradingSettings(tx, {
            settings: { ...ALL_TRADING_ON, trade: { ...ALL_TRADING_ON.trade, items: false } },
            expectedVersion: trading.version,
            actorAccountId: admin,
            now: clock,
            events: app.settingsEvents,
          }),
        );
        app.gameSettings.invalidate();
      };
      const accept = () => t.act(b, offerId, 'accept', { characterId: b.hero.id });
      const [acc] =
        round % 2 === 0
          ? await Promise.all([accept(), later(round * 3, switchOff)])
          : await Promise.all([later(round * 3, accept), switchOff()]);
      const s = await status(offerId);
      if (acc.statusCode === 200) expect(s).toBe('accepted');
      else {
        expect(acc.statusCode).toBe(409);
        expect(s).toBe('void');
      }
      expect(await holdings([a.hero.id, b.hero.id])).toEqual(before);
      expect(transactionStats.retries).toBe(retries);
    }
    await setTradingSettings(app, db(), ALL_TRADING_ON);
    await expectReconciled();
  });

  it('accept vs a block and vs a suspension: accepted or voided', async () => {
    for (let round = 0; round < ROUNDS * 2; round++) {
      const [a, b] = await pair();
      const { offerId } = await giftOffer(a, b);
      const before = await holdings([a.hero.id, b.hero.id]);
      const retries = transactionStats.retries;
      const block = () =>
        app.inject({
          method: 'POST',
          url: '/api/blocks',
          payload: { handle: b.handle },
          cookies: { [SESSION_COOKIE]: a.token },
        });
      const suspend = () =>
        withTransaction(db(), async (tx) => {
          // As the moderator route does: the subject's account row first, then the seam.
          await tx.execute(sql`select 1 from accounts where id = ${a.id} for update`);
          await tx.insert(sanctions).values({
            id: randomUUID(),
            subjectId: a.id,
            kind: 'suspend',
            reason: 'Test',
            createdAt: clock,
            expiresAt: new Date(clock.getTime() + 24 * HOUR),
          });
          await app.sanctionEvents.emit(
            {
              sanction: {} as never,
              kind: 'suspend',
              subjectId: a.id,
              actorAccountId: b.id,
              at: clock,
            },
            tx,
          );
        });
      const other: () => Promise<unknown> = round < ROUNDS ? block : suspend;
      const accept = () => t.act(b, offerId, 'accept', { characterId: b.hero.id });
      const [acc] =
        round % 2 === 0
          ? await Promise.all([accept(), later(round * 2, other)])
          : await Promise.all([later(round * 2, accept), other()] as const);
      const s = await status(offerId);
      expect(s).toBe(acc.statusCode === 200 ? 'accepted' : 'void');
      expect(await holdings([a.hero.id, b.hero.id])).toEqual(before);
      expect(transactionStats.retries).toBe(retries);
    }
    await expectReconciled();
  });

  it('two-way trades between the same pair at once: both trade, no deadlock', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const [a, b] = await pair();
      const ab = await giftOffer(a, b);
      const ba = await giftOffer(b, a);
      // Swaps both ways too: each asks for an item of the other.
      const aItem = await insertTradeItem(db(), a.hero.id);
      const bItem = await insertTradeItem(db(), b.hero.id);
      const swap1 = await t.send(a, b, {
        give: { gold: 50 },
        ask: { itemIds: [bItem.id] },
        receiverCharacterId: b.hero.id,
      });
      const swap2 = await t.send(b, a, {
        give: { gold: 50 },
        ask: { itemIds: [aItem.id] },
        receiverCharacterId: a.hero.id,
      });
      const before = await holdings([a.hero.id, b.hero.id]);
      const retries = transactionStats.retries;
      const results = await Promise.all([
        t.act(b, ab.offerId, 'accept', { characterId: b.hero.id }),
        later(round, () => t.act(a, ba.offerId, 'accept', { characterId: a.hero.id })),
        later(round * 2, () => t.act(b, swap1.json().id, 'accept', {})),
        t.act(a, swap2.json().id, 'accept', {}),
      ]);
      expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200]);
      expect(await holdings([a.hero.id, b.hero.id])).toEqual(before);
      expect(transactionStats.retries).toBe(retries);
    }
    await expectReconciled();
  });

  it('a shelf deposit racing the escrow of the same item: the item goes to one of them', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const [a, b] = await pair();
      const epic = await insertTradeItem(db(), a.hero.id);
      const retries = transactionStats.retries;
      const send = () => t.send(a, b, { give: { itemIds: [epic.id], gold: 10 } });
      const deposit = () =>
        app.inject({
          method: 'POST',
          url: `/api/characters/${a.hero.id}/shelf/deposit`,
          payload: { itemIds: [epic.id], gold: 10 },
          headers: { 'idempotency-key': randomUUID() },
          cookies: { [SESSION_COOKIE]: a.token },
        });
      const [s, d] =
        round % 2 === 0
          ? await Promise.all([send(), later(round * 3, deposit)])
          : await Promise.all([later(round * 3, send), deposit()]);
      const codes = [s.statusCode, d.statusCode];
      expect(codes.filter((c) => c === 200 || c === 201)).toHaveLength(1);
      const [row] = await db().select().from(itemInstances).where(eq(itemInstances.id, epic.id));
      expect(row!.onShelf !== (row!.escrowOfferId !== null)).toBe(true);
      expect(transactionStats.retries).toBe(retries);
    }
    await expectReconciled();
  });

  it('spending held gold racing its release: the spend goes through once the time has come', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      clock = START;
      const giver = await insertTrader(db(), clock);
      const taker = await insertTrader(db(), clock, { gold: 0 });
      await befriendSince(db(), giver, taker, clock);
      const sent = await t.send(giver, taker, { give: { gold: 1_000 } });
      await t.act(taker, sent.json().id, 'accept', { characterId: taker.hero.id });
      // Before the hold ends: refused.
      const early = await app.inject({
        method: 'POST',
        url: `/api/characters/${taker.hero.id}/warehouse/upgrade`,
        payload: { level: 0 },
        headers: { 'idempotency-key': randomUUID() },
        cookies: { [SESSION_COOKIE]: taker.token },
      });
      expect(early.statusCode).toBe(422);
      clock = new Date(START.getTime() + 72 * HOUR);
      const retries = transactionStats.retries;
      const spend = () =>
        app.inject({
          method: 'POST',
          url: `/api/characters/${taker.hero.id}/warehouse/upgrade`,
          payload: { level: 0 },
          headers: { 'idempotency-key': randomUUID() },
          cookies: { [SESSION_COOKIE]: taker.token },
        });
      const release = () => sweepTrades(db(), clock, activity, { accountId: taker.id });
      const [res] =
        round % 2 === 0
          ? await Promise.all([spend(), later(round * 2, release)])
          : await Promise.all([later(round * 2, spend), release()]);
      expect(res.statusCode, res.body).toBe(200);
      await release();
      const [hold] = await db()
        .select()
        .from(tradeHolds)
        .where(eq(tradeHolds.characterId, taker.hero.id));
      expect(hold!.releasedAt).not.toBeNull();
      expect(transactionStats.retries).toBe(retries);
    }
    clock = START;
    await expectReconciled();
  });
});
