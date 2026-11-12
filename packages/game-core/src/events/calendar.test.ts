import { describe, expect, it } from 'vitest';
import {
  CALENDAR_LIMITS,
  DEFAULT_EVENT_CALENDAR,
  EVENT_CLOSE_GRACE_MS,
  calendarStart,
  ceilToHour,
  checkCalendarSettings,
  clampCalendarIndex,
  nextCalendarEvent,
  planEventSchedule,
  projectCalendar,
  type EventCalendarSettings,
  type EventWindow,
} from './index.js';

/** Ticket 8.3: the automatic event calendar (docs/EVENTS.md "The calendar"). Injected clock. */
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const t0 = new Date('2031-01-06T00:00:00Z');
const at = (ms: number) => new Date(t0.getTime() + ms);

const on: EventCalendarSettings = {
  paused: false,
  rotation: [
    { definitionId: 'lanternProcession', days: 28 },
    { definitionId: 'harvestOfBones', days: 7 },
  ],
  gapDays: 7,
  nextIndex: 0,
};

const closedEvent = (n: number, start: number, end: number): EventWindow => ({
  number: n,
  definitionId: 'harvestOfBones',
  startsAt: at(start),
  endsAt: at(end),
  closedAt: at(end + EVENT_CLOSE_GRACE_MS),
});

/** Runs the calendar like the scheduler: create, run, close; `steps` times. */
function simulate(settings: EventCalendarSettings, steps: number, startAt = t0) {
  const events: EventWindow[] = [];
  let s = { ...settings };
  let now = startAt;
  for (let i = 0; i < steps; i += 1) {
    const plan = nextCalendarEvent(s, events, now);
    if (!plan) break;
    const ok = planEventSchedule(events, plan, now);
    expect(ok.ok).toBe(true);
    events.push({
      number: events.length + 1,
      definitionId: plan.definitionId,
      startsAt: plan.startsAt,
      endsAt: plan.endsAt,
    });
    s = { ...s, nextIndex: (plan.index + 1) % s.rotation.length };
    // The event runs and closes at end + grace; the scheduler's next run is then.
    now = new Date(plan.endsAt.getTime() + EVENT_CLOSE_GRACE_MS);
    events[events.length - 1]!.closedAt = now;
  }
  return events;
}

