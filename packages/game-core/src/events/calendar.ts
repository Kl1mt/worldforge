import { findEventDefinition } from './definitions.js';
import { EVENT_CLOSE_GRACE_MS, EVENT_LENGTH_LIMITS, type EventWindow } from './plan.js';

/**
 * The automatic event calendar (ticket 8.3, docs/EVENTS.md "The calendar"). The owner sets a
 * **rotation** (which events, in which order, each with its length) and a **gap** between events;
 * the scheduler then puts the next event of the rotation on the calendar by itself once the last
 * one has closed. Pure: every function takes `now`; the server runs them under the events' plan
 * lock, so the calendar never creates two events and never overlaps one (game-core's
 * `planEventSchedule` still decides every insert).
 *
 * - **Paused** (the default, also in production until the owner turns it on): nothing is created
 *   automatically; a waiting event stays on the calendar.
 * - **The next start** is the last event's end plus the gap, but never in the past: a calendar
 *   turned on after a long pause starts the next event at the next full hour.
 * - **Manual always wins:** an event the owner schedules by hand replaces an automatic one that
 *   has not begun (the server cancels it); the rotation then continues after the manual event.
 * - **Skip:** the next entry of the rotation is passed over (an automatic event already waiting is
 *   cancelled instead, and the following entry takes its place).
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface CalendarEntry {
  definitionId: string;
  /** The length of this event when the calendar creates it (whole days). */
  days: number;
}

export interface EventCalendarSettings {
  paused: boolean;
  /** In order; may repeat an event. Empty: nothing automatic. */
  rotation: readonly CalendarEntry[];
  /** Whole days between one event's end and the next one's start. */
  gapDays: number;
  /** The rotation entry the calendar creates next (an index into `rotation`). */
  nextIndex: number;
}

export const CALENDAR_LIMITS = {
  maxEntries: 12,
  minDays: 1,
  maxDays: EVENT_LENGTH_LIMITS.maxMs / DAY_MS,
  minGapDays: 0,
  maxGapDays: 60,
} as const;

/** The calendar before the owner has set it: paused, both events in turn, a week apart. */
export const DEFAULT_EVENT_CALENDAR: EventCalendarSettings = {
  paused: true,
  rotation: [
    { definitionId: 'lanternProcession', days: 28 },
    { definitionId: 'harvestOfBones', days: 7 },
  ],
  gapDays: 7,
  nextIndex: 0,
};

export type CalendarProblem =
  'unknown_event' | 'too_many_entries' | 'bad_length' | 'bad_gap' | 'bad_index';

export const CALENDAR_MESSAGES: Record<CalendarProblem, string> = {
  unknown_event: 'There is no such event.',
  too_many_entries: `The rotation holds at most ${CALENDAR_LIMITS.maxEntries} events.`,
  bad_length: `An event in the rotation lasts ${CALENDAR_LIMITS.minDays} to ${CALENDAR_LIMITS.maxDays} whole days.`,
  bad_gap: `The gap between events is ${CALENDAR_LIMITS.minGapDays} to ${CALENDAR_LIMITS.maxGapDays} whole days.`,
  bad_index: 'The next event must be one of the rotation.',
};

/** Problems with calendar settings, or null. */
export function checkCalendarSettings(s: EventCalendarSettings): CalendarProblem | null {
  if (s.rotation.length > CALENDAR_LIMITS.maxEntries) return 'too_many_entries';
  for (const e of s.rotation) {
    if (!findEventDefinition(e.definitionId)) return 'unknown_event';
    if (!Number.isInteger(e.days) || e.days < CALENDAR_LIMITS.minDays) return 'bad_length';
    if (e.days > CALENDAR_LIMITS.maxDays) return 'bad_length';
  }
  if (
    !Number.isInteger(s.gapDays) ||
    s.gapDays < CALENDAR_LIMITS.minGapDays ||
    s.gapDays > CALENDAR_LIMITS.maxGapDays
  )
    return 'bad_gap';
  if (!Number.isInteger(s.nextIndex) || s.nextIndex < 0) return 'bad_index';
  if (s.rotation.length > 0 && s.nextIndex >= s.rotation.length) return 'bad_index';
  return null;
}

