/**
 * The arena rating (ticket 5.6, docs/PVP.md "Rating"): Glicko-2 (Glickman, "Example of the
 * Glicko-2 system", 2012), one rating per hero per season. Pure: every function takes the clock it
 * needs, nothing reads ambient state.
 *
 * **Rating periods in async play.** Glicko-2 updates a batch of games at the end of a rating
 * period. Duels here are asynchronous and the result must show at once, so every rated duel is a
 * rating period of one game for each of its two heroes (`rateGames` with one game), and time
 * without duels counts as empty periods of `RATING_PERIOD_MS` (one day): before a duel, each whole
 * idle day grows the deviation as Glicko-2's "did not compete" step does (φ² + σ² per period), up
 * to the starting deviation. `rateGames` also takes many games at once (the paper's own example,
 * the reference test), so a batch mode stays possible.
 *
 * **Both sides move.** The challenger plays the game it chose; the defender plays it from its side
 * (a challenger win is a defence loss), against the other's rating *before* the duel. A defence
 * loss counts like any loss: the arena only offers defences near the challenger's rating and power
 * (`matchmaking.ts`), so a loss there costs about what a win against it gains.
 *
 * **Diminishing returns** (`ratingFactor`, win-trading): the change of rating, deviation and
 * volatility is scaled by a factor that falls with each rated duel the same two accounts fought in
 * the window; at 0 the duel counts for nothing.
 */

/** Bump when a rating can end differently for the same games (a constant, the maths, a factor). */
export const ARENA_RATING_VERSION = 1;

/** Glicko-2's scale factor between the Glicko scale and its internal one (400 / ln 10). */
export const GLICKO2_SCALE = 173.7178;

export interface ArenaRatingConfig {
  /** A new hero's rating (Glicko's 1500). */
  initialRating: number;
  /** A new hero's rating deviation (350: "we know nothing yet"). */
  initialDeviation: number;
  /** A new hero's volatility (Glickman's suggested 0.06). */
  initialVolatility: number;
  /** τ: how much volatility may change (Glickman: 0.3–1.2; 0.5 is his example). */
  tau: number;
  /** Convergence tolerance of the volatility iteration (Glickman: 0.000001). */
  epsilon: number;
  /** One empty rating period (idle time grows the deviation once per whole period). */
  periodMs: number;
  /** The deviation never exceeds this (the starting deviation). */
  maxDeviation: number;
  /** Below this the deviation does not fall (keeps a settled rating able to move). */
  minDeviation: number;
}

export const DEFAULT_RATING_CONFIG: Readonly<ArenaRatingConfig> = Object.freeze({
  initialRating: 1500,
  initialDeviation: 350,
  initialVolatility: 0.06,
  tau: 0.5,
  epsilon: 0.000001,
  periodMs: 24 * 60 * 60 * 1000,
  maxDeviation: 350,
  minDeviation: 30,
});

export const RATING_PERIOD_MS = DEFAULT_RATING_CONFIG.periodMs;

/** A hero's rating on the Glicko scale (rating ~1500, deviation 30–350). */
export interface Rating {
  rating: number;
  deviation: number;
  volatility: number;
}

export const initialRating = (config: ArenaRatingConfig = DEFAULT_RATING_CONFIG): Rating => ({
  rating: config.initialRating,
  deviation: config.initialDeviation,
  volatility: config.initialVolatility,
});

/** One game of a rating period, from the rated hero's side. */
export interface RatedGame {
  opponent: Pick<Rating, 'rating' | 'deviation'>;
  /** 1 a win, 0.5 a draw, 0 a loss. */
  score: number;
}

const g = (phi: number) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const expectation = (mu: number, muJ: number, phiJ: number) =>
  1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));

/**
 * The expected score of `a` against `b` (its win chance, a draw counting half), with both
 * deviations: Glicko's E with the combined uncertainty √(φa² + φb²).
 */
