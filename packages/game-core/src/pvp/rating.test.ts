import { describe, expect, it } from 'vitest';
import {
  ARENA_RATING_VERSION,
  DEFAULT_RATING_CONFIG,
  PAIR_FACTORS,
  PROVISIONAL_GAMES,
  ageRating,
  expectedScore,
  initialRating,
  mailboxKey,
  patternFlags,
  rateDuel,
  rateGames,
  ratedPairExclusion,
  ratingFactor,
  ratingRange,
  ratingStanding,
  seasonStartRating,
  type Rating,
} from '../index.js';

const DAY = 86_400_000;
const T0 = new Date(Date.UTC(2026, 10, 1));

describe('Glicko-2 (Glickman 2012, "Example of the Glicko-2 system")', () => {
  // The paper's worked example: 1500 / 200 / 0.06 with τ = 0.5 against three opponents.
  const player: Rating = { rating: 1500, deviation: 200, volatility: 0.06 };
  const games = [
    { opponent: { rating: 1400, deviation: 30 }, score: 1 },
    { opponent: { rating: 1550, deviation: 100 }, score: 0 },
    { opponent: { rating: 1700, deviation: 300 }, score: 0 },
  ];

  it('matches the published reference values', () => {
    const r = rateGames(player, games);
    expect(r.rating).toBeCloseTo(1464.06, 1);
    expect(r.deviation).toBeCloseTo(151.52, 1);
    // The paper prints σ' = 0.05999 (0.059996 to six places).
    expect(r.volatility).toBeCloseTo(0.059996, 6);
  });

  it('a period without games only grows the deviation (step 6)', () => {
    const r = rateGames(player, []);
    expect(r.rating).toBe(1500);
    expect(r.volatility).toBe(0.06);
    // √(φ² + σ²) on the Glicko-2 scale: 200 → 200.27.
    expect(r.deviation).toBeCloseTo(200.27, 1);
  });

  it('is deterministic and order-independent within a period', () => {
    const a = rateGames(player, games);
    const b = rateGames(player, [...games].reverse());
    expect(rateGames(player, games)).toEqual(a);
    expect(b.rating).toBeCloseTo(a.rating, 9);
    expect(b.deviation).toBeCloseTo(a.deviation, 9);
  });

  it('refuses a score that is not a win, draw or loss', () => {
    expect(() => rateGames(player, [{ opponent: player, score: 0.7 }])).toThrow(RangeError);
  });

  it('expected scores are complementary and favour the higher rating', () => {
    const a = { rating: 1700, deviation: 80 };
    const b = { rating: 1500, deviation: 120 };
    expect(expectedScore(a, b) + expectedScore(b, a)).toBeCloseTo(1, 12);
    expect(expectedScore(a, b)).toBeGreaterThan(0.7);
    expect(expectedScore(b, b)).toBeCloseTo(0.5, 12);
  });

  it('the defaults are the published ones and versioned', () => {
    expect(initialRating()).toEqual({ rating: 1500, deviation: 350, volatility: 0.06 });
    expect(DEFAULT_RATING_CONFIG.tau).toBe(0.5);
    expect(ARENA_RATING_VERSION).toBe(1);
  });
});

