/**
 * Test support for the arena matchmaking fairness suite (ticket 5.6, `arena-fairness.test.ts`,
 * `tools/balance/arena.ts`, docs/PVP.md "Matchmaking"). Excluded from the package build.
 *
 * A synthetic arena population per rated bracket: heroes of every class at every level of the
 * bracket, in gear tiers drawn with a realistic spread (most in commons and rares, a few in full
 * Legendary +10 Void kits; B.2-shaped builds from 20 up), each with its 5.1 Character Power. All
 * draws come from fixed seeds, so every measurement is the same in every run.
 */
import {
  CLASS_IDS,
  PVP_BRACKETS,
  bracketPower,
  createRng,
  pickOpponents,
  rateDuel,
  simulateDuel,
  initialRating,
  type ClassId,
  type MatchCandidate,
  type MatchmakingConfig,
  type PvpBracket,
  type PvpFighterInput,
  type Rating,
  DEFAULT_MATCHMAKING,
  BRACKET_POWER_VERSION,
  awakenItem,
} from '../index.js';
import { gear, sampleBuild, winShare, type GearTier } from './pvp-fixtures.js';

/** Rated brackets (level 10 and up; owner decision 5.4). */
export const RATED_BRACKETS: readonly PvpBracket[] = PVP_BRACKETS.filter((b) => b.min >= 10);

/** How a bracket's heroes are dressed (weights): a spread from commons to the best kits. */
export const TIER_WEIGHTS: readonly [GearTier | 'build', number][] = [
  ['common', 30],
  ['rare', 24],
  ['epic', 18],
  ['legendary', 12],
  ['build', 6],
  ['legendary+5', 6],
  ['legendary+10void', 4],
];

export interface ArenaHero extends MatchCandidate {
  index: number;
  classId: ClassId;
  level: number;
  tier: GearTier | 'build';
  fighter: PvpFighterInput;
}

function drawTier(r: () => number, level: number): GearTier | 'build' {
  const weights = TIER_WEIGHTS.filter(([t]) => t !== 'build' || level >= 20);
  const total = weights.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [t, w] of weights) {
    if ((x -= w) < 0) return t;
  }
  return weights[weights.length - 1]![0];
}

const popMemo = new Map<string, ArenaHero[]>();

/** Ticket 6.5b: how a population is drawn beyond its bracket and size. */
export interface ArenaPopulationOptions {
  /**
   * Every hero in a +10 Void Legendary kit awakens every piece that may (the endgame players the
   * owner expects to awaken). The same heroes, gear and levels as without it.
   */
  awakened?: boolean;
  /** The bracket Power version matchmaking ranks by (default `BRACKET_POWER_VERSION`). */
  powerVersion?: 1 | 2;
}

/** `size` heroes of a bracket (one account each), with their Power. Memoised per bracket. */
export function arenaPopulation(
  bracket: PvpBracket,
  size: number,
  options: ArenaPopulationOptions = {},
): ArenaHero[] {
  const version = options.powerVersion ?? BRACKET_POWER_VERSION;
  const key = `${bracket.id}:${size}:${options.awakened ? 'awakened' : 'plain'}:${version}`;
  const cached = popMemo.get(key);
  if (cached) return cached;
  const rng = createRng(`arena-pop:${bracket.id}`);
  const top = bracket.max ?? bracket.min + 5;
  const heroes: ArenaHero[] = [];
  for (let i = 0; i < size; i++) {
    const classId = CLASS_IDS[i % CLASS_IDS.length]!;
    const level = rng.int(bracket.min, top);
    const tier = drawTier(() => rng.next(), level);
    const dressed =
      tier === 'build' ? sampleBuild(classId, level - 1, i) : gear(classId, level, tier, i);
    const equipment =
      options.awakened && tier === 'legendary+10void'
        ? dressed.map((item) => {
            const r = awakenItem(item);
            return r.ok ? r.item : item;
          })
        : dressed;
    const power = bracketPower({ classId, level, equipment }, bracket, version);
    heroes.push({
      index: i,
      defenceId: `d${String(i).padStart(4, '0')}`,
      accountId: `a${String(i).padStart(4, '0')}`,
      classId,
      level,
      tier,
      power,
      rating: 1500,
      deviation: 350,
      fighter: { classId, level, equipment },
    });
  }
  popMemo.set(key, heroes);
  return heroes;
}

export interface FairnessReport {
  pairs: number;
  /** Mean of the favourite's win share over the offered pairs (0.5 = every pair even). */
  meanFavourite: number;
  /** The 90th percentile of the favourite's share. */
  p90Favourite: number;
  /** Share of pairs whose favourite wins at least 90 % / 95 %. */
  over90: number;
  over95: number;
  /** The worst pair offered. */
  maxFavourite: number;
  /** Share of offered pairs whose favourite (by win share) is the higher-Power hero. */
  powerPredicts: number;
  /** Mean list length, and the share of lists that needed a wider Power range. */
  meanListSize: number;
  widened: number;
  /** Seekers who got no opponent at all. */
  emptyLists: number;
  /** Share of pairs three or more gear tiers apart (e.g. commons against Legendary +5). */
  extremePairs: number;
}

