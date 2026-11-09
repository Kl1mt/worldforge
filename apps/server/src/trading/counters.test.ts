/**
 * Trade cap counters (ticket T.4): the week and day boundaries on an injected clock (the window
 * rule: the transaction's clock picks the window, stored with the row), all-or-nothing refusals,
 * given and received apart, and the other party's numbers kept out of the refusal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  DEFAULT_TRADING_SETTINGS,
  tradeCapIncrements,
  type TradeOfferFacts,
} from '@worldforge/game-core';
import { tradeCounters } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { withTransaction } from '../db/transaction.js';
import { createTestDatabase } from '../test/db.js';
import { insertAccount, type TestAccount } from '../test/social.js';
import { ApiError } from '../errors.js';
import { commitTradeCounters, readTradeCounters } from './counters.js';

let database: DatabaseHandle;
let a: TestAccount;
let b: TestAccount;
const LIMITS = DEFAULT_TRADING_SETTINGS.limits;

beforeAll(async () => {
  database = await createTestDatabase();
  a = await insertAccount(database.db);
  b = await insertAccount(database.db);
});
afterAll(async () => {
  await database?.close();
});

const legendaryGift: TradeOfferFacts = {
  give: {
    items: [{ id: 'x', rarityId: 'legendary', source: 'farming' }],
    materials: {},
    gold: 0,
  },
  ask: { items: [], materials: {}, gold: 0 },
};

/** A's gift to B, accepted at `now`; resolves to the error code, or null. */
async function accept(
  offer: TradeOfferFacts,
  now: Date,
  sender = a,
  receiver = b,
  limits = LIMITS,
): Promise<string | null> {
  try {
    await withTransaction(database.db, (tx) =>
      commitTradeCounters(tx, {
        actorId: receiver.id,
        limits,
        now,
        parties: [
          { accountId: sender.id, adding: tradeCapIncrements(offer, 'sender') },
          { accountId: receiver.id, adding: tradeCapIncrements(offer, 'receiver') },
        ],
      }),
    );
    return null;
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
}

describe('caps at the week boundary', () => {
  it('the 4th Legendary in a week is refused; Monday 00:00 starts a new week', async () => {
    // 2031-05-11 is a Sunday.
    const sunday = new Date('2031-05-11T10:00:00.000Z');
    for (let i = 0; i < 3; i++) expect(await accept(legendaryGift, sunday)).toBeNull();
    expect(await accept(legendaryGift, new Date('2031-05-11T23:59:59.999Z'))).toBe(
      'trade_cap_reached',
    );
    expect(await accept(legendaryGift, new Date('2031-05-12T00:00:00.000Z'))).toBeNull();
    const rows = await database.db
      .select()
      .from(tradeCounters)
      .where(eq(tradeCounters.metric, 'legendarySet'));
    const byWindow = rows.map(
      (r) => `${r.accountId === a.id ? 'a' : 'b'}:${r.windowStart}:${r.direction}:${r.amount}`,
    );
    expect(byWindow.sort()).toEqual([
      'a:2031-05-05:given:3',
      'a:2031-05-12:given:1',
      'b:2031-05-05:received:3',
      'b:2031-05-12:received:1',
    ]);
  });

  it('the refusal names your cap with numbers and theirs without', async () => {
    let err: ApiError | null = null;
    try {
      await withTransaction(database.db, (tx) =>
        commitTradeCounters(tx, {
          actorId: b.id,
          limits: LIMITS,
          now: new Date('2031-05-14T10:00:00.000Z'),
          parties: [
            { accountId: a.id, adding: { 'legendarySet:given': 3 } },
            { accountId: b.id, adding: { 'legendarySet:received': 3 } },
          ],
        }),
      );
    } catch (e) {
      err = e as ApiError;
    }
    expect(err?.statusCode).toBe(409);
    const refusals = (err!.details as { refusals: object[] }).refusals;
    expect(refusals).toEqual([
      { check: 'cap_reached', party: 'them', metric: 'legendarySet', direction: 'given' },
      expect.objectContaining({ party: 'you', used: 1, adding: 3, max: 3, direction: 'received' }),
    ]);
  });
});

describe('caps at the day boundary', () => {
  it('the 6th trade of a day is refused and writes nothing; midnight resets it', async () => {
    const [c, d] = [await insertAccount(database.db), await insertAccount(database.db)];
    const gold: TradeOfferFacts = {
      give: { items: [], materials: {}, gold: 10 },
      ask: { items: [], materials: {}, gold: 0 },
    };
    for (let i = 0; i < 5; i++) {
      expect(await accept(gold, new Date('2031-06-03T20:00:00.000Z'), c, d)).toBeNull();
    }
    const before = await readTradeCounters(database.db, c.id, new Date('2031-06-03T23:00:00Z'));
    expect(await accept(gold, new Date('2031-06-03T23:59:59.999Z'), c, d)).toBe(
      'trade_cap_reached',
    );
    // All or nothing: the gold that would have fitted wasn't counted either.
    expect(await readTradeCounters(database.db, c.id, new Date('2031-06-03T23:00:00Z'))).toEqual(
      before,
    );
    expect(before).toEqual({ 'trades:any': 5, 'gold:given': 50 });
    expect(await accept(gold, new Date('2031-06-04T00:00:00.000Z'), c, d)).toBeNull();
    // Same week (2031-06-02 is a Monday): the gold keeps adding up across the days.
    expect(await readTradeCounters(database.db, c.id, new Date('2031-06-04T00:00:00Z'))).toEqual({
      'trades:any': 1,
      'gold:given': 60,
    });
  });

  it('a lowered limit refuses at accept what fitted before', async () => {
    const [c, d] = [await insertAccount(database.db), await insertAccount(database.db)];
    const now = new Date('2031-07-01T12:00:00Z');
    expect(await accept(legendaryGift, now, c, d)).toBeNull();
    expect(await accept(legendaryGift, now, c, d, { ...LIMITS, legendarySetPerWeek: 1 })).toBe(
      'trade_cap_reached',
    );
  });
});
