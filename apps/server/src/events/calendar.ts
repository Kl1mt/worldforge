import { asc, eq, sql } from 'drizzle-orm';
import {
  CALENDAR_MESSAGES,
  DEFAULT_EVENT_CALENDAR,
  EVENT_PLAN_MESSAGES,
  checkCalendarSettings,
  clampCalendarIndex,
  findEventDefinition,
  nextCalendarEvent,
  planEventSchedule,
  projectCalendar,
  shortCalendarEntry,
  type CalendarEntry,
  type CalendarProblem,
  type EventCalendarSettings,
  type PlannedEvent,
} from '@worldforge/game-core';
import { eventCalendar, worldEvents, type WorldEvent } from '../db/schema.js';
import type { Database, Executor, Transaction } from '../db/types.js';
import { writeAudit } from '../db/audit.js';
import { ApiError } from '../errors.js';
import { recordTelemetry } from '../telemetry/record.js';
import { lengthTooShort, listEvents, underPlanLock, type EventPlanActor } from './model.js';

/**
 * The automatic event calendar (ticket 8.3, docs/EVENTS.md "The calendar"). game-core decides
 * (`events/calendar.ts`); this runs it under the events' plan lock (`events:plan`, the same lock as
 * every manual plan change), so the calendar and the owner never race:
 * - **Settings** (`event_calendar`, one row; no row = paused with the default rotation): pause,
 *   resume, rotation, gap, skip; every change audited `event.calendar` with before and after.
 * - **Ticket 8.3b:** automatic events start on a Monday 00:00 UTC (game-core `calendarStart`), and
 *   a rotation entry shorter than its event's weeks is refused (`400 length_too_short`).
 * - **Creation** (`ensureCalendarEvent`, the scheduler's `eventJobs` step on the leader, 6.9):
 *   when the calendar runs and every event has closed, the next rotation entry is inserted with
 *   `source = 'calendar'` and `calendar_slot = created_count + 1` (unique), and the row's cursor
 *   moves on in the same transaction. A crash before the commit leaves nothing; two instances (or a
 *   restarted one) serialise on the lock, and the second sees the first's event (`nextCalendarEvent`
 *   is null while one waits); the slot's unique index is the last guard. Audited `event.schedule`
 *   with `via: 'calendar'`.
 * - **Manual always wins** (`displaceCalendarEventTx`, called by `scheduleEvent`): an automatic
 *   event that has not begun is cancelled for the owner's own, and its entry comes back after it.
 */

export interface CalendarState {
  settings: EventCalendarSettings;
  createdCount: number;
  updatedAt: Date | null;
  /** Whether the owner ever saved the calendar (false: the defaults). */
  saved: boolean;
}

const calendarError = (problem: CalendarProblem | 'empty_rotation') =>
  new ApiError(
    409,
    'calendar_refused',
    problem === 'empty_rotation' ? 'The rotation is empty.' : CALENDAR_MESSAGES[problem],
    { problem },
  );

export async function readCalendar(db: Executor, forUpdate = false): Promise<CalendarState> {
  const q = db.select().from(eventCalendar).where(eq(eventCalendar.id, 1));
  const [row] = forUpdate ? await q.for('update') : await q;
  if (!row) {
    return { settings: DEFAULT_EVENT_CALENDAR, createdCount: 0, updatedAt: null, saved: false };
  }
  return {
    settings: {
      paused: row.paused,
      rotation: row.rotation,
      gapDays: row.gapDays,
      nextIndex: clampCalendarIndex(row.nextIndex, row.rotation.length),
    },
    createdCount: row.createdCount,
    updatedAt: row.updatedAt,
    saved: true,
  };
}

async function writeCalendar(
  tx: Transaction,
  s: EventCalendarSettings,
  createdCount: number,
  now: Date,
  accountId: string | null,
): Promise<void> {
  const values = {
    paused: s.paused,
    rotation: s.rotation.map((e) => ({ definitionId: e.definitionId, days: e.days })),
    gapDays: s.gapDays,
    nextIndex: s.nextIndex,
    createdCount,
    updatedBy: accountId,
    updatedAt: now,
  };
  await tx
    .insert(eventCalendar)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: eventCalendar.id, set: values });
}

