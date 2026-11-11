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
      // ≤ 8 % in 5.6; matchmaking 3 (B.4b) draws from a new seed (its version is in it; nothing
      // else differs here, this population has no repeat pairs): 30+ measures 8.2 %.
      // Ticket 6.1: with the Cinderwastes' tier-4 gear 30+ rose to 13.2 % / 6.5 % (Power ranks the
      // top kits close while duels separate them), recorded at ≤ 14 % / ≤ 7 %. Ticket B.5: 30+
      // ranks by duel Power (bracket Power 3): 3.2 % / 1.0 %, so 30+ is back on every bracket's
      // band. 10–19 2.3 % / 0.5 %, 20–29 3.3 % / 0.7 % (unchanged: they keep Character Power).
      expect(mm.over90).toBeLessThanOrEqual(0.09);
      // Ticket B.4 (matchmaking 2, Power relative to the class): 1 / 1 / 4 % here, from 1 / 1 / 2 %
      // (the classes now even out on realistic heroes, `competitive-balance.test.ts`).
      expect(mm.over95).toBeLessThanOrEqual(0.05);
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

  // Ticket B.5: since 6.2 the 30+ bracket holds heroes up to 40 (the Cinder Depths' gear, item
  // level 39). Before B.5 this population measured 13.8 % / 8.8 % at the season's start; with duel
  // Power 4.0 % / 0.7 %, and 3.8 % / 0.7 % with every +10 Void kit awakened (6.5b).
  for (const awakened of [false, true]) {
    it(`30+ with heroes up to level 40${awakened ? ', top kits awakened' : ''}: inside the band`, SLOW, () => {
      const bracket = RATED_BRACKETS.find((b) => b.id === '30-plus')!;
      const pop = arenaPopulation(bracket, SIZE, { maxLevel: 40, awakened });
      const mm = measureFairness(bracket, pop, 'matchmaking', SEEDS);
      expect(mm.meanFavourite).toBeLessThanOrEqual(0.72);
      expect(mm.over90).toBeLessThanOrEqual(0.08);
      expect(mm.over95).toBeLessThanOrEqual(0.05);
      expect(mm.extremePairs).toBeLessThanOrEqual(0.03);
      expect(mm.emptyLists).toBe(0);
      expect(mm.meanListSize).toBeGreaterThanOrEqual(4.9);
      expect(mm.widened).toBeLessThanOrEqual(0.25);
    });
  }
});
