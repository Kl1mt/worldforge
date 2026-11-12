import { findEventDefinition } from './definitions.js';
import { eventMinDays } from './progress.js';

/**
 * The event calendar (ticket 6.6, docs/EVENTS.md "Scheduling"), modelled on 5.3's seasons. An event
 * runs in `[startsAt, endsAt)` (UTC, the game clock): progress counts when the request that made it
 * arrived inside the window (the window rule). **One at a time:** windows of events that are not
 * cancelled never overlap, and at most one event waits to begin. Pure: every function takes `now`.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** What an event's length may be: at least an hour, at most four weeks. */
export const EVENT_LENGTH_LIMITS = { minMs: HOUR_MS, maxMs: 28 * DAY_MS } as const;

/**
 * How long after an event's end it is closed (unfinished quests expire for good and the reward
 * sweep runs). Progress from a request that arrived before the end still commits in this grace.
 */
export const EVENT_CLOSE_GRACE_MS = 5 * 60 * 1000;

export interface EventWindow {
  number: number;
  definitionId: string;
  startsAt: Date;
  endsAt: Date;
  cancelledAt?: Date | null;
  closedAt?: Date | null;
}

/**
 * - `scheduled`: not begun; `active`: under way; `closing`: ended, not closed yet; `closed`: done;
 * - `cancelled`: called off before it began.
 */
export type EventStatus = 'scheduled' | 'active' | 'closing' | 'closed' | 'cancelled';

export function eventStatus(e: EventWindow, now: Date): EventStatus {
  if (e.cancelledAt) return 'cancelled';
  const t = now.getTime();
  if (t < e.startsAt.getTime()) return 'scheduled';
  if (t < e.endsAt.getTime()) return 'active';
  return e.closedAt ? 'closed' : 'closing';
}

/** Whether `at` lies in the event's window and the event is not cancelled. */
export function inEventWindow(e: EventWindow, at: Date): boolean {
  const t = at.getTime();
  return !e.cancelledAt && t >= e.startsAt.getTime() && t < e.endsAt.getTime();
}

/** The event under way at `at`, if any (at most one, by the plan rules). */
export function eventAt<E extends EventWindow>(events: readonly E[], at: Date): E | undefined {
  return events.find((e) => inEventWindow(e, at));
}

/** The next event that has not begun (not cancelled), if any. */
export function nextEvent<E extends EventWindow>(events: readonly E[], now: Date): E | undefined {
  return [...events]
    .filter((e) => !e.cancelledAt && e.startsAt.getTime() > now.getTime())
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0];
}

export type EventPlanProblem =
  | 'unknown_event'
  | 'end_before_start'
  | 'too_short'
  | 'length_too_short'
  | 'too_long'
  | 'starts_in_past'
  | 'ends_in_past'
  | 'overlaps'
  | 'one_scheduled'
  | 'already_ended'
  | 'already_begun'
  | 'cancelled'
  | 'not_found';

export const EVENT_PLAN_MESSAGES: Record<EventPlanProblem, string> = {
  unknown_event: 'There is no such event.',
  end_before_start: 'An event must end after it starts.',
  too_short: 'An event lasts at least one hour.',
  length_too_short: 'An event of several weeks must last at least all of its weeks.',
  too_long: 'An event lasts at most four weeks.',
  starts_in_past: 'A new event cannot start in the past.',
  ends_in_past: 'An event cannot be set to end in the past.',
  overlaps: 'Only one event can run at a time.',
  one_scheduled: 'Another event is already waiting to begin; cancel it first.',
  already_ended: 'That event has already ended.',
  already_begun: 'That event has already begun; end it early instead.',
  cancelled: 'That event was cancelled.',
  not_found: 'There is no such event on the calendar.',
};

function checkLength(startsAt: Date, endsAt: Date): EventPlanProblem | null {
  const ms = endsAt.getTime() - startsAt.getTime();
  if (ms <= 0) return 'end_before_start';
  if (ms < EVENT_LENGTH_LIMITS.minMs) return 'too_short';
  if (ms > EVENT_LENGTH_LIMITS.maxMs) return 'too_long';
  return null;
}

