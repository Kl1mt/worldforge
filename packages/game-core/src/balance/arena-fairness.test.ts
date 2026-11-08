import { describe, expect, it } from 'vitest';
import { RATED_BRACKETS, arenaPopulation, measureFairness } from './arena-fixtures.js';

/**
 * Arena matchmaking fairness (ticket 5.6, docs/PVP.md "Matchmaking"). A synthetic population of
 * 120 heroes per rated bracket (every class and level, commons to Legendary +10 Void kits and B.2
 * builds), every hero asks for a list, and every offered pair is fought 32 times from fixed seeds:
 * each number is a measurement that is the same in every run, so a band fails only when a rule, a
 * factor or content changes. The measured values are in docs/PVP.md.
 *
 * "Favourite": the side that wins more of the pair's duels; its share is the pair's expected win
 * chance (a fair pair measures ~57 % over 32 duels by chance alone).
 */

const SIZE = 120;
const SEEDS = 32;
const SLOW = { timeout: 120_000 };

describe('matchmaking fairness bands', () => {
  for (const bracket of RATED_BRACKETS) {
    it(`${bracket.label}: offered pairs are far fairer than 5.5's random lists`, SLOW, () => {
      const pop = arenaPopulation(bracket, SIZE);
      const mm = measureFairness(bracket, pop, 'matchmaking', SEEDS);
      const random = measureFairness(bracket, pop, 'random', SEEDS);
      // The band.
      expect(mm.meanFavourite).toBeLessThanOrEqual(0.72);
      expect(mm.over90).toBeLessThanOrEqual(0.08);
      expect(mm.over95).toBeLessThanOrEqual(0.03);
      // The 5.4 risk: pairs three or more gear tiers apart (commons against Legendary +5).
      expect(mm.extremePairs).toBeLessThanOrEqual(0.03);
      // Lists stay full with a realistic population, and rarely need a wider range.
      expect(mm.emptyLists).toBe(0);
      expect(mm.meanListSize).toBeGreaterThanOrEqual(4.9);
      expect(mm.widened).toBeLessThanOrEqual(0.25);
      // Against random lists (the reference: gear decides most of them).
      expect(random.meanFavourite - mm.meanFavourite).toBeGreaterThanOrEqual(0.15);
      expect(random.over95).toBeGreaterThanOrEqual(0.3);
      expect(random.extremePairs).toBeGreaterThanOrEqual(0.1);
    });
  }
});