export function expectedScore(
  a: Pick<Rating, 'rating' | 'deviation'>,
  b: Pick<Rating, 'rating' | 'deviation'>,
): number {
  const phi = Math.hypot(a.deviation, b.deviation) / GLICKO2_SCALE;
  return expectation((a.rating - 1500) / GLICKO2_SCALE, (b.rating - 1500) / GLICKO2_SCALE, phi);
}

/** The volatility step (Glickman 2012, step 5: the Illinois algorithm). */
function newVolatility(
  sigma: number,
  phi: number,
  v: number,
  delta: number,
  config: ArenaRatingConfig,
): number {
  const a = Math.log(sigma * sigma);
  const tau2 = config.tau * config.tau;
  const f = (x: number) => {
    const ex = Math.exp(x);
    const d = phi * phi + v + ex;
    return (ex * (delta * delta - phi * phi - v - ex)) / (2 * d * d) - (x - a) / tau2;
  };
  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * config.tau) < 0) k += 1;
    B = a - k * config.tau;
  }
  let fA = f(A);
  let fB = f(B);
  for (let i = 0; i < 100 && Math.abs(B - A) > config.epsilon; i++) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA /= 2;
    }
    B = C;
    fB = fC;
  }
  return Math.exp(A / 2);
}

/**
 * One Glicko-2 rating period (steps 2–8 of the paper). With no games, only the deviation grows
 * (step 6 alone). The deviation stays within `[minDeviation, maxDeviation]` after the update.
 */
export function rateGames(
  player: Rating,
  games: readonly RatedGame[],
  config: ArenaRatingConfig = DEFAULT_RATING_CONFIG,
): Rating {
  const mu = (player.rating - 1500) / GLICKO2_SCALE;
  const phi = player.deviation / GLICKO2_SCALE;
  const sigma = player.volatility;
  if (games.length === 0) {
    return {
      rating: player.rating,
      deviation: clampDeviation(Math.sqrt(phi * phi + sigma * sigma) * GLICKO2_SCALE, config),
      volatility: sigma,
    };
  }
  let vInv = 0;
  let sum = 0;
  for (const game of games) {
    if (!(game.score === 0 || game.score === 0.5 || game.score === 1))
      throw new RangeError(`A game scores 0, 0.5 or 1, not ${game.score}`);
    const muJ = (game.opponent.rating - 1500) / GLICKO2_SCALE;
    const phiJ = game.opponent.deviation / GLICKO2_SCALE;
    const gJ = g(phiJ);
    const e = expectation(mu, muJ, phiJ);
    vInv += gJ * gJ * e * (1 - e);
    sum += gJ * (game.score - e);
  }
  const v = 1 / vInv;
  const delta = v * sum;
  const sigmaNew = newVolatility(sigma, phi, v, delta, config);
  const phiStar = Math.sqrt(phi * phi + sigmaNew * sigmaNew);
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muNew = mu + phiNew * phiNew * sum;
  return {
    rating: muNew * GLICKO2_SCALE + 1500,
    deviation: clampDeviation(phiNew * GLICKO2_SCALE, config),
    volatility: sigmaNew,
  };
}

function clampDeviation(rd: number, config: ArenaRatingConfig): number {
  return Math.min(config.maxDeviation, Math.max(config.minDeviation, rd));
}

/**
 * Idle time before a duel: each whole empty rating period since the hero's last rated duel grows
 * the deviation (φ² + σ² per period), never above `maxDeviation`. A clock that went backwards
 * counts as no time.
 */
export function ageRating(
  r: Rating,
  lastRatedAt: Date | null,
  now: Date,
  config: ArenaRatingConfig = DEFAULT_RATING_CONFIG,
): Rating {
  if (!lastRatedAt) return r;
  const periods = Math.floor(Math.max(0, now.getTime() - lastRatedAt.getTime()) / config.periodMs);
  if (periods <= 0) return r;
  const phi = r.deviation / GLICKO2_SCALE;
  const grown = Math.sqrt(phi * phi + periods * r.volatility * r.volatility) * GLICKO2_SCALE;
  return { ...r, deviation: Math.min(config.maxDeviation, Math.max(r.deviation, grown)) };
}