const live = <E extends EventWindow>(events: readonly E[]) => events.filter((e) => !e.cancelledAt);

const overlaps = (a: { startsAt: Date; endsAt: Date }, b: { startsAt: Date; endsAt: Date }) =>
  a.startsAt.getTime() < b.endsAt.getTime() && b.startsAt.getTime() < a.endsAt.getTime();

/**
 * Schedules an event `[startsAt, endsAt)`: it may start now (a minute's slack) or later, may not
 * overlap another event, and only one event may wait to begin.
 */
export function planEventSchedule(
  events: readonly EventWindow[],
  plan: { definitionId: string; startsAt: Date; endsAt: Date },
  now: Date,
): { ok: true; number: number } | { ok: false; problem: EventPlanProblem } {
  const def = findEventDefinition(plan.definitionId);
  if (!def) return { ok: false, problem: 'unknown_event' };
  const length = checkLength(plan.startsAt, plan.endsAt);
  if (length) return { ok: false, problem: length };
  // Ticket 8.3b: every week of a weekly event in full.
  if (plan.endsAt.getTime() - plan.startsAt.getTime() < eventMinDays(def) * DAY_MS)
    return { ok: false, problem: 'length_too_short' };
  if (plan.startsAt.getTime() < now.getTime() - 60_000)
    return { ok: false, problem: 'starts_in_past' };
  if (nextEvent(events, now)) return { ok: false, problem: 'one_scheduled' };
  if (live(events).some((e) => overlaps(e, plan))) return { ok: false, problem: 'overlaps' };
  const number = Math.max(0, ...events.map((e) => e.number)) + 1;
  return { ok: true, number };
}

/**
 * Moves an event's end: earlier ("end early", `endsAt` = now) or later ("extend"), for the event
 * under way or the one waiting to begin. Never into the past, never over the next event.
 */
export function planEventEnd<E extends EventWindow>(
  events: readonly E[],
  number: number,
  endsAt: Date,
  now: Date,
): { ok: true; event: E } | { ok: false; problem: EventPlanProblem } {
  const event = events.find((e) => e.number === number);
  if (!event) return { ok: false, problem: 'not_found' };
  if (event.cancelledAt) return { ok: false, problem: 'cancelled' };
  if (event.endsAt.getTime() <= now.getTime()) return { ok: false, problem: 'already_ended' };
  if (endsAt.getTime() < now.getTime()) return { ok: false, problem: 'ends_in_past' };
  const ms = endsAt.getTime() - event.startsAt.getTime();
  if (ms <= 0) return { ok: false, problem: 'end_before_start' };
  // Ending now may leave an event shorter than an hour; only a longer plan is length-checked.
  const ending = endsAt.getTime() <= now.getTime() + 60_000;
  if (!ending && ms < EVENT_LENGTH_LIMITS.minMs) return { ok: false, problem: 'too_short' };
  // Ticket 8.3b: moving the end may not cut a weekly event's weeks (ending it now still may).
  const def = findEventDefinition(event.definitionId);
  if (!ending && def && ms < eventMinDays(def) * DAY_MS)
    return { ok: false, problem: 'length_too_short' };
  if (ms > EVENT_LENGTH_LIMITS.maxMs) return { ok: false, problem: 'too_long' };
  const moved = { startsAt: event.startsAt, endsAt };
  if (live(events).some((e) => e.number !== number && overlaps(e, moved)))
    return { ok: false, problem: 'overlaps' };
  return { ok: true, event };
}

/** Cancels an event that has not begun (one under way is ended early instead). */
export function planEventCancel<E extends EventWindow>(
  events: readonly E[],
  number: number,
  now: Date,
): { ok: true; event: E } | { ok: false; problem: EventPlanProblem } {
  const event = events.find((e) => e.number === number);
  if (!event) return { ok: false, problem: 'not_found' };
  if (event.cancelledAt) return { ok: false, problem: 'cancelled' };
  if (event.startsAt.getTime() <= now.getTime()) return { ok: false, problem: 'already_begun' };
  return { ok: true, event };
}
