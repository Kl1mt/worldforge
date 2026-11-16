import { describe, expect, it } from 'vitest';
import { COSMETICS, findCosmetic } from './catalogue.js';
import {
  SHRINE_BANK_LIMIT,
  SHRINE_DUPLICATE_MARKS,
  SHRINE_MARK_PRICES,
  SHRINE_POOL,
  SHRINE_RARITIES,
  SHRINE_RARITY_WEIGHTS,
  SHRINE_WEIGHT_TOTAL,
  drawShrine,
  shrineAccrual,
  shrineBankStart,
  shrineDay,
  shrineMarkPrice,
  shrineOdds,
  shrineOutcome,
  shrinePurchaseProblem,
  shrineRarityChance,
  shrineSeasonDraws,
  shrineSpendSource,
} from './shrine.js';

/** Ticket 9.5: the Reward Shrine's rules (docs/SHRINE.md). */

describe('the Shrine pool', () => {
  it('holds 8 to 12 companions and only Shrine-sourced cosmetics, every rarity filled', () => {
    expect(SHRINE_POOL.filter((e) => e.kind === 'companion').length).toBeGreaterThanOrEqual(8);
    expect(SHRINE_POOL.filter((e) => e.kind === 'companion').length).toBeLessThanOrEqual(12);
    for (const e of SHRINE_POOL) expect(findCosmetic(e.cosmeticId)?.source.kind).toBe('shrine');
    // Every companion comes from the Shrine (nothing else grants one yet).
    for (const c of COSMETICS.filter((c) => c.kind === 'companion')) {
      expect(c.source.kind, c.id).toBe('shrine');
    }
    for (const r of SHRINE_RARITIES) {
      expect(SHRINE_POOL.some((e) => e.rarity === r), r).toBe(true);
    }
  });

  it('publishes odds that sum to one, uniform within a rarity', () => {
    const odds = shrineOdds();
    expect(odds).toHaveLength(SHRINE_POOL.length);
    expect(odds.reduce((a, o) => a + o.chance, 0)).toBeCloseTo(1, 12);
    expect(Object.values(SHRINE_RARITY_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(
      SHRINE_WEIGHT_TOTAL,
    );
    for (const r of SHRINE_RARITIES) {
      const of = odds.filter((o) => o.rarity === r);
      expect(of.reduce((a, o) => a + o.chance, 0)).toBeCloseTo(shrineRarityChance(r), 12);
      expect(new Set(of.map((o) => o.chance)).size).toBe(1);
    }
    // Rarer is rarer, per rarity and per cosmetic.
    const per = (r: (typeof SHRINE_RARITIES)[number]) => odds.find((o) => o.rarity === r)!.chance;
    expect(per('common')).toBeGreaterThan(per('rare'));
    expect(per('rare')).toBeGreaterThan(per('hallowed'));
  });

  it('measures the published odds over many seeds', () => {
    const n = 60_000;
    const counts = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const d = drawShrine(`measure-${i}`);
      counts.set(d.cosmeticId, (counts.get(d.cosmeticId) ?? 0) + 1);
    }
    for (const o of shrineOdds()) {
      const seen = (counts.get(o.cosmeticId) ?? 0) / n;
      const se = Math.sqrt((o.chance * (1 - o.chance)) / n);
      expect(Math.abs(seen - o.chance), o.cosmeticId).toBeLessThan(5 * se);
    }
  });

  it('replays a draw from its seed, whatever the account owns', () => {
    const a = drawShrine('0123456789abcdef0123456789abcdef');
    expect(drawShrine('0123456789abcdef0123456789abcdef')).toEqual(a);
    expect(shrineEntry(a.cosmeticId)).toBe(true);
    const fresh = shrineOutcome('0123456789abcdef0123456789abcdef', new Set());
    expect(fresh).toEqual({ ...a, outcome: 'grant', marks: 0 });
    const dup = shrineOutcome('0123456789abcdef0123456789abcdef', new Set([a.cosmeticId]));
    expect(dup).toEqual({ ...a, outcome: 'marks', marks: SHRINE_DUPLICATE_MARKS[a.rarity] });
  });
});

function shrineEntry(id: string) {
  return SHRINE_POOL.some((e) => e.cosmeticId === id);
}

describe('marks', () => {
  it('pays more for a rarer duplicate and prices every pool cosmetic', () => {
    expect(SHRINE_DUPLICATE_MARKS.common).toBeLessThan(SHRINE_DUPLICATE_MARKS.rare);
    expect(SHRINE_DUPLICATE_MARKS.rare).toBeLessThan(SHRINE_DUPLICATE_MARKS.hallowed);
    for (const e of SHRINE_POOL) {
      expect(shrineMarkPrice(e.cosmeticId)).toBe(SHRINE_MARK_PRICES[e.rarity]);
    }
    expect(shrineMarkPrice('banner.forgeward')).toBeNull();
  });

  it('refuses unknown, owned and unaffordable purchases, at the price edge', () => {
    const id = SHRINE_POOL.find((e) => e.rarity === 'rare')!.cosmeticId;
    const price = SHRINE_MARK_PRICES.rare;
    expect(shrinePurchaseProblem('banner.forgeward', new Set(), 999)).toBe('unknown_offer');
    expect(shrinePurchaseProblem('nope', new Set(), 999)).toBe('unknown_offer');
    expect(shrinePurchaseProblem(id, new Set([id]), 999)).toBe('already_owned');
    expect(shrinePurchaseProblem(id, new Set(), price - 1)).toBe('insufficient_marks');
    expect(shrinePurchaseProblem(id, new Set(), price)).toBeNull();
  });
});

describe('the free-draw bank', () => {
  it('starts with today held for a new account and a full bank for an old one', () => {
    const made = new Date('2026-03-04T23:59:00Z');
    const start = shrineBankStart(made);
    expect(shrineAccrual(start, 0, shrineDay(made))).toEqual({
      grant: 1,
      through: shrineDay(made),
    });
    expect(shrineAccrual(start, 0, shrineDay(made) + 30).grant).toBe(SHRINE_BANK_LIMIT);
  });

  it('adds one a day up to the limit, at its edges', () => {
    expect(shrineAccrual(10, 0, 10)).toEqual({ grant: 0, through: 10 });
    expect(shrineAccrual(10, 0, 11)).toEqual({ grant: 1, through: 11 });
    expect(shrineAccrual(10, 5, 12)).toEqual({ grant: 2, through: 12 });
    expect(shrineAccrual(10, 5, 13)).toEqual({ grant: 2, through: 13 });
    expect(shrineAccrual(10, SHRINE_BANK_LIMIT - 1, 11)).toEqual({ grant: 1, through: 11 });
    expect(shrineAccrual(10, SHRINE_BANK_LIMIT, 11)).toEqual({ grant: 0, through: 11 });
    expect(shrineAccrual(10, SHRINE_BANK_LIMIT, 40)).toEqual({ grant: 0, through: 40 });
    expect(shrineAccrual(10, 0, 10 + SHRINE_BANK_LIMIT + 1).grant).toBe(SHRINE_BANK_LIMIT);
  });

  it('never grants twice for a day and ignores a clock that went back', () => {
    const first = shrineAccrual(10, 0, 12);
    expect(shrineAccrual(first.through, first.grant, 12).grant).toBe(0);
    expect(shrineAccrual(12, 0, 11)).toEqual({ grant: 0, through: 12 });
  });

  it('days a full bank sat through are not paid back later', () => {
    // Full on day 10; seven drawn on day 20: the next accrual that day adds nothing.
    let s = shrineAccrual(3, 0, 10);
    expect(s.grant).toBe(SHRINE_BANK_LIMIT);
    s = shrineAccrual(s.through, SHRINE_BANK_LIMIT, 20);
    expect(s).toEqual({ grant: 0, through: 20 });
    expect(shrineAccrual(s.through, 0, 20).grant).toBe(0);
    expect(shrineAccrual(s.through, 0, 21).grant).toBe(1);
  });

  it('counts days in UTC', () => {
    expect(shrineDay(new Date('2026-11-16T23:59:59.999Z'))).toBe(
      shrineDay(new Date('2026-11-16T00:00:00Z')),
    );
    expect(shrineDay(new Date('2026-11-17T00:00:00Z'))).toBe(
      shrineDay(new Date('2026-11-16T00:00:00Z')) + 1,
    );
  });
});

describe('spending and play draws', () => {
  it('spends free draws first, then play, then shop', () => {
    expect(shrineSpendSource({ daily: 1, play: 1, shop: 1 })).toBe('daily');
    expect(shrineSpendSource({ daily: 0, play: 2, shop: 1 })).toBe('play');
    expect(shrineSpendSource({ daily: 0, play: 0, shop: 1 })).toBe('shop');
    expect(shrineSpendSource({ daily: 0, play: 0, shop: 0 })).toBeNull();
  });

  it('pays season honours by the best tier', () => {
    expect(shrineSeasonDraws([])).toBe(0);
    expect(shrineSeasonDraws(['veteran'])).toBe(1);
    expect(shrineSeasonDraws(['veteran', 'champion', 'renowned'])).toBe(4);
    expect(shrineSeasonDraws(['exalted'])).toBe(3);
  });
});
