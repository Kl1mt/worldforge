import type { AreaId } from '../world/areas.js';
import type { EnemyId } from '../world/enemies.js';
import type { MaterialId } from '../world/materials.js';
import type { QuestEvent } from './events.js';

/** One goal of a quest (GDD §11.1). */
export type QuestObjective =
  | { kind: 'kill'; enemyId: EnemyId; count: number }
  | { kind: 'gather'; materialId: MaterialId; count: number }
  | { kind: 'reach'; areaId: AreaId }
  | { kind: 'defeatBoss'; bossId: EnemyId };

/** Progress needed to complete an objective. */
export function objectiveTarget(objective: QuestObjective): number {
  return objective.kind === 'kill' || objective.kind === 'gather' ? objective.count : 1;
}

/** How much an event advances an objective (0 if it does not match). */
export function objectiveAdvance(objective: QuestObjective, event: QuestEvent): number {
  switch (objective.kind) {
    case 'kill':
      return event.type === 'enemyKilled' && event.enemyId === objective.enemyId
        ? Math.max(0, Math.floor(event.count))
        : 0;
    case 'gather':
      return event.type === 'materialGathered' && event.materialId === objective.materialId
        ? Math.max(0, Math.floor(event.count))
        : 0;
    case 'reach':
      return event.type === 'areaReached' && event.areaId === objective.areaId ? 1 : 0;
    case 'defeatBoss':
      return event.type === 'bossDefeated' && event.bossId === objective.bossId ? 1 : 0;
  }
}

/** Fresh progress for a list of objectives. */
export function initialProgress(objectives: readonly QuestObjective[]): number[] {
  return objectives.map(() => 0);
}

/**
 * Applies events to objective progress. Pure; never decreases progress and caps every objective at
 * its target, so applying events in any grouping gives the same result.
 */
export function applyQuestEvents(
  objectives: readonly QuestObjective[],
  progress: readonly number[],
  events: readonly QuestEvent[],
): number[] {
  return objectives.map((objective, i) => {
    const target = objectiveTarget(objective);
    let value = Math.min(target, Math.max(0, progress[i] ?? 0));
    for (const event of events) {
      if (value >= target) break;
      value = Math.min(target, value + objectiveAdvance(objective, event));
    }
    return value;
  });
}

export function isQuestComplete(
  objectives: readonly QuestObjective[],
  progress: readonly number[],
): boolean {
  return objectives.every((o, i) => (progress[i] ?? 0) >= objectiveTarget(o));
}
