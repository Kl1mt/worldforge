import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  EVENT_CLOSE_GRACE_MS,
  EVENT_PLAN_MESSAGES,
  eventAt,
  eventMinDays,
  eventQuestOpensAt,
  eventQuestWeek,
  eventStatus,
  eventWeekAt,
  eventWeeks,
  findEventDefinition,
  nextEvent,
  planEventCancel,
  planEventEnd,
  planEventSchedule,
  tiersReached,
  type EventDefinition,
  type EventPlanProblem,
  type EventStatus,
} from '@worldforge/game-core';
import {
  cosmeticUnlocks,
  eventTrackGrants,
  eventTracks,
  worldEvents,
  type WorldEvent,
} from '../db/schema.js';
import { queryRows } from '../db/query.js';
import { withTransaction } from '../db/transaction.js';
import type { Database, Executor, Transaction } from '../db/types.js';
import { notifyTx } from '../inbox/notify.js';
import { writeAudit } from '../db/audit.js';
import { ApiError } from '../errors.js';
import { recordTelemetry } from '../telemetry/record.js';
import { displaceCalendarEventTx, ensureCalendarEvent, type EnsureOptions } from './calendar.js';

/**
 * Rotating events (ticket 6.6, docs/EVENTS.md), modelled on 5.3's seasons:
 * - **The calendar.** `world_events` rows; every plan change (admin panel, CLI) runs under one
 *   advisory lock with game-core's rules (one at a time, never overlapping) and is audited.
 * - **The window rule.** Progress counts when the request that made it arrived inside
 *   `[starts_at, ends_at)`. A progress write takes the event's shared advisory lock and re-checks
 *   `closed_at`; the close takes it exclusively, so it waits for writes in flight and none follows.
 * - **The reward track.** Tiers are granted in the transaction that completes a quest, exactly once
 *   (`event_track_grants`' primary key, `on conflict do nothing`). After the close, a resumable
 *   sweep checks every account's tallies against the track and grants any tier still missing.
 */

const lockKey = (key: string) => sql`hashtextextended(${key}, 0)`;
const PLAN_LOCK = 'events:plan';
const eventLock = (n: number) => `event:${n}`;

export async function listEvents(db: Executor): Promise<WorldEvent[]> {
  return db.select().from(worldEvents).orderBy(asc(worldEvents.number));
}

/** An event as players, the admin panel and the CLI see it (the definition's content included). */
export interface EventView {
  number: number;
  definitionId: string;
  name: string;
  tagline: string;
  giver: string;
  description: string;
  tallyName: string;
  modifier: { name: string; description: string };
  /** Ticket 8.3: `week` (1…), `minLevel` (null: every hero) and when the quest opens. */
  quests: {
    id: string;
    name: string;
    description: string;
    target: number;
    tallies: number;
    week: number;
    minLevel: number | null;
    opensAt: string;
  }[];
  /** Ticket 8.3: how many weeks the quest line spans; the week under way (0 before the start). */
  weeks: number;
  week: number;
  track: {
    tier: number;
    tallies: number;
    cosmetic: { id: string; kind: string; name: string; description: string; shownToday: boolean };
  }[];
  startsAt: string;
  endsAt: string;
  status: EventStatus;
  /** Ticket 8.3: `manual` or `calendar`. */
  source: string;
}

