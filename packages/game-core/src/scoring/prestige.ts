import { SCORE_METRICS, type ScoreMetric } from './types.js';

/**
 * The boards that give honours: the four score boards (5.3) and the arena ladder (ticket 5.6,
 * `arena`: the season's rated duel ladder, docs/PVP.md "The ladder").
 */
export const PRESTIGE_METRICS = [...SCORE_METRICS, 'arena'] as const;
export type PrestigeMetric = ScoreMetric | 'arena';
export const isPrestigeMetric = (v: unknown): v is PrestigeMetric =>
  typeof v === 'string' && (PRESTIGE_METRICS as readonly string[]).includes(v);
const metricOrder = (m: PrestigeMetric) => PRESTIGE_METRICS.indexOf(m);

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
  /**
   * The lowest place that can earn this tier (inclusive), however large the board; null = any
   * place on the board.
   */
  maxRank: number | null;
  /**
   * Ticket B.4: the tier's share of the board (0.1 = the top 10 %, rounded up), between
   * `minPlaces` and `maxRank`; null = `maxRank` alone (Champion, Veteran).
   */
  boardShare: number | null;
  /** Ticket B.4: the places a tier always has, however small the board (with `boardShare`). */
  minPlaces: number;
  /** The hero's level at season end must be at least this (the minimum activity). */
  minLevel: number;
  /** The profile frame's asset name (A.10). */
  frameAsset: string;
  /** Plain words for players. */
  rule: string;
}

/** The minimum activity for Veteran: the hero is level 10 or higher at season end. */
export const VETERAN_MIN_LEVEL = 10;

/**
 * Best first. A hero earns the best tier its place allows.
 *
 * Ticket B.4 (docs/LEADERBOARDS.md "Balance pass: competitive systems"): Exalted and Renowned
 * scale with the board. Before, they were fixed places (top 10, top 100): on a board of 20 every
 * hero was Exalted or Renowned, on a board of 100 nine in ten were Renowned and nobody a Veteran.
 * Now Exalted is the top 2 % (at least 3 places, at most the top 10) and Renowned the top 10 %
 * (at least 5 places, at most the top 100), so each keeps its meaning at every town size and both
 * reach their old caps once a board has 500 (Exalted) or 1,000 (Renowned) heroes.
 */
export const PRESTIGE_TIERS: readonly PrestigeTierDef[] = [
  {
    id: 'champion',
    name: 'Champion',
    maxRank: 1,
    boardShare: null,
    minPlaces: 1,
    minLevel: 1,
    frameAsset: 'season-frame-champion',
    rule: 'First place on a season board.',
  },
  {
    id: 'exalted',
    name: 'Exalted',
    maxRank: 10,
    boardShare: 0.02,
    minPlaces: 3,
    minLevel: 1,
    frameAsset: 'season-frame-exalted',
    rule: 'Among the top 2 % of a season board (at least the top 3, at most the top 10).',
  },
  {
    id: 'renowned',
    name: 'Renowned',
    maxRank: 100,
    boardShare: 0.1,
    minPlaces: 5,
    minLevel: 1,
    frameAsset: 'season-frame-renowned',
    rule: 'Among the top 10 % of a season board (at least the top 5, at most the top 100).',
  },
  {
    id: 'veteran',
    name: 'Veteran',
    maxRank: null,
    boardShare: null,
    minPlaces: 0,
    minLevel: VETERAN_MIN_LEVEL,
    frameAsset: 'season-frame-veteran',
    rule: `On a season board at its end, with a hero of level ${VETERAN_MIN_LEVEL} or higher.`,
  },
];

/**
 * The lowest place that earns a tier on a board of `boardSize` heroes (null = any place).
 * Ticket B.4: `boardShare` of the board, rounded up, between `minPlaces` and `maxRank`.
 */
export function tierLastPlace(tier: PrestigeTierDef, boardSize: number): number | null {
  if (tier.maxRank === null) return null;
  if (tier.boardShare === null) return tier.maxRank;
  const size = Number.isFinite(boardSize) && boardSize > 0 ? Math.floor(boardSize) : 0;
  return Math.min(tier.maxRank, Math.max(tier.minPlaces, Math.ceil(tier.boardShare * size)));
}

/** Every tier's last place on a board of this size (for players: "the top 3 this season"). */
export function tierCutoffs(boardSize: number): Record<PrestigeTier, number | null> {
  return Object.fromEntries(
    PRESTIGE_TIERS.map((t) => [t.id, tierLastPlace(t, boardSize)]),
  ) as Record<PrestigeTier, number | null>;
}

