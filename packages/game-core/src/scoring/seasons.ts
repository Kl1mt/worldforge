/**
 * Seasons (ticket 5.3, docs/LEADERBOARDS.md "Seasons"). A season is a window of time in UTC,
 * `[startsAt, endsAt)`: a score change counts in the season whose window holds the moment the
 * request that made it arrived (the window rule, 5.2's `achieved_at`). Seasons follow one another
 * without overlap; the server keeps them (`seasons` table) and these rules decide what a plan may
 * look like. Pure: no clock of its own, every function takes `now`.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** Owner default (Phase 5): seasons last eight weeks. */
export const DEFAULT_SEASON_WEEKS = 8;
export const DEFAULT_SEASON_MS = DEFAULT_SEASON_WEEKS * WEEK_MS;

/** What a season's length may be: at least a day, at most half a year. */
export const SEASON_LENGTH_LIMITS = { minMs: DAY_MS, maxMs: 26 * WEEK_MS } as const;

/**
 * How long after a season's end its final standings are taken. A score change whose request
 * arrived before the end still counts if its refresh commits within this grace (requests take
 * seconds); the archive then waits for refreshes in flight (a lock), and later ones are left out.
 */
export const SEASON_CLOSE_GRACE_MS = 5 * 60 * 1000;

export interface SeasonWindow {
  number: number;
  startsAt: Date;
  endsAt: Date;
}

/**
 * - `scheduled`: not begun yet;
 * - `active`: under way;
 * - `closing`: ended, the final standings or the awards are not done yet;
 * - `closed`: archived and every award given.
 */
export type SeasonStatus = 'scheduled' | 'active' | 'closing' | 'closed';

export function seasonStatus(
  s: SeasonWindow & { awardedAt?: Date | null },
  now: Date,
): SeasonStatus {
  const t = now.getTime();
  if (t < s.startsAt.getTime()) return 'scheduled';
  if (t < s.endsAt.getTime()) return 'active';
  return s.awardedAt ? 'closed' : 'closing';
}

/** Whether `at` lies in the season's window `[startsAt, endsAt)`. */
export function inSeasonWindow(s: Pick<SeasonWindow, 'startsAt' | 'endsAt'>, at: Date): boolean {
  const t = at.getTime();
  return t >= s.startsAt.getTime() && t < s.endsAt.getTime();
}

/** The season whose window holds `at`, if any. */
export function seasonAt<S extends SeasonWindow>(seasons: readonly S[], at: Date): S | undefined {
  return seasons.find((s) => inSeasonWindow(s, at));
}

/** Seasons in order, ascending by number. */
const byNumber = <S extends SeasonWindow>(seasons: readonly S[]) =>
  [...seasons].sort((a, b) => a.number - b.number);

/** The season under way, else the latest one that has begun (the boards' default), if any. */
export function defaultBoardSeason<S extends SeasonWindow>(
  seasons: readonly S[],
  now: Date,
): S | undefined {
  return byNumber(seasons)
    .filter((s) => s.startsAt.getTime() <= now.getTime())
    .at(-1);
}

export type SeasonPlanProblem =
  | 'end_before_start'
  | 'too_short'
  | 'too_long'
  | 'starts_in_past'
  | 'ends_in_past'
  | 'overlaps'
  | 'not_after_previous'
  | 'already_ended'
  | 'not_editable';

export const SEASON_PLAN_MESSAGES: Record<SeasonPlanProblem, string> = {
  end_before_start: 'A season must end after it starts.',
  too_short: 'A season lasts at least one day.',
  too_long: 'A season lasts at most 26 weeks.',
  starts_in_past: 'A new season cannot start in the past.',
  ends_in_past: 'A season cannot be set to end in the past.',
  overlaps: 'Seasons may not overlap.',
  not_after_previous: 'A new season must start after the latest one.',
  already_ended: 'That season has already ended.',
  not_editable: 'Only the current season and the next one can be changed.',
};

/** Length checks shared by every plan change. */
export function checkSeasonLength(startsAt: Date, endsAt: Date): SeasonPlanProblem | null {
  const ms = endsAt.getTime() - startsAt.getTime();
  if (ms <= 0) return 'end_before_start';
  if (ms < SEASON_LENGTH_LIMITS.minMs) return 'too_short';
  if (ms > SEASON_LENGTH_LIMITS.maxMs) return 'too_long';
  return null;
}

/** Whether two windows share any moment (`[a, b)` against `[c, d)`). */
const overlaps = (a: SeasonWindow, b: Pick<SeasonWindow, 'startsAt' | 'endsAt'>) =>
  a.startsAt.getTime() < b.endsAt.getTime() && b.startsAt.getTime() < a.endsAt.getTime();