export const eventViewSchema = {
  type: 'object',
  required: [
    'number',
    'definitionId',
    'name',
    'tagline',
    'giver',
    'description',
    'tallyName',
    'modifier',
    'quests',
    'track',
    'startsAt',
    'endsAt',
    'status',
    'weeks',
    'week',
    'source',
  ],
  properties: {
    number: { type: 'integer' },
    definitionId: { type: 'string' },
    name: { type: 'string' },
    tagline: { type: 'string' },
    giver: { type: 'string' },
    description: { type: 'string' },
    tallyName: { type: 'string' },
    modifier: {
      type: 'object',
      required: ['name', 'description'],
      properties: { name: { type: 'string' }, description: { type: 'string' } },
    },
    quests: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'name', 'description', 'target', 'tallies', 'week', 'minLevel', 'opensAt'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          target: { type: 'integer' },
          tallies: { type: 'integer' },
          week: { type: 'integer' },
          minLevel: { type: ['integer', 'null'] },
          opensAt: { type: 'string' },
        },
      },
    },
    track: {
      type: 'array',
      items: {
        type: 'object',
        required: ['tier', 'tallies', 'cosmetic'],
        properties: {
          tier: { type: 'integer' },
          tallies: { type: 'integer' },
          cosmetic: {
            type: 'object',
            required: ['id', 'kind', 'name', 'description', 'shownToday'],
            properties: {
              id: { type: 'string' },
              kind: { type: 'string' },
              name: { type: 'string' },
              description: { type: 'string' },
              shownToday: { type: 'boolean' },
            },
          },
        },
      },
    },
    startsAt: { type: 'string' },
    endsAt: { type: 'string' },
    status: { type: 'string' },
    weeks: { type: 'integer' },
    week: { type: 'integer' },
    source: { type: 'string' },
  },
} as const;

export function eventView(e: WorldEvent, now: Date, cosmetic: CosmeticLookup): EventView | null {
  const def = findEventDefinition(e.definitionId);
  if (!def) return null;
  return {
    number: e.number,
    definitionId: def.id,
    name: def.name,
    tagline: def.tagline,
    giver: def.giver,
    description: def.description,
    tallyName: def.tallyName,
    modifier: { name: def.modifier.name, description: def.modifier.description },
    quests: def.quests.map((q) => ({
      id: q.id,
      name: q.name,
      description: q.description,
      target: q.objective.count,
      tallies: q.tallies,
      week: eventQuestWeek(q),
      minLevel: q.minLevel ?? null,
      opensAt: eventQuestOpensAt(e.startsAt, q).toISOString(),
    })),
    weeks: eventWeeks(def),
    week: Math.min(eventWeeks(def), eventWeekAt(e.startsAt, now)),
    track: def.track.map((t) => ({
      tier: t.tier,
      tallies: t.tallies,
      cosmetic: cosmetic(t.cosmeticId),
    })),
    startsAt: e.startsAt.toISOString(),
    endsAt: e.endsAt.toISOString(),
    status: eventStatus(e, now),
    source: e.source,
  };
}

export type CosmeticLookup = (id: string) => {
  id: string;
  kind: string;
  name: string;
  description: string;
  shownToday: boolean;
};

/** The event under way and the next one, from a list. */
export function currentAndNextEvent(list: WorldEvent[], now: Date) {
  return { current: eventAt(list, now) ?? null, next: nextEvent(list, now) ?? null };
}

function planError(problem: EventPlanProblem, definitionId?: string): ApiError {
  if (problem === 'length_too_short') return lengthTooShort(definitionId ?? '');
  return new ApiError(409, 'event_plan_refused', EVENT_PLAN_MESSAGES[problem], { problem });
}

/**
 * Ticket 8.3b: a weekly event given fewer days than its weeks (by hand, by moving its end, or in
 * the calendar's rotation): `400 length_too_short` with the minimum.
 */
export function lengthTooShort(definitionId: string): ApiError {
  const def = findEventDefinition(definitionId);
  const minDays = def ? eventMinDays(def) : 0;
  return new ApiError(
    400,
    'length_too_short',
    `${def?.name ?? 'This event'} runs over ${minDays / 7} weeks, so it must last at least ${minDays} days.`,
    { definitionId, minDays },
  );
}

export interface EventPlanActor {
  /** An admin's account (audited on it), or the owner's CLI. */
  accountId: string | null;
  via: 'admin' | 'cli';
  /** Inside the plan transaction: e.g. re-check the admin's role. */
  guard?: (tx: Transaction) => Promise<void>;
}

