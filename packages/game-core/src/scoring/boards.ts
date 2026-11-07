import type { ScoreMetric } from './types.js';

/**
 * Leaderboards (ticket 5.2, docs/LEADERBOARDS.md "Boards"): what a board can be filtered by and
 * how its entries are ordered. The scores themselves are 5.1's (`computeScore`).
 */

/** Board names, in the order the board page lists them. */
export const BOARD_METRICS: readonly { id: ScoreMetric; name: string; unit: string }[] = [
  { id: 'level', name: 'Character Level', unit: 'level' },
  { id: 'gearScore', name: 'Gear Score', unit: 'points' },
  { id: 'power', name: 'Character Power', unit: 'points' },
  { id: 'pveProgress', name: 'PvE Progress', unit: 'milestones' },
];

/**
 * The time a board covers: all time, or one season (ticket 5.3: `scope=season` with a season
 * number; the season boards rank each hero's score at the season's end, for heroes whose score on
 * that board rose during the season; docs/LEADERBOARDS.md "Seasons").
 */
export const BOARD_SCOPES = ['allTime', 'season'] as const;
export type BoardScope = (typeof BOARD_SCOPES)[number];

export interface LevelBracket {
  id: string;
  label: string;
  min: number;
  /** Inclusive; null = no upper bound. */
  max: number | null;
}

/**
 * Level brackets for the board filter, following the world's level bands: the fields and the
 * Crowwood (1–9), the Burial Grounds to the Abbey (10–19), the Abbey's depths and the Ashen Pass
 * (20–29), and past the top content (30+). Data, so a later phase can add brackets.
 */
export const LEVEL_BRACKETS: readonly LevelBracket[] = [
  { id: '1-9', label: 'Levels 1–9', min: 1, max: 9 },
  { id: '10-19', label: 'Levels 10–19', min: 10, max: 19 },
  { id: '20-29', label: 'Levels 20–29', min: 20, max: 29 },
  { id: '30-plus', label: 'Level 30 and above', min: 30, max: null },
];

export const LEVEL_BRACKET_IDS = LEVEL_BRACKETS.map((b) => b.id);

export function findLevelBracket(id: string): LevelBracket | undefined {
  return LEVEL_BRACKETS.find((b) => b.id === id);
}

export function levelBracketOf(level: number): LevelBracket {
  return LEVEL_BRACKETS.find((b) => level >= b.min && (b.max === null || level <= b.max))!;
}

/** What a board entry is ranked by. */
export interface RankedEntry {
  sortKey: readonly number[];
  /** When the hero reached this `sortKey` (ISO string or epoch ms). */
  achievedAt: string | number | Date;
  /** The last resort for a total order (the server uses the hero's id). */
  id: string;
}

/** Lexicographic, higher first; a shorter key that is a prefix of a longer one ranks lower. */
export function compareSortKeys(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return b[i]! - a[i]!;
  return b.length - a.length;
}

/**
 * The board order (ticket 5.2): the metric's `sortKey` (higher first, its own tie-breakers
 * included), then whoever reached it first, then the id. Negative = `a` ranks above `b`. The
 * server's SQL order must agree (tested).
 */
export function compareBoardEntries(a: RankedEntry, b: RankedEntry): number {
  const byKey = compareSortKeys(a.sortKey, b.sortKey);
  if (byKey !== 0) return byKey;
  const ta = new Date(a.achievedAt).getTime();
  const tb = new Date(b.achievedAt).getTime();
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
