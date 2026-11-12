import type { ProjectResource } from '../world/projects.js';
import {
  GUILD_SEASON_FORMULA_VERSION,
  guildSeasonScore,
  type GuildSeasonInput,
  type GuildSeasonMember,
} from './formula.js';

/**
 * "Reached first" for the Guild Roll (ticket 8.4b, docs/LEADERBOARDS.md "Guild seasons: ties").
 * Between two guilds with the same `sortKey`, the one that reached it earlier ranks first. The
 * moment is derived from the **facts' own times**, never from when a row happened to be refreshed:
 *
 * - a guild boss stage counts from the moment it was broken;
 * - a counted member's PvE share counts from when their best hero reached it on the PvE Progress
 *   board (5.2's `achieved_at`), a town-works gift from the start of its day;
 * - nothing of a member counts before they became counted (7 days after joining).
 *
 * Replaying those facts in time order, the guild's score only rises (every part is a sum or a capped
 * sum of non-negative facts). `guildSeasonReachedAt` is the earliest moment at which the facts the
 * guild holds now already add up to its current total, i.e. the time of the latest fact that raised
 * it, clamped to the season's window `[startsAt, at]`. Pure and deterministic: the same facts give
 * the same moment, whoever reads the roll and whenever the scheduler runs.
 */

/** One counted member's facts with their times (milliseconds since the epoch). */
export interface GuildSeasonTimedMember {
  /** When the member became counted (joined + `GUILD_SEASON_RULES.countAfterDays`). */
  countsFrom: number;
  /** The best hero's PvE Progress share and when it was reached (null: none). */
  pve: { value: number; of: number; at: number } | null;
  /** Counted town-works gifts, one per project, stage, resource and day; `at`: the day's start. */
  gifts: readonly {
    projectId: string;
    stageId: string;
    resource: ProjectResource;
    amount: number;
    at: number;
  }[];
}

/** A guild's season facts with their times; `guildSeasonInputAt` turns it into the formula input. */
export interface GuildSeasonTimeline {
  /** Every guild boss stage broken in the season, in a stable order (week, stage). */
  stages: readonly { stage: number; at: number }[];
  /** The counted members, in a stable order. */
  members: readonly GuildSeasonTimedMember[];
}

const giftKey = (g: { projectId: string; stageId: string; resource: string }) =>
  `${g.projectId}\u0000${g.stageId}\u0000${g.resource}`;

/** When a member's fact starts to count: not before the member does. */
const effective = (m: GuildSeasonTimedMember, at: number) => Math.max(at, m.countsFrom);

/**
 * The formula input made of the facts that count at `t` (all of them by default). Gifts are summed
 * per project, stage and resource in key order, as the stored input always was.
 */
export function guildSeasonInputAt(
  timeline: GuildSeasonTimeline,
  t = Number.POSITIVE_INFINITY,
): GuildSeasonInput {
  const stages = timeline.stages.filter((s) => s.at <= t).map((s) => s.stage);
  const members: GuildSeasonMember[] = timeline.members.map((m) => {
    const sums = new Map<string, number>();
    for (const g of m.gifts) {
      if (effective(m, g.at) > t) continue;
      const key = giftKey(g);
      sums.set(key, (sums.get(key) ?? 0) + g.amount);
    }
    return {
      pve: m.pve && effective(m, m.pve.at) <= t ? { value: m.pve.value, of: m.pve.of } : null,
      gifts: [...sums.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, amount]) => {
          const [projectId, stageId, resource] = key.split('\u0000') as [string, string, string];
          return { projectId, stageId, resource: resource as ProjectResource, amount };
        }),
    };
  });
  return { stages, members };
}

/**
 * The moment the guild reached its current score (see the module comment), within
 * `[window.startsAt, window.at]`. A guild with nothing scored is at `startsAt`.
 */
export function guildSeasonReachedAt(
  timeline: GuildSeasonTimeline,
  window: { startsAt: number; at: number },
  version = GUILD_SEASON_FORMULA_VERSION,
): number {
  const final = guildSeasonScore(guildSeasonInputAt(timeline), version).value;
  const times = new Set<number>();
  for (const s of timeline.stages) times.add(s.at);
  for (const m of timeline.members) {
    if (m.pve) times.add(effective(m, m.pve.at));
    for (const g of m.gifts) times.add(effective(m, g.at));
  }
  const sorted = [...times].sort((a, b) => a - b);
  // The total only rises along the timeline: the first moment it equals the final total.
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const at = guildSeasonScore(guildSeasonInputAt(timeline, sorted[mid]!), version).value;
    if (at >= final) hi = mid;
    else lo = mid + 1;
  }
  const reached = final <= 0 || lo >= sorted.length ? window.startsAt : sorted[lo]!;
  return Math.min(window.at, Math.max(window.startsAt, reached));
}
