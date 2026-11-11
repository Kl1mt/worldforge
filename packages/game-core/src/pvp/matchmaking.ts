import type { ClassId } from '../classes.js';
import type { EquippedItem } from '../activity/equipment.js';
import { createRng } from '../rng.js';
import { characterPower } from '../scoring/power.js';
import { awakenedEffectStrength } from '../items/awakening-state.js';
import { itemEffectInstances } from '../effects/resolve.js';
import { setBonusInstances } from '../items/sets.js';
import { findEffect } from '../effects/registry.js';
import { duelStrength } from './duel.js';

/**
 * Bracket Power's version (stored on a defence as `duel_defences.power_version`).
 * - 1 (ticket 6.1): 5.1's Character Power 1 at the bracket's reference level (kept at 1 when the
 *   board's Power moved to 2).
 * - 2 (ticket 6.5b): version 1 × the awakening factor (`awakeningMatchFactor`), so matchmaking
 *   sees an awakened kit (owner decision: awakening counts in duels). Equal to version 1 for every
 *   kit without an awakening.
 */
export const BRACKET_POWER_VERSION = 3;
// 3 (ticket B.5): in the brackets of `DUEL_POWER_BRACKETS` (30+), bracket Power is the hero's duel
//   strength (`duelPower`) instead of Character Power: Power is a PvE measure and barely separates
//   the top kits (90 %+ favourites 13.2 % in 30+, most of them within 1 % of each other on
//   Power). Every other bracket keeps version 2's value (docs/PVP.md "B.5").
/** The Character Power formula bracket Power evaluates (Power 1, ticket 6.1). */
export const BRACKET_POWER_FORMULA = 1;

/**
 * Ticket 6.5b: what one awakened effect a duel reads is worth to matchmaking, as a share of
 * bracket Power. Character Power barely sees an awakening (+0.1 % for a whole kit: it is a PvE
 * evaluation), while a duel does. Fitted with the population's own yardstick
 * (`tools/balance/awakening.ts match`): the duel log-odds per log bracket-Power gap on the arena
 * population, against a whole awakened +10 Void kit's duel share over itself plain. 20–29 measures
 * 0.22 % and 30+ 0.20 % per effect (a whole kit +0.7–1.4 %). See docs/PVP.md "6.5b".
 */
export const AWAKENING_MATCH_WEIGHT = 0.002;

/** Effect components a duel never reads (`pvpEffects` turns them off). */
const DUEL_OFF: ReadonlySet<string> = new Set(['bossSlayer', 'lifeOnKill', 'bloodrush']);

/** Whether a duel reads an effect for a class: a component it keeps, and the class may use it. */
function duelReads(effectId: string, classId: ClassId): boolean {
  const def = findEffect(effectId);
  if (!def || (def.classId !== undefined && def.classId !== classId)) return false;
  return def.components.some((c) => !DUEL_OFF.has(c.type));
}

/**
 * Awakened effects a kit brings into a duel: each item whose own effect is awakened, plus each
 * set bonus that is awakened (n awakened distinct pieces for a bonus of n), counting only effects
 * a duel reads for the class (not boss slayer, life on kill or bloodrush alone, not another
 * class's effect). 0 without awakening.
 */
export function awakenedEffectCount(equipment: readonly EquippedItem[], classId: ClassId): number {
  let n = 0;
  for (const item of equipment) {
    if (awakenedEffectStrength(item) <= 1) continue;
    const own = itemEffectInstances(item)[0];
    if (own && duelReads(own.effectId, classId)) n++;
  }
  if (equipment.some((i) => i.awakening && i.setId)) {
    n += setBonusInstances(equipment).filter(
      (b) => (b.strength ?? 1) > 1 && duelReads(b.effectId, classId),
    ).length;
  }
  return n;
}

/** The factor bracket Power 2 puts on Power for a kit's awakenings (1 without any). */
export function awakeningMatchFactor(
  equipment: readonly EquippedItem[],
  classId: ClassId,
  weight = AWAKENING_MATCH_WEIGHT,
): number {
  return 1 + weight * awakenedEffectCount(equipment, classId);
}
import type { PvpBracket, PvpFighterInput } from './normalise.js';

/**
 * Ticket B.5: the brackets whose bracket Power (version 3) is `duelPower`. Measured on the arena
 * population: in 30+ it takes 90 %+ favourites from 13.2 % to 3.2 % (95 %+ 6.5 % → 1.0 %); in
 * 10–19 and 20–29 Character Power ranks as well or better (tried there: 10–19 2.3 % → 6.0 %,
 * 20–29 after a season 3.7 % → 5.3 %), so they keep it.
 */
