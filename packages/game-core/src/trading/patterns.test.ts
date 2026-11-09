import { describe, expect, it } from 'vitest';
import {
  TRADE_ACCOUNT_FLAGS,
  TRADE_PAIR_FLAGS,
  TRADE_PATTERN_TEXT,
  tradeAccountFlags,
  tradePairFlags,
  type TradePairFacts,
} from './patterns.js';

const none = { items: 0, gold: 0, materialUnits: 0 };
const pair = (over: Partial<TradePairFacts> = {}): TradePairFacts => ({
  trades: 3,
  aToB: { items: 2, gold: 500, materialUnits: 0 },
  bToA: { items: 1, gold: 0, materialUnits: 0 },
  partnersA: 3,
  partnersB: 2,
  sameInvite: false,
  sameMailbox: false,
  ...over,
});

describe('tradePairFlags', () => {
  it('flags nothing for a two-way pair with other partners', () => {
    expect(tradePairFlags(pair())).toEqual([]);
  });
  it('flags one-way flows from two trades, in either direction', () => {
    expect(tradePairFlags(pair({ bToA: none }))).toEqual(['oneWay']);
    expect(tradePairFlags(pair({ aToB: none }))).toEqual(['oneWay']);
    expect(tradePairFlags(pair({ trades: 1, bToA: none }))).toEqual([]);
  });
  it('flags pairs that only trade with each other, and shared sign-ups', () => {
    expect(tradePairFlags(pair({ partnersA: 1, partnersB: 1 }))).toEqual(['onlyEachOther']);
    expect(tradePairFlags(pair({ partnersA: 1, partnersB: 2 }))).toEqual([]);
    expect(tradePairFlags(pair({ sameInvite: true, sameMailbox: true }))).toEqual([
      'sameInvite',
      'sameMailbox',
    ]);
  });
});

describe('tradeAccountFlags', () => {
  const quiet = { receivedWhileNew: none, weeksAtCap: 0, flaggedItems: 0, reversals: 0 };
  it('flags each signal at its threshold', () => {
    expect(tradeAccountFlags(quiet)).toEqual([]);
    expect(tradeAccountFlags({ ...quiet, receivedWhileNew: { ...none, items: 3 } })).toEqual([
      'newAccountReceiving',
    ]);
    expect(tradeAccountFlags({ ...quiet, receivedWhileNew: { ...none, gold: 4_999 } })).toEqual([]);
    expect(tradeAccountFlags({ ...quiet, receivedWhileNew: { ...none, gold: 5_000 } })).toEqual([
      'newAccountReceiving',
    ]);
    expect(tradeAccountFlags({ ...quiet, weeksAtCap: 1 })).toEqual([]);
    expect(tradeAccountFlags({ ...quiet, weeksAtCap: 2 })).toEqual(['atCap']);
    expect(tradeAccountFlags({ ...quiet, flaggedItems: 1 })).toEqual(['flaggedItems']);
    expect(tradeAccountFlags({ ...quiet, reversals: 1 })).toEqual([]);
    expect(tradeAccountFlags({ ...quiet, reversals: 2 })).toEqual(['repeatedReversals']);
  });
  it('has plain words for every flag', () => {
    for (const f of [...TRADE_PAIR_FLAGS, ...TRADE_ACCOUNT_FLAGS]) {
      expect(TRADE_PATTERN_TEXT[f].length).toBeGreaterThan(10);
    }
  });
});