export async function underPlanLock<T>(
  db: Database,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return withTransaction(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${lockKey(PLAN_LOCK)})`);
    return fn(tx);
  });
}

export async function scheduleEvent(
  db: Database,
  plan: { definitionId: string; startsAt: Date; endsAt: Date },
  now: Date,
  actor: EventPlanActor,
): Promise<WorldEvent> {
  return underPlanLock(db, async (tx) => {
    await actor.guard?.(tx);
    // Ticket 8.3: manual always wins over an automatic event that has not begun (cancelled, its
    // rotation entry comes back after this one). Rolled back with the rest if this plan is refused.
    const displaced = findEventDefinition(plan.definitionId)
      ? await displaceCalendarEventTx(tx, now, actor)
      : null;
    const out = planEventSchedule(await listEvents(tx), plan, now);
    if (!out.ok) throw planError(out.problem, plan.definitionId);
    const [row] = await tx
      .insert(worldEvents)
      .values({ number: out.number, ...plan, createdAt: now, source: 'manual' })
      .returning();
    await writeAudit(tx, {
      event: 'event.schedule',
      accountId: actor.accountId,
      data: {
        via: actor.via,
        event: out.number,
        definitionId: plan.definitionId,
        startsAt: plan.startsAt.toISOString(),
        endsAt: plan.endsAt.toISOString(),
        displaced,
      },
    });
    recordTelemetry(tx, now, [{ metric: 'event.schedule', dims: [plan.definitionId, actor.via] }]);
    return row!;
  });
}

/** Moves an event's end: earlier (end early, `endsAt` = now) or later (extend). */
export async function setEventEnd(
  db: Database,
  number: number,
  endsAt: Date,
  now: Date,
  actor: EventPlanActor,
): Promise<WorldEvent> {
  return underPlanLock(db, async (tx) => {
    await actor.guard?.(tx);
    const list = await listEvents(tx);
    const out = planEventEnd(list, number, endsAt, now);
    if (!out.ok) throw planError(out.problem, list.find((e) => e.number === number)?.definitionId);
    const [row] = await tx
      .update(worldEvents)
      .set({ endsAt })
      .where(eq(worldEvents.number, number))
      .returning();
    await writeAudit(tx, {
      event: endsAt.getTime() <= now.getTime() + 60_000 ? 'event.end' : 'event.extend',
      accountId: actor.accountId,
      data: {
        via: actor.via,
        event: number,
        from: out.event.endsAt.toISOString(),
        to: endsAt.toISOString(),
      },
    });
    return row!;
  });
}

/** Cancels an event that has not begun. */
export async function cancelEvent(
  db: Database,
  number: number,
  now: Date,
  actor: EventPlanActor,
): Promise<WorldEvent> {
  return underPlanLock(db, async (tx) => {
    await actor.guard?.(tx);
    const out = planEventCancel(await listEvents(tx), number, now);
    if (!out.ok) throw planError(out.problem);
    const [row] = await tx
      .update(worldEvents)
      .set({ cancelledAt: now })
      .where(eq(worldEvents.number, number))
      .returning();
    await writeAudit(tx, {
      event: 'event.cancel',
      accountId: actor.accountId,
      data: { via: actor.via, event: number, definitionId: out.event.definitionId },
    });
    return row!;
  });
}

/**
 * Inside a progress transaction: the event `number` if its window holds `at` and it is not closed,
 * read under its shared lock (re-checked after the lock), or null.
 */
export async function lockOpenEvent(
  tx: Transaction,
  number: number,
  at: Date,
): Promise<WorldEvent | null> {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(${lockKey(eventLock(number))})`);
  const [fresh] = await tx.select().from(worldEvents).where(eq(worldEvents.number, number));
  if (!fresh || fresh.closedAt || fresh.cancelledAt) return null;
  const t = at.getTime();
  return t >= fresh.startsAt.getTime() && t < fresh.endsAt.getTime() ? fresh : null;
}

