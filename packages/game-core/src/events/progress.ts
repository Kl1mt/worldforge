import type { QuestEvent } from '../quests/events.js';
import type { EnemyId } from '../world/enemies.js';
import type { MaterialId } from '../world/materials.js';
import type {
  EventDefinition,
  EventModifier,
  EventObjective,
  EventTrackTier,
} from './definitions.js';

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
    case 'defeatBoss':
      return e.type === 'bossDefeated' && (o.bossIds === null || o.bossIds.includes(e.bossId))
        ? 1
        : 0;
  }
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
): { progress: number[]; completed: string[] } {
  const completed: string[] = [];
  const next = def.quests.map((q, i) => {
    const target = eventObjectiveTarget(q.objective);
    const before = Math.min(target, Math.max(0, progress[i] ?? 0));
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
  modifier: EventModifier,
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
  if (def.quests.length < 3 || def.quests.length > 5) p('3–5 quests');
  if (new Set(def.quests.map((q) => q.id)).size !== def.quests.length) p('duplicate quest ids');
  for (const q of def.quests) {
    if (!Number.isInteger(q.tallies) || q.tallies <= 0) p(`${q.id}: tallies`);
    const o = q.objective;
    if (!Number.isInteger(o.count) || o.count <= 0) p(`${q.id}: count`);
    if (o.kind === 'kill' && o.enemyIds?.some((e) => !known.enemies.has(e))) p(`${q.id}: enemy`);
    if (o.kind === 'defeatBoss' && o.bossIds?.some((e) => !known.bosses.has(e))) p(`${q.id}: boss`);
    if (o.kind === 'gather' && !known.materials.has(o.materialId)) p(`${q.id}: material`);
  }
  const total = def.quests.reduce((s, q) => s + q.tallies, 0);
  let last = 0;
  for (const t of def.track) {
    if (t.tallies <= last) p(`tier ${t.tier}: tallies must rise`);
    last = t.tallies;
    if (!known.cosmetics.has(t.cosmeticId)) p(`tier ${t.tier}: unknown cosmetic ${t.cosmeticId}`);
  }
  if (last > total) p('the top tier needs more tallies than the quests give');
  if (new Set(def.track.map((t) => t.cosmeticId)).size !== def.track.length)
    p('a cosmetic twice on the track');
  const m = def.modifier;
  if (!Number.isInteger(m.every) || m.every < 10) p('modifier: every ≥ 10');
  if (m.enemyIds.length === 0 || m.enemyIds.some((e) => !known.enemies.has(e)))
    p('modifier: enemies');
  if (!known.materials.has(m.materialId)) p('modifier: material');
  return problems;
}