describe('the event calendar (8.3)', () => {
  it('starts paused, with both events in rotation a week apart', () => {
    expect(DEFAULT_EVENT_CALENDAR.paused).toBe(true);
    expect(checkCalendarSettings(DEFAULT_EVENT_CALENDAR)).toBeNull();
    expect(nextCalendarEvent(DEFAULT_EVENT_CALENDAR, [], t0)).toBeNull();
  });

  it('checks the settings', () => {
    expect(checkCalendarSettings(on)).toBeNull();
    const bad = (p: Partial<EventCalendarSettings>) => checkCalendarSettings({ ...on, ...p });
    expect(bad({ rotation: [{ definitionId: 'nope', days: 7 }] })).toBe('unknown_event');
    expect(bad({ rotation: [{ definitionId: 'harvestOfBones', days: 0 }] })).toBe('bad_length');
    expect(bad({ rotation: [{ definitionId: 'harvestOfBones', days: 29 }] })).toBe('bad_length');
    expect(bad({ rotation: [{ definitionId: 'harvestOfBones', days: 1.5 }] })).toBe('bad_length');
    expect(bad({ gapDays: -1 })).toBe('bad_gap');
    expect(bad({ gapDays: CALENDAR_LIMITS.maxGapDays + 1 })).toBe('bad_gap');
    expect(bad({ nextIndex: 2 })).toBe('bad_index');
    expect(bad({ rotation: Array.from({ length: 13 }, () => on.rotation[1]!), nextIndex: 0 })).toBe(
      'too_many_entries',
    );
    expect(bad({ rotation: [], nextIndex: 0 })).toBeNull();
    expect(clampCalendarIndex(5, 2)).toBe(0);
    expect(clampCalendarIndex(1, 2)).toBe(1);
    expect(clampCalendarIndex(0, 0)).toBe(0);
  });

  it('the first event starts at the next full hour; each next one at the last end + the gap', () => {
    expect(ceilToHour(at(1)).getTime()).toBe(at(HOUR).getTime());
    expect(ceilToHour(t0).getTime()).toBe(t0.getTime());
    const first = nextCalendarEvent(on, [], at(10 * 60_000))!;
    expect(first).toMatchObject({ definitionId: 'lanternProcession', index: 0 });
    expect(first.startsAt.toISOString()).toBe(at(HOUR).toISOString());
    expect(first.endsAt.getTime() - first.startsAt.getTime()).toBe(28 * DAY);

    const events = simulate(on, 5);
    expect(events.map((e) => e.definitionId)).toEqual([
      'lanternProcession',
      'harvestOfBones',
      'lanternProcession',
      'harvestOfBones',
      'lanternProcession',
    ]);
    for (let i = 1; i < events.length; i += 1) {
      // The gap, exactly; the default length of each entry, exactly.
      expect(events[i]!.startsAt.getTime() - events[i - 1]!.endsAt.getTime()).toBe(7 * DAY);
      const want = events[i]!.definitionId === 'harvestOfBones' ? 7 : 28;
      expect(events[i]!.endsAt.getTime() - events[i]!.startsAt.getTime()).toBe(want * DAY);
    }
  });

  it('a gap of 0 starts the next one the full hour after the close, never overlapping', () => {
    const events = simulate({ ...on, gapDays: 0 }, 4);
    for (let i = 1; i < events.length; i += 1) {
      const gap = events[i]!.startsAt.getTime() - events[i - 1]!.endsAt.getTime();
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeLessThanOrEqual(HOUR);
    }
  });

  it('never two events: nothing is created while one is waiting, under way or closing', () => {
    const running: EventWindow = {
      number: 1,
      definitionId: 'harvestOfBones',
      startsAt: at(0),
      endsAt: at(7 * DAY),
    };
    // Under way.
    expect(nextCalendarEvent(on, [running], at(DAY))).toBeNull();
    // Ended, in the close's grace (not closed yet).
    expect(nextCalendarEvent(on, [running], at(7 * DAY + 60_000))).toBeNull();
    // Waiting to begin (scheduled by hand).
    const waiting = { ...running, startsAt: at(30 * DAY), endsAt: at(37 * DAY) };
    expect(nextCalendarEvent(on, [waiting], at(DAY))).toBeNull();
    // Closed: the next one, a gap after its end.
    const closed = { ...running, closedAt: at(7 * DAY + EVENT_CLOSE_GRACE_MS) };
    const next = nextCalendarEvent(on, [closed], at(7 * DAY + EVENT_CLOSE_GRACE_MS))!;
    expect(next.startsAt.toISOString()).toBe(at(14 * DAY).toISOString());
    // A cancelled event neither blocks nor counts as the last end.
    const cancelled = { ...waiting, cancelledAt: at(DAY) };
    const after = nextCalendarEvent(on, [closed, cancelled], at(8 * DAY))!;
    expect(after.startsAt.toISOString()).toBe(at(14 * DAY).toISOString());
    // Many random histories: whatever the calendar creates never overlaps (planEventSchedule).
    for (const gapDays of [0, 1, 3, 7, 30]) {
      const ev = simulate({ ...on, gapDays }, 8);
      for (let i = 1; i < ev.length; i += 1)
        expect(ev[i]!.startsAt.getTime()).toBeGreaterThanOrEqual(ev[i - 1]!.endsAt.getTime());
    }
  });

  it('pause and resume: nothing while paused; on resume, the gap after the last end or the next hour', () => {
    const last = closedEvent(1, 0, 7 * DAY);
    const paused = { ...on, paused: true };
    for (const d of [8, 14, 40]) expect(nextCalendarEvent(paused, [last], at(d * DAY))).toBeNull();
    // Resumed before the gap is over: the gap is kept.
    expect(nextCalendarEvent(on, [last], at(9 * DAY))!.startsAt.toISOString()).toBe(
      at(14 * DAY).toISOString(),
    );
    // Resumed long after: the next full hour, not the past.
    const late = at(40 * DAY + 17 * 60_000);
    expect(nextCalendarEvent(on, [last], late)!.startsAt.toISOString()).toBe(
      at(40 * DAY + HOUR).toISOString(),
    );
    // Resume keeps the rotation where it was.
    expect(nextCalendarEvent({ ...on, nextIndex: 1 }, [last], late)!.definitionId).toBe(
      'harvestOfBones',
    );
  });

  it('skip passes over one entry of the rotation', () => {
    const skipped = simulate({ ...on, nextIndex: 1 }, 2);
    expect(skipped.map((e) => e.definitionId)).toEqual(['harvestOfBones', 'lanternProcession']);
  });

  it('a manual event in between: the rotation continues after it, the gap from its end', () => {
    const manual = closedEvent(1, 3 * DAY, 5 * DAY);
    const next = nextCalendarEvent({ ...on, nextIndex: 1 }, [manual], at(6 * DAY))!;
    expect(next.definitionId).toBe('harvestOfBones');
    expect(next.startsAt.toISOString()).toBe(at(12 * DAY).toISOString());
  });

  it('projects the next three: the waiting event first, then the rotation from its end', () => {
    const waiting = {
      number: 4,
      definitionId: 'harvestOfBones',
      startsAt: at(2 * DAY),
      endsAt: at(9 * DAY),
      source: 'manual',
    };
    const planned = projectCalendar(on, [waiting], t0);
    expect(planned.map((p) => [p.kind, p.definitionId, p.number])).toEqual([
      ['scheduled', 'harvestOfBones', 4],
      ['rotation', 'lanternProcession', null],
      ['rotation', 'harvestOfBones', null],
    ]);
    expect(planned[1]!.startsAt.toISOString()).toBe(at(16 * DAY).toISOString());
    expect(planned[2]!.startsAt.toISOString()).toBe(at((16 + 28 + 7) * DAY).toISOString());
    // The projection matches what the calendar then creates, step by step.
    const made = simulate(on, 3, at(30 * 60_000));
    const shown = projectCalendar(on, [], at(30 * 60_000));
    expect(shown.map((p) => [p.definitionId, p.startsAt.getTime(), p.endsAt.getTime()])).toEqual(
      made.map((e) => [e.definitionId, e.startsAt.getTime(), e.endsAt.getTime()]),
    );
    // An empty rotation plans nothing automatic.
    expect(projectCalendar({ ...on, rotation: [] }, [], t0)).toEqual([]);
    expect(calendarStart(null, 7, at(1)).toISOString()).toBe(at(HOUR).toISOString());
  });
});
