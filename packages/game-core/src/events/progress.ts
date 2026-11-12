import type { QuestEvent } from '../quests/events.js';
import type { EnemyId } from '../world/enemies.js';
import type { MaterialId } from '../world/materials.js';
import type {
  EventDefinition,
  EventModifier,
  EventObjective,
  EventQuestDefinition,
  EventTrackTier,
} from './definitions.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Ticket 8.3: the length of an event week (weekly quests open one after another). */
export const EVENT_WEEK_MS = WEEK_MS;

/**
 * Event progress rules (ticket 6.6, docs/EVENTS.md "Progress"). Pure. Like quests, progress only
 * adds and caps at the target, so it is the same however a span of farming is split into
 * settlements.
 */

export function eventObjectiveTarget(o: EventObjective): number {
  return o.count;
}

/** How much one quest event advances an event objective (0 if it does not match). */
export function eventObjectiveAdvance(o: EventObjective, e: QuestEvent): number {
  switch (o.kind) {
    case 'kill':
      return e.type === 'enemyKilled' && (o.enemyIds === null || o.enemyIds.includes(e.enemyId))
        ? Math.max(0, Math.floor(e.count))
        : 0;
    case 'gather':
      return e.type === 'materialGathered' && e.materialId === o.materialId
        ? Math.max(0, Math.floor(e.count))
        : 0;
    case 'gatherAny':
      return e.type === 'materialGathered' && o.materialIds.includes(e.materialId)
        ? Math.max(0, Math.floor(e.count))
        : 0;
    case 'defeatBoss':
      return e.type === 'bossDefeated' && (o.bossIds === null || o.bossIds.includes(e.bossId))
        ? 1
        : 0;
  }
}

/** Ticket 8.3: the week a quest opens in (1 when the definition doesn't say). */
export function eventQuestWeek(q: Pick<EventQuestDefinition, 'week'>): number {
  return q.week ?? 1;
}

/** Ticket 8.3: how many weeks the definition's quest line spans. */
export function eventWeeks(def: EventDefinition): number {
  return Math.max(1, ...def.quests.map(eventQuestWeek));
}

/**
 * Ticket 8.3: the event week `at` falls in (1 from the start, 2 from seven days on, …), or 0
 * before the start. Weekly quests open at their week's first moment (the window rule).
 */
export function eventWeekAt(startsAt: Date, at: Date): number {
  const ms = at.getTime() - startsAt.getTime();
  return ms < 0 ? 0 : Math.floor(ms / WEEK_MS) + 1;
}

/** Ticket 8.3: when a quest opens (the event's start for week-1 quests). */
export function eventQuestOpensAt(startsAt: Date, q: Pick<EventQuestDefinition, 'week'>): Date {
  return new Date(startsAt.getTime() + (eventQuestWeek(q) - 1) * WEEK_MS);
}

/**
 * Ticket 8.3: what a request may advance: the event week it arrived in and the hero's level then.
 * Omitted (6.6's callers): every quest is open.
 */
export interface EventProgressContext {
  week: number;
  level: number;
}

/** Whether a quest is open to this request: its week has begun and the hero meets its level. */
export function eventQuestOpen(q: EventQuestDefinition, ctx?: EventProgressContext): boolean {
  if (!ctx) return true;
  return eventQuestWeek(q) <= ctx.week && ctx.level >= (q.minLevel ?? 0);
}

/** Fresh progress: one number per quest, in the definition's order. */
export function initialEventProgress(def: EventDefinition): number[] {
  return def.quests.map(() => 0);
}

/**
 * Applies quest events to a hero's event progress. Returns the new progress and the quests that
 * became complete with these events (each quest completes once: it is capped at its target).
 */