const summary = (s: EventCalendarSettings) => ({
  paused: s.paused,
  rotation: s.rotation.map((e) => `${e.definitionId}:${e.days}`),
  gapDays: s.gapDays,
  nextIndex: s.nextIndex,
});

export interface CalendarPatch {
  paused?: boolean;
  rotation?: readonly CalendarEntry[];
  gapDays?: number;
}

/** Pauses, resumes or sets the rotation and the gap (any of them). Audited `event.calendar`. */
export async function updateCalendar(
  db: Database,
  patch: CalendarPatch,
  now: Date,
  actor: EventPlanActor,
): Promise<CalendarState> {
  return underPlanLock(db, async (tx) => {
    await actor.guard?.(tx);
    const before = await readCalendar(tx, true);
    const rotation = patch.rotation ?? before.settings.rotation;
    const next: EventCalendarSettings = {
      paused: patch.paused ?? before.settings.paused,
      rotation,
      gapDays: patch.gapDays ?? before.settings.gapDays,
      nextIndex: clampCalendarIndex(before.settings.nextIndex, rotation.length),
    };
    const problem = checkCalendarSettings(next);
    if (problem === 'length_too_short')
      throw lengthTooShort(shortCalendarEntry(rotation)!.definitionId);
    if (problem) throw calendarError(problem);
    await writeCalendar(tx, next, before.createdCount, now, actor.accountId);
    const action =
      patch.rotation === undefined && patch.gapDays === undefined && patch.paused !== undefined
        ? patch.paused
          ? 'pause'
          : 'resume'
        : 'set';
    await writeAudit(tx, {
      event: 'event.calendar',
      accountId: actor.accountId,
      data: { via: actor.via, action, before: summary(before.settings), after: summary(next) },
    });
    return { ...before, settings: next, updatedAt: now, saved: true };
  });
}

/** An automatic event that has not begun (at most one: one waits at a time). */
async function waitingCalendarEvent(tx: Executor, now: Date): Promise<WorldEvent | null> {
  const list = await listEvents(tx);
  return (
    list.find(
      (e) => e.source === 'calendar' && !e.cancelledAt && e.startsAt.getTime() > now.getTime(),
    ) ?? null
  );
}

async function cancelForCalendar(
  tx: Transaction,
  e: WorldEvent,
  now: Date,
  actor: EventPlanActor,
  reason: 'skip' | 'manual_override',
): Promise<void> {
  await tx.update(worldEvents).set({ cancelledAt: now }).where(eq(worldEvents.number, e.number));
  await writeAudit(tx, {
    event: 'event.cancel',
    accountId: actor.accountId,
    data: { via: actor.via, event: e.number, definitionId: e.definitionId, reason },
  });
}

/**
 * Skips the calendar's next event: an automatic one waiting to begin is cancelled (the next entry
 * takes its place at the next run); otherwise the rotation passes over its next entry.
 */
/**
 * Ticket 8.7: names what a skip would pass over (the cursor, the events created, the waiting one),
 * so a skip sent twice from one view (a lost answer, two tabs) skips once (`409 calendar_changed`).
 */
const skipTokenOf = (nextIndex: number, createdCount: number, waiting: WorldEvent | null) =>
  `${nextIndex}.${createdCount}.${waiting?.number ?? 0}`;