/** What one rated duel does to one side. */
export interface RatingChange {
  before: Rating;
  after: Rating;
  /** The diminishing-returns factor applied (1 = in full, 0 = counted for nothing). */
  factor: number;
}

export interface DuelRatingInput {
  challenger: { rating: Rating; lastRatedAt: Date | null };
  defender: { rating: Rating; lastRatedAt: Date | null };
  outcome: 'challenger' | 'defender' | 'draw';
  /** `ratingFactor` of this pair (1 = full). */
  factor: number;
  now: Date;
}

/**
 * Both heroes' new ratings after a rated duel. Each side is first aged to `now`, then rated on the
 * one game against the other's aged rating (both from before the duel), then the change is scaled
 * by `factor` (rating, deviation and volatility alike, so a factor of 0 changes nothing).
 */
export function rateDuel(
  input: DuelRatingInput,
  config: ArenaRatingConfig = DEFAULT_RATING_CONFIG,
): { challenger: RatingChange; defender: RatingChange } {
  if (!(input.factor >= 0 && input.factor <= 1))
    throw new RangeError(`A rating factor lies in [0, 1], not ${input.factor}`);
  const c = ageRating(input.challenger.rating, input.challenger.lastRatedAt, input.now, config);
  const d = ageRating(input.defender.rating, input.defender.lastRatedAt, input.now, config);
  const cScore = input.outcome === 'challenger' ? 1 : input.outcome === 'draw' ? 0.5 : 0;
  const side = (self: Rating, other: Rating, score: number): RatingChange => {
    const full = rateGames(self, [{ opponent: other, score }], config);
    const k = input.factor;
    return {
      before: self,
      after: {
        rating: self.rating + k * (full.rating - self.rating),
        deviation: self.deviation + k * (full.deviation - self.deviation),
        volatility: self.volatility + k * (full.volatility - self.volatility),
      },
      factor: k,
    };
  };
  return { challenger: side(c, d, cScore), defender: side(d, c, 1 - cScore) };
}

/** Rated games before a hero leaves "provisional" and is ranked on the ladder. */
export const PROVISIONAL_GAMES = 10;
/** At or below this deviation a rating reads "settled". */
export const SETTLED_DEVIATION = 100;

export type RatingStanding = 'provisional' | 'settling' | 'settled';

/** The rating's certainty in plain words (the ladder and the arena screen). */
export function ratingStanding(r: Pick<Rating, 'deviation'>, games: number): RatingStanding {
  if (games < PROVISIONAL_GAMES) return 'provisional';
  return r.deviation <= SETTLED_DEVIATION ? 'settled' : 'settling';
}

/** "1,520, likely 1,380–1,660": the rating and its 95 % range (± 2 deviations), rounded to 10. */
export function ratingRange(r: Pick<Rating, 'rating' | 'deviation'>): {
  shown: number;
  low: number;
  high: number;
} {
  const round10 = (x: number) => Math.round(x / 10) * 10;
  return {
    shown: Math.round(r.rating),
    low: Math.max(0, round10(r.rating - 2 * r.deviation)),
    high: round10(r.rating + 2 * r.deviation),
  };
}

/**
 * The season reset (soft): a hero's first rating of a season starts from its last rating of an
 * earlier season pulled halfway back to 1500, with a wide deviation (it has to prove itself
 * again); a hero new to the arena starts at 1500 / 350 / 0.06.
 */
export const SEASON_CARRY = 0.5;
export const SEASON_START_DEVIATION = 250;

export function seasonStartRating(
  previous: Rating | null,
  config: ArenaRatingConfig = DEFAULT_RATING_CONFIG,
): Rating {
  if (!previous) return initialRating(config);
  return {
    rating: config.initialRating + SEASON_CARRY * (previous.rating - config.initialRating),
    deviation: Math.max(SEASON_START_DEVIATION, Math.min(config.maxDeviation, previous.deviation)),
    volatility: config.initialVolatility,
  };
}

/** The ladder's order key: the rating (higher first), stored as an integer (× 100). */
export const ladderKey = (r: Pick<Rating, 'rating'>) => Math.round(r.rating * 100);