export function applyEventProgress(
  def: EventDefinition,
  progress: readonly number[],
  events: readonly QuestEvent[],
  ctx?: EventProgressContext,
): { progress: number[]; completed: string[] } {
  const completed: string[] = [];
  const next = def.quests.map((q, i) => {
    const target = eventObjectiveTarget(q.objective);
    const before = Math.min(target, Math.max(0, progress[i] ?? 0));
    // Ticket 8.3: a quest whose week has not begun, or whose level the hero lacks, waits.
    if (!eventQuestOpen(q, ctx)) return before;
    let value = before;
    for (const e of events) {
      if (value >= target) break;
      value = Math.min(target, value + eventObjectiveAdvance(q.objective, e));
    }
    if (before < target && value >= target) completed.push(q.id);
    return value;
  });
  return { progress: next, completed };
}

/** The quests done in a progress list. */
export function completedEventQuests(def: EventDefinition, progress: readonly number[]): string[] {
  return def.quests
    .filter((q, i) => (progress[i] ?? 0) >= eventObjectiveTarget(q.objective))
    .map((q) => q.id);
}

/** Tallies earned by a progress list (the done quests' tallies). */
export function eventTallies(def: EventDefinition, progress: readonly number[]): number {
  return def.quests.reduce(
    (sum, q, i) => sum + ((progress[i] ?? 0) >= eventObjectiveTarget(q.objective) ? q.tallies : 0),
    0,
  );
}

/**
 * The kill bounty: `counted` is the hero's running count of matching kills in this event before
 * the settlement. Returns the new count and the bonus material (floor of the new count over
 * `every`, minus the floor of the old one), so the bonus is split-invariant.
 */
export function killBounty(
  modifier: Extract<EventModifier, { kind: 'killBounty' }>,
  counted: number,
  killsByEnemy: Partial<Record<EnemyId, number>>,
): { counted: number; bonus: Partial<Record<MaterialId, number>> } {
  let add = 0;
  for (const id of modifier.enemyIds) add += Math.max(0, Math.floor(killsByEnemy[id] ?? 0));
  const before = Math.max(0, Math.floor(counted));
  const after = before + add;
  const n = Math.floor(after / modifier.every) - Math.floor(before / modifier.every);
  return { counted: after, bonus: n > 0 ? { [modifier.materialId]: n } : {} };
}

/**
 * Ticket 8.3: the gather bounty, like the kill bounty: `counted` is the hero's running count of
 * the modifier's materials gathered in this event before the settlement.
 */
export function gatherBounty(
  modifier: Extract<EventModifier, { kind: 'gatherBounty' }>,
  counted: number,
  gathered: Partial<Record<MaterialId, number>>,
): { counted: number; bonus: Partial<Record<MaterialId, number>> } {
  let add = 0;
  for (const id of modifier.materialIds) add += Math.max(0, Math.floor(gathered[id] ?? 0));
  const before = Math.max(0, Math.floor(counted));
  const after = before + add;
  const n = Math.floor(after / modifier.every) - Math.floor(before / modifier.every);
  return { counted: after, bonus: n > 0 ? { [modifier.materialId]: n } : {} };
}

/** What a settlement or a claim tells the modifier. */
export interface EventBountyFacts {
  /** Kills by foe (farming). */
  killsByEnemy?: Partial<Record<EnemyId, number>>;
  /** Materials gathered while farming (the settlement's own; never a hoard, never a bonus). */
  gathered?: Partial<Record<MaterialId, number>>;
}

/** The modifier's bounty for a definition, whatever its kind (6.6's kill, 8.3's gather). */
export function eventBounty(
  modifier: EventModifier,
  counted: number,
  facts: EventBountyFacts,
): { counted: number; bonus: Partial<Record<MaterialId, number>> } {
  switch (modifier.kind) {
    case 'killBounty':
      return killBounty(modifier, counted, facts.killsByEnemy ?? {});
    case 'gatherBounty':
      return gatherBounty(modifier, counted, facts.gathered ?? {});
  }
}

/** The track tiers an account with `tallies` has reached, lowest first. */
export function tiersReached(def: EventDefinition, tallies: number): EventTrackTier[] {
  return def.track.filter((t) => tallies >= t.tallies);
}