export interface GrantedTier {
  tier: number;
  cosmeticId: string;
  /** False when the account already owned the cosmetic (e.g. from an earlier run of the event). */
  newUnlock: boolean;
}

/**
 * Grants every tier the account's `tallies` reach on the event's track that it does not hold yet:
 * a ledger row per (event, account, tier) and the tier's cosmetic, each `on conflict do nothing`,
 * so a tier is granted exactly once however many transactions try. Audits and counts only what it
 * inserted.
 */
export async function grantTiersTx(
  tx: Transaction,
  event: Pick<WorldEvent, 'number'>,
  def: EventDefinition,
  accountId: string,
  tallies: number,
  now: Date,
  via: 'progress' | 'sweep',
): Promise<GrantedTier[]> {
  const granted: GrantedTier[] = [];
  for (const t of tiersReached(def, tallies)) {
    const [ledger] = await tx
      .insert(eventTrackGrants)
      .values({
        event: event.number,
        accountId,
        tier: t.tier,
        cosmeticId: t.cosmeticId,
        grantedAt: now,
      })
      .onConflictDoNothing()
      .returning({ tier: eventTrackGrants.tier });
    if (!ledger) continue;
    const unlocked = await tx
      .insert(cosmeticUnlocks)
      .values({
        accountId,
        cosmeticId: t.cosmeticId,
        source: `event:${event.number}:tier:${t.tier}`,
        grantedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: cosmeticUnlocks.cosmeticId });
    const g = { tier: t.tier, cosmeticId: t.cosmeticId, newUnlock: unlocked.length > 0 };
    granted.push(g);
    await writeAudit(tx, {
      event: 'event.reward',
      accountId,
      data: { event: event.number, eventId: def.id, via, tallies, ...g },
    });
    // Ticket 8.5: the milestone and its keepsake, in the account's inbox (once per tier).
    await notifyTx(tx, {
      accountId,
      kind: 'event.reward',
      data: { eventId: def.id, event: event.number, tier: t.tier, cosmeticId: t.cosmeticId },
      now,
      dedupeKey: `event:${event.number}:tier:${t.tier}`,
    });
    recordTelemetry(tx, now, [
      { metric: 'event.reward', dims: [def.id, `tier${t.tier}`, t.cosmeticId] },
    ]);
  }
  return granted;
}

/**
 * Closes an ended event once (after `ends_at` + grace): under its exclusive lock, so progress in
 * flight finishes first and none is written after it. Unfinished quests expire from here on.
 */
