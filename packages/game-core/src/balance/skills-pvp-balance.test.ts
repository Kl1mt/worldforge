import { describe, expect, it } from 'vitest';
import {
  CLASS_IDS,
  PVP_BRACKETS,
  PVP_RULES_VERSION,
  simulateDuel,
  type ClassId,
  type PvpBracket,
  type PvpFighterInput,
} from '../index.js';
import {
  RATED_BRACKETS,
  arenaPopulation,
  measureFairness,
  type ArenaHero,
} from './arena-fixtures.js';
import {
  GEAR_TIERS,
  fighter,
  fresh,
  gear,
  matchupTiers,
  sampleBuild,
  typical,
  winShare,
} from './pvp-fixtures.js';
import { duelLeaderAt } from './skills-balance.js';

/**
 * Ticket B.7: the PvP bands of 5.4 (`pvp-balance.test.ts`) and the matchmaking bands of 5.6/B.5
 * (`arena-fairness.test.ts`) under duel rules 3 with loadouts (docs/BALANCE.md "B.7", docs/PVP.md
 * "B.7"). Same kits and seeds as those suites; each hero fields its class's duel leader at its
 * level (`B7_LEADERS`). Fixed seeds: each number is the same in every run. Numbers from
 * `tools/balance/skills-balance.ts pvp` and `arena`.
 */
const SLOW = { timeout: 300_000 };

const lead = (f: PvpFighterInput): PvpFighterInput => ({
  ...f,
  loadout: duelLeaderAt(f.classId, f.level),
});

/** The 5.4 fresh-hero minimums (1–9's measured floor, see pvp-balance.test.ts). */
const FRESH_MINIMUM: Record<string, { perClass: number; mean: number }> = {
  default: { perClass: 0.08, mean: 0.15 },
  '1-9': { perClass: 0.03, mean: 0.07 },
};

/**
 * Class matchups with every hero on its duel leader, against 5.4's band (pairs 40–60 %, classes
 * 45–55 %; the default loadout keeps it, pvp-balance.test.ts). With the leaders it does not hold
 * (owner question 2, docs/BALANCE.md "B.7"): measured 1–9 pairs 41–75 %, classes 38–66 % (no
 * rated duels there); 10–19 44–66 %, 43–58 %; 20–29 34–58 %, 43–57 %; 30+ 39.7–56 %, 46–54 %
 * (one pair, hunter–warrior, just under). Asserted as recorded, a few points wide, so they cannot
 * slip further unseen while the owner decides.
 */
const MATCHUP_BANDS: Record<string, { pairs: [number, number]; classes: [number, number] }> = {
  '1-9': { pairs: [0.38, 0.78], classes: [0.35, 0.69] },
  '10-19': { pairs: [0.41, 0.69], classes: [0.4, 0.61] },
  '20-29': { pairs: [0.31, 0.61], classes: [0.4, 0.6] },
  '30-plus': { pairs: [0.37, 0.6], classes: [0.45, 0.55] },
};