export async function skipCalendarEvent(
  db: Database,
  now: Date,
  actor: EventPlanActor,
  /** The view's `skipToken`; the panel always sends it, the CLI (one typed command) may not. */
  expect?: string,
): Promise<{ state: CalendarState; skipped: string; cancelled: number | null }> {
  return underPlanLock(db, async (tx) => {
    await actor.guard?.(tx);
    const before = await readCalendar(tx, true);
    const s = before.settings;
    if (s.rotation.length === 0) throw calendarError('empty_rotation');
    const waiting = await waitingCalendarEvent(tx, now);
    if (expect !== undefined && expect !== skipTokenOf(s.nextIndex, before.createdCount, waiting)) {
      throw new ApiError(
        409,
        'calendar_changed',
        'The calendar changed since you looked (the skip may already have happened). Look again.',
      );
    }
    let next = s;
    let skipped: string;
    if (waiting) {
      await cancelForCalendar(tx, waiting, now, actor, 'skip');
      skipped = waiting.definitionId;
    } else {
      skipped = s.rotation[s.nextIndex]!.definitionId;
      next = { ...s, nextIndex: (s.nextIndex + 1) % s.rotation.length };
    }
    await writeCalendar(tx, next, before.createdCount, now, actor.accountId);
    await writeAudit(tx, {
      event: 'event.calendar',
      accountId: actor.accountId,
      data: {
        via: actor.via,
        action: 'skip',
        skipped,
        cancelled: waiting?.number ?? null,
        before: summary(s),
        after: summary(next),
      },
    });
    return {
      state: { ...before, settings: next, updatedAt: now, saved: true },
      skipped,
      cancelled: waiting?.number ?? null,
    };
  });
}

/**
 * Manual always wins (called inside `scheduleEvent`'s plan transaction): an automatic event that
 * has not begun is cancelled, and the rotation comes back to its entry after the owner's event.
 * Returns the number cancelled, or null.
 */
export async function displaceCalendarEventTx(
  tx: Transaction,
  now: Date,
  actor: EventPlanActor,
): Promise<number | null> {
  const waiting = await waitingCalendarEvent(tx, now);
  if (!waiting) return null;
  await cancelForCalendar(tx, waiting, now, actor, 'manual_override');
  const c = await readCalendar(tx, true);
  const r = c.settings.rotation;
  if (r.length > 0) {
    // The displaced entry comes back next: the one just before the cursor, if it is that event.
    const prev = (c.settings.nextIndex - 1 + r.length) % r.length;
    const back =
      r[prev]!.definitionId === waiting.definitionId
        ? prev
        : Math.max(
            0,
            r.findIndex((e) => e.definitionId === waiting.definitionId),
          );
    if (back !== c.settings.nextIndex) {
      await writeCalendar(tx, { ...c.settings, nextIndex: back }, c.createdCount, now, null);
    }
  }
  return waiting.number;
}

export interface EnsureOptions {
  /** Tests only: throw after the insert, before the commit (a restart mid-create). */
  failAfterInsert?: boolean;
}

/**
 * The scheduler's calendar step: creates the next rotation event if the calendar runs and every
 * event has closed. Exactly once (see the module comment). Returns the event created, or null.
 */