/** The next index after a rotation change: kept if it still names an entry, else the first. */
export function clampCalendarIndex(index: number, rotationLength: number): number {
  return rotationLength === 0 || index >= rotationLength || index < 0 ? 0 : index;
}

/** The next full hour at or after `t` (UTC). */
export function ceilToHour(t: Date): Date {
  return new Date(Math.ceil(t.getTime() / HOUR_MS) * HOUR_MS);
}

const live = <E extends EventWindow>(events: readonly E[]) => events.filter((e) => !e.cancelledAt);

/** The latest end of the events that are not cancelled, or null. */
function lastEnd(events: readonly EventWindow[]): Date | null {
  const ends = live(events).map((e) => e.endsAt.getTime());
  return ends.length === 0 ? null : new Date(Math.max(...ends));
}

/**
 * When an automatic event created at `createdAt` starts: the last end plus the gap, but never
 * before the next full hour after `createdAt` (so never in the past).
 */
export function calendarStart(prevEnd: Date | null, gapDays: number, createdAt: Date): Date {
  const earliest = ceilToHour(createdAt).getTime();
  const wanted = prevEnd ? prevEnd.getTime() + gapDays * DAY_MS : earliest;
  return new Date(Math.max(earliest, wanted));
}

export interface CalendarPlan {
  definitionId: string;
  startsAt: Date;
  endsAt: Date;
  /** The rotation entry it comes from. */
  index: number;
}

/**
 * What the calendar creates now, or null: only when it runs (not paused, a rotation) and every
 * event that is not cancelled has closed (none under way, waiting or closing).
 */
export function nextCalendarEvent(
  settings: EventCalendarSettings,
  events: readonly EventWindow[],
  now: Date,
): CalendarPlan | null {
  if (settings.paused || settings.rotation.length === 0) return null;
  if (live(events).some((e) => !e.closedAt)) return null;
  const index = clampCalendarIndex(settings.nextIndex, settings.rotation.length);
  const entry = settings.rotation[index]!;
  const startsAt = calendarStart(lastEnd(events), settings.gapDays, now);
  return {
    definitionId: entry.definitionId,
    startsAt,
    endsAt: new Date(startsAt.getTime() + entry.days * DAY_MS),
    index,
  };
}

export interface PlannedEvent {
  definitionId: string;
  startsAt: Date;
  endsAt: Date;
  /**
   * - `scheduled`: already on the calendar (by hand or by the calendar), waiting to begin;
   * - `rotation`: what the calendar will create (if it runs and nothing changes).
   */
  kind: 'scheduled' | 'rotation';
  /** The event's number when it is on the calendar. */
  number: number | null;
  /** The rotation entry (for `rotation`). */
  index: number | null;
}

/**
 * The next `count` planned events: the one waiting to begin (if any), then the rotation from the
 * last end on, each created when the one before it closes. Shown also while paused (as what the
 * calendar would do once turned on). An event under way is not "planned".
 */
export function projectCalendar(
  settings: EventCalendarSettings,
  events: readonly (EventWindow & { source?: string | null })[],
  now: Date,
  count = 3,
): PlannedEvent[] {
  const out: PlannedEvent[] = [];
  const waiting = live(events)
    .filter((e) => e.startsAt.getTime() > now.getTime())
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  for (const e of waiting) {
    if (out.length >= count) return out;
    out.push({
      definitionId: e.definitionId,
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      kind: 'scheduled',
      number: e.number,
      index: null,
    });
  }
  if (settings.rotation.length === 0) return out;
  let index = clampCalendarIndex(settings.nextIndex, settings.rotation.length);
  let prev = lastEnd(events);
  while (out.length < count) {
    // Created at the scheduler's first run after the previous event closes (or now).
    const createdAt = new Date(
      Math.max(now.getTime(), prev ? prev.getTime() + EVENT_CLOSE_GRACE_MS : 0),
    );
    const entry = settings.rotation[index]!;
    const startsAt = calendarStart(prev, settings.gapDays, createdAt);
    const endsAt = new Date(startsAt.getTime() + entry.days * DAY_MS);
    out.push({
      definitionId: entry.definitionId,
      startsAt,
      endsAt,
      kind: 'rotation',
      number: null,
      index,
    });
    prev = endsAt;
    index = (index + 1) % settings.rotation.length;
  }
  return out;
}