describe.each(PVP_BRACKETS.map((b) => [b.id, b] as const))(
  'B.7: PvP bracket %s with loadouts',
  (_id, b: PvpBracket) => {
    const L = b.referenceLevel;

    it('runs under duel rules 3', () => {
      expect(PVP_RULES_VERSION).toBe(3);
    });

    it('class matchups with everyone on their duel leader', SLOW, () => {
      const tiers = matchupTiers(b);
      const mgear = (c: ClassId, t: string, s: number) =>
        t === 'build' ? sampleBuild(c, L - 1, s) : gear(c, L, t as never, s);
      const mean: Record<string, number> = {};
      const pairs: string[] = [];
      const band = MATCHUP_BANDS[b.id]!;
      for (const a of CLASS_IDS)
        for (const d of CLASS_IDS) {
          if (a >= d) continue;
          let share = 0;
          for (const t of tiers)
            for (let s = 0; s < 6; s++)
              share += winShare(
                lead(fighter(a, L, mgear(a, t, s))),
                lead(fighter(d, L, mgear(d, t, s + 100))),
                12,
                `pvp-matchup:${b.id}:${a}:${d}:${t}:${s}`,
              ).share;
          share /= tiers.length * 6;
          pairs.push(`${a}–${d} ${share.toFixed(2)}`);
          mean[a] = (mean[a] ?? 0) + share / 3;
          mean[d] = (mean[d] ?? 0) + (1 - share) / 3;
          expect(share, pairs.join(' · ')).toBeGreaterThanOrEqual(band.pairs[0]);
          expect(share, pairs.join(' · ')).toBeLessThanOrEqual(band.pairs[1]);
        }
      for (const c of CLASS_IDS) {
        expect(mean[c]!, `${c} ${pairs.join(' · ')}`).toBeGreaterThanOrEqual(band.classes[0]);
        expect(mean[c]!, `${c} ${pairs.join(' · ')}`).toBeLessThanOrEqual(band.classes[1]);
      }
    });

    it('5.4’s 25 % gear rule: every gear step still wins, none overwhelmingly', SLOW, () => {
      // Measured on the leaders: the same steps as on the default within ±5 points (51–100 %).
      for (let i = 1; i < GEAR_TIERS.length; i++) {
        const [better, worse] = [GEAR_TIERS[i]!, GEAR_TIERS[i - 1]!];
        let share = 0;
        for (const c of CLASS_IDS)
          for (let s = 0; s < 3; s++)
            share += winShare(
              lead(fighter(c, L, gear(c, L, better, s))),
              lead(fighter(c, L, gear(c, L, worse, s + 7))),
              24,
              `pvp-step:${b.id}:${c}:${i}:${s}`,
            ).share;
        share /= CLASS_IDS.length * 3;
        expect(share, `${better} over ${worse}`).toBeGreaterThan(0.5);
        if (worse !== 'naked') expect(share, `${better} over ${worse}`).toBeLessThanOrEqual(0.98);
      }
    });

    it('a loadout is worth less than a full gear step (same class, same kit)', SLOW, () => {
      // Measured: the leader beats the default 47–72 % in Legendary +5 kits; the epic → Legendary
      // step wins 89–97 %.
      for (const c of CLASS_IDS) {
        let share = 0;
        for (let s = 0; s < 3; s++) {
          const f = fighter(c, L, gear(c, L, 'legendary+5', s));
          share += winShare(lead(f), f, 40, `b7-edge:${b.id}:${c}:${s}`).share;
        }
        expect(share / 3, c).toBeLessThanOrEqual(0.8);
      }
    });

    it('a fresh hero on their own leader keeps a real chance against typical leaders', SLOW, () => {
      // Measured (both on their leaders): 1–9 3–10 %, mean 6 %; 10–19 11–32 %, 18 %; 20–29 27–41 %,
      // 34 %; 30+ 39–64 %, 51 %. A fresh hero who keeps the default against typical heroes on their
      // leaders falls to 7–15 % (mean 11 %) in 10–19 (reported, docs/BALANCE.md "B.7").
      const min = FRESH_MINIMUM[b.id] ?? FRESH_MINIMUM.default!;
      let total = 0;
      for (const c of CLASS_IDS) {
        let share = 0;
        for (let s = 0; s < 3; s++) {
          const hero = lead(fresh(c, b, s));
          for (const d of CLASS_IDS)
            for (let k = 0; k < 3; k++)
              share += winShare(
                hero,
                lead(typical(d, b, k)),
                16,
                `pvp-typical:fresh:${b.id}:${c}:${s}:${d}:${k}`,
              ).share;
        }
        share /= 36;
        // 1–9 drops to 3 % for the warrior and hunter (rated duels open at 10).
        expect(share, c).toBeGreaterThanOrEqual(b.id === '1-9' ? 0.025 : min.perClass);
        total += share;
      }
      expect(total / CLASS_IDS.length).toBeGreaterThanOrEqual(b.id === '1-9' ? 0.05 : min.mean);
    });

    it(
      'duels still end in seconds; damage over time stays a sliver (the ±25 % luck rule holds)',
      SLOW,
      () => {
        // Ticks take no luck roll. Measured: they are 0–1 % of all damage; median 6.8–8 s, no time limit.
        const durations: number[] = [];
        let limits = 0;
        let ticks = 0;
        let all = 0;
        for (const a of CLASS_IDS)
          for (const d of CLASS_IDS)
            for (let s = 0; s < 25; s++)
              for (const r of [
                simulateDuel({
                  challenger: lead(fighter(a, L, sampleBuild(a, L - 1, s))),
                  defender: lead(typical(d, b, s)),
                  seed: `dur:${b.id}:${a}:${d}:${s}`,
                }),
                simulateDuel({
                  challenger: lead(typical(a, b, s)),
                  defender: lead(typical(d, b, s + 1)),
                  seed: `dur2:${b.id}:${a}:${d}:${s}`,
                }),
              ]) {
                durations.push(r.durationMs);
                if (r.reason === 'timeLimit') limits++;
                for (const e of r.events) {
                  if (e.type === 'tick') ticks += e.damage;
                  if (e.type === 'tick' || e.type === 'attack') all += e.damage;
                }
              }
        durations.sort((x, y) => x - y);
        const median = durations[durations.length >> 1]!;
        expect(median).toBeGreaterThan(4_000);
        expect(median).toBeLessThan(15_000);
        expect(limits / durations.length).toBeLessThanOrEqual(0.01);
        expect(ticks / all).toBeLessThanOrEqual(0.03);
      },
    );
  },
);

