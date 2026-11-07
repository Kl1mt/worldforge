/**
 * Leaderboard scores (ticket 5.1, docs/LEADERBOARDS.md). Every score is computed by a versioned
 * game-core formula over server state; nothing a client sends is ever a score.
 */

export const SCORE_METRICS = ['level', 'gearScore', 'power', 'pveProgress'] as const;
export type ScoreMetric = (typeof SCORE_METRICS)[number];

/**
 * The formula version of each metric. Bump a metric's version whenever its value can change for
 * the same inputs (a weight, a reference foe, a milestone, or a combat rule Power runs through):
 * 5.2 stores `(metric, version, inputs, value)` and recomputes stored values of an older version.
 * The pinned values in `scoring.test.ts` fail when a number moves without a bump.
 */
export const FORMULA_VERSIONS: Readonly<Record<ScoreMetric, number>> = {
  level: 1,
  gearScore: 1,
  power: 1,
  pveProgress: 1,
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
