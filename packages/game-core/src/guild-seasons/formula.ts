import { findCommunityProject, type ProjectResource } from '../world/projects.js';

/**
 * The guild season ranking (ticket 8.4, docs/LEADERBOARDS.md "Guild seasons"). A published,
 * versioned formula over facts the server stores; nothing a client sends is ever a guild score.
 *
 * **Version 1** adds three parts, each a whole number:
 * - **Guild boss:** every guild boss stage the guild reached during the season scores its stage
 *   points (Cracked 20, Staggered 40, Broken 60, Shattered 80, Laid to Rest 100): a full week is
 *   300, an eight-week season at most 2,400.
 * - **Members' PvE Progress:** each counted member scores 100 × their best hero's PvE Progress as
 *   a share of its milestones (25 of 25 = 100); the best 20 count: at most 2,000.
 * - **Town works:** each counted member scores what they gave to the community projects during the
 *   season since joining, as a share of each need (a whole need of one resource = 100 points, a
 *   tenth of the gold of a stage = 10), at most 100 per member; the best 20 count: at most 2,000.
 *
 * Order: the total, then the guild boss part, then PvE, then the town works part (`sortKey`,
 * higher first); the server adds "reached first", then the guild id.
 *
 * Pure: no clock, no randomness. Who counts (the churn rules) is decided by the server from
 * `GUILD_SEASON_RULES` and recorded in the input, which is stored with every row, so a row can
 * always be recomputed (`pnpm admin:guild-seasons check`).
 */
export const GUILD_SEASON_FORMULA_VERSION = 1;
export const SUPPORTED_GUILD_SEASON_VERSIONS: readonly number[] = [1];

export interface GuildSeasonWeights {
  /** Points per guild boss stage reached (index = stage; 0 unused). */
  stagePoints: readonly number[];
  /** Points for a member whose best hero has every PvE Progress milestone. */
  pvePerMember: number;
  /** Points for giving one whole need of one resource to the town works. */
  communityPerNeed: number;
  /** The most town-works points one member adds in a season. */
  communityPerMemberCap: number;
  /** Only the best this many members count for each member part. */
  countedMembers: number;
}

export const GUILD_SEASON_WEIGHTS: Readonly<Record<number, GuildSeasonWeights>> = {
  1: {
    stagePoints: [0, 20, 40, 60, 80, 100],
    pvePerMember: 100,
    communityPerNeed: 100,
    communityPerMemberCap: 100,
    countedMembers: 20,
  },
};

/** One counted member's facts. */
export interface GuildSeasonMember {
  /** The best hero's PvE Progress value and the milestones of its formula version (null: none). */
  pve: { value: number; of: number } | null;
  /** What they gave to the town works in the season since joining, per project, stage, resource. */
  gifts: readonly {
    projectId: string;
    stageId: string;
    resource: ProjectResource;
    amount: number;
  }[];
}

export interface GuildSeasonInput {
  /** Every guild boss stage the guild reached in the season (one entry per stage per week). */
  stages: readonly number[];
  /** The counted members (the churn rules), in a stable order. */
  members: readonly GuildSeasonMember[];
}

export interface GuildSeasonScore {
  formulaVersion: number;
  value: number;
  /** [total, boss, pve, community], compared lexicographically, higher first. */
  sortKey: number[];
  parts: { boss: number; pve: number; community: number };
  /** Counted members (for the board's minimum, `GUILD_SEASON_RULES.minMembers`). */
  members: number;
}

const whole = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;

/** A member's PvE points (0–`pvePerMember`). */
export function memberPvePoints(m: GuildSeasonMember, version = GUILD_SEASON_FORMULA_VERSION) {
  const w = weightsOf(version);
  if (!m.pve) return 0;
  const of = whole(m.pve.of);
  if (of === 0) return 0;
  const value = Math.min(whole(m.pve.value), of);
  return Math.floor((w.pvePerMember * value) / of);
}

/** A member's town-works points (0–`communityPerMemberCap`). Unknown needs count 0. */
export function memberCommunityPoints(
  m: GuildSeasonMember,
  version = GUILD_SEASON_FORMULA_VERSION,
): number {
  const w = weightsOf(version);
  let points = 0;
  for (const g of m.gifts) {
    const stage = findCommunityProject(g.projectId)?.stages.find((s) => s.id === g.stageId);
    const need = stage?.needs.find((n) => n.resource === g.resource)?.amount ?? 0;
    if (need <= 0) continue;
    points += (w.communityPerNeed * Math.min(whole(g.amount), need)) / need;
  }
  return Math.min(w.communityPerMemberCap, Math.floor(points + 1e-9));
}

function weightsOf(version: number): GuildSeasonWeights {
  const w = GUILD_SEASON_WEIGHTS[version];
  if (!w) throw new RangeError(`Unknown guild season formula version ${version}`);
  return w;
}

const bestSum = (values: number[], n: number) =>
  values
    .sort((a, b) => b - a)
    .slice(0, n)
    .reduce((s, v) => s + v, 0);

export function guildSeasonScore(
  input: GuildSeasonInput,
  version = GUILD_SEASON_FORMULA_VERSION,
): GuildSeasonScore {
  const w = weightsOf(version);
  let boss = 0;
  for (const s of input.stages) {
    const stage = Number.isInteger(s) ? s : 0;
    boss += w.stagePoints[stage] ?? 0;
  }
  const pve = bestSum(
    input.members.map((m) => memberPvePoints(m, version)),
    w.countedMembers,
  );
  const community = bestSum(
    input.members.map((m) => memberCommunityPoints(m, version)),
    w.countedMembers,
  );
  const value = boss + pve + community;
  return {
    formulaVersion: version,
    value,
    sortKey: [value, boss, pve, community],
    parts: { boss, pve, community },
    members: input.members.length,
  };
}

/** Lexicographic, higher first: negative when `a` ranks before `b`. */
export function compareGuildSortKeys(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (b[i] ?? 0) - (a[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Board order: the key, then reached first, then the guild id (the server's SQL order). */
export function compareGuildEntries(
  a: { sortKey: readonly number[]; achievedAt: number; guildId: string },
  b: { sortKey: readonly number[]; achievedAt: number; guildId: string },
): number {
  return (
    compareGuildSortKeys(a.sortKey, b.sortKey) ||
    a.achievedAt - b.achievedAt ||
    (a.guildId < b.guildId ? -1 : a.guildId > b.guildId ? 1 : 0)
  );
}