/** The population with loadouts: every hero on its leader, or every second one (the others default). */
const dress = (pop: readonly ArenaHero[], every: 1 | 2) =>
  pop.map((h) => (h.index % every === 0 ? { ...h, fighter: lead(h.fighter) } : h));

describe('B.7: matchmaking fairness with loadouts (bracket Power ignores them)', () => {
  // arena-fairness.test.ts's population and seeds. Everyone on their leader: inside every band
  // (measured 2.3–5.5 % / 0.7–1.8 %). Half on their leader: 10–29 inside (5.7 % / 2.8 %), 30+ not
  // (9.2 % / 3.5 %, to 52 11–12 %, mean favourite 73 %): owner question 3 (bracket Power 4).
  const cases: [string, number | undefined, boolean, number][] = [
    ['10-19', undefined, false, 0.09],
    ['20-29', undefined, false, 0.09],
    ['30-plus', undefined, false, 0.11],
    ['30-plus', 52, false, 0.14],
    ['30-plus', 52, true, 0.14],
  ];
  for (const [id, maxLevel, awakened, halfOver90] of cases) {
    it(`${id}${maxLevel ? ` to ${maxLevel}` : ''}${awakened ? ', awakened' : ''}`, SLOW, () => {
      const bracket = RATED_BRACKETS.find((b) => b.id === id)!;
      const pop = arenaPopulation(bracket, 120, { ...(maxLevel ? { maxLevel } : {}), awakened });
      const all = measureFairness(bracket, dress(pop, 1), 'matchmaking', 32);
      expect(all.meanFavourite).toBeLessThanOrEqual(0.72);
      expect(all.over90).toBeLessThanOrEqual(0.09);
      expect(all.over95).toBeLessThanOrEqual(0.05);
      expect(all.emptyLists).toBe(0);
      const half = measureFairness(bracket, dress(pop, 2), 'matchmaking', 32);
      expect(half.over90).toBeLessThanOrEqual(halfOver90);
      expect(half.over95).toBeLessThanOrEqual(0.05);
      expect(half.meanFavourite).toBeLessThanOrEqual(0.75);
    });
  }
});
