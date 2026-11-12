/**
 * Ticket 8.3: the automatic event calendar and the Lantern Procession (docs/EVENTS.md). Each
 * describe has its own database (events are global). Dates derive from the wall clock (CLAUDE.md
 * "Dates"); the game clock is injected, and the scheduler's step (`runEventJobs`) is called with it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  EVENT_CLOSE_GRACE_MS,
  EVENT_WEEK_MS,
  ceilToMonday,
  getEventDefinition,
  type QuestEvent,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import {
  accounts,
  auditLog,
  characterMaterials,
  characters,
  cosmeticUnlocks,
  eventParticipants,
  eventTrackGrants,
  itemInstances,
  worldEvents,
} from '../db/schema.js';
import { withTransaction } from '../db/transaction.js';
import { queryRows } from '../db/query.js';
import { createTestDatabase } from '../test/db.js';
import { insertCharacter } from '../test/heroes.js';
import { caller, insertAccount, type TestAccount } from '../test/social.js';
import { reconcileWithAudit } from '../telemetry/report.js';
import { listEvents, runEventJobs, scheduleEvent, sweepEventRewards } from './model.js';
import { recordEventProgressTx } from './progress.js';
import { formatCalendarStatus, runEventCommand, UsageError } from './event-cli.js';
import { calendarEvents, readCalendar } from './calendar.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** A Monday 00:00 UTC a month or so ahead of the wall clock. */
const BASE = (() => {
  const d = new Date(Date.now() + 30 * DAY);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return day + ((8 - new Date(day).getUTCDay()) % 7) * DAY;
})();
const cli = { accountId: null, via: 'cli' as const };
const proc = getEventDefinition('lanternProcession');
const iso = (ms: number) => new Date(ms).toISOString();

async function world(startMs: number) {
  const database = await createTestDatabase();
  const clock = { ms: startMs };
  const now = () => new Date(clock.ms);
  const app = buildApp({
    database,
    auth: { now },
    activity: { ...DEFAULT_ACTIVITY_OPTIONS, now },
    worldStateTtlMs: 0,
  });
  await app.ready();
  const db = database.db;
  const call = caller(app);
  const hero = async (
    who: TestAccount,
    level = 6,
    seedSecret = 'cafebabecafebabecafebabecafebabe',
  ) => {
    const h = await insertCharacter(db, who.id, { level });
    await db
      .update(characters)
      .set({ farmState: { seedSecret, cycleIndex: 0, health: null } })
      .where(eq(characters.id, h.id));
    return { ...h, level };
  };
  /** The scheduler's event step at the game clock. */
  const tick = () => runEventJobs(db, now());
  const close = async () => {
    await app.close();
    await database.close();
  };
  return { database, db, app, clock, now, call, hero, tick, close };
}
type World = Awaited<ReturnType<typeof world>>;

interface AdminEvents {
  current: { number: number; definitionId: string; source: string } | null;
  next: { number: number; definitionId: string; source: string } | null;
  calendar: {
    paused: boolean;
    saved: boolean;
    rotation: { definitionId: string; days: number }[];
    gapDays: number;
    nextIndex: number;
    skipToken: string;
    planned: {
      definitionId: string;
      startsAt: string;
      endsAt: string;
      kind: string;
      number: number | null;
    }[];
  };
  counts: { event: number; heroes: number; accounts: number; grants: number }[];
}