/** Content checks (`content.test.ts`-style): problems with a definition, empty when fine. */
export function validateEventDefinition(
  def: EventDefinition,
  known: {
    enemies: ReadonlySet<string>;
    bosses: ReadonlySet<string>;
    materials: ReadonlySet<string>;
    cosmetics: ReadonlySet<string>;
  },
): string[] {
  const problems: string[] = [];
  const p = (m: string) => problems.push(`${def.id}: ${m}`);
  // 6.6: 3–5 quests. Ticket 8.3: 3–5 quests in each week, weeks 1…n without a gap, every week
  // inside the default length, at most 20 quests in all.
  const weeks = eventWeeks(def);
  for (let w = 1; w <= weeks; w += 1) {
    const n = def.quests.filter((q) => eventQuestWeek(q) === w).length;
    if (n < 3 || n > 5) p(`week ${w}: 3–5 quests`);
  }
  if (def.quests.length > 20) p('at most 20 quests');
  if ((weeks - 1) * 7 >= def.defaultDays) p('a week of quests opens after the default end');
  if (new Set(def.quests.map((q) => q.id)).size !== def.quests.length) p('duplicate quest ids');
  for (const q of def.quests) {
    if (!Number.isInteger(q.tallies) || q.tallies <= 0) p(`${q.id}: tallies`);
    if (q.week !== undefined && (!Number.isInteger(q.week) || q.week < 1)) p(`${q.id}: week`);
    if (q.minLevel !== undefined && (!Number.isInteger(q.minLevel) || q.minLevel < 2))
      p(`${q.id}: minLevel`);
    const o = q.objective;
    if (!Number.isInteger(o.count) || o.count <= 0) p(`${q.id}: count`);
    if (o.kind === 'kill' && o.enemyIds?.some((e) => !known.enemies.has(e))) p(`${q.id}: enemy`);
    if (o.kind === 'kill' && o.enemyIds?.length === 0) p(`${q.id}: no foes`);
    if (o.kind === 'defeatBoss' && o.bossIds?.some((e) => !known.bosses.has(e))) p(`${q.id}: boss`);
    if (o.kind === 'gather' && !known.materials.has(o.materialId)) p(`${q.id}: material`);
    if (
      o.kind === 'gatherAny' &&
      (o.materialIds.length === 0 || o.materialIds.some((m) => !known.materials.has(m)))
    )
      p(`${q.id}: materials`);
  }
  const total = def.quests.reduce((s, q) => s + q.tallies, 0);
  if (def.track.length < 3 || def.track.length > 7) p('3–7 tiers');
  let last = 0;
  def.track.forEach((t, i) => {
    if (t.tier !== i + 1) p(`tier ${t.tier}: tiers are numbered 1…n`);
    if (t.tallies <= last) p(`tier ${t.tier}: tallies must rise`);
    last = t.tallies;
    if (!known.cosmetics.has(t.cosmeticId)) p(`tier ${t.tier}: unknown cosmetic ${t.cosmeticId}`);
  });
  if (last > total) p('the top tier needs more tallies than the quests give');
  // Ticket 8.3: the first tier is within reach of a hero of any level (quests open to all).
  const open = def.quests
    .filter((q) => q.minLevel === undefined)
    .reduce((s, q) => s + q.tallies, 0);
  if ((def.track[0]?.tallies ?? 0) > open) p('the first tier needs a level-gated quest');
  if (new Set(def.track.map((t) => t.cosmeticId)).size !== def.track.length)
    p('a cosmetic twice on the track');
  const m = def.modifier;
  if (!Number.isInteger(m.every) || m.every < 10) p('modifier: every ≥ 10');
  if (
    m.kind === 'killBounty' &&
    (m.enemyIds.length === 0 || m.enemyIds.some((e) => !known.enemies.has(e)))
  )
    p('modifier: enemies');
  if (
    m.kind === 'gatherBounty' &&
    (m.materialIds.length === 0 || m.materialIds.some((x) => !known.materials.has(x)))
  )
    p('modifier: materials');
  if (!known.materials.has(m.materialId)) p('modifier: material');
  return problems;
}
