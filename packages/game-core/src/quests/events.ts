import type { AreaId } from '../world/areas.js';
import type { EnemyId } from '../world/enemies.js';
import type { MaterialId } from '../world/materials.js';

/**
 * Something that happened to a character in the world and may advance its quests (ticket 2.4).
 * Events come from server-side settlements (farming) and dungeon runs (ticket 2.5), never from the
 * client. Counting events are additive, so a span of farming produces the same progress however it
 * is split into settlements.
 */
export type QuestEvent =
  /** Enemies killed while farming (from `FarmingSettlement.killsByEnemy`). */
  | { type: 'enemyKilled'; enemyId: EnemyId; count: number }
  /** Materials gathered or dropped (from `FarmingSettlement.materials`). */
  | { type: 'materialGathered'; materialId: MaterialId; count: number }
  /** The character farmed in an area (credited time there). */
  | { type: 'areaReached'; areaId: AreaId }
  /** A named boss was defeated (the dungeon run result, ticket 2.5). */
  | { type: 'bossDefeated'; bossId: EnemyId };

/** The parts of a farming settlement that quests listen to. */
export interface QuestSettlementFacts {
  /** Area the window started in. */
  startAreaId: AreaId;
  /** Area at the window end (differs after a pending switch). */
  endAreaId: AreaId;
  /** Whether the window committed at least one cycle. */
  encounters: number;
  killsByEnemy: Partial<Record<EnemyId, number>>;
  materials: Partial<Record<MaterialId, number>>;
}

/**
 * Quest events of one farming settlement. An area counts as reached once a cycle there has been
 * committed; kills and materials are passed through as counts (in a stable order).
 */
export function questEventsFromSettlement(facts: QuestSettlementFacts): QuestEvent[] {
  const events: QuestEvent[] = [];
  if (facts.encounters > 0) {
    events.push({ type: 'areaReached', areaId: facts.startAreaId });
    if (facts.endAreaId !== facts.startAreaId) {
      events.push({ type: 'areaReached', areaId: facts.endAreaId });
    }
  }
  for (const [enemyId, count] of Object.entries(facts.killsByEnemy) as [EnemyId, number][]) {
    if (count > 0) events.push({ type: 'enemyKilled', enemyId, count });
  }
  for (const [materialId, count] of Object.entries(facts.materials) as [MaterialId, number][]) {
    if (count > 0) events.push({ type: 'materialGathered', materialId, count });
  }
  return events;
}