describe('async rating periods (one duel = one period; idle days age the deviation)', () => {
  const settled: Rating = { rating: 1600, deviation: 60, volatility: 0.06 };

  it('whole idle days grow the deviation, never above the start', () => {
    expect(ageRating(settled, null, T0)).toEqual(settled);
    expect(ageRating(settled, T0, new Date(T0.getTime() + DAY - 1))).toEqual(settled);
    const day1 = ageRating(settled, T0, new Date(T0.getTime() + DAY));
    const day30 = ageRating(settled, T0, new Date(T0.getTime() + 30 * DAY));
    expect(day1.deviation).toBeGreaterThan(60);
    expect(day30.deviation).toBeGreaterThan(day1.deviation);
    expect(day30.rating).toBe(1600);
    expect(ageRating(settled, T0, new Date(T0.getTime() + 100_000 * DAY)).deviation).toBe(350);
    // A clock that went backwards counts as no time.
    expect(ageRating(settled, T0, new Date(T0.getTime() - 5 * DAY))).toEqual(settled);
  });

  it('a duel moves both sides, the winner up and the loser down', () => {
    const c = { rating: initialRating(), lastRatedAt: null };
    const d = { rating: initialRating(), lastRatedAt: null };
    const out = rateDuel({ challenger: c, defender: d, outcome: 'challenger', factor: 1, now: T0 });
    expect(out.challenger.after.rating).toBeGreaterThan(1500);
    expect(out.defender.after.rating).toBeLessThan(1500);
    // Equal ratings: the change is symmetric.
    expect(out.challenger.after.rating - 1500).toBeCloseTo(1500 - out.defender.after.rating, 9);
    expect(out.challenger.after.deviation).toBeLessThan(350);
    // The same as one Glicko-2 period of one game for each side.
    expect(out.challenger.after).toEqual(
      rateGames(initialRating(), [{ opponent: initialRating(), score: 1 }]),
    );
  });

  it('a defence loss counts like a loss, a draw like half a win', () => {
    const c = { rating: { rating: 1500, deviation: 100, volatility: 0.06 }, lastRatedAt: T0 };
    const d = { rating: { rating: 1500, deviation: 100, volatility: 0.06 }, lastRatedAt: T0 };
    const lost = rateDuel({
      challenger: c,
      defender: d,
      outcome: 'challenger',
      factor: 1,
      now: T0,
    });
    const held = rateDuel({ challenger: c, defender: d, outcome: 'defender', factor: 1, now: T0 });
    const draw = rateDuel({ challenger: c, defender: d, outcome: 'draw', factor: 1, now: T0 });
    expect(lost.defender.after.rating).toBeLessThan(1500);
    expect(held.defender.after.rating).toBeGreaterThan(1500);
    expect(held.defender.after.rating - 1500).toBeCloseTo(lost.challenger.after.rating - 1500, 9);
    expect(draw.challenger.after.rating).toBeCloseTo(1500, 9);
  });

  it('diminishing returns scale the whole change; at 0 nothing moves', () => {
    const c = { rating: initialRating(), lastRatedAt: null };
    const d = { rating: { rating: 1550, deviation: 90, volatility: 0.06 }, lastRatedAt: T0 };
    const now = new Date(T0.getTime() + 3 * DAY);
    const full = rateDuel({ challenger: c, defender: d, outcome: 'challenger', factor: 1, now });
    const half = rateDuel({ challenger: c, defender: d, outcome: 'challenger', factor: 0.5, now });
    const none = rateDuel({ challenger: c, defender: d, outcome: 'challenger', factor: 0, now });
    expect(half.challenger.after.rating - 1500).toBeCloseTo(
      (full.challenger.after.rating - 1500) / 2,
      9,
    );
    expect(none.challenger.after).toEqual(none.challenger.before);
    expect(none.defender.after).toEqual(none.defender.before);
    // The defender's "before" is aged by its idle days.
    expect(none.defender.before.deviation).toBeGreaterThan(90);
    expect(() =>
      rateDuel({ challenger: c, defender: d, outcome: 'draw', factor: 1.5, now }),
    ).toThrow(RangeError);
  });

  it('a long series converges toward the stronger hero', () => {
    let a = { rating: initialRating(), lastRatedAt: null as Date | null };
    let b = { rating: initialRating(), lastRatedAt: null as Date | null };
    for (let i = 0; i < 40; i++) {
      const now = new Date(T0.getTime() + i * DAY);
      // a wins three of every four.
      const out = rateDuel({
        challenger: a,
        defender: b,
        outcome: i % 4 === 3 ? 'defender' : 'challenger',
        factor: 1,
        now,
      });
      a = { rating: out.challenger.after, lastRatedAt: now };
      b = { rating: out.defender.after, lastRatedAt: now };
    }
    const e = expectedScore(a.rating, b.rating);
    expect(e).toBeGreaterThan(0.6);
    expect(e).toBeLessThan(0.9);
    expect(a.rating.deviation).toBeLessThan(120);
  });
});