describe('the automatic calendar (admin panel, injected clock)', () => {
  let w: World;
  // A fresh admin session at the game clock (the clock jumps weeks; sessions expire).
  const admin = () => insertAccount(w.db, { role: 'admin', now: w.now() });
  const get = async () => {
    const res = await w.call(await admin(), 'GET', '/api/admin/events');
    expect(res.statusCode, res.body).toBe(200);
    return res.json<AdminEvents>();
  };
  const post = async (url: string, body?: object) => w.call(await admin(), 'POST', url, body);
  const calendarAudits = async () =>
    (await w.db.select().from(auditLog))
      .filter((a) => a.event === 'event.calendar')
      .map((a) => (a.data as { action: string }).action);
  /** Runs the clock to an event's end and past the close's grace, then the scheduler's step. */
  const runOut = async (endsAt: string) => {
    w.clock.ms = Date.parse(endsAt) + EVENT_CLOSE_GRACE_MS;
    return w.tick();
  };

  beforeAll(async () => {
    w = await world(BASE - 20 * MIN);
  });
  afterAll(() => w.close());

  it('answers 404 to everyone but admins, before the body', async () => {
    const player = await insertAccount(w.db, { now: w.now() });
    const moderator = await insertAccount(w.db, { role: 'moderator', now: w.now() });
    for (const who of [null, player, moderator]) {
      for (const [url, body] of [
        ['/api/admin/events/calendar', { paused: false }],
        ['/api/admin/events/calendar', { nonsense: 1 }],
        ['/api/admin/events/calendar/skip', undefined],
      ] as const) {
        const res = await w.call(who, 'POST', url, body);
        expect(res.statusCode, `${who?.role ?? 'anonymous'} ${url}`).toBe(404);
      }
    }
    expect(await w.db.select().from(auditLog).where(eq(auditLog.event, 'event.calendar'))).toEqual(
      [],
    );
  });

  it('starts paused with the default rotation; nothing is created; the next three are shown', async () => {
    const v = await get();
    expect(v.calendar).toMatchObject({ paused: true, saved: false, gapDays: 7, nextIndex: 0 });
    expect(v.calendar.rotation.map((e) => [e.definitionId, e.days])).toEqual([
      ['lanternProcession', 28],
      ['harvestOfBones', 7],
    ]);
    expect(v.calendar.planned.map((p) => [p.kind, p.definitionId])).toEqual([
      ['rotation', 'lanternProcession'],
      ['rotation', 'harvestOfBones'],
      ['rotation', 'lanternProcession'],
    ]);
    expect((await w.tick()).created).toBeNull();
    w.clock.ms += 30 * DAY;
    expect((await w.tick()).created).toBeNull();
    expect(await listEvents(w.db)).toEqual([]);
    w.clock.ms = BASE - 20 * MIN;
  });

  it('refuses bad settings (409 or 400) and changes nothing', async () => {
    const bad = await post('/api/admin/events/calendar', {
      rotation: [{ definitionId: 'nope', days: 7 }],
    });
    expect(bad.statusCode).toBe(409);
    expect(bad.json().error).toMatchObject({
      code: 'calendar_refused',
      details: { problem: 'unknown_event' },
    });
    expect((await post('/api/admin/events/calendar', { gapDays: 61 })).statusCode).toBe(400);
    expect((await post('/api/admin/events/calendar', {})).statusCode).toBe(400);
    expect(
      (
        await post('/api/admin/events/calendar', {
          rotation: [{ definitionId: 'harvestOfBones', days: 29 }],
        })
      ).statusCode,
    ).toBe(400);
    // Ticket 8.3b: a weekly event below its weeks: 400 with the minimum, not saved.
    const short = await post('/api/admin/events/calendar', {
      rotation: [{ definitionId: 'lanternProcession', days: 21 }],
    });
    expect(short.statusCode).toBe(400);
    expect(short.json().error).toMatchObject({
      code: 'length_too_short',
      details: { definitionId: 'lanternProcession', minDays: 28 },
    });
    expect(short.json().error.message).toContain('at least 28 days');
    expect((await readCalendar(w.db)).saved).toBe(false);
  });

  it('on: the first event on the coming Monday, its own length; one at a time; then the gap and a Monday', async () => {
    const set = await post('/api/admin/events/calendar', {
      rotation: [
        { definitionId: 'lanternProcession', days: 28 },
        { definitionId: 'harvestOfBones', days: 3 },
      ],
      gapDays: 2,
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json<AdminEvents>().calendar.paused).toBe(true);
    expect((await post('/api/admin/events/calendar', { paused: false })).statusCode).toBe(200);
    // The scheduler's next step creates it, once.
    const made = await w.tick();
    expect(made.created).toBe(1);
    expect((await w.tick()).created).toBeNull();
    const [e1] = await listEvents(w.db);
    expect(e1).toMatchObject({ definitionId: 'lanternProcession', source: 'calendar' });
    expect(e1!.startsAt.toISOString()).toBe(iso(BASE));
    expect(e1!.endsAt.toISOString()).toBe(iso(BASE + 28 * DAY));
    expect(e1!.calendarSlot).toBe(1);
    const v = await get();
    expect(v.next).toMatchObject({ number: 1, source: 'calendar' });
    expect(v.calendar.planned.map((p) => [p.kind, p.definitionId, p.startsAt])).toEqual([
      ['scheduled', 'lanternProcession', iso(BASE)],
      // 8.3b: the end + the 2-day gap, then the Monday after.
      ['rotation', 'harvestOfBones', iso(BASE + 35 * DAY)],
      ['rotation', 'lanternProcession', iso(BASE + 42 * DAY)],
    ]);
    // Under way and in the close's grace: nothing new.
    w.clock.ms = BASE + 10 * DAY;
    expect((await w.tick()).created).toBeNull();
    w.clock.ms = BASE + 28 * DAY + EVENT_CLOSE_GRACE_MS - 1;
    expect((await w.tick()).created).toBeNull();
    // Closed: the next one, the first Monday at least the gap after the end, its own length.
    const after = await runOut(iso(BASE + 28 * DAY));
    expect(after).toMatchObject({ closed: [1], swept: [1], created: 2 });
    const e2 = (await listEvents(w.db)).find((e) => e.number === 2)!;
    expect([e2.definitionId, e2.startsAt.toISOString(), e2.endsAt.toISOString()]).toEqual([
      'harvestOfBones',
      iso(BASE + 35 * DAY),
      iso(BASE + 38 * DAY),
    ]);
    // The boundaries of the new event (window rule): it is not under way before its start.
    w.clock.ms = BASE + 35 * DAY - 1;
    expect((await get()).current).toBeNull();
    w.clock.ms = BASE + 35 * DAY;
    expect((await get()).current?.number).toBe(2);
  });

  it('pause and resume: nothing while paused; on resume, the coming Monday', async () => {
    expect((await post('/api/admin/events/calendar', { paused: true })).statusCode).toBe(200);
    // Event 2 still runs out and closes; the paused calendar creates nothing.
    const out = await runOut(iso(BASE + 38 * DAY));
    expect(out).toMatchObject({ closed: [2], created: null });
    w.clock.ms = BASE + 50 * DAY + 17 * MIN;
    expect((await w.tick()).created).toBeNull();
    // Resumed long after: the coming Monday (never in the past), the rotation where it was.
    await post('/api/admin/events/calendar', { paused: false });
    expect((await w.tick()).created).toBe(3);
    const e3 = (await listEvents(w.db)).find((e) => e.number === 3)!;
    expect([e3.definitionId, e3.startsAt.toISOString()]).toEqual([
      'lanternProcession',
      iso(BASE + 56 * DAY),
    ]);
    expect(await calendarAudits()).toEqual(['set', 'resume', 'pause', 'resume']);
  });

  it('skip: a waiting automatic event is cancelled and the next entry takes its place', async () => {
    const skipped = await post('/api/admin/events/calendar/skip');
    expect(skipped.statusCode, skipped.body).toBe(200);
    expect((await listEvents(w.db)).find((e) => e.number === 3)!.cancelledAt).not.toBeNull();
    expect((await w.tick()).created).toBe(4);
    const e4 = (await listEvents(w.db)).find((e) => e.number === 4)!;
    expect(e4.definitionId).toBe('harvestOfBones');
    // The gap counts from the last event that ran (event 2), never from a cancelled one.
    expect(e4.startsAt.toISOString()).toBe(iso(BASE + 56 * DAY));
    // Event 4 runs out; the step creates the Procession (event 5), which is skipped while paused
    // (a pause keeps a waiting event; skip still cancels it): the Harvest comes next.
    await runOut(e4.endsAt.toISOString());
    const v = await get();
    expect(v.next?.definitionId).toBe('lanternProcession');
    await post('/api/admin/events/calendar', { paused: true });
    await post('/api/admin/events/calendar/skip');
    const c = await readCalendar(w.db);
    expect(c.settings.rotation[c.settings.nextIndex]!.definitionId).toBe('harvestOfBones');
    // Paused with nothing waiting: skip moves the cursor without creating anything.
    await post('/api/admin/events/calendar/skip');
    const c2 = await readCalendar(w.db);
    expect(c2.settings.rotation[c2.settings.nextIndex]!.definitionId).toBe('lanternProcession');
    expect((await w.tick()).created).toBeNull();
    expect((await calendarAudits()).filter((a) => a === 'skip')).toHaveLength(3);
  });

  it('a skip sent twice with the view it was made from skips once (ticket 8.7)', async () => {
    // Nothing waiting (paused): the first skip moves the cursor, the repeat is refused.
    const before = await readCalendar(w.db);
    const token = (await get()).calendar.skipToken;
    const first = await post('/api/admin/events/calendar/skip', { expect: token });
    expect(first.statusCode, first.body).toBe(200);
    const again = await post('/api/admin/events/calendar/skip', { expect: token });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ error: { code: string } }>().error.code).toBe('calendar_changed');
    const after = await readCalendar(w.db);
    expect(after.settings.nextIndex).toBe(
      (before.settings.nextIndex + 1) % before.settings.rotation.length,
    );
    // With the fresh view's token it skips again.
    const fresh = (await get()).calendar.skipToken;
    expect(fresh).not.toBe(token);
    expect((await post('/api/admin/events/calendar/skip', { expect: fresh })).statusCode).toBe(200);
    const restored = await readCalendar(w.db);
    expect(restored.settings.nextIndex).toBe(before.settings.nextIndex);
  });

  it('manual always wins: it replaces a waiting automatic event, whose entry comes back after it', async () => {
    await post('/api/admin/events/calendar', { paused: false });
    const created = (await w.tick()).created!;
    const auto = (await listEvents(w.db)).find((e) => e.number === created)!;
    expect(auto).toMatchObject({ definitionId: 'lanternProcession', source: 'calendar' });
    // The owner schedules the Harvest by hand, starting before the automatic one.
    const start = auto.startsAt.getTime() - DAY;
    const manual = await post('/api/admin/events', {
      definitionId: 'harvestOfBones',
      startsAt: iso(start),
      endsAt: iso(start + 2 * DAY),
    });
    expect(manual.statusCode, manual.body).toBe(200);
    const list = await listEvents(w.db);
    expect(list.find((e) => e.number === created)!.cancelledAt).not.toBeNull();
    const m = list.at(-1)!;
    expect(m).toMatchObject({ definitionId: 'harvestOfBones', source: 'manual' });
    const cancel = (await w.db.select().from(auditLog)).filter(
      (a) => a.event === 'event.cancel' && (a.data as { event: number }).event === created,
    );
    expect(cancel.map((a) => (a.data as { reason: string }).reason)).toEqual(['manual_override']);
    // While it waits the calendar creates nothing; once it closes, the displaced entry comes.
    w.clock.ms = start + DAY;
    expect((await w.tick()).created).toBeNull();
    const after = await runOut(m.endsAt.toISOString());
    const next = (await listEvents(w.db)).find((e) => e.number === after.created)!;
    expect(next.definitionId).toBe('lanternProcession');
    // The first Monday at least the gap (2 days, set above) after the manual event's end.
    expect(next.startsAt.toISOString()).toBe(
      ceilToMonday(new Date(m.endsAt.getTime() + 2 * DAY)).toISOString(),
    );
    expect(next.startsAt.getUTCDay()).toBe(1);
    // A manual plan that is refused (here: it starts in the past) rolls the displacement back:
    // the waiting automatic event stays.
    const refused = await post('/api/admin/events', {
      definitionId: 'harvestOfBones',
      startsAt: iso(w.clock.ms - 2 * DAY),
      endsAt: iso(w.clock.ms + DAY),
    });
    expect(refused.json().error.details.problem).toBe('starts_in_past');
    expect((await listEvents(w.db)).find((e) => e.number === next.number)!.cancelledAt).toBeNull();
  });

  it('never two at once over the whole history; every change and creation audited', async () => {
    const live = (await listEvents(w.db))
      .filter((e) => !e.cancelledAt)
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    for (let i = 1; i < live.length; i += 1)
      expect(live[i]!.startsAt.getTime()).toBeGreaterThanOrEqual(live[i - 1]!.endsAt.getTime());
    const auto = await calendarEvents(w.db);
    expect(auto.map((e) => e.calendarSlot)).toEqual(auto.map((_, i) => i + 1));
    // 8.3b: every automatic event starts on a Monday 00:00 UTC.
    for (const e of auto)
      expect(e.startsAt.toISOString()).toBe(ceilToMonday(e.startsAt).toISOString());
    const schedules = (await w.db.select().from(auditLog)).filter(
      (a) => a.event === 'event.schedule',
    );
    expect(schedules.filter((a) => (a.data as { via: string }).via === 'calendar')).toHaveLength(
      auto.length,
    );
    expect((await reconcileWithAudit(w.db)).filter((x) => !x.ok)).toEqual([]);
  });
});

