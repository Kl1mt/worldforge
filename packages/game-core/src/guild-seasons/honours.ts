/**
 * Guild honours (ticket 8.4, docs/LEADERBOARDS.md "Guild honours"): by the guild's place on the
 * guild board's final standings, scaled with the board like B.4's tiers. Cosmetic only: each tier's
 * cosmetics (`COSMETICS`, source `guildSeason`) go to the guild's honour roll (the churn rules),
 * cumulatively (a Champion guild's members get every tier's).
 */
export const GUILD_HONOUR_TIER_IDS = ['champion', 'exalted', 'renowned'] as const;
export type GuildHonourTier = (typeof GUILD_HONOUR_TIER_IDS)[number];

export interface GuildHonourTierDef {
  id: GuildHonourTier;
  name: string;
  maxRank: number;
  /** Share of the board (rounded up), between `minPlaces` and `maxRank`; null = `maxRank`. */
  boardShare: number | null;
  minPlaces: number;
  rule: string;
}

export const GUILD_HONOUR_TIERS: readonly GuildHonourTierDef[] = [
  {
    id: 'champion',
    name: 'Champion guild',
    maxRank: 1,
    boardShare: null,
    minPlaces: 1,
    rule: 'First on the guild roll at the season’s end.',
  },
  {
    id: 'exalted',
    name: 'Exalted guild',
    maxRank: 3,
    boardShare: 0.1,
    minPlaces: 2,
    rule: 'Among the top 10 % of the guild roll (at least the top 2, at most the top 3).',
  },
  {
    id: 'renowned',
    name: 'Renowned guild',
    maxRank: 10,
    boardShare: 0.3,
    minPlaces: 3,
    rule: 'Among the top 30 % of the guild roll (at least the top 3, at most the top 10).',
  },
];

export const isGuildHonourTier = (v: unknown): v is GuildHonourTier =>
  typeof v === 'string' && (GUILD_HONOUR_TIER_IDS as readonly string[]).includes(v);

export const findGuildHonourTier = (id: string) => GUILD_HONOUR_TIERS.find((t) => t.id === id);

/** The last place of a tier on a board of `size` guilds. */
export function guildTierLastPlace(tier: GuildHonourTierDef, size: number): number {
  const n = Number.isFinite(size) && size > 0 ? Math.floor(size) : 0;
  if (tier.boardShare === null) return Math.min(tier.maxRank, n);
  return Math.min(n, tier.maxRank, Math.max(tier.minPlaces, Math.ceil(tier.boardShare * n)));
}

/** The tier a place earns on a board of `size` guilds, or null. */
export function guildHonourTierFor(rank: number, size: number): GuildHonourTier | null {
  if (!Number.isInteger(rank) || rank < 1 || rank > size) return null;
  for (const t of GUILD_HONOUR_TIERS) if (rank <= guildTierLastPlace(t, size)) return t.id;
  return null;
}

export interface GuildFinalStanding {
  guildId: string;
  rank: number;
}

export interface GuildSeasonAward {
  guildId: string;
  rank: number;
  tier: GuildHonourTier;
}

/** The awards of a season's guild standings (deterministic, independent of order). */
export function guildSeasonAwards(standings: readonly GuildFinalStanding[]): GuildSeasonAward[] {
  const size = standings.length;
  return [...standings]
    .sort((a, b) => a.rank - b.rank || (a.guildId < b.guildId ? -1 : 1))
    .flatMap((s) => {
      const tier = guildHonourTierFor(s.rank, size);
      return tier ? [{ guildId: s.guildId, rank: s.rank, tier }] : [];
    });
}

/** Lower is better (0 = champion). */
export const guildTierOrder = (t: GuildHonourTier) => GUILD_HONOUR_TIER_IDS.indexOf(t);