export const findPrestigeTier = (id: string): PrestigeTierDef | undefined =>
  PRESTIGE_TIERS.find((t) => t.id === id);

export const isPrestigeTier = (v: unknown): v is PrestigeTier =>
  typeof v === 'string' && (PRESTIGE_TIER_IDS as readonly string[]).includes(v);

/** Lower is better (0 = champion). */
export const tierOrder = (t: PrestigeTier) => PRESTIGE_TIER_IDS.indexOf(t);

/**
 * The tier a place earns on a board of `boardSize` heroes (the season's final standings of that
 * board), or null (no place, or a Veteran place below the minimum level).
 */
export function prestigeTierFor(
  rank: number,
  level: number,
  boardSize: number,
): PrestigeTier | null {
  if (!Number.isInteger(rank) || rank < 1) return null;
  for (const t of PRESTIGE_TIERS) {
    const last = tierLastPlace(t, Math.max(boardSize, rank));
    if ((last === null || rank <= last) && level >= t.minLevel) return t.id;
  }
  return null;
}

export interface TitleDef {
  metric: PrestigeMetric;
  /** The noun of the title ("Exalted Pathfinder"). */
  noun: string;
  /** The badge's asset name (A.10). */
  badgeAsset: string;
}

/**
 * One title per board; the tier names its rank. The arena ladder (5.6) reuses the Character Power
 * board's crossed-blades badge (no new art).
 */
export const SEASON_TITLES: Readonly<Record<PrestigeMetric, TitleDef>> = {
  level: { metric: 'level', noun: 'Climber', badgeAsset: 'title-badge-level' },
  gearScore: { metric: 'gearScore', noun: 'Armsbearer', badgeAsset: 'title-badge-gear-score' },
  power: { metric: 'power', noun: 'Blade', badgeAsset: 'title-badge-power' },
  pveProgress: {
    metric: 'pveProgress',
    noun: 'Pathfinder',
    badgeAsset: 'title-badge-pve-progress',
  },
  arena: { metric: 'arena', noun: 'Duellist', badgeAsset: 'title-badge-power' },
};

/** "Exalted Pathfinder". */
export function prestigeTitle(metric: PrestigeMetric, tier: PrestigeTier): string {
  return `${findPrestigeTier(tier)!.name} ${SEASON_TITLES[metric].noun}`;
}

/** One hero's final place on one season board (the archive row, as the award reads it). */
export interface FinalStanding {
  metric: PrestigeMetric;
  rank: number;
  accountId: string;
  characterId: string;
  level: number;
}

/** What an account earns on one board in one season: the best tier any of its heroes reached. */
export interface PrestigeAward {
  accountId: string;
  metric: PrestigeMetric;
  tier: PrestigeTier;
  /** The place that earned it (the best place for that tier). */
  rank: number;
  characterId: string;
}

/**
 * The awards of a season, from its final standings: per account and board, the best tier among
 * the account's heroes (then the better place, then the hero id); the tiers' places scale with
 * each board's size (ticket B.4). Deterministic and independent of
 * the input's order, so a resumed award run computes the same set.
 */
export function seasonAwards(standings: readonly FinalStanding[]): PrestigeAward[] {
  // Ticket B.4: a board's size is its last place in the archive (ranks are 1…n per board).
  const size = new Map<PrestigeMetric, number>();
  for (const s of standings) size.set(s.metric, Math.max(size.get(s.metric) ?? 0, s.rank));
  const best = new Map<string, PrestigeAward>();
  for (const s of standings) {
    const tier = prestigeTierFor(s.rank, s.level, size.get(s.metric)!);
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
      metricOrder(a.metric) - metricOrder(b.metric) ||
      a.rank - b.rank ||
      (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0),
  );
}

/**
 * Which award a player shows when they have not chosen (the first award they earn): the best
 * tier, then the board order. Players can change or clear it at any time.
 */
export function bestAward<A extends { tier: PrestigeTier; metric: PrestigeMetric; season: number }>(
  awards: readonly A[],
): A | undefined {
  return [...awards].sort(
    (a, b) =>
      tierOrder(a.tier) - tierOrder(b.tier) ||
      b.season - a.season ||
      metricOrder(a.metric) - metricOrder(b.metric),
  )[0];
}

/** What a player shows next to their name: one title and one frame, each from an earned award. */
export interface PrestigeDisplay {
  title: { season: number; metric: PrestigeMetric; tier: PrestigeTier } | null;
  frame: { season: number; metric: PrestigeMetric; tier: PrestigeTier } | null;
}

export const NO_PRESTIGE: PrestigeDisplay = { title: null, frame: null };