/** Gear tiers in order (a build counts as a Legendary kit). */
const TIER_RANK: Record<GearTier | 'build', number> = {
  naked: 0,
  common: 1,
  rare: 2,
  epic: 3,
  legendary: 4,
  build: 4,
  'legendary+5': 5,
  'legendary+10void': 6,
};
export const tierGap = (a: ArenaHero, b: ArenaHero) =>
  Math.abs(TIER_RANK[a.tier] - TIER_RANK[b.tier]);

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};

/**
 * The fairness band: every hero of the population asks for a list (`pickOpponents`, or `random`
 * like 5.5's draw), and each offered pair is fought `seeds` times (alternating sides). Ratings are
 * the population's (all 1500 at the season's start, or after `settleRatings`).
 */
export function measureFairness(
  bracket: PvpBracket,
  heroes: readonly ArenaHero[],
  mode: 'matchmaking' | 'random',
  seeds: number,
  config: MatchmakingConfig = DEFAULT_MATCHMAKING,
  size = 5,
  /** Ticket 6.5b: count only the offered pairs this accepts (e.g. one side awakened). */
  only?: (seeker: ArenaHero, opponent: ArenaHero) => boolean,
): FairnessReport {
  const fav: number[] = [];
  let predicts = 0;
  let lists = 0;
  let listed = 0;
  let widened = 0;
  let empty = 0;
  let extreme = 0;
  for (const seeker of heroes) {
    const others = heroes.filter((h) => h.accountId !== seeker.accountId);
    let picks: ArenaHero[];
    if (mode === 'random') {
      const rng = createRng(`arena-random:${bracket.id}:${seeker.index}`);
      const pool = [...others];
      for (let i = pool.length - 1; i > 0; i--) {
        const j = rng.int(0, i);
        [pool[i], pool[j]] = [pool[j]!, pool[i]!];
      }
      picks = pool.slice(0, size);
    } else {
      const res = pickOpponents(seeker, others, `fair:${bracket.id}:${seeker.index}`, size, config);
      picks = res.picks.map((p) => p.candidate);
      if (res.widened > 0) widened++;
    }
    lists++;
    listed += picks.length;
    if (picks.length === 0) empty++;
    for (const d of picks) {
      if (only && !only(seeker, d)) continue;
      if (tierGap(seeker, d) >= 3) extreme++;
      const p = winShare(
        seeker.fighter,
        d.fighter,
        seeds,
        `arena-fair:${bracket.id}:${seeker.index}:${d.index}`,
      ).share;
      const f = Math.max(p, 1 - p);
      fav.push(f);
      const strongerWins = seeker.power >= d.power === p >= 0.5;
      if (strongerWins) predicts++;
    }
  }
  return {
    pairs: fav.length,
    meanFavourite: fav.reduce((s, x) => s + x, 0) / Math.max(1, fav.length),
    p90Favourite: quantile(fav, 0.9),
    over90: fav.filter((x) => x >= 0.9).length / Math.max(1, fav.length),
    over95: fav.filter((x) => x >= 0.95).length / Math.max(1, fav.length),
    maxFavourite: fav.length ? Math.max(...fav) : 0,
    powerPredicts: predicts / Math.max(1, fav.length),
    meanListSize: listed / Math.max(1, lists),
    widened: widened / Math.max(1, lists),
    emptyLists: empty,
    extremePairs: extreme / Math.max(1, fav.length),
  };
}

/**
 * A simulated season: `rounds` times, every hero asks for a list and fights one opponent drawn
 * from it (a seeded pick), and both ratings move (`rateDuel`, factor 1, one day apart). Returns a
 * copy of the population with the ratings reached.
 */
export function settleRatings(
  bracket: PvpBracket,
  heroes: readonly ArenaHero[],
  rounds: number,
  config: MatchmakingConfig = DEFAULT_MATCHMAKING,
): ArenaHero[] {
  const state = heroes.map((h) => ({ ...h }));
  const ratings = new Map<string, { r: Rating; at: Date | null }>(
    state.map((h) => [h.accountId, { r: initialRating(), at: null }]),
  );
  const start = Date.UTC(2026, 0, 1);
  for (let round = 0; round < rounds; round++) {
    const now = new Date(start + round * 86_400_000);
    for (const seeker of state) {
      const others = state.filter((h) => h.accountId !== seeker.accountId);
      const res = pickOpponents(
        seeker,
        others,
        `settle:${bracket.id}:${round}:${seeker.index}`,
        5,
        config,
      );
      if (res.picks.length === 0) continue;
      const rng = createRng(`settle-pick:${bracket.id}:${round}:${seeker.index}`);
      const d = res.picks[rng.int(0, res.picks.length - 1)]!.candidate;
      const duel = simulateDuel({
        challenger: seeker.fighter,
        defender: d.fighter,
        seed: `settle-duel:${bracket.id}:${round}:${seeker.index}`,
      });
      const a = ratings.get(seeker.accountId)!;
      const b = ratings.get(d.accountId)!;
      const out = rateDuel({
        challenger: { rating: a.r, lastRatedAt: a.at },
        defender: { rating: b.r, lastRatedAt: b.at },
        outcome: duel.outcome,
        factor: 1,
        now,
      });
      ratings.set(seeker.accountId, { r: out.challenger.after, at: now });
      ratings.set(d.accountId, { r: out.defender.after, at: now });
      for (const h of [seeker, d]) {
        const r = ratings.get(h.accountId)!.r;
        h.rating = r.rating;
        h.deviation = r.deviation;
      }
    }
  }
  return state;
}