export const DUEL_POWER_BRACKETS: readonly string[] = Object.freeze(['30-plus']);
/** Duel Power of a hero exactly as strong as the bracket's reference kit. */
export const DUEL_POWER_SCALE = 1000;
/**
 * Duel Power = scale × e^(exponent × duel strength). Below 1 it compresses the measure, so the
 * Power steps (5 / 10 / 20 %) hold more accounts: at 1, a week of rated duels among the realistic
 * 30+ heroes counted only 41 % in full (repeat pairs; B.4: 45 %); at 0.6, 51 % (¼: 9 %, B.4 17 %)
 * with 90 %+ favourites at 3.2 % (1.8 % at 1). See docs/PVP.md "B.5".
 */
export const DUEL_POWER_EXPONENT = 0.6;

/**
 * Ticket B.5: a hero's **duel Power** in a bracket: `DUEL_POWER_SCALE` × e^(`DUEL_POWER_EXPONENT`
 * × `duelStrength`), so a relative gap of 6 % is about a 10 % edge in time to win over time to
 * lose against the bracket's reference heroes. It reads the duel's own normalisation (gear at
 * `keep`, effects at `effectKeep`, the class tuning, awakening), so no class scale or awakening
 * factor is needed on top. Deterministic, ≈ 0.2 ms.
 */
export function duelPower(fighter: PvpFighterInput, bracket: PvpBracket): number {
  return Math.round(
    DUEL_POWER_SCALE * Math.exp(DUEL_POWER_EXPONENT * duelStrength(fighter, bracket)),
  );
}

/** Whether a bracket's bracket Power (version 3) is duel Power. */
export const usesDuelPower = (bracketId: string) => DUEL_POWER_BRACKETS.includes(bracketId);
import { PAIR_FACTORS } from './integrity.js';
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

/**
 * 2 (ticket B.4, docs/PVP.md "Balance pass: competitive systems"): Power is compared relative to
 * the class (`classPowerScale`), and accounts not yet met this week come first (`freshPairsFirst`).
 * 3 (ticket B.4b): repeat pairs are never left out (their duels count ¼); only accounts met fewer
 * than `freshBelow` times this week count toward `minAccounts`, so the range still widens when
 * the fresh opponents run out, as it did when repeat pairs were removed.
 */
export const MATCHMAKING_VERSION = 4;
// 4 (ticket B.5): the config is per bracket (`matchmakingConfig`): in the duel-Power brackets the
//   class scale is its own (duel Power already reads the class). `pickOpponents` is unchanged, and the
//   offer's seed keeps version 3's prefix (`OFFER_SEED_VERSION`), so a list in a bracket where
//   nothing changed (1–29) is drawn exactly as before.

/** The version in the offer draw's seed: 3 since B.4b, kept by 4 (see above). */
const OFFER_SEED_VERSION = 3;

/**
 * A hero's **bracket Power**: 5.1's Character Power of its (checked) gear, evaluated at the
 * bracket's reference level, × its awakening factor since version 2; since version 3 (ticket
 * B.5) the hero's `duelPower` in the duel-Power brackets (30+). A duel fights every hero at that level (5.4: level does not count
 * inside a bracket), so the level part of Power says nothing about a duel; measured, ranging on raw
 * Power left 4 % of offered pairs in 10–19 at a 95 %+ favourite against 0.5 % with bracket Power
 * (docs/PVP.md "Matchmaking"). Its version is `BRACKET_POWER_VERSION`: Power 1 since ticket 6.1
 * (the board's Power 2 adds two trials; matchmaking keeps the measure it was fitted on).
 */
export function bracketPower(
  fighter: PvpFighterInput,
  bracket: PvpBracket,
  version: 1 | 2 | 3 = BRACKET_POWER_VERSION,
  weight = AWAKENING_MATCH_WEIGHT,
) {
  if (version === 3 && usesDuelPower(bracket.id)) return duelPower(fighter, bracket);
  const power = characterPower(
    {
      classId: fighter.classId,
      level: bracket.referenceLevel,
      equipment: fighter.equipment,
    },
    BRACKET_POWER_FORMULA,
  ).power;
  if (version === 1) return power;
  const factor = awakeningMatchFactor(fighter.equipment, fighter.classId, weight);
  return factor === 1 ? power : Math.round(power * factor);
}

export interface MatchmakingConfig {
  /** Relative Power gaps tried in turn (0.1 = within 10 % of the stronger side). */
  powerSteps: readonly number[];
  /** Power below this counts as this (a naked or level-10 hero's Power is small and noisy). */
  powerFloor: number;
  /** The range widens while fewer accounts than this are in it. */
  minAccounts: number;
  /** Closest-rated accounts kept before the random draw, as a multiple of the list size. */
  poolFactor: number;
  /**
   * Ticket B.4: keep accounts the seeker has met fewer times in the repeat-pair window first
   * (`MatchCandidate.recentDuels`), then the closest in rating. Without it a hero meets the same
   * handful of closest-rated players again and again: in a realistic 500-player season only 30 %
   * of rated duels counted in full (39 % for a quarter); with it 83 % (3 %).
   */
  freshPairsFirst: boolean;
  /**
   * Ticket B.4b: with `freshPairsFirst`, an account counts toward `minAccounts` only while the
   * seeker has met it fewer than this many times in the window (from then on its duels count at
   * the ¼ floor). Measured without it, in a 100-player town the range stayed narrow, filled with
   * repeat pairs, and the full-value duels fell by a third.
   */
  freshBelow: number;
  /**
   * Ticket B.4: a class's bracket Power is divided by this before it is compared (`matchPower`).
   * Power is a PvE measure, and the same Power does not mean the same duel strength in every
   * class: on a realistic season the warlock won 60 % of the Power-matched pairs it was offered
   * and the warrior 41 % (mage over warrior 66 %, warlock over warrior 65 %). Fitted on those
   * pairs (both rated brackets with enough heroes gave the same values): 47–53 % per class.
   */
  classPowerScale: Readonly<Record<ClassId, number>>;
}

