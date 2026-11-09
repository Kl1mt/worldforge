/**
 * Leaderboard scores (ticket 5.1, docs/LEADERBOARDS.md). Every score is computed by a versioned
 * game-core formula over server state; nothing a client sends is ever a score.
 */

export const SCORE_METRICS = ['level', 'gearScore', 'power', 'pveProgress'] as const;
export type ScoreMetric = (typeof SCORE_METRICS)[number];

/**
 * The formula version of each metric. Bump a metric's version whenever its value can change for
 * the same inputs (a weight, a reference foe, a milestone, a tie-breaker, or a combat rule Power runs through):
 * 5.2 stores `(metric, version, inputs, value)` and recomputes stored values of an older version.
 * The pinned values in `scoring.test.ts` fail when a number moves without a bump.
 */
export type FormulaVersions = Readonly<Record<ScoreMetric, number>>;

export const FORMULA_VERSIONS: FormulaVersions = {
  level: 1,
  /** 2 (ticket B.4): equal scores are ordered by magic quality (`sortKey` [total, quality]). */
  gearScore: 2,
  /** 2 (ticket 6.1): trials at levels 30 and 34 added (22 trials). */
  power: 2,
  /** 2 (ticket 6.1): the Cinderwastes' three milestones added (13). */
  pveProgress: 2,
};

/**
 * Ticket 6.1: the versions in force when formula switches became scheduled. A newer version in
 * `FORMULA_VERSIONS` takes over only between seasons (`formulaVersionsAt`, `scoring/schedule.ts`).
 */
export const FORMULA_BASELINE: FormulaVersions = {
  level: 1,
  gearScore: 2,
  power: 1,
  pveProgress: 1,
};

/** Every version that can still be computed, per metric (stored rows of any of them recompute). */
export const SUPPORTED_FORMULA_VERSIONS: Readonly<Record<ScoreMetric, readonly number[]>> = {
  level: [1],
  gearScore: [2],
  power: [1, 2],
  pveProgress: [1, 2],
};

/** One line of a score's breakdown: what counted, how much, and why (or why not). */
export interface ScoreLine {
  /** Stable id within the score (a slot, a trial level, a milestone id). */
  id: string;
  label: string;
  /** Short plain-words detail, e.g. `Item level 22 · Legendary · +5 · Void`. */
  detail: string;
  /** Points this line adds (0 when it does not count). */
  points: number;
  counted: boolean;
  /** Why a line does not count (`empty`, `invalid_item`, `not_reached`, …). */
  reason?: string;
}

export interface Score {
  metric: ScoreMetric;
  formulaVersion: number;
  /** The headline value (what a board shows). */
  value: number;
  /**
   * Compared lexicographically, higher first: `value` and then the metric's tie-breakers (5.2
   * adds "reached first" after these). Always integers.
   */
  sortKey: number[];
  /** One sentence: what this metric measures. */
  summary: string;
  lines: ScoreLine[];
}