describe('the calendar from the CLI (deploy/admin.sh events calendar …)', () => {
  let w: World;
  beforeAll(async () => {
    w = await world(BASE - 20 * MIN);
  });
  afterAll(() => w.close());
  const run = (...args: string[]) => runEventCommand(w.db, args, w.now());

  it('status, set, resume, skip, pause; audited via cli', async () => {
    expect(await run('calendar', 'status')).toContain('PAUSED');
    expect(await run('calendar', 'status')).toContain('defaults, never saved');
    const set = await run(
      'calendar',
      'set',
      '--rotation',
      'harvestOfBones:5,lanternProcession',
      '--gap',
      '3',
    );
    expect(set).toContain('harvestOfBones (5 days), lanternProcession (28 days)');
    expect(set).toContain('Gap between events: 3 days');
    expect(await run('calendar', 'resume')).toContain('Calendar: running');
    expect(await run('close')).toContain('The calendar put event 1 on the calendar.');
    const status = await formatCalendarStatus(w.db, w.now());
    expect(status).toContain('event 1, on the calendar (automatic)');
    // 8.3b: on a Monday, with the weekdays shown.
    expect(status).toContain(`Mon ${iso(BASE)} → Sat ${iso(BASE + 5 * DAY)}  Harvest of Bones`);
    expect(status).toContain('first Monday 00:00 UTC');
    expect(await run('calendar', 'skip')).toContain('Skipped Harvest of Bones (event 1 cancelled)');
    expect(await run('calendar', 'pause')).toContain('PAUSED');
    await expect(run('calendar', 'set')).rejects.toThrow(UsageError);
    await expect(run('calendar', 'set', '--rotation', 'nope:3')).rejects.toThrow(UsageError);
    await expect(run('calendar', 'set', '--gap', 'x')).rejects.toThrow(UsageError);
    await expect(run('calendar', 'set', '--rotation', 'harvestOfBones:40')).rejects.toThrow(
      UsageError,
    );
    await expect(run('calendar', 'frobnicate')).rejects.toThrow(UsageError);
    const audits = (await w.db.select().from(auditLog)).filter((a) => a.event === 'event.calendar');
    expect(audits.map((a) => (a.data as { via: string; action: string }).action)).toEqual([
      'set',
      'resume',
      'skip',
      'pause',
    ]);
    expect(audits.every((a) => (a.data as { via: string }).via === 'cli')).toBe(true);
  });
});

