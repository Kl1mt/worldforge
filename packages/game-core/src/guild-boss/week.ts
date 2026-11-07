/**
 * The guild boss week (ticket 4.9, docs/GUILD_BOSS.md "The week"). One explicit window, in UTC:
 * a week starts on **Monday 00:00:00.000 UTC** and ends just before the next Monday (start
 * inclusive, end exclusive). Every attempt stores the start of the week it was made in (the window
 * rule: stored, never recomputed from a later clock), so a request that spans midnight counts in
 * the week of the moment its transaction read the clock.
 */
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface GuildBossWeek {
  /** `YYYY-MM-DD` of the Monday the week starts on (UTC). */
  key: string;
  /** Inclusive start (ms since the epoch). */
  startMs: number;
  /** Exclusive end: the next Monday 00:00 UTC. */
  endMs: number;
}

/** The week containing `ms` (any moment, ms since the epoch). */
export function guildBossWeek(ms: number): GuildBossWeek {
  if (!Number.isFinite(ms)) throw new RangeError(`Invalid time: ${ms}`);
  const dayStart = Math.floor(ms / DAY_MS) * DAY_MS;
  // 1970-01-01 was a Thursday: day 0 → weekday 3 counting from Monday.
  const weekday = (((Math.floor(ms / DAY_MS) + 3) % 7) + 7) % 7;
  const startMs = dayStart - weekday * DAY_MS;
  return { key: new Date(startMs).toISOString().slice(0, 10), startMs, endMs: startMs + WEEK_MS };
}

/** The week that starts on the Monday `key` (`YYYY-MM-DD`); throws for anything else. */
export function guildBossWeekFromKey(key: string): GuildBossWeek {
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(key) ? Date.parse(`${key}T00:00:00Z`) : NaN;
  const week = Number.isFinite(ms) ? guildBossWeek(ms) : null;
  if (!week || week.key !== key) throw new RangeError(`Not a guild boss week: ${key}`);
  return week;
}