export async function closeEvent(
  db: Database,
  number: number,
  now: Date,
  graceMs = EVENT_CLOSE_GRACE_MS,
): Promise<'closed' | 'already' | 'not_due' | 'missing'> {
  return withTransaction(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${lockKey(eventLock(number))})`);
    const [e] = await tx
      .select()
      .from(worldEvents)
      .where(eq(worldEvents.number, number))
      .for('update');
    if (!e || e.cancelledAt) return 'missing';
    if (e.closedAt) return 'already';
    if (now.getTime() < e.endsAt.getTime() + graceMs) return 'not_due';
    await tx.update(worldEvents).set({ closedAt: now }).where(eq(worldEvents.number, number));
    const [c] = await queryRows<{ heroes: number; accounts: number; done: number }>(
      tx,
      sql`select count(*)::int as heroes, count(distinct account_id)::int as accounts,
          coalesce(sum(tallies), 0)::int as done
        from event_participants where event = ${number}`,
    );
    await writeAudit(tx, {
      event: 'event.close',
      data: {
        event: number,
        definitionId: e.definitionId,
        heroes: c?.heroes ?? 0,
        accounts: c?.accounts ?? 0,
        tallies: c?.done ?? 0,
      },
    });
    return 'closed';
  });
}

export interface SweepOptions {
  /** Accounts checked per transaction. */
  batch?: number;
  /** Tests only: throw after this many batches (a restart mid-grant). */
  failAfterBatches?: number;
}

/**
 * The close's reward sweep: every account with tallies on the event gets every tier those reach
 * that it does not hold. Resumable and exactly-once: the grants are `on conflict do nothing`, and
 * `rewards_swept_at` is set only after the last batch, so a crash leaves it null and the next run
 * finishes the same set. Two sweeps at once grant each tier once.
 */
export async function sweepEventRewards(
  db: Database,
  number: number,
  now: Date,
  options: SweepOptions = {},
): Promise<{ kind: 'swept'; granted: number } | { kind: 'already' | 'not_closed' | 'missing' }> {
  const [e] = await db.select().from(worldEvents).where(eq(worldEvents.number, number));
  if (!e) return { kind: 'missing' };
  if (!e.closedAt) return { kind: 'not_closed' };
  if (e.rewardsSweptAt) return { kind: 'already' };
  const def = findEventDefinition(e.definitionId);
  const batch = Math.max(1, options.batch ?? 200);
  let granted = 0;
  let after = '00000000-0000-0000-0000-000000000000';
  for (let n = 0; def; n += 1) {
    const rows = await db
      .select({ accountId: eventTracks.accountId, tallies: eventTracks.tallies })
      .from(eventTracks)
      .where(and(eq(eventTracks.event, number), sql`${eventTracks.accountId} > ${after}::uuid`))
      .orderBy(asc(eventTracks.accountId))
      .limit(batch);
    if (rows.length === 0) break;
    if (options.failAfterBatches !== undefined && n >= options.failAfterBatches) {
      throw new Error(`reward sweep stopped after ${n} batches (test)`);
    }
    // One transaction per account: its counters follow its own test-account flag (D.4).
    for (const r of rows) {
      granted += await withTransaction(
        db,
        async (tx) => (await grantTiersTx(tx, e, def, r.accountId, r.tallies, now, 'sweep')).length,
      );
    }
    after = rows.at(-1)!.accountId;
  }
  await withTransaction(db, async (tx) => {
    const [fresh] = await tx
      .select()
      .from(worldEvents)
      .where(eq(worldEvents.number, number))
      .for('update');
    if (!fresh || fresh.rewardsSweptAt) return;
    await tx.update(worldEvents).set({ rewardsSweptAt: now }).where(eq(worldEvents.number, number));
    const [c] = await queryRows<{ n: number }>(
      tx,
      sql`select count(*)::int as n from event_track_grants where event = ${number}`,
    );
    await writeAudit(tx, { event: 'event.sweep', data: { event: number, grants: c?.n ?? 0 } });
  });
  return { kind: 'swept', granted };
}

export interface EventJobReport {
  closed: number[];
  swept: number[];
  /** Ticket 8.3: the event the calendar created, or null. */
  created: number | null;
}

/**
 * The scheduler's event step (and the CLI's `close`): close and sweep every ended event, then let
 * the calendar (8.3) put the next one on the calendar if it runs.
 */
export async function runEventJobs(
  db: Database,
  now: Date,
  options: { graceMs?: number; sweep?: SweepOptions; calendar?: EnsureOptions } = {},
): Promise<EventJobReport> {
  const report: EventJobReport = { closed: [], swept: [], created: null };
  const due = await db
    .select()
    .from(worldEvents)
    .where(
      and(
        isNull(worldEvents.cancelledAt),
        isNull(worldEvents.rewardsSweptAt),
        sql`${worldEvents.endsAt} <= ${now.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(worldEvents.number));
  for (const e of due) {
    if (!e.closedAt) {
      const out = await closeEvent(db, e.number, now, options.graceMs);
      if (out === 'closed') report.closed.push(e.number);
      if (out !== 'closed' && out !== 'already') continue;
    }
    const s = await sweepEventRewards(db, e.number, now, options.sweep);
    if (s.kind === 'swept') report.swept.push(e.number);
  }
  report.created = (await ensureCalendarEvent(db, now, options.calendar))?.number ?? null;
  return report;
}