/** Applies synthetic quest events to a hero at the game clock (the progress rule). */
const apply = (
  w: World,
  hero: { id: string; accountId: string; level: number },
  events: QuestEvent[],
) =>
  withTransaction(w.db, (tx) => recordEventProgressTx(tx, hero, { questEvents: events }, w.now()));
const kills = (count: number, enemyId = 'risenFarmhand'): QuestEvent =>
  ({ type: 'enemyKilled', enemyId, count }) as QuestEvent;
const gathered = (count: number, materialId = 'timber'): QuestEvent =>
  ({ type: 'materialGathered', materialId, count }) as QuestEvent;
const boss: QuestEvent = { type: 'bossDefeated', bossId: 'gravewarden' };
const everything: QuestEvent[] = [
  kills(20_000),
  kills(20_000, 'hollowKnight'),
  gathered(5_000),
  ...Array.from({ length: 6 }, () => boss),
];

describe('the Lantern Procession: weekly unlocks, level gates, rewards exactly once', () => {
  let w: World;
  const start = BASE;
  const weekStart = (n: number) => start + (n - 1) * EVENT_WEEK_MS;
  beforeAll(async () => {
    w = await world(start - HOUR);
    await scheduleEvent(
      w.db,
      {
        definitionId: 'lanternProcession',
        startsAt: new Date(start),
        endsAt: new Date(start + 28 * DAY),
      },
      w.now(),
      cli,
    );
  });
  afterAll(() => w.close());

  interface Mine {
    current: {
      week: number;
      weeks: number;
      quests: { id: string; week: number; minLevel: number | null; opensAt: string }[];
    } | null;
    hero: { quests: { id: string; progress: number; open: boolean }[]; tallies: number } | null;
    track: { tallies: number; granted: { tier: number; cosmeticId: string }[] } | null;
  }
  const mine = async (who: TestAccount, id: string) => {
    const res = await w.call(who, 'GET', `/api/characters/${id}/event`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Mine>();
  };

  it('weeks open at the start + 7, 14, 21 days; a request 1 ms before a week counts nothing for it', async () => {
    const who = await insertAccount(w.db, { now: w.now() });
    const veteran = await w.hero(who, 50);
    const newcomer = await w.hero(who, 6);
    w.clock.ms = start;
    for (const h of [veteran, newcomer])
      expect((await w.call(who, 'POST', `/api/characters/${h.id}/event/join`)).statusCode).toBe(
        201,
      );
    const view = await mine(who, veteran.id);
    expect(view.current).toMatchObject({ week: 1, weeks: 4 });
    expect(view.current!.quests.filter((q) => q.week === 2).map((q) => q.opensAt)).toEqual([
      iso(weekStart(2)),
      iso(weekStart(2)),
      iso(weekStart(2)),
    ]);
    expect(view.hero!.quests.map((q) => q.open)).toEqual(
      proc.quests.map((q) => (q.week ?? 1) === 1),
    );
    // The newcomer: the deeper road (28+) stays shut even in its week.
    expect((await mine(who, newcomer.id)).hero!.quests.map((q) => q.open)).toEqual(
      proc.quests.map((q) => (q.week ?? 1) === 1 && q.minLevel === undefined),
    );

    // 1 ms before week 2: everything completes week 1 only (35 marks; tiers 1–2).
    w.clock.ms = weekStart(2) - 1;
    const w1 = await apply(w, veteran, everything);
    expect(w1!.completed).toEqual(['clearTheGateRoad', 'wickAndFrame', 'wardensAtTheGate']);
    expect(w1!.granted.map((g) => g.cosmeticId)).toEqual([
      'title-colour.wick-amber',
      'banner.procession-lantern',
    ]);
    // Week 2's first moment: its tasks open.
    w.clock.ms = weekStart(2);
    const w2 = await apply(w, veteran, everything);
    expect(w2!.completed).toEqual(['theAshenRoad', 'oilForTheLanterns', 'throughTheCinders']);
    const p = (
      await w.db
        .select()
        .from(eventParticipants)
        .where(and(eq(eventParticipants.event, 1), eq(eventParticipants.characterId, veteran.id)))
    )[0]!;
    proc.quests.forEach((q, i) => {
      if ((q.week ?? 1) > 2) expect(p.progress[i], q.id).toBe(0);
    });
    // The newcomer's open road in week 2 (same account: one track).
    const n2 = await apply(w, newcomer, everything);
    expect(n2!.completed).toEqual([
      'clearTheGateRoad',
      'wickAndFrame',
      'theAshenRoad',
      'oilForTheLanterns',
    ]);
    // Weeks 3 and 4; the newcomer reaches 28 only for week 4 (the deeper road from then on).
    w.clock.ms = weekStart(3);
    await apply(w, veteran, everything);
    w.clock.ms = weekStart(4);
    await apply(w, veteran, everything);
    await w.db.update(characters).set({ level: 28 }).where(eq(characters.id, newcomer.id));
    const n4 = await apply(w, { ...newcomer, level: 28 }, everything);
    // Earlier weeks stay open until the end: at 28 the whole deeper road opens for it.
    expect(n4!.completed).toEqual([
      'wardensAtTheGate',
      'throughTheCinders',
      'holdTheVerge',
      'brassForTheFrames',
      'keepersOfTheFlame',
      'toTheHollowsEdge',
      'theLastLight',
      'intoTheDark',
    ]);
    // 1 ms before the end counts; the end does not (the window rule, 6.6).
    w.clock.ms = start + 28 * DAY;
    expect(await apply(w, newcomer, everything)).toBeNull();
  });

  it('every tier once: the ledger, the unlocks and the audit agree; the sweep adds nothing', async () => {
    const grants = await w.db.select().from(eventTrackGrants).where(eq(eventTrackGrants.event, 1));
    expect(grants.map((g) => g.tier).sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const unlocks = await w.db.select().from(cosmeticUnlocks);
    expect(unlocks.map((u) => u.cosmeticId).sort()).toEqual(
      proc.track.map((t) => t.cosmeticId).sort(),
    );
    expect(unlocks.every((u) => u.source.startsWith('event:1:tier:'))).toBe(true);
    const rewards = (await w.db.select().from(auditLog)).filter((a) => a.event === 'event.reward');
    expect(rewards).toHaveLength(7);
    w.clock.ms = start + 28 * DAY + EVENT_CLOSE_GRACE_MS;
    expect(await w.tick()).toMatchObject({ closed: [1], swept: [1] });
    expect(await sweepEventRewards(w.db, 1, w.now())).toEqual({ kind: 'already' });
    expect(await w.db.select().from(eventTrackGrants)).toHaveLength(7);
    expect((await reconcileWithAudit(w.db)).filter((x) => !x.ok)).toEqual([]);
  });
});

describe('8.3b: a weekly event is never shorter than its weeks', () => {
  let w: World;
  beforeAll(async () => {
    w = await world(BASE - HOUR);
  });
  afterAll(() => w.close());

  it('refuses it by hand, by moving the end and in the CLI; ending it now still works', async () => {
    const admin = await insertAccount(w.db, { role: 'admin', now: w.now() });
    const schedule = (days: number, definitionId = 'lanternProcession') =>
      w.call(admin, 'POST', '/api/admin/events', {
        definitionId,
        startsAt: iso(BASE),
        endsAt: iso(BASE + days * DAY),
      });
    const short = await schedule(27);
    expect(short.statusCode).toBe(400);
    expect(short.json().error).toMatchObject({
      code: 'length_too_short',
      details: { definitionId: 'lanternProcession', minDays: 28 },
    });
    // A one-week event keeps 6.6's rules (an hour to four weeks).
    expect((await schedule(1, 'harvestOfBones')).statusCode).toBe(200);
    await w.call(admin, 'POST', '/api/admin/events/1/cancel');
    await expect(
      runEventCommand(
        w.db,
        ['schedule', 'lanternProcession', '--start', iso(BASE), '--days', '21'],
        w.now(),
      ),
    ).rejects.toThrow('at least 28 days');
    expect((await schedule(28)).statusCode).toBe(200);
    // Bringing the end forward below its weeks is refused; ending it now is not.
    w.clock.ms = BASE + DAY;
    const cut = await w.call(admin, 'POST', '/api/admin/events/2/end', {
      endsAt: iso(BASE + 20 * DAY),
    });
    expect(cut.statusCode).toBe(400);
    expect(cut.json().error.code).toBe('length_too_short');
    expect((await w.call(admin, 'POST', '/api/admin/events/2/end', {})).statusCode).toBe(200);
    // The calendar's CLI refuses a short rotation entry with the same words.
    await expect(
      runEventCommand(w.db, ['calendar', 'set', '--rotation', 'lanternProcession:14'], w.now()),
    ).rejects.toThrow('at least 28 days');
    expect((await readCalendar(w.db)).saved).toBe(false);
  });
});

describe('invariance: the Procession changes only materials, by its documented bonus', () => {
  let w: World;
  beforeAll(async () => {
    w = await world(BASE - 2 * DAY);
  });
  afterAll(() => w.close());

  const snapshot = async (id: string) => {
    const [c] = await w.db.select().from(characters).where(eq(characters.id, id));
    const items = await w.db
      .select({
        baseId: itemInstances.baseId,
        rarityId: itemInstances.rarityId,
        seed: itemInstances.seed,
        affixes: itemInstances.affixes,
      })
      .from(itemInstances)
      .where(eq(itemInstances.characterId, id));
    const mats = await w.db
      .select()
      .from(characterMaterials)
      .where(eq(characterMaterials.characterId, id));
    return {
      level: c!.level,
      xp: c!.experience,
      gold: c!.gold,
      items: items.sort((a, b) => a.seed - b.seed),
      materials: Object.fromEntries(mats.map((m) => [m.materialId, m.quantity])),
    };
  };

  it('farms the same hour without the event, outside it and joined', async () => {
    const [wa, wb, wc] = [
      await insertAccount(w.db, { now: w.now() }),
      await insertAccount(w.db, { now: w.now() }),
      await insertAccount(w.db, { now: w.now() }),
    ];
    const [none, outside, joined] = [await w.hero(wa), await w.hero(wb), await w.hero(wc)];
    const farm = async (who: TestAccount, id: string) => {
      expect((await w.call(who, 'POST', `/api/characters/${id}/select`)).statusCode).toBeLessThan(
        300,
      );
      const res = await w.call(who, 'POST', `/api/characters/${id}/activity`, {
        areaId: 'abandonedFields',
      });
      expect(res.statusCode, res.body).toBe(201);
    };
    const settle = (who: TestAccount, id: string) =>
      w.call(who, 'POST', `/api/characters/${id}/activity/settle`);
    await farm(wa, none.id);
    w.clock.ms += HOUR;
    await settle(wa, none.id);
    await scheduleEvent(
      w.db,
      {
        definitionId: 'lanternProcession',
        startsAt: w.now(),
        endsAt: new Date(w.now().getTime() + 28 * DAY),
      },
      w.now(),
      cli,
    );
    expect((await w.call(wc, 'POST', `/api/characters/${joined.id}/event/join`)).statusCode).toBe(
      201,
    );
    await farm(wb, outside.id);
    await farm(wc, joined.id);
    w.clock.ms += HOUR;
    await settle(wb, outside.id);
    await settle(wc, joined.id);
    const [a, b, c] = [
      await snapshot(none.id),
      await snapshot(outside.id),
      await snapshot(joined.id),
    ];
    expect(a.xp + a.level).toBeGreaterThan(6);
    expect(b).toEqual(a);
    const { materials, ...rest } = c;
    const { materials: am, ...aRest } = a;
    expect(rest).toEqual(aRest);
    // The bounty counted exactly the hour's gathered Timber, Ashwort, Raw Hide and Iron Ore.
    const p = (
      await w.db
        .select()
        .from(eventParticipants)
        .where(eq(eventParticipants.characterId, joined.id))
    )[0]!;
    const counted = ['timber', 'ashwort', 'rawHide', 'ironOre'].reduce(
      (s, m) => s + ((am as Record<string, number>)[m] ?? 0),
      0,
    );
    expect(p.bountyKills).toBe(counted);
    const bonus = Math.floor(counted / 25);
    // The seed is pinned (`hero`), so the hour is the same every run (≈ 45 gathered, 1 ore).
    expect(bonus).toBeGreaterThan(0);
    expect(p.bonus).toEqual({ ironOre: bonus });
    expect(materials).toEqual({
      ...am,
      ironOre: ((am as Record<string, number>).ironOre ?? 0) + bonus,
    });
    expect((await reconcileWithAudit(w.db)).filter((x) => !x.ok)).toEqual([]);
  });
});

describe('test accounts (D.4) take part but are left out of the counts', () => {
  let w: World;
  beforeAll(async () => {
    w = await world(BASE);
    await scheduleEvent(
      w.db,
      {
        definitionId: 'lanternProcession',
        startsAt: new Date(BASE),
        endsAt: new Date(BASE + 28 * DAY),
      },
      w.now(),
      cli,
    );
  });
  afterAll(() => w.close());

  it('counts players only; the tester still gets its keepsakes once', async () => {
    const admin = await insertAccount(w.db, { role: 'admin', now: w.now() });
    const player = await insertAccount(w.db, { now: w.now() });
    const tester = await insertAccount(w.db, { now: w.now() });
    await w.db.update(accounts).set({ isTest: true }).where(eq(accounts.id, tester.id));
    for (const who of [player, tester]) {
      const h = await w.hero(who, 50);
      expect((await w.call(who, 'POST', `/api/characters/${h.id}/event/join`)).statusCode).toBe(
        201,
      );
      await apply(w, h, everything);
      await apply(w, h, everything);
    }
    const res = await w.call(admin, 'GET', '/api/admin/events');
    expect(res.json<AdminEvents>().counts).toEqual([
      { event: 1, heroes: 1, accounts: 1, questsDone: 3, grants: 2 },
    ]);
    const tGrants = await w.db
      .select()
      .from(eventTrackGrants)
      .where(eq(eventTrackGrants.accountId, tester.id));
    expect(tGrants.map((g) => g.tier)).toEqual([1, 2]);
    // The tester's counters go to the test rollups (D.4); the player's report balances.
    const [testRows] = await queryRows<{ n: number }>(
      w.db,
      sql`select count(*)::int as n from telemetry_daily_test where metric = 'event.reward'`,
    );
    expect(testRows!.n).toBeGreaterThan(0);
    expect((await reconcileWithAudit(w.db)).filter((x) => !x.ok)).toEqual([]);
    expect(await w.db.select().from(worldEvents)).toHaveLength(1);
  });
});