/**
 * Schedules the next season `[startsAt, endsAt)`, or replaces the one already scheduled (not yet
 * begun). It must start no earlier than now and no earlier than the end of every season that has
 * begun, and must not overlap one. Returns the plan change or the problem.
 */
export function planSchedule<S extends SeasonWindow>(
  seasons: readonly S[],
  window: { startsAt: Date; endsAt: Date },
  now: Date,
): { ok: true; number: number; replaces: S | null } | { ok: false; problem: SeasonPlanProblem } {
  const length = checkSeasonLength(window.startsAt, window.endsAt);
  if (length) return { ok: false, problem: length };
  if (window.startsAt.getTime() < now.getTime() - 60_000)
    return { ok: false, problem: 'starts_in_past' };
  const ordered = byNumber(seasons);
  const scheduled = ordered.filter((s) => s.startsAt.getTime() > now.getTime());
  const begun = ordered.filter((s) => s.startsAt.getTime() <= now.getTime());
  // Only the very next season can be scheduled or replaced; a later one waits for it.
  const replaces = scheduled.at(0) ?? null;
  if (scheduled.length > 1) return { ok: false, problem: 'not_editable' };
  const last = begun.at(-1);
  if (last && window.startsAt.getTime() < last.endsAt.getTime())
    return { ok: false, problem: 'not_after_previous' };
  if (begun.some((s) => overlaps(s, window))) return { ok: false, problem: 'overlaps' };
  const number = replaces ? replaces.number : (ordered.at(-1)?.number ?? 0) + 1;
  return { ok: true, number, replaces };
}

/**
 * Moves a season's end: earlier ("end early") or later ("extend"). Allowed for the season under
 * way and the scheduled next one. The new end must not lie in the past (ending now is allowed) and
 * must keep the length limits. A next season that starts exactly where this one ended moves along
 * with it, keeping its length (seasons stay back to back); any other overlap is refused.
 */
export function planEnd<S extends SeasonWindow>(
  seasons: readonly S[],
  number: number,
  endsAt: Date,
  now: Date,
):
  | { ok: true; season: S; follower: { season: S; startsAt: Date; endsAt: Date } | null }
  | { ok: false; problem: SeasonPlanProblem } {
  const ordered = byNumber(seasons);
  const season = ordered.find((s) => s.number === number);
  if (!season) return { ok: false, problem: 'not_editable' };
  if (season.endsAt.getTime() <= now.getTime()) return { ok: false, problem: 'already_ended' };
  if (endsAt.getTime() < now.getTime()) return { ok: false, problem: 'ends_in_past' };
  const ms = endsAt.getTime() - season.startsAt.getTime();
  if (ms <= 0) return { ok: false, problem: 'end_before_start' };
  // Ending a season early may make it shorter than a day; only a longer plan is length-checked.
  const ending = endsAt.getTime() <= now.getTime() + 60_000;
  if (!ending && ms < SEASON_LENGTH_LIMITS.minMs) return { ok: false, problem: 'too_short' };
  if (ms > SEASON_LENGTH_LIMITS.maxMs) return { ok: false, problem: 'too_long' };
  const next = ordered.find((s) => s.number > number);
  let follower: { season: S; startsAt: Date; endsAt: Date } | null = null;
  if (next) {
    if (next.startsAt.getTime() === season.endsAt.getTime()) {
      const length = next.endsAt.getTime() - next.startsAt.getTime();
      follower = {
        season: next,
        startsAt: endsAt,
        endsAt: new Date(endsAt.getTime() + length),
      };
    } else if (endsAt.getTime() > next.startsAt.getTime()) {
      return { ok: false, problem: 'overlaps' };
    }
  }
  return { ok: true, season, follower };
}

/**
 * The season that follows automatically when the latest one has begun and nothing is scheduled
 * after it: back to back, the default length. If the server was down past that whole season, the
 * new one starts now instead (whole minute) so it is not over before it begins.
 */
export function nextAutomaticSeason<S extends SeasonWindow>(
  seasons: readonly S[],
  now: Date,
): { number: number; startsAt: Date; endsAt: Date } | null {
  const last = byNumber(seasons).at(-1);
  if (!last || last.startsAt.getTime() > now.getTime()) return null;
  let startsAt = last.endsAt;
  if (startsAt.getTime() + DEFAULT_SEASON_MS <= now.getTime()) {
    startsAt = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  }
  return {
    number: last.number + 1,
    startsAt,
    endsAt: new Date(startsAt.getTime() + DEFAULT_SEASON_MS),
  };
}

/** "Season 3". */
export const seasonName = (number: number) => `Season ${number}`;
