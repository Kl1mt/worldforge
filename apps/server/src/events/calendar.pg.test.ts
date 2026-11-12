/**
 * Real-PostgreSQL tests of the automatic event calendar (ticket 8.3, docs/EVENTS.md "The
 * calendar"). Runs when `DATABASE_URL` is set, skipped otherwise (CI sets `REQUIRE_PG_TESTS=1`).
 * Asserts only what holds in every order (CLAUDE.md "Races"):
 * - many creators at once (the scheduler's step called directly, as two instances or a restart
 *   overlapping a run would): exactly one event per calendar slot, never two waiting, never
 *   overlapping;
 * - a restart mid-create (a throw after the insert, before the commit): nothing is left, the next
 *   run creates it once;
 * - two API instances with the 6.9 leader election, both ticking the scheduler, one restarting:
 *   the calendar's event is created exactly once.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { EVENT_CLOSE_GRACE_MS } from '@worldforge/game-core';
import { buildApp } from '../app.js';
import type { DatabaseHandle } from '../db/types.js';
import { queryRows } from '../db/query.js';
import { createPostgresTestDatabase } from '../test/db.js';
import { calendarEvents, ensureCalendarEvent, updateCalendar } from './calendar.js';
import { closeEvent, listEvents, setEventEnd } from './model.js';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === '1') {
  throw new Error('REQUIRE_PG_TESTS=1 but DATABASE_URL is not set');
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const cli = { accountId: null, via: 'cli' as const };

/** Polls `check` until it holds (state, not the wall clock), at most `ms`. */
async function until(check: () => Promise<boolean> | boolean, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

function assertNoOverlap(events: { startsAt: Date; endsAt: Date; cancelledAt: Date | null }[]) {
  const live = events
    .filter((e) => !e.cancelledAt)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  for (let i = 1; i < live.length; i += 1)
    expect(live[i]!.startsAt.getTime()).toBeGreaterThanOrEqual(live[i - 1]!.endsAt.getTime());
}

describe.skipIf(!url)('real PostgreSQL: the event calendar creates each event once', () => {
  let database: DatabaseHandle;
  const apps: FastifyInstance[] = [];
  // The injected game clock, derived from the wall clock (CLAUDE.md "Dates").
  let nowMs = Math.ceil(Date.now() / HOUR) * HOUR + 30 * DAY + 10 * 60_000;
  const now = () => new Date(nowMs);
  const db = () => database.db;

  beforeAll(async () => {
    database = await createPostgresTestDatabase(url!, { poolMax: 30 });
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });
  afterAll(async () => {
    await database?.close();
  });

  /** Ends the waiting/running event now and closes it, so the calendar may create the next. */
  const finishCurrent = async () => {
    const live = (await listEvents(db())).filter((e) => !e.cancelledAt && !e.closedAt);
    for (const e of live) {
      if (e.startsAt.getTime() > nowMs) nowMs = e.startsAt.getTime() + HOUR;
      if (e.endsAt.getTime() > nowMs) await setEventEnd(db(), e.number, now(), now(), cli);
      nowMs += EVENT_CLOSE_GRACE_MS;
      expect(await closeEvent(db(), e.number, now())).toBe('closed');
    }
  };

  it('many creators at once, over many cycles: one event per slot, never overlapping', async () => {
    await updateCalendar(
      db(),
      {
        paused: false,
        rotation: [
          { definitionId: 'lanternProcession', days: 28 },
          { definitionId: 'harvestOfBones', days: 7 },
        ],
        gapDays: 0,
      },
      now(),
      cli,
    );
    for (let cycle = 0; cycle < 6; cycle += 1) {
      const made = await Promise.all(
        Array.from({ length: 8 }, () => ensureCalendarEvent(db(), now())),
      );
      expect(made.filter((e) => e !== null)).toHaveLength(1);
      // Nothing more while it waits.
      expect(await ensureCalendarEvent(db(), now())).toBeNull();
      await finishCurrent();
    }
    const auto = await calendarEvents(db());
    expect(auto.map((e) => e.calendarSlot)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(auto.map((e) => e.definitionId)).toEqual([
      'lanternProcession',
      'harvestOfBones',
      'lanternProcession',
      'harvestOfBones',
      'lanternProcession',
      'harvestOfBones',
    ]);
    assertNoOverlap(await listEvents(db()));
    const [audits] = await queryRows<{ n: number }>(
      db(),
      sql`select count(*)::int as n from audit_log
        where event = 'event.schedule' and data->>'via' = 'calendar'`,
    );
    expect(audits!.n).toBe(6);
  });

  it('a restart mid-create leaves nothing; the next run creates it once', async () => {
    const before = (await calendarEvents(db())).length;
    const results = await Promise.allSettled([
      ensureCalendarEvent(db(), now(), { failAfterInsert: true }),
      ensureCalendarEvent(db(), now(), { failAfterInsert: true }),
    ]);
    // Whichever got the lock first threw after its insert; the other then saw the same plan and
    // threw too (or found nothing to do if it looked before): nothing committed either way.
    expect(results.every((r) => r.status === 'rejected' || r.value === null)).toBe(true);
    expect(await calendarEvents(db())).toHaveLength(before);
    const [made, again] = await Promise.all([
      ensureCalendarEvent(db(), now()),
      ensureCalendarEvent(db(), now()),
    ]);
    expect([made, again].filter((e) => e !== null)).toHaveLength(1);
    const auto = await calendarEvents(db());
    expect(auto).toHaveLength(before + 1);
    expect(auto.at(-1)!.calendarSlot).toBe(before + 1);
    await finishCurrent();
  });

  it('two API instances with leader election, one restarting: created exactly once', async () => {
    const instance = async () => {
      const a = buildApp({
        database,
        activity: { settleIntervalMs: 30, now },
      });
      apps.push(a);
      await a.ready();
      return a;
    };
    const before = (await calendarEvents(db())).length;
    const a = await instance();
    const b = await instance();
    expect(await until(async () => (await calendarEvents(db())).length === before + 1)).toBe(true);
    // A restart: one instance goes, a new one comes, both keep ticking for a while.
    await a.close();
    apps.splice(apps.indexOf(a), 1);
    const c = await instance();
    const ran = (app: FastifyInstance) => app.schedulerState.jobs.eventJobs.detail !== null;
    expect(await until(() => ran(b) && ran(c))).toBe(true);
    // Whoever leads now has run the step again (the new one may lead or stand by).
    const runs = await queryRows<{ n: number }>(
      db(),
      sql`select count(*)::int as n from world_events where source = 'calendar'`,
    );
    expect(runs[0]!.n).toBe(before + 1);
    expect(await calendarEvents(db())).toHaveLength(before + 1);
    // Exactly one of the two live instances leads the event jobs.
    const leaders = [b, c].filter((x) => x.schedulerLeader.leading().includes('eventJobs'));
    expect(leaders).toHaveLength(1);
    assertNoOverlap(await listEvents(db()));
  });
});