export const DEFAULT_MATCHMAKING: Readonly<MatchmakingConfig> = Object.freeze({
  powerSteps: [0.05, 0.1, 0.2],
  powerFloor: 400,
  minAccounts: 5,
  poolFactor: 2,
  freshPairsFirst: true,
  freshBelow: PAIR_FACTORS.length,
  classPowerScale: { warrior: 1.035, mage: 1, hunter: 1, warlock: 0.967 },
});

/**
 * Ticket B.5 (matchmaking 4): the config for a bracket. The duel-Power brackets get their own class
 * scale (`DUEL_POWER_MATCHMAKING`); the others are `DEFAULT_MATCHMAKING`.
 */
export function matchmakingConfig(bracketId: string): Readonly<MatchmakingConfig> {
  return usesDuelPower(bracketId) ? DUEL_POWER_MATCHMAKING : DEFAULT_MATCHMAKING;
}

/**
 * Matchmaking in the duel-Power brackets. Duel Power reads the class tuning, so B.4's Power scale
 * (warrior ÷ 1.035, warlock ÷ 0.967) would count the class twice (on the synthetic population it
 * took 90 %+ favourites from 3 % back to 6 %). What remains is fitted on the realistic heroes
 * (`realistic-arena.json`, offered pairs): duel Power, measured against reference heroes without
 * effects, rates the warrior a little high against real opponents (41 % over offered pairs with
 * no scale); warrior ÷ 1.02 puts every class at 44.5–53.4 %.
 */
export const DUEL_POWER_MATCHMAKING: Readonly<MatchmakingConfig> = Object.freeze({
  ...DEFAULT_MATCHMAKING,
  classPowerScale: Object.freeze({ warrior: 1.02, mage: 1, hunter: 1, warlock: 1 }),
});

/**
 * The Power matchmaking compares (ticket B.4): bracket Power ÷ the class's `classPowerScale`. A
 * hero without a class (a caller from before B.4) is compared on its Power as it is.
 */
export function matchPower(
  hero: { power: number; classId?: ClassId },
  config: MatchmakingConfig = DEFAULT_MATCHMAKING,
): number {
  const scale = hero.classId ? (config.classPowerScale[hero.classId] ?? 1) : 1;
  return hero.power / scale;
}

export interface MatchSeeker extends Pick<Rating, 'rating' | 'deviation'> {
  power: number;
  /** Ticket B.4: the hero's class, for `classPowerScale`. */
  classId?: ClassId;
}

export interface MatchCandidate extends Pick<Rating, 'rating' | 'deviation'> {
  defenceId: string;
  accountId: string;
  power: number;
  /** Ticket B.4: the defence's class, for `classPowerScale`. */
  classId?: ClassId;
  /**
   * Ticket B.4: rated duels between the seeker's account and this one in the repeat-pair window
   * (`PAIR_WINDOW_MS`; the server counts them under 5.6's rules). Absent = 0.
   */
  recentDuels?: number;
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
  const own = matchPower(seeker, config);
  const gaps = candidates.map((c) => ({ c, gap: powerGap(own, matchPower(c, config), config) }));
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
    const counted = config.freshPairsFirst
      ? new Set(
          inRange
            .filter((x) => (x.c.recentDuels ?? 0) < config.freshBelow)
            .map((x) => x.c.accountId),
        ).size
      : accounts;
    if (counted >= config.minAccounts) break;
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
  const met = (c: C) => (config.freshPairsFirst ? (c.recentDuels ?? 0) : 0);
  const closest = [...byAccount.values()]
    .sort(
      (a, b) =>
        met(a.c) - met(b.c) ||
        ratingGap(a.c) - ratingGap(b.c) ||
        a.gap - b.gap ||
        (a.c.defenceId < b.c.defenceId ? -1 : a.c.defenceId > b.c.defenceId ? 1 : 0),
    )
    .slice(0, size * config.poolFactor);
  // A seeded Fisher–Yates draw of `size` among the closest.
  const rng = createRng(`arena-offer:v${OFFER_SEED_VERSION}:${seed}`);
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
