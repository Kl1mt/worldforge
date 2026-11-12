/**
 * Ticket 6.6: rotating events (docs/EVENTS.md). Each describe has its own database (events are
 * global). Dates derive from the wall clock (CLAUDE.md "Dates"); the game clock is injected.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import {
  EVENT_CLOSE_GRACE_MS,
  getEventDefinition,
  killBounty,
  type EnemyId,
  type QuestEvent,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import {
  accountNotifications,
  accounts,
  auditLog,
  characterMaterials,
  characters,
  cosmeticUnlocks,
  eventParticipants,
  eventTrackGrants,
  eventTracks,
  itemInstances,
  prestigeDisplays,
  worldEvents,
} from '../db/schema.js';
import { withTransaction } from '../db/transaction.js';
import { queryRows } from '../db/query.js';
import { createTestDatabase } from '../test/db.js';
import { insertCharacter } from '../test/heroes.js';
import { caller, insertAccount, type TestAccount } from '../test/social.js';
import { reconcileWithAudit } from '../telemetry/report.js';
import {
  runEventJobs,
  scheduleEvent,
  setEventEnd,
  sweepEventRewards,
  closeEvent,
} from './model.js';
import { recordEventProgressTx } from './progress.js';
import { runEventCommand, UsageError } from './event-cli.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** A Monday 00:00 UTC a month or so ahead of the wall clock. */
const BASE = (() => {
  const d = new Date(Date.now() + 30 * DAY);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return day + ((8 - new Date(day).getUTCDay()) % 7) * DAY;
})();
const harvest = getEventDefinition('harvestOfBones');
const cli = { accountId: null, via: 'cli' as const };

