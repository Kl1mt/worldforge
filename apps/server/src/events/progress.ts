import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  applyEventProgress,
  eventBounty,
  eventWeekAt,
  findEventDefinition,
  initialEventProgress,
  type EnemyId,
  type MaterialId,
  type QuestEvent,
} from '@worldforge/game-core';
import { eventParticipants, eventTracks, worldEvents, type WorldEvent } from '../db/schema.js';
import type { Transaction } from '../db/types.js';
import { writeAudit } from '../db/audit.js';
import { recordTelemetry } from '../telemetry/record.js';
import { changeMaterialsTx } from '../materials/store.js';
import { ApiError } from '../errors.js';
import { grantTiersTx, lockOpenEvent, type GrantedTier } from './model.js';

/**
 * Event progress (ticket 6.6, docs/EVENTS.md "Progress"). The only writer of event progress, the
 * modifier's bonus and the reward track's tallies. Called inside the transaction that produced the
 * events, after the character row is locked (the settlement, a dungeon claim), next to
 * `recordQuestEventsTx`; ordinary quests never see the event's bonus.
 */

export interface EventFacts {
  questEvents: readonly QuestEvent[];
  /** Kills by foe (farming); the kill bounty counts them. */
  killsByEnemy?: Partial<Record<EnemyId, number>>;
  /** Ticket 8.3: materials gathered while farming (the settlement's own); the gather bounty. */
  gathered?: Partial<Record<MaterialId, number>>;
}

export interface EventProgressOutcome {
  event: number;
  completed: string[];
  tallies: number;
  bonus: Partial<Record<MaterialId, number>>;
  granted: GrantedTier[];
}

/**
 * Applies a request's events to the hero's progress in the event under way at `now` (the request's
 * arrival: the window rule). Nothing happens unless the hero joined that event; `joinedBy` (a
 * dungeon claim: the run's start) leaves out events of something begun before the hero joined.
 */
export async function recordEventProgressTx(
  tx: Transaction,
  /** `level`: the hero's level when the request arrived (8.3's level-gated quests). */
  hero: { id: string; accountId: string; level: number },
  facts: EventFacts,
  now: Date,
  { joinedBy }: { joinedBy?: Date } = {},
): Promise<EventProgressOutcome | null> {
  const iso = now.toISOString();
  const [candidate] = await tx
    .select({ number: worldEvents.number })
    .from(eventParticipants)
    .innerJoin(worldEvents, eq(worldEvents.number, eventParticipants.event))
    .where(
      and(
        eq(eventParticipants.characterId, hero.id),
        sql`${worldEvents.startsAt} <= ${iso}::timestamptz`,
        sql`${worldEvents.endsAt} > ${iso}::timestamptz`,
        isNull(worldEvents.cancelledAt),
        isNull(worldEvents.closedAt),
      ),
    )
    .limit(1);
  if (!candidate) return null;
  const event = await lockOpenEvent(tx, candidate.number, now);
  if (!event) return null;
  const def = findEventDefinition(event.definitionId);
  if (!def) return null;
  const [p] = await tx
    .select()
    .from(eventParticipants)
    .where(
      and(eq(eventParticipants.event, event.number), eq(eventParticipants.characterId, hero.id)),
    )
    .for('update');
  if (!p) return null;
  if (joinedBy && p.joinedAt.getTime() > joinedBy.getTime()) return null;

  const bounty = eventBounty(def.modifier, p.bountyKills, facts);
  const bonusEvents: QuestEvent[] = (Object.entries(bounty.bonus) as [MaterialId, number][]).map(
    ([materialId, count]) => ({ type: 'materialGathered', materialId, count }),
  );
  // Ticket 8.3: only the weeks begun when the request arrived, and the hero's level then.
  const { progress, completed } = applyEventProgress(
    def,
    p.progress,
    [...facts.questEvents, ...bonusEvents],
    { week: eventWeekAt(event.startsAt, now), level: hero.level },
  );
  const moved = progress.some((v, i) => v !== p.progress[i]);
  if (!moved && bounty.counted === p.bountyKills) return null;

  const tallies = def.quests
    .filter((q) => completed.includes(q.id))
    .reduce((s, q) => s + q.tallies, 0);
  const bonusTotal = { ...p.bonus };
  for (const [id, n] of Object.entries(bounty.bonus) as [MaterialId, number][]) {
    bonusTotal[id] = (bonusTotal[id] ?? 0) + n;
  }
  await tx
    .update(eventParticipants)
    .set({
      progress,
      bountyKills: bounty.counted,
      bonus: bonusTotal,
      tallies: p.tallies + tallies,
      updatedAt: now,
    })
    .where(
      and(eq(eventParticipants.event, event.number), eq(eventParticipants.characterId, hero.id)),
    );
  const hasBonus = bonusEvents.length > 0;
  if (hasBonus) await changeMaterialsTx(tx, hero.id, bounty.bonus, now);

  let granted: GrantedTier[] = [];
  if (tallies > 0) {
    const [track] = await tx
      .insert(eventTracks)
      .values({ event: event.number, accountId: hero.accountId, tallies, updatedAt: now })
      .onConflictDoUpdate({
        target: [eventTracks.event, eventTracks.accountId],
        set: { tallies: sql`${eventTracks.tallies} + ${tallies}`, updatedAt: now },
      })
      .returning({ tallies: eventTracks.tallies });
    granted = await grantTiersTx(tx, event, def, hero.accountId, track!.tallies, now, 'progress');
  }
  if (hasBonus || completed.length > 0) {
    await writeAudit(tx, {
      event: 'event.progress',
      accountId: hero.accountId,
      characterId: hero.id,
      data: { event: event.number, eventId: def.id, completed, tallies, bonus: bounty.bonus },
    });
    recordTelemetry(tx, now, [
      ...def.quests
        .filter((q) => completed.includes(q.id))
        .map((q) => ({ metric: 'event.quest' as const, dims: [def.id, q.id], amount: q.tallies })),
      ...(Object.entries(bounty.bonus) as [MaterialId, number][]).map(([id, n]) => ({
        metric: 'material.in' as const,
        dims: ['event', id, def.id],
        amount: n,
      })),
    ]);
  }
  return { event: event.number, completed, tallies, bonus: bounty.bonus, granted };
}

/**
 * Joins the hero to the event under way (the caller locked and settled it, so nothing farmed
 * before the join counts). Repeat-safe by state: joining again changes nothing.
 */
export async function joinEventTx(
  tx: Transaction,
  hero: { id: string; accountId: string },
  current: WorldEvent | null,
  now: Date,
): Promise<{ joined: boolean }> {
  if (!current) throw new ApiError(422, 'no_event', 'No event is under way.');
  const event = await lockOpenEvent(tx, current.number, now);
  if (!event) throw new ApiError(422, 'no_event', 'No event is under way.');
  const def = findEventDefinition(event.definitionId);
  if (!def) throw new ApiError(422, 'no_event', 'No event is under way.');
  const rows = await tx
    .insert(eventParticipants)
    .values({
      event: event.number,
      characterId: hero.id,
      accountId: hero.accountId,
      progress: initialEventProgress(def),
      joinedAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ event: eventParticipants.event });
  if (rows.length === 0) return { joined: false };
  await writeAudit(tx, {
    event: 'event.join',
    accountId: hero.accountId,
    characterId: hero.id,
    data: { event: event.number, eventId: def.id },
  });
  recordTelemetry(tx, now, [{ metric: 'event.join', dims: [def.id] }]);
  return { joined: true };
}
