import { describe, expect, it } from 'vitest';
import {
  TRADE_HOLD_MS,
  TRADE_OFFER_TTL_MS,
  holdUntil,
  isOfferExpired,
  offerContents,
  offerExpiresAt,
  switchesVoiding,
  tradeEndText,
} from './offers.js';
import { TRADING_SWITCH_PATHS } from './settings.js';

const side = (over: Partial<Parameters<typeof offerContents>[0][number]> = {}) => ({
  items: [],
  gold: 0,
  materials: {},
  ...over,
});

describe('trade offers (T.5)', () => {
  it('expires after 48 hours and holds for 72, exactly at the boundary', () => {
    const now = new Date('2031-01-01T00:00:00.000Z');
    expect(offerExpiresAt(now).getTime() - now.getTime()).toBe(TRADE_OFFER_TTL_MS);
    expect(TRADE_OFFER_TTL_MS).toBe(48 * 3_600_000);
    expect(holdUntil(now).getTime() - now.getTime()).toBe(TRADE_HOLD_MS);
    expect(TRADE_HOLD_MS).toBe(72 * 3_600_000);
    const at = offerExpiresAt(now);
    expect(isOfferExpired(at, new Date(at.getTime() - 1))).toBe(false);
    expect(isOfferExpired(at, at)).toBe(true);
  });

  it('summarises kinds and item categories of both sides', () => {
    const c = offerContents([
      side({ items: [{ id: 'a', rarityId: 'legendary', setId: 'x', source: 'farming' }] }),
      side({ gold: 10, materials: { timber: 0, ironOre: 3 } }),
    ]);
    expect(c.kinds.sort()).toEqual(['gold', 'items', 'materials']);
    expect(c.categories).toEqual(['set']);
  });

  it('voids by switch: the master always, a kind or category when present, shelf never', () => {
    const goldOnly = offerContents([side({ gold: 5 }), side()]);
    const epic = offerContents([
      side({ items: [{ id: 'e', rarityId: 'epic', source: 'farming' }] }),
      side(),
    ]);
    expect(switchesVoiding(['trading'], goldOnly)).toEqual(['trading']);
    expect(switchesVoiding(['trade.gold'], goldOnly)).toEqual(['trade.gold']);
    expect(switchesVoiding(['trade.items', 'tradeable.epic'], goldOnly)).toEqual([]);
    expect(switchesVoiding(['tradeable.epic', 'tradeable.legendary'], epic)).toEqual([
      'tradeable.epic',
    ]);
    for (const p of TRADING_SWITCH_PATHS.filter((x) => x.startsWith('shelf.'))) {
      expect(switchesVoiding([p], epic)).toEqual([]);
      expect(switchesVoiding([p], goldOnly)).toEqual([]);
    }
  });

  it('says plainly why an offer ended, never naming a sanction or a blocker', () => {
    expect(tradeEndText('void', { cause: 'switch', switches: ['trade.gold'] })).toBe(
      'This offer was withdrawn: trading of gold is paused. Everything in it went back to the sender.',
    );
    expect(
      tradeEndText('void', { cause: 'switch', switches: ['tradeable.epic', 'trade.gold'] }),
    ).toMatch(/trading of Epic items and gold is paused/);
    expect(tradeEndText('void', { cause: 'switch', switches: ['trading'] })).toMatch(
      /trading is paused/,
    );
    for (const cause of ['block', 'sanction', 'relation'] as const) {
      const t = tradeEndText('void', { cause });
      expect(t).not.toMatch(/block|sanction|suspend|restrict/i);
    }
    expect(tradeEndText('expired')).toMatch(/48 hours/);
  });
});
