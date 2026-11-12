/**
 * Who counts for a guild in a season, and who shares its honours (ticket 8.4, docs/LEADERBOARDS.md
 * "Guild seasons: who counts"). The server applies these rules when it gathers a guild's input;
 * they are data so the owner can tune them.
 *
 * - **Counted members** (the score): members at the moment of the refresh (or the archive) who
 *   joined at least `countAfterDays` days before it, are not test accounts and have no active
 *   sanction. A member who leaves (or is kicked) stops counting at once and takes their part with
 *   them; a joiner counts only after `countAfterDays`.
 * - **Town works**: only gifts on days *after* the day the member joined, inside the season, count
 *   (gifts made before joining never follow a player into a guild).
 * - **Guild boss**: the stages the guild itself reached in the season (the damage stays with the
 *   guild it was fought for, docs/GUILD_BOSS.md), whoever is in it now.
 * - **Honours**: members at the archive who had been in the guild at least `honourAfterDays` days at
 *   the season's end, are not test accounts, have no active sanction at the archive, and took part
 *   for the guild in the season (a guild boss attempt for it, or a counted gift to the town works).
 *   So joining a top guild in the last two weeks earns nothing.
 * - A guild is on the board only with at least `minMembers` counted members (a guild of test
 *   accounts has none and never appears).
 */
export const GUILD_SEASON_RULES = {
  countAfterDays: 7,
  honourAfterDays: 14,
  minMembers: 3,
} as const;

const DAY_MS = 86_400_000;

/** Whether a member who joined at `joinedAt` counts for the score at `at`. */
export function memberCounts(joinedAt: Date, at: Date): boolean {
  return joinedAt.getTime() <= at.getTime() - GUILD_SEASON_RULES.countAfterDays * DAY_MS;
}

/** Whether a member who joined at `joinedAt` may share the honours of a season ending at `endsAt`. */
export function memberHonourEligible(joinedAt: Date, endsAt: Date): boolean {
  return joinedAt.getTime() <= endsAt.getTime() - GUILD_SEASON_RULES.honourAfterDays * DAY_MS;
}

/**
 * Whether a town-works gift on `day` (`YYYY-MM-DD`, the contribution window) counts for a member
 * who joined at `joinedAt` in a season `[startsAt, endsAt)`: the day began inside the season and
 * after the day the member joined.
 */
export function giftDayCounts(
  day: string,
  joinedAt: Date,
  window: { startsAt: Date; endsAt: Date },
): boolean {
  const start = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(start)) return false;
  const joinedDay = joinedAt.toISOString().slice(0, 10);
  return start >= window.startsAt.getTime() && start < window.endsAt.getTime() && day > joinedDay;
}