describe('plain words, ranges and the season reset', () => {
  it('provisional until enough games, then settling or settled', () => {
    expect(ratingStanding({ deviation: 50 }, PROVISIONAL_GAMES - 1)).toBe('provisional');
    expect(ratingStanding({ deviation: 150 }, PROVISIONAL_GAMES)).toBe('settling');
    expect(ratingStanding({ deviation: 100 }, PROVISIONAL_GAMES)).toBe('settled');
  });

  it('the shown range is ± 2 deviations, rounded to 10', () => {
    expect(ratingRange({ rating: 1523.4, deviation: 71 })).toEqual({
      shown: 1523,
      low: 1380,
      high: 1670,
    });
    expect(ratingRange({ rating: 400, deviation: 350 }).low).toBe(0);
  });

  it('a season starts soft: halfway back to 1500, deviation at least 250', () => {
    expect(seasonStartRating(null)).toEqual(initialRating());
    expect(seasonStartRating({ rating: 1900, deviation: 50, volatility: 0.07 })).toEqual({
      rating: 1700,
      deviation: 250,
      volatility: 0.06,
    });
    expect(seasonStartRating({ rating: 1300, deviation: 300, volatility: 0.05 })).toEqual({
      rating: 1400,
      deviation: 300,
      volatility: 0.06,
    });
  });
});

describe('win-trading rules', () => {
  it('diminishing returns against the same pair of accounts', () => {
    expect(PAIR_FACTORS).toEqual([1, 0.5, 0.25]);
    expect([0, 1, 2, 3, 9].map(ratingFactor)).toEqual([1, 0.5, 0.25, 0, 0]);
    expect(() => ratingFactor(-1)).toThrow(RangeError);
    expect(() => ratingFactor(1.5)).toThrow(RangeError);
  });

  it('friends, guildmates and shared signals are excluded, in that order', () => {
    expect(ratedPairExclusion({ friend: false, guildmate: false, sharedSignal: false })).toBe(null);
    expect(ratedPairExclusion({ friend: true, guildmate: true, sharedSignal: true })).toBe(
      'friend',
    );
    expect(ratedPairExclusion({ friend: false, guildmate: true, sharedSignal: true })).toBe(
      'guildmate',
    );
    expect(ratedPairExclusion({ friend: false, guildmate: false, sharedSignal: true })).toBe(
      'sharedSignal',
    );
  });

  it('the mailbox key folds case, +tags and Gmail dots', () => {
    expect(mailboxKey('A.Lice+arena@GoogleMail.com')).toBe('alice@gmail.com');
    expect(mailboxKey('alice@gmail.com')).toBe('alice@gmail.com');
    expect(mailboxKey('a.lice+x@example.org')).toBe('a.lice@example.org');
    expect(mailboxKey('a.lice@example.org')).not.toBe(mailboxKey('alice@example.org'));
  });

  it('pattern flags: repeated, lopsided, one way', () => {
    expect(patternFlags({ duels: 3, winsA: 2, winsB: 1, challengesA: 2 })).toEqual([]);
    expect(patternFlags({ duels: 3, winsA: 3, winsB: 0, challengesA: 3 })).toEqual(['oneWay']);
    expect(patternFlags({ duels: 5, winsA: 4, winsB: 1, challengesA: 2 })).toEqual([
      'repeated',
      'lopsided',
    ]);
    expect(patternFlags({ duels: 4, winsA: 0, winsB: 4, challengesA: 0 })).toEqual([
      'lopsided',
      'oneWay',
    ]);
  });
});
