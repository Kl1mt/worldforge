/**
 * Real-PostgreSQL races for the trade cap counters (ticket T.4, docs/TRADING.md "Test strategy":
 * "caps at the boundary"). Runs when `DATABASE_URL` is set, skipped otherwise (CI sets
 * `REQUIRE_PG_TESTS=1`). Several accepts compete for the last slot of a cap, in varied orders and
 * with growing head starts; only what holds in every order is asserted: exactly the slots left are
 * taken, the counters equal the accepts that committed, and nothing is retried or deadlocked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  DEFAULT_TRADING_SETTINGS,
  tradeCapIncrements,
  type TradeOfferFacts,
} from '@worldforge/game-core';
import { tradeCounters } from '../db/schema.js';
import { transactionStats, withTransaction } from '../db/transaction.js';
import type { DatabaseHandle } from '../db/types.js';
import { createPostgresTestDatabase } from '../test/db.js';
import { insertAccount, type TestAccount } from '../test/social.js';
import { ApiError } from '../errors.js';
import { commitTradeCounters, readTradeCounters } from './counters.js';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === '1') {
  throw new Error('REQUIRE_PG_TESTS=1 but DATABASE_URL is not set');
}

const ROUNDS = 3;
const LIMITS = DEFAULT_TRADING_SETTINGS.limits;
const NOW = new Date('2031-07-02T12:00:00.000Z');

const gift = (item: TradeOfferFacts['give']['items'][number]): TradeOfferFacts => ({
  give: { items: [item], materials: {}, gold: 0 },
  ask: { items: [], materials: {}, gold: 0 },
});
const LEGENDARY = gift({ id: 'l', rarityId: 'legendary', source: 'farming' });
const MYTHIC = gift({ id: 'm', rarityId: 'mythic', source: 'farming' });

async function accept(
  database: DatabaseHandle,
  offer: TradeOfferFacts,
  sender: TestAccount,
  receiver: TestAccount,
  delayMs: number,
): Promise<'ok' | 'cap'> {
  await new Promise((r) => setTimeout(r, delayMs));
  try {
    await withTransaction(database.db, async (tx) => {
      await commitTradeCounters(tx, {
        actorId: receiver.id,
        limits: LIMITS,
        now: NOW,
        parties: [
          { accountId: sender.id, adding: tradeCapIncrements(offer, 'sender') },
          { accountId: receiver.id, adding: tradeCapIncrements(offer, 'receiver') },
        ],
      });
    });
    return 'ok';
  } catch (e) {
    if (e instanceof ApiError && e.code === 'trade_cap_reached') return 'cap';
    throw e;
  }
}

describe.skipIf(!url)('real PostgreSQL: trade caps hold under races', () => {
  let database: DatabaseHandle;

  beforeAll(async () => {
    database = await createPostgresTestDatabase(url!, { poolMax: 20 });
  });
  afterAll(async () => {
    await database?.close();
  });

  it('two accepts for the last Legendary slot of one receiver: exactly one wins', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const receiver = await insertAccount(database.db);
      const [s1, s2, s0] = [
        await insertAccount(database.db),
        await insertAccount(database.db),
        await insertAccount(database.db),
      ];
      // Two of three slots used by an earlier trade.
      await accept(database, LEGENDARY, s0, receiver, 0);
      await accept(database, LEGENDARY, s0, receiver, 0);
      const retries = transactionStats.retries;
      const head = round * 3;
      const order = round % 2 === 0 ? [s1, s2] : [s2, s1];
      const results = await Promise.all(
        order.map((s, i) => accept(database, LEGENDARY, s, receiver, i === 0 ? 0 : head)),
      );
      expect(results.filter((r) => r === 'ok')).toHaveLength(1);
      expect(results.filter((r) => r === 'cap')).toHaveLength(1);
      const used = await readTradeCounters(database.db, receiver.id, NOW);
      expect(used).toEqual({ 'trades:any': 3, 'legendarySet:received': 3 });
      // The winner's sender counted the gift, the loser's nothing.
      const given = await Promise.all(
        [s1, s2].map(
          async (s) => (await readTradeCounters(database.db, s.id, NOW))['legendarySet:given'] ?? 0,
        ),
      );
      expect(given.sort()).toEqual([0, 1]);
      expect(transactionStats.retries).toBe(retries);
    }
  });

  it('many accepts both ways at once: caps exact on every account, no deadlock', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const people = await Promise.all(Array.from({ length: 4 }, () => insertAccount(database.db)));
      const retries = transactionStats.retries;
      // Every ordered pair sends a Mythic twice: 24 accepts for caps of 1 given and 1 received.
      const jobs = people.flatMap((a, i) =>
        people.flatMap((b, j) =>
          i === j ? [] : [0, 1].map((k) => ({ a, b, k: k + i + j + round })),
        ),
      );
      const results = await Promise.all(
        jobs.map(({ a, b, k }) => accept(database, MYTHIC, a, b, k % 3)),
      );
      const wins = results.filter((r) => r === 'ok').length;
      expect(wins).toBeGreaterThanOrEqual(1);
      for (const p of people) {
        const c = await readTradeCounters(database.db, p.id, NOW);
        expect(c['mythicVoid:given'] ?? 0).toBeLessThanOrEqual(1);
        expect(c['mythicVoid:received'] ?? 0).toBeLessThanOrEqual(1);
        expect(c['trades:any'] ?? 0).toBeLessThanOrEqual(LIMITS.tradesPerDay);
      }
      // Every committed accept is counted once on each side.
      const rows = await database.db
        .select()
        .from(tradeCounters)
        .where(and(eq(tradeCounters.metric, 'mythicVoid'), eq(tradeCounters.direction, 'given')));
      const ids = new Set(people.map((p) => p.id));
      const given = rows.filter((r) => ids.has(r.accountId)).reduce((n, r) => n + r.amount, 0);
      expect(given).toBe(wins);
      expect(transactionStats.retries).toBe(retries);
    }
  });
});
