import { createRng } from '../rng.js';
import { characterPower, POWER_FORMULA_VERSION } from '../scoring/power.js';
import type { PvpBracket, PvpFighterInput } from './normalise.js';
import { expectedScore, type Rating } from './rating.js';

/**
 * Arena matchmaking (ticket 5.6, docs/PVP.md "Matchmaking"): which defences the server offers a
 * hero for rated duels. Eligibility (bracket, level, own, blocked, sanctioned, friends,
 * guildmates, shared signals, pairs at a factor of 0) is decided by the server before; this picks
 * among the eligible ones, by **Character Power** first and **rating** second:
 *
 * 1. **Power range.** Only defences whose bracket Power (`bracketPower`: 5.1's Character Power at
 *    the bracket's reference level) is within `powerSteps[0]` (relative to the larger of the two) are considered. If fewer than `minAccounts` accounts are in range,
 *    the range widens one step at a time, up to the last step and never beyond: a pair further
 *    apart is never offered (the 5.4 risk: two full gear steps apart, gear decides).
 * 2. **Rating.** In range, the `size × poolFactor` accounts closest in rating are kept (one
 *    defence per account: its closest), and `size` of them are drawn at random from the seed (so
 *    a list cannot be predicted or farmed for one favourite).
 *
 * Pure and deterministic for a seed (the server draws the seed from `crypto`).
 */

export const MATCHMAKING_VERSION = 1;

/**
 * A hero's **bracket Power**: 5.1's Character Power of its (checked) gear, evaluated at the
 * bracket's reference level. A duel fights every hero at that level (5.4: level does not count
 * inside a bracket), so the level part of Power says nothing about a duel; measured, ranging on raw
 * Power left 4 % of offered pairs in 10–19 at a 95 %+ favourite against 0.5 % with bracket Power
 * (docs/PVP.md "Matchmaking"). Its version follows Power's (`BRACKET_POWER_VERSION`).
 */
export function bracketPower(
  fighter: PvpFighterInput,
  bracket: Pick<PvpBracket, 'referenceLevel'>,
) {
  return characterPower({
    classId: fighter.classId,
    level: bracket.referenceLevel,
    equipment: fighter.equipment,
  }).power;
}
export const BRACKET_POWER_VERSION = POWER_FORMULA_VERSION;

export interface MatchmakingConfig {
  /** Relative Power gaps tried in turn (0.1 = within 10 % of the stronger side). */
  powerSteps: readonly number[];
  /** Power below this counts as this (a naked or level-10 hero's Power is small and noisy). */
  powerFloor: number;
  /** The range widens while fewer accounts than this are in it. */
  minAccounts: number;
  /** Closest-rated accounts kept before the random draw, as a multiple of the list size. */
  poolFactor: number;
}

export const DEFAULT_MATCHMAKING: Readonly<MatchmakingConfig> = Object.freeze({
  powerSteps: [0.05, 0.1, 0.2],
  powerFloor: 400,
  minAccounts: 5,
  poolFactor: 2,
});

export interface MatchSeeker extends Pick<Rating, 'rating' | 'deviation'> {
  power: number;
}

export interface MatchCandidate extends Pick<Rating, 'rating' | 'deviation'> {
  defenceId: string;
  accountId: string;
  power: number;
}

export interface MatchPick<C extends MatchCandidate = MatchCandidate> {
  candidate: C;
  /** The seeker's expected score against it (Glicko E with both deviations). */
  expected: number;
  /** The relative Power gap (0 = equal). */
  powerGap: number;
}

export interface MatchResult<C extends MatchCandidate = MatchCandidate> {
  picks: MatchPick<C>[];
  /** The Power range the list came from (the widest step tried), or null when nothing was in any. */
  powerStep: number | null;
  /** How many steps the range widened (0 = the first range sufficed). */
  widened: number;
}

/** The relative Power gap between two heroes: |a − b| ÷ the larger (at least the floor). */
export function powerGap(
  a: number,
  b: number,
  config: MatchmakingConfig = DEFAULT_MATCHMAKING,
): number {
  const hi = Math.max(a, b, config.powerFloor);
  return Math.abs(a - b) / hi;
}

/** Plain words for an offered opponent ("an even match"). */
export type MatchOdds = 'favoured' | 'even' | 'underdog';
export const matchOdds = (expected: number): MatchOdds =>
  expected >= 0.6 ? 'favoured' : expected <= 0.4 ? 'underdog' : 'even';

export function pickOpponents<C extends MatchCandidate>(
  seeker: MatchSeeker,
  candidates: readonly C[],
  seed: string,
  size: number,
  config: MatchmakingConfig = DEFAULT_MATCHMAKING,
): MatchResult<C> {
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`List size ${size}`);
  const gaps = candidates.map((c) => ({ c, gap: powerGap(seeker.power, c.power, config) }));
  let pool: typeof gaps = [];
  let step: number | null = null;
  let widened = 0;
  for (const [i, s] of config.powerSteps.entries()) {
    const inRange = gaps.filter((x) => x.gap <= s);
    const accounts = new Set(inRange.map((x) => x.c.accountId)).size;
    if (accounts === 0 && i < config.powerSteps.length - 1) continue;
    pool = inRange;
    step = s;
    widened = i;
    if (accounts >= config.minAccounts) break;
  }
  if (pool.length === 0) return { picks: [], powerStep: null, widened };
  // One defence per account: the closest in rating (then in Power, then the id).
  const ratingGap = (c: C) => Math.abs(c.rating - seeker.rating);
  const byAccount = new Map<string, (typeof gaps)[number]>();
  for (const x of pool) {
    const prev = byAccount.get(x.c.accountId);
    if (
      !prev ||
      ratingGap(x.c) < ratingGap(prev.c) ||
      (ratingGap(x.c) === ratingGap(prev.c) &&
        (x.gap < prev.gap || (x.gap === prev.gap && x.c.defenceId < prev.c.defenceId)))
    )
      byAccount.set(x.c.accountId, x);
  }
  const closest = [...byAccount.values()]
    .sort(
      (a, b) =>
        ratingGap(a.c) - ratingGap(b.c) ||
        a.gap - b.gap ||
        (a.c.defenceId < b.c.defenceId ? -1 : a.c.defenceId > b.c.defenceId ? 1 : 0),
    )
    .slice(0, size * config.poolFactor);
  // A seeded Fisher–Yates draw of `size` among the closest.
  const rng = createRng(`arena-offer:v${MATCHMAKING_VERSION}:${seed}`);
  const drawn = [...closest];
  for (let i = drawn.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [drawn[i], drawn[j]] = [drawn[j]!, drawn[i]!];
  }
  return {
    picks: drawn.slice(0, size).map((x) => ({
      candidate: x.c,
      expected: expectedScore(seeker, x.c),
      powerGap: x.gap,
    })),
    powerStep: step,
    widened,
  };
}
