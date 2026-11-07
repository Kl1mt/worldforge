import { SCORE_METRICS, type ScoreMetric } from './types.js';

/**
 * Prestige rewards (ticket 5.3, docs/LEADERBOARDS.md "Prestige rewards"): titles and profile
 * frames awarded at a season's end by placement on each board. Cosmetic only: nothing here is read
 * by combat, loot, the economy or a score (GDD §10.2, §13.3; tested in `prestige.test.ts`).
 *
 * Asset names are fixed (ticket A.10 draws them): one frame per tier, one title badge per board.
 */

export const PRESTIGE_TIER_IDS = ['champion', 'exalted', 'renowned', 'veteran'] as const;
export type PrestigeTier = (typeof PRESTIGE_TIER_IDS)[number];

export interface PrestigeTierDef {
  id: PrestigeTier;
  name: string;
  /** The lowest place that still earns this tier (inclusive); null = any place on the board. */
  maxRank: number | null;
  /** The hero's level at season end must be at least this (the minimum activity). */
  minLevel: number;
  /** The profile frame's asset name (A.10). */
  frameAsset: string;
  /** Plain words for players. */
  rule: string;
}

/** The minimum activity for Veteran: the hero is level 10 or higher at season end. */
export const VETERAN_MIN_LEVEL = 10;

/** Best first. A hero earns the best tier its place allows. */
export const PRESTIGE_TIERS: readonly PrestigeTierDef[] = [
  {
    id: 'champion',
    name: 'Champion',
    maxRank: 1,
    minLevel: 1,
    frameAsset: 'season-frame-champion',
    rule: 'First place on a season board.',
  },
  {
    id: 'exalted',
    name: 'Exalted',
    maxRank: 10,
    minLevel: 1,
    frameAsset: 'season-frame-exalted',
    rule: 'Among the top 10 of a season board.',
  },
  {
    id: 'renowned',
    name: 'Renowned',
    maxRank: 100,
    minLevel: 1,
    frameAsset: 'season-frame-renowned',
    rule: 'Among the top 100 of a season board.',
  },
  {
    id: 'veteran',
    name: 'Veteran',
    maxRank: null,
    minLevel: VETERAN_MIN_LEVEL,
    frameAsset: 'season-frame-veteran',
    rule: `On a season board at its end, with a hero of level ${VETERAN_MIN_LEVEL} or higher.`,
  },
];

export const findPrestigeTier = (id: string): PrestigeTierDef | undefined =>
  PRESTIGE_TIERS.find((t) => t.id === id);

export const isPrestigeTier = (v: unknown): v is PrestigeTier =>
  typeof v === 'string' && (PRESTIGE_TIER_IDS as readonly string[]).includes(v);

/** Lower is better (0 = champion). */
export const tierOrder = (t: PrestigeTier) => PRESTIGE_TIER_IDS.indexOf(t);

/** The tier a place earns, or null (no place, or a Veteran place below the minimum level). */
export function prestigeTierFor(rank: number, level: number): PrestigeTier | null {
  if (!Number.isInteger(rank) || rank < 1) return null;
  for (const t of PRESTIGE_TIERS) {
    if ((t.maxRank === null || rank <= t.maxRank) && level >= t.minLevel) return t.id;
  }
  return null;
}

export interface TitleDef {
  metric: ScoreMetric;
  /** The noun of the title ("Exalted Pathfinder"). */
  noun: string;
  /** The badge's asset name (A.10). */
  badgeAsset: string;
}

/** One title per board; the tier names its rank. */
export const SEASON_TITLES: Readonly<Record<ScoreMetric, TitleDef>> = {
  level: { metric: 'level', noun: 'Climber', badgeAsset: 'title-badge-level' },
  gearScore: { metric: 'gearScore', noun: 'Armsbearer', badgeAsset: 'title-badge-gear-score' },
  power: { metric: 'power', noun: 'Blade', badgeAsset: 'title-badge-power' },
  pveProgress: {
    metric: 'pveProgress',
    noun: 'Pathfinder',
    badgeAsset: 'title-badge-pve-progress',
  },
};

/** "Exalted Pathfinder". */
export function prestigeTitle(metric: ScoreMetric, tier: PrestigeTier): string {
  return `${findPrestigeTier(tier)!.name} ${SEASON_TITLES[metric].noun}`;
}

/** One hero's final place on one season board (the archive row, as the award reads it). */
export interface FinalStanding {
  metric: ScoreMetric;
  rank: number;
  accountId: string;
  characterId: string;
  level: number;
}

/** What an account earns on one board in one season: the best tier any of its heroes reached. */
export interface PrestigeAward {
  accountId: string;
  metric: ScoreMetric;
  tier: PrestigeTier;
  /** The place that earned it (the best place for that tier). */
  rank: number;
  characterId: string;
}

/**
 * The awards of a season, from its final standings: per account and board, the best tier among
 * the account's heroes (then the better place, then the hero id). Deterministic and independent of
 * the input's order, so a resumed award run computes the same set.
 */
export function seasonAwards(standings: readonly FinalStanding[]): PrestigeAward[] {
  const best = new Map<string, PrestigeAward>();
  for (const s of standings) {
    const tier = prestigeTierFor(s.rank, s.level);
    if (!tier) continue;
    const key = `${s.accountId}\u0000${s.metric}`;
    const award: PrestigeAward = {
      accountId: s.accountId,
      metric: s.metric,
      tier,
      rank: s.rank,
      characterId: s.characterId,
    };
    const prev = best.get(key);
    if (
      !prev ||
      tierOrder(tier) < tierOrder(prev.tier) ||
      (tier === prev.tier &&
        (s.rank < prev.rank || (s.rank === prev.rank && s.characterId < prev.characterId)))
    ) {
      best.set(key, award);
    }
  }
  return [...best.values()].sort(
    (a, b) =>
      SCORE_METRICS.indexOf(a.metric) - SCORE_METRICS.indexOf(b.metric) ||
      a.rank - b.rank ||
      (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0),
  );
}

/**
 * Which award a player shows when they have not chosen (the first award they earn): the best
 * tier, then the board order. Players can change or clear it at any time.
 */
export function bestAward<A extends { tier: PrestigeTier; metric: ScoreMetric; season: number }>(
  awards: readonly A[],
): A | undefined {
  return [...awards].sort(
    (a, b) =>
      tierOrder(a.tier) - tierOrder(b.tier) ||
      b.season - a.season ||
      SCORE_METRICS.indexOf(a.metric) - SCORE_METRICS.indexOf(b.metric),
  )[0];
}

/** What a player shows next to their name: one title and one frame, each from an earned award. */
export interface PrestigeDisplay {
  title: { season: number; metric: ScoreMetric; tier: PrestigeTier } | null;
  frame: { season: number; metric: ScoreMetric; tier: PrestigeTier } | null;
}

export const NO_PRESTIGE: PrestigeDisplay = { title: null, frame: null };
