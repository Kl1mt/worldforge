import { describe, expect, it } from 'vitest';
import { DEFAULT_TRADING_SETTINGS } from './settings.js';
import {
  TRADE_CAPS,
  TRADE_CAP_METRICS,
  capUsageOfSide,
  checkTradeCaps,
  openOfferRefusal,
  tradeCapIncrements,
  tradeCapText,
  tradeWindows,
} from './caps.js';
import type { TradeItemFacts } from './rules.js';

const LIMITS = DEFAULT_TRADING_SETTINGS.limits;
const item = (id: string, over: Partial<TradeItemFacts> = {}): TradeItemFacts => ({
  id,
  rarityId: 'legendary',
  source: 'farming',
  ...over,
});
const side = (over: object = {}) => ({ items: [], materials: {}, gold: 0, ...over });

describe('trade windows (the week and day boundary rules)', () => {
  it('a week runs Monday 00:00 UTC to the next Monday; a day midnight to midnight', () => {
    // 2031-05-11 is a Sunday.
    const lastMs = tradeWindows(new Date('2031-05-11T23:59:59.999Z'));
    const first = tradeWindows(new Date('2031-05-12T00:00:00.000Z'));
    expect(lastMs.week.key).toBe('2031-05-05');
    expect(first.week.key).toBe('2031-05-12');
    expect(lastMs.week.endsAt.toISOString()).toBe('2031-05-12T00:00:00.000Z');
    expect(lastMs.day.key).toBe('2031-05-11');
    expect(first.day.key).toBe('2031-05-12');
    expect(first.day.endsAt.toISOString()).toBe('2031-05-13T00:00:00.000Z');
  });

  it('every cap names a real limit; trades are daily, the rest weekly', () => {
    for (const m of TRADE_CAP_METRICS) expect(LIMITS[TRADE_CAPS[m].limit]).toBeGreaterThan(0);
    expect(TRADE_CAP_METRICS.filter((m) => TRADE_CAPS[m].period === 'day')).toEqual(['trades']);
  });
});

describe('what an offer counts', () => {
  it('items by rarity: Mythic and Void also count as Legendary/set; a Void Mythic once', () => {
    expect(
      capUsageOfSide(
        side({
          items: [
            item('e', { rarityId: 'epic' }),
            item('l'),
            item('s', { setId: 'gravecaller' }),
            item('m', { rarityId: 'mythic' }),
            item('vl', { variant: 'void' }),
            item('vm', { rarityId: 'mythic', variant: 'void' }),
          ],
        }),
      ),
    ).toEqual({ epic: 1, legendarySet: 5, mythicVoid: 3 });
  });

  it('gold and materials by group (seals never count, they are refused)', () => {
    expect(
      capUsageOfSide(
        side({
          gold: 250,
          materials: { timber: 10, rawHide: 5, soulShard: 3, abbeySilver: 1, gravewardenSeal: 1 },
        }),
      ),
    ).toEqual({ gold: 250, commonMaterials: 15, soulShards: 3, abbeySilver: 1 });
  });

  it('given and received separately; one trade a day for both', () => {
    const offer = { give: side({ gold: 100 }), ask: side({ items: [item('l')] }) };
    expect(tradeCapIncrements(offer, 'sender')).toEqual({
      'trades:any': 1,
      'gold:given': 100,
      'legendarySet:received': 1,
    });
    expect(tradeCapIncrements(offer, 'receiver')).toEqual({
      'trades:any': 1,
      'gold:received': 100,
      'legendarySet:given': 1,
    });
  });
});

describe('checkTradeCaps', () => {
  const now = new Date('2031-05-11T20:00:00Z');
  it('the last slot fits, one more does not', () => {
    const used = { 'legendarySet:received': 2, 'mythicVoid:received': 0 };
    expect(
      checkTradeCaps({ used, adding: { 'legendarySet:received': 1 }, limits: LIMITS, now }),
    ).toEqual([]);
    const [r] = checkTradeCaps({
      used: { 'legendarySet:received': 3 },
      adding: { 'legendarySet:received': 1 },
      limits: LIMITS,
      now,
    });
    expect(r).toEqual({
      check: 'cap_reached',
      metric: 'legendarySet',
      direction: 'received',
      limit: 'legendarySetPerWeek',
      used: 3,
      adding: 1,
      max: 3,
      resetsAt: '2031-05-12T00:00:00.000Z',
    });
    expect(tradeCapText(r!, 'you')).toContain('3 Legendary');
    expect(tradeCapText(r!, 'them')).not.toMatch(/\d/);
  });

  it('given does not use up received', () => {
    expect(
      checkTradeCaps({
        used: { 'gold:given': 10_000 },
        adding: { 'gold:received': 10_000 },
        limits: LIMITS,
        now,
      }),
    ).toEqual([]);
  });

  it('the gold that crosses 10,000, and the 6th trade of a day', () => {
    const got = checkTradeCaps({
      used: { 'gold:received': 9_000, 'trades:any': 5 },
      adding: { 'gold:received': 1_001, 'trades:any': 1 },
      limits: LIMITS,
      now,
    });
    expect(got.map((r) => [r.metric, r.resetsAt])).toEqual([
      ['trades', '2031-05-12T00:00:00.000Z'],
      ['gold', '2031-05-12T00:00:00.000Z'],
    ]);
  });

  it('a lowered limit refuses new amounts but adding nothing never fails', () => {
    const limits = { ...LIMITS, epicPerWeek: 0 };
    expect(checkTradeCaps({ used: { 'epic:given': 5 }, adding: {}, limits, now })).toEqual([]);
    expect(checkTradeCaps({ used: {}, adding: { 'epic:given': 1 }, limits, now })).toHaveLength(1);
  });

  it('open offers are counted from the offers, sender and receiver apart', () => {
    expect(openOfferRefusal({ sent: 2, received: 0 }, LIMITS, 'sender')).toBeNull();
    expect(openOfferRefusal({ sent: 3, received: 0 }, LIMITS, 'sender')).toMatchObject({
      limit: 'openOffersSent',
      max: 3,
    });
    expect(openOfferRefusal({ sent: 3, received: 9 }, LIMITS, 'receiver')).toBeNull();
    expect(openOfferRefusal({ sent: 0, received: 10 }, LIMITS, 'receiver')).toMatchObject({
      limit: 'openOffersReceived',
    });
  });
});