export async function ensureCalendarEvent(
  db: Database,
  now: Date,
  options: EnsureOptions = {},
): Promise<WorldEvent | null> {
  // A cheap look first: most runs have nothing to do (paused, or an event on the calendar).
  const first = await readCalendar(db);
  if (!nextCalendarEvent(first.settings, await listEvents(db), now)) return null;
  return underPlanLock(db, async (tx) => {
    const c = await readCalendar(tx, true);
    const list = await listEvents(tx);
    const plan = nextCalendarEvent(c.settings, list, now);
    if (!plan) return null;
    const ok = planEventSchedule(list, plan, now);
    if (!ok.ok) {
      // Cannot happen with game-core's rules (nothing waits, the start is not in the past); kept
      // as a guard so a broken plan never inserts.
      throw new ApiError(409, 'event_plan_refused', EVENT_PLAN_MESSAGES[ok.problem], {
        problem: ok.problem,
      });
    }
    const slot = c.createdCount + 1;
    const [row] = await tx
      .insert(worldEvents)
      .values({
        number: ok.number,
        definitionId: plan.definitionId,
        startsAt: plan.startsAt,
        endsAt: plan.endsAt,
        createdAt: now,
        source: 'calendar',
        calendarSlot: slot,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) return null;
    if (options.failAfterInsert)
      throw new Error('calendar creation stopped after the insert (test)');
    await writeCalendar(
      tx,
      { ...c.settings, nextIndex: (plan.index + 1) % c.settings.rotation.length },
      slot,
      now,
      null,
    );
    await writeAudit(tx, {
      event: 'event.schedule',
      data: {
        via: 'calendar',
        event: row.number,
        definitionId: row.definitionId,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt.toISOString(),
        slot,
        index: plan.index,
      },
    });
    recordTelemetry(tx, now, [{ metric: 'event.schedule', dims: [row.definitionId, 'calendar'] }]);
    return row;
  });
}

/** The calendar as the admin panel and the CLI show it. */
export interface CalendarView {
  paused: boolean;
  saved: boolean;
  rotation: { definitionId: string; name: string; days: number }[];
  gapDays: number;
  nextIndex: number;
  createdCount: number;
  /** Ticket 8.7: sent back with a skip (`skipCalendarEvent`'s `expect`). */
  skipToken: string;
  updatedAt: string | null;
  planned: {
    definitionId: string;
    name: string;
    startsAt: string;
    endsAt: string;
    kind: PlannedEvent['kind'];
    number: number | null;
    source: 'manual' | 'calendar' | null;
  }[];
}

export async function calendarView(db: Executor, now: Date): Promise<CalendarView> {
  const c = await readCalendar(db);
  const list = await listEvents(db);
  const name = (id: string) => findEventDefinition(id)?.name ?? id;
  const planned = projectCalendar(c.settings, list, now, 3);
  return {
    paused: c.settings.paused,
    saved: c.saved,
    rotation: c.settings.rotation.map((e) => ({ ...e, name: name(e.definitionId) })),
    gapDays: c.settings.gapDays,
    nextIndex: c.settings.nextIndex,
    createdCount: c.createdCount,
    skipToken: skipTokenOf(
      c.settings.nextIndex,
      c.createdCount,
      await waitingCalendarEvent(db, now),
    ),
    updatedAt: c.updatedAt?.toISOString() ?? null,
    planned: planned.map((p) => ({
      definitionId: p.definitionId,
      name: name(p.definitionId),
      startsAt: p.startsAt.toISOString(),
      endsAt: p.endsAt.toISOString(),
      kind: p.kind,
      number: p.number,
      source: p.number === null ? null : (list.find((e) => e.number === p.number)?.source ?? null),
    })),
  };
}

export const calendarViewSchema = {
  type: 'object',
  required: [
    'paused',
    'saved',
    'rotation',
    'gapDays',
    'nextIndex',
    'createdCount',
    'skipToken',
    'updatedAt',
    'planned',
  ],
  properties: {
    paused: { type: 'boolean' },
    saved: { type: 'boolean' },
    rotation: {
      type: 'array',
      items: {
        type: 'object',
        required: ['definitionId', 'name', 'days'],
        properties: {
          definitionId: { type: 'string' },
          name: { type: 'string' },
          days: { type: 'integer' },
        },
      },
    },
    gapDays: { type: 'integer' },
    nextIndex: { type: 'integer' },
    createdCount: { type: 'integer' },
    skipToken: { type: 'string' },
    updatedAt: { type: ['string', 'null'] },
    planned: {
      type: 'array',
      items: {
        type: 'object',
        required: ['definitionId', 'name', 'startsAt', 'endsAt', 'kind', 'number', 'source'],
        properties: {
          definitionId: { type: 'string' },
          name: { type: 'string' },
          startsAt: { type: 'string' },
          endsAt: { type: 'string' },
          kind: { type: 'string' },
          number: { type: ['integer', 'null'] },
          source: { type: ['string', 'null'] },
        },
      },
    },
  },
} as const;

/** Calendar-created events in creation order (tests, the CLI). */
export async function calendarEvents(db: Executor): Promise<WorldEvent[]> {
  return db
    .select()
    .from(worldEvents)
    .where(sql`${worldEvents.source} = 'calendar'`)
    .orderBy(asc(worldEvents.calendarSlot));
}