async function world(startMs = BASE - DAY) {
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
  /** A hero with a fixed farming seed, so two heroes farm the same fights. */
  const hero = async (
    who: TestAccount,
    level = 6,
    seedSecret = 'feedfacefeedfacefeedfacefeedface',
  ) => {
    const h = await insertCharacter(db, who.id, { level });
    await db
      .update(characters)
      .set({ farmState: { seedSecret, cycleIndex: 0, health: null } })
      .where(eq(characters.id, h.id));
    return h;
  };
  const farm = async (who: TestAccount, id: string, areaId = 'abandonedFields') => {
    const selected = await call(who, 'POST', `/api/characters/${id}/select`);
    expect(selected.statusCode, selected.body).toBeLessThan(300);
    return call(who, 'POST', `/api/characters/${id}/activity`, { areaId });
  };
  const settle = (who: TestAccount, id: string) =>
    call(who, 'POST', `/api/characters/${id}/activity/settle`);
  const join = (who: TestAccount, id: string) =>
    call(who, 'POST', `/api/characters/${id}/event/join`);
  const mine = async (who: TestAccount, id: string) => {
    const res = await call(who, 'GET', `/api/characters/${id}/event`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<HeroEvent>();
  };
  const participant = async (event: number, id: string) =>
    (
      await db
        .select()
        .from(eventParticipants)
        .where(and(eq(eventParticipants.event, event), eq(eventParticipants.characterId, id)))
    )[0];
  return { database, db, app, clock, now, call, hero, farm, settle, join, mine, participant };
}
type World = Awaited<ReturnType<typeof world>>;

interface HeroEvent {
  now: string;
  current: { number: number; name: string; status: string } | null;
  next: { number: number } | null;
  hero: {
    quests: { id: string; progress: number; target: number; done: boolean }[];
    tallies: number;
    bountyKills: number;
    bonus: Record<string, number>;
  } | null;
  track: { tallies: number; granted: { tier: number; cosmeticId: string }[] } | null;
}

/** Applies synthetic events to a hero's event progress in one transaction (the progress rule). */
const progress = (
  w: World,
  hero: { id: string; accountId: string },
  events: QuestEvent[],
  kills = {},
) =>
  withTransaction(w.db, (tx) =>
    recordEventProgressTx(
      tx,
      { level: 1, ...hero },
      { questEvents: events, killsByEnemy: kills },
      w.now(),
    ),
  );
const kill = (enemyId: EnemyId, count: number): QuestEvent => ({
  type: 'enemyKilled',
  enemyId,
  count,
});
const everything: QuestEvent[] = [
  kill('risenFarmhand', 60),
  kill('carrionWolf', 400),
  { type: 'materialGathered', materialId: 'soulShard', count: 12 },
  { type: 'bossDefeated', bossId: 'gravewarden' },
];

async function closeAll(w: World) {
  await w.app.close();
  await w.database.close();
}

describe('the event boundary (window rule, injected clock)', () => {
  let w: World;
  const start = BASE;
  const end = BASE + 7 * DAY;
  beforeAll(async () => {
    w = await world(start - HOUR);
    await scheduleEvent(
      w.db,
      { definitionId: 'harvestOfBones', startsAt: new Date(start), endsAt: new Date(end) },
      w.now(),
      cli,
    );
  });
  afterAll(() => closeAll(w));

  it('joins only while it runs; counts settlements that arrive in [start, end), then closes once', async () => {
    const who = await insertAccount(w.db, { now: w.now() });
    const h = await w.hero(who);
    // Before the start: announced, but nothing to join.
    expect((await w.mine(who, h.id)).next?.number).toBe(1);
    const early = await w.join(who, h.id);
    expect(early.statusCode).toBe(422);
    expect(early.json().error.code).toBe('no_event');

    // The first moment counts. Farming before the join (settled by it) does not.
    expect((await w.farm(who, h.id)).statusCode).toBe(201);
    w.clock.ms = start;
    expect((await w.join(who, h.id)).statusCode).toBe(201);
    expect((await w.join(who, h.id)).statusCode).toBe(200);
    const joined = (await w.participant(1, h.id))!;
    expect(joined.progress).toEqual([0, 0, 0, 0]);
    expect(joined.joinedAt).toEqual(new Date(start));

    w.clock.ms = start + HOUR;
    expect((await w.settle(who, h.id)).statusCode).toBe(200);
    const after1h = (await w.participant(1, h.id))!;
    expect(after1h.progress[2]).toBeGreaterThan(0); // kills anywhere
    expect(after1h.bountyKills).toBeGreaterThan(0);

    // A settlement 1 ms before the end counts; one at the end does not (its kills are still the
    // hero's: farming is unchanged, only the event ignores them).
    w.clock.ms = end - 1;
    await w.settle(who, h.id);
    const last = (await w.participant(1, h.id))!;
    expect(last.updatedAt).toEqual(new Date(end - 1));
    w.clock.ms = end;
    const atEnd = await w.settle(who, h.id);
    expect(atEnd.statusCode).toBe(200);
    expect(await w.participant(1, h.id)).toEqual(last);
    expect((await w.mine(who, h.id)).current).toBeNull();
    expect((await w.join(who, h.id)).statusCode).toBe(422);

    // Closed after the grace, once; nothing is written after it.
    expect(await runEventJobs(w.db, w.now())).toEqual({ closed: [], swept: [], created: null });
    w.clock.ms = end + EVENT_CLOSE_GRACE_MS;
    expect(await runEventJobs(w.db, w.now())).toEqual({ closed: [1], swept: [1], created: null });
    expect(await runEventJobs(w.db, w.now())).toEqual({ closed: [], swept: [], created: null });
    expect(await closeEvent(w.db, 1, w.now())).toBe('already');
    // A late progress write with a clock inside the window finds the event closed.
    expect(
      await withTransaction(w.db, (tx) =>
        recordEventProgressTx(tx, h, { questEvents: everything }, new Date(end - 1000)),
      ),
    ).toBeNull();
    expect(await w.participant(1, h.id)).toEqual(last);
    const audits = await w.db.select().from(auditLog).where(eq(auditLog.event, 'event.close'));
    expect(audits).toHaveLength(1);
  });
});

describe('one event at a time; admin controls and the permission matrix', () => {
  let w: World;
  let admin: TestAccount;
  beforeAll(async () => {
    w = await world(BASE - DAY);
    admin = await insertAccount(w.db, { role: 'admin', now: w.now() });
  });
  afterAll(() => closeAll(w));

  const iso = (ms: number) => new Date(ms).toISOString();

  it('answers 404 to everyone but admins, before the body', async () => {
    const player = await insertAccount(w.db, { now: w.now() });
    const moderator = await insertAccount(w.db, { role: 'moderator', now: w.now() });
    const routes: ['GET' | 'POST', string, object?][] = [
      ['GET', '/api/admin/events'],
      [
        'POST',
        '/api/admin/events',
        { definitionId: 'harvestOfBones', startsAt: iso(BASE), endsAt: iso(BASE + DAY) },
      ],
      ['POST', '/api/admin/events', { bad: true }],
      ['POST', '/api/admin/events/1/end', {}],
      ['POST', '/api/admin/events/1/cancel'],
    ];
    for (const who of [null, player, moderator]) {
      for (const [method, url, body] of routes) {
        const res = await w.call(who, method, url, body);
        expect(res.statusCode, `${who?.role ?? 'anonymous'} ${method} ${url}`).toBe(404);
      }
    }
    expect(await w.db.select().from(worldEvents)).toEqual([]);
    const res = await w.call(admin, 'GET', '/api/admin/events');
    expect(res.statusCode).toBe(200);
    expect(res.json().definitions.map((d: { id: string }) => d.id)).toEqual([
      'harvestOfBones',
      'lanternProcession',
    ]);
  });

  it('schedules, refuses a second at once, extends, ends early, cancels a future one; audited', async () => {
    const schedule = (s: number, e: number, definitionId = 'harvestOfBones') =>
      w.call(admin, 'POST', '/api/admin/events', {
        definitionId,
        startsAt: iso(s),
        endsAt: iso(e),
      });
    expect((await schedule(BASE, BASE + 7 * DAY, 'nope')).json().error.details.problem).toBe(
      'unknown_event',
    );
    const first = await schedule(BASE, BASE + 7 * DAY);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().next.number).toBe(1);
    // One waiting at a time, and never overlapping.
    const second = await schedule(BASE + 7 * DAY, BASE + 9 * DAY);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.details.problem).toBe('one_scheduled');
    // Cancel the waiting one; its window is free again; numbers are not reused.
    expect((await w.call(admin, 'POST', '/api/admin/events/1/cancel')).statusCode).toBe(200);
    expect((await schedule(BASE, BASE + 7 * DAY)).json().next.number).toBe(2);
    // Under way: no second, no overlap after it; it cannot be cancelled, only ended.
    w.clock.ms = BASE + DAY;
    expect((await schedule(BASE + 6 * DAY, BASE + 8 * DAY)).json().error.details.problem).toBe(
      'overlaps',
    );
    expect((await schedule(BASE + 7 * DAY, BASE + 8 * DAY)).statusCode).toBe(200);
    expect(
      (await w.call(admin, 'POST', '/api/admin/events/2/cancel')).json().error.details.problem,
    ).toBe('already_begun');
    // Extending into the next one is refused; extending the next one is fine.
    const extend = (n: number, to: number) =>
      w.call(admin, 'POST', `/api/admin/events/${n}/end`, { endsAt: iso(to) });
    expect((await extend(2, BASE + 7 * DAY + HOUR)).json().error.details.problem).toBe('overlaps');
    expect((await extend(3, BASE + 10 * DAY)).statusCode).toBe(200);
    // End early: now.
    const ended = await w.call(admin, 'POST', '/api/admin/events/2/end', {});
    expect(ended.statusCode).toBe(200);
    expect(ended.json().current).toBeNull();
    expect(ended.json().next.number).toBe(3);
    const events = (await w.db.select().from(auditLog)).filter((a) => a.event.startsWith('event.'));
    expect(events.map((a) => a.event)).toEqual([
      'event.schedule',
      'event.cancel',
      'event.schedule',
      'event.schedule',
      'event.extend',
      'event.end',
    ]);
    expect(
      events.every((a) => a.accountId === admin.id && (a.data as { via: string }).via === 'admin'),
    ).toBe(true);
    // The windows never overlap.
    const live = (await w.db.select().from(worldEvents)).filter((e) => !e.cancelledAt);
    for (const a of live)
      for (const b of live)
        if (a.number !== b.number)
          expect(a.startsAt < b.endsAt && b.startsAt < a.endsAt, `${a.number} vs ${b.number}`).toBe(
            false,
          );
  });

  it('the CLI uses the same rules', async () => {
    w.clock.ms = BASE + DAY + HOUR;
    expect(await runEventCommand(w.db, ['list'], w.now())).toContain(
      'harvestOfBones: Harvest of Bones',
    );
    const status = await runEventCommand(w.db, ['status'], w.now());
    expect(status, status).toContain('Next: Event 3 (Harvest of Bones)');
    await expect(runEventCommand(w.db, ['schedule', 'harvestOfBones'], w.now())).rejects.toThrow(
      UsageError,
    );
    await expect(
      runEventCommand(w.db, ['schedule', 'harvestOfBones', '--start', '2030-01-01'], w.now()),
    ).rejects.toThrow(UsageError);
    await expect(
      runEventCommand(
        w.db,
        ['schedule', 'harvestOfBones', '--start', iso(BASE + 20 * DAY)],
        w.now(),
      ),
    ).rejects.toThrow('Another event is already waiting');
    expect(await runEventCommand(w.db, ['cancel', '3'], w.now())).toBe(
      'Event 3 (Harvest of Bones) is cancelled.',
    );
    expect(
      await runEventCommand(
        w.db,
        ['schedule', 'harvestOfBones', '--start', iso(BASE + 20 * DAY), '--days', '3'],
        w.now(),
      ),
    ).toBe(
      `Scheduled Event 4 (Harvest of Bones): ${iso(BASE + 20 * DAY)} → ${iso(BASE + 23 * DAY)}.`,
    );
    expect(
      await runEventCommand(w.db, ['extend', '4', '--to', iso(BASE + 24 * DAY)], w.now()),
    ).toContain(`now ends at ${iso(BASE + 24 * DAY)}`);
    w.clock.ms = BASE + 21 * DAY;
    expect(await runEventCommand(w.db, ['end', '4'], w.now())).toContain('ended at');
    w.clock.ms = BASE + 22 * DAY;
    expect(await runEventCommand(w.db, ['close'], w.now())).toBe(
      'Closed: events 2, 4. Rewards swept: events 2, 4. Nothing else was due.',
    );
    const cliAudits = (await w.db.select().from(auditLog)).filter(
      (a) => a.event.startsWith('event.') && (a.data as { via?: string }).via === 'cli',
    );
    expect(cliAudits.map((a) => a.event)).toEqual([
      'event.cancel',
      'event.schedule',
      'event.extend',
      'event.end',
    ]);
  });
});

describe('an event ending mid-quest; the reward track exactly once', () => {
  let w: World;
  beforeAll(async () => {
    w = await world(BASE);
    await scheduleEvent(
      w.db,
      {
        definitionId: 'harvestOfBones',
        startsAt: new Date(BASE),
        endsAt: new Date(BASE + 7 * DAY),
      },
      w.now(),
      cli,
    );
  });
  afterAll(() => closeAll(w));

  it('two heroes of one account fill one track; each tier and cosmetic is granted once', async () => {
    w.clock.ms = BASE + HOUR;
    const who = await insertAccount(w.db, { now: w.now() });
    const a = await w.hero(who);
    const b = await w.hero(who);
    for (const h of [a, b]) expect((await w.join(who, h.id)).statusCode).toBe(201);
    // Hero a: the first two quests (20 tallies: tier 1).
    const first = await progress(w, a, everything.slice(0, 1).concat(everything[2]!));
    expect(first?.completed).toEqual(['turnTheFurrows', 'ossuaryTithe']);
    expect(first?.granted.map((g) => g.tier)).toEqual([1]);
    // Repeating the same events changes nothing (capped).
    expect(await progress(w, a, everything)).toMatchObject({
      completed: ['theLongReaping', 'stillAWarden'],
    });
    // a is done (50): tiers 2 and 3. b doing everything adds tallies but no tier twice.
    const bOut = await progress(w, b, everything);
    expect(bOut?.tallies).toBe(50);
    expect(bOut?.granted).toEqual([]);
    const view = await w.mine(who, b.id);
    expect(view.track?.tallies).toBe(100);
    expect(view.track?.granted.map((g) => g.cosmeticId)).toEqual(
      harvest.track.map((t) => t.cosmeticId),
    );
    expect(view.hero?.quests.every((q) => q.done)).toBe(true);
    const unlocks = await w.db
      .select()
      .from(cosmeticUnlocks)
      .where(eq(cosmeticUnlocks.accountId, who.id));
    expect(unlocks.map((u) => u.source).sort()).toEqual([
      'event:1:tier:1',
      'event:1:tier:2',
      'event:1:tier:3',
    ]);
    // Ticket 8.5: each tier once in the account's inbox, with its keepsake.
    const notes = await w.db
      .select()
      .from(accountNotifications)
      .where(
        and(
          eq(accountNotifications.accountId, who.id),
          eq(accountNotifications.kind, 'event.reward'),
        ),
      );
    expect(notes.map((n) => (n.data as { tier: number }).tier).sort()).toEqual([1, 2, 3]);
    expect(notes.map((n) => (n.data as { cosmeticId: string }).cosmeticId).sort()).toEqual(
      harvest.track.map((t) => t.cosmeticId).sort(),
    );
    const cos = await w.call(who, 'GET', '/api/account/cosmetics');
    expect(
      cos.json().unlocks.map((u: { id: string; shownToday: boolean }) => [u.id, u.shownToday]),
    ).toEqual([
      // Ticket 6.8: the collection book shows every keepsake.
      ['banner.harvest-sheaf', true],
      ['title-colour.bone-white', true],
      ['title.reaper-of-the-harvest', true],
    ]);
  });

  it('the title shows through the honours picker (one title at a time, only your own)', async () => {
    const who = (
      await w.db
        .select()
        .from(accounts)
        .where(sql`exists (select 1 from cosmetic_unlocks c where c.account_id = ${accounts.id})`)
    )[0]!;
    const token = await insertAccount(w.db, { now: w.now() }); // a stranger
    // Act as the owner: a fresh session for that account.
    const { createSession } = await import('../auth/index.js');
    const session = await createSession(w.db, who.id, new Date(w.now().getTime() - 1000), DAY);
    const me = {
      id: who.id,
      handle: who.handle,
      displayName: who.displayName,
      token: session.token,
      role: 'player' as const,
    };
    const set = (as: TestAccount, body: object) =>
      w.call(as, 'POST', '/api/account/prestige', body);
    const ok = await set(me, {
      title: null,
      frame: null,
      cosmeticTitle: 'title.reaper-of-the-harvest',
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().shown.cosmeticTitle).toBe('title.reaper-of-the-harvest');
    const both = await set(me, {
      title: { season: 1, metric: 'level' },
      frame: null,
      cosmeticTitle: 'title.reaper-of-the-harvest',
    });
    expect(both.statusCode).toBe(422);
    expect(
      (
        await set(token, { title: null, frame: null, cosmeticTitle: 'title.reaper-of-the-harvest' })
      ).json().error.code,
    ).toBe('award_not_earned');
    expect(
      (await set(me, { title: null, frame: null, cosmeticTitle: 'banner.harvest-sheaf' })).json()
        .error.code,
    ).toBe('award_not_earned');
    await w.db.update(accounts).set({ profileVisibility: 'public' }).where(eq(accounts.id, who.id));
    const profile = await w.call(token, 'GET', `/api/players/${who.handle}/profile`);
    expect(profile.statusCode, profile.body).toBe(200);
    expect(profile.json().profile.prestige.cosmeticTitle).toBe('title.reaper-of-the-harvest');
    const [d] = await w.db
      .select()
      .from(prestigeDisplays)
      .where(eq(prestigeDisplays.accountId, who.id));
    expect(d?.cosmeticTitle).toBe('title.reaper-of-the-harvest');
  });

  it('ends mid-quest: unfinished quests expire, nothing earned is lost, the next run starts fresh', async () => {
    const who = await insertAccount(w.db, { now: w.now() });
    const h = await w.hero(who);
    await w.join(who, h.id);
    const out = await progress(w, h, [kill('risenFarmhand', 30), kill('carrionWolf', 10)], {
      risenFarmhand: 85,
    });
    expect(out?.bonus).toEqual({ soulShard: 2 });
    const before = (await w.participant(1, h.id))!;
    expect(before.progress).toEqual([30, 2, 40, 0]);
    const shards = async () =>
      (
        await w.db
          .select()
          .from(characterMaterials)
          .where(
            and(
              eq(characterMaterials.characterId, h.id),
              eq(characterMaterials.materialId, 'soulShard'),
            ),
          )
      )[0]?.quantity ?? 0;
    expect(await shards()).toBe(2);
    // The owner ends it early.
    await setEventEnd(w.db, 1, w.now(), w.now(), cli);
    expect((await w.mine(who, h.id)).current).toBeNull();
    // Progress after the end changes nothing; the bonus shards stay.
    expect(await progress(w, h, everything, { risenFarmhand: 500 })).toBeNull();
    expect(await w.participant(1, h.id)).toEqual(before);
    expect(await shards()).toBe(2);
    w.clock.ms += EVENT_CLOSE_GRACE_MS;
    expect(await runEventJobs(w.db, w.now())).toEqual({ closed: [1], swept: [1], created: null });
    // Earlier tiers are kept.
    expect((await w.db.select().from(eventTrackGrants)).length).toBe(3);
    // The next run: a new number, fresh progress (the first run's cosmetics are not granted twice).
    await scheduleEvent(
      w.db,
      {
        definitionId: 'harvestOfBones',
        startsAt: w.now(),
        endsAt: new Date(w.now().getTime() + DAY),
      },
      w.now(),
      cli,
    );
    expect((await w.join(who, h.id)).statusCode).toBe(201);
    expect((await w.participant(2, h.id))!.progress).toEqual([0, 0, 0, 0]);
    expect((await w.mine(who, h.id)).hero?.tallies).toBe(0);
  });

  it('the sweep grants a tier still missing, exactly once, across a restart', async () => {
    // Tallies without their grants (as after a crash between them, or a lowered threshold):
    // three accounts on event 2.
    const rows = [];
    for (let i = 0; i < 3; i++) rows.push(await insertAccount(w.db, { now: w.now() }));
    await w.db.insert(eventTracks).values(
      rows.map((r, i) => ({
        event: 2,
        accountId: r.id,
        tallies: [10, 25, 50][i]!,
        updatedAt: w.now(),
      })),
    );
    w.clock.ms += DAY + EVENT_CLOSE_GRACE_MS;
    expect(await closeEvent(w.db, 2, w.now())).toBe('closed');
    await expect(
      sweepEventRewards(w.db, 2, w.now(), { batch: 1, failAfterBatches: 1 }),
    ).rejects.toThrow('stopped');
    const midway = await w.db.select().from(eventTrackGrants).where(eq(eventTrackGrants.event, 2));
    expect(midway).toHaveLength(1);
    expect(
      (await w.db.select().from(worldEvents).where(eq(worldEvents.number, 2)))[0]!.rewardsSweptAt,
    ).toBeNull();
    expect(await sweepEventRewards(w.db, 2, w.now(), { batch: 1 })).toEqual({
      kind: 'swept',
      granted: 5,
    });
    expect(await sweepEventRewards(w.db, 2, w.now())).toEqual({ kind: 'already' });
    const grants = await w.db.select().from(eventTrackGrants).where(eq(eventTrackGrants.event, 2));
    expect(grants.map((g) => g.tier).sort()).toEqual([1, 1, 1, 2, 2, 3]);
    // Reconciled: every grant audited and counted once; every tally audited... except the three
    // inserted by hand above, which the tallies check reports.
    const checks = await reconcileWithAudit(w.db);
    const bad = checks.filter((c) => !c.ok).map((c) => c.check);
    expect(bad).toEqual(['events: tallies held = tallies audited']);
  });
});

describe('invariance: no event, or not joined, means identical results; joined adds only the bonus', () => {
  let w: World;
  beforeAll(async () => {
    w = await world(BASE - 2 * DAY);
  });
  afterAll(() => closeAll(w));

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

  it('farms the same hour three ways', async () => {
    // One active hero per account: three accounts.
    const [wa, wb, wc] = [
      await insertAccount(w.db, { now: w.now() }),
      await insertAccount(w.db, { now: w.now() }),
      await insertAccount(w.db, { now: w.now() }),
    ];
    const [none, outside, joined] = [await w.hero(wa), await w.hero(wb), await w.hero(wc)];
    // No event at all.
    const started = await w.farm(wa, none.id);
    expect(started.statusCode, started.body).toBe(201);
    w.clock.ms += HOUR;
    await w.settle(wa, none.id);
    // An event under way: one hero stays out, one joins.
    await scheduleEvent(
      w.db,
      {
        definitionId: 'harvestOfBones',
        startsAt: w.now(),
        endsAt: new Date(w.now().getTime() + 2 * DAY),
      },
      w.now(),
      cli,
    );
    expect((await w.join(wc, joined.id)).statusCode).toBe(201);
    expect((await w.farm(wb, outside.id)).statusCode).toBe(201);
    expect((await w.farm(wc, joined.id)).statusCode).toBe(201);
    w.clock.ms += HOUR;
    await w.settle(wb, outside.id);
    await w.settle(wc, joined.id);
    const [a, b, c] = [
      await snapshot(none.id),
      await snapshot(outside.id),
      await snapshot(joined.id),
    ];
    expect(a.xp + a.level).toBeGreaterThan(6);
    expect(b).toEqual(a);
    // Joined: the same XP, gold and items; materials plus the bounty only.
    const p = (await w.participant(1, joined.id))!;
    // The seed is pinned (`hero`), so the hour is the same fights every run: 271 risen, 6 shards.
    const bonus = Math.floor(p.bountyKills / harvest.modifier.every);
    expect(bonus).toBeGreaterThan(0);
    expect(p.bonus).toEqual(bonus > 0 ? { soulShard: bonus } : {});
    const { materials, ...rest } = c;
    const { materials: aMaterials, ...aRest } = a;
    expect(rest).toEqual(aRest);
    expect(materials).toEqual({
      ...aMaterials,
      ...(bonus > 0 ? { soulShard: (aMaterials.soulShard ?? 0) + bonus } : {}),
    });
    // The bounty counted exactly the modifier's foes of that hour.
    const [reward] = await queryRows<{ kills: number }>(
      w.db,
      sql`select (data->>'kills')::int as kills from audit_log where event = 'activity.reward' and character_id = ${joined.id}`,
    );
    expect(p.bountyKills).toBeLessThanOrEqual(reward!.kills);
    expect(
      killBounty(harvest.modifier as Extract<typeof harvest.modifier, { kind: 'killBounty' }>, 0, {
        risenFarmhand: p.bountyKills,
      }).bonus,
    ).toEqual(p.bonus);
    // Telemetry and audit agree.
    expect((await reconcileWithAudit(w.db)).filter((x) => !x.ok)).toEqual([]);
  });

  it('nothing in the game rules reads the events or cosmetics modules', () => {
    const root = join(import.meta.dirname, '../../../../packages/game-core/src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) files.push(p);
      }
    };
    walk(root);
    const importers = files
      .filter((p) => /from '(\.\.\/)+events\//.test(readFileSync(p, 'utf8')))
      .map((p) => p.slice(root.length + 1))
      .filter((p) => !p.startsWith('events/') && !p.startsWith('quests/'))
      .sort();
    expect(importers).toEqual([]);
  });
});

describe('test accounts are left out of the participation counts', () => {
  let w: World;
  beforeAll(async () => {
    w = await world(BASE);
    await scheduleEvent(
      w.db,
      { definitionId: 'harvestOfBones', startsAt: new Date(BASE), endsAt: new Date(BASE + DAY) },
      w.now(),
      cli,
    );
  });
  afterAll(() => closeAll(w));

  it('counts players only', async () => {
    const admin = await insertAccount(w.db, { role: 'admin', now: w.now() });
    const player = await insertAccount(w.db, { now: w.now() });
    const tester = await insertAccount(w.db, { now: w.now() });
    await w.db.update(accounts).set({ isTest: true }).where(eq(accounts.id, tester.id));
    for (const who of [player, tester]) {
      const h = await w.hero(who);
      await w.join(who, h.id);
      await progress(w, h, everything);
    }
    const res = await w.call(admin, 'GET', '/api/admin/events');
    expect(res.json().counts).toEqual([
      { event: 1, heroes: 1, accounts: 1, questsDone: 4, grants: 3 },
    ]);
    expect((await reconcileWithAudit(w.db)).filter((x) => !x.ok)).toEqual([]);
  });
});
