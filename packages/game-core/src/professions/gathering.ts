import type { Rng } from '../rng.js';
import type { AreaId } from '../world/areas.js';
import { getEnemy, type EnemyId } from '../world/enemies.js';
import { getMaterial, type MaterialId, type ProfessionId } from '../world/materials.js';
import { DEFAULT_PROFESSION_CONFIG, type ProfessionConfig } from './config.js';
import type { ProfessionLevels } from './progression.js';

export interface GatheredUnits {
  materialId: MaterialId;
  quantity: number;
  /** The gathering profession, or null for combat drops (no profession XP). */
  professionId: ProfessionId | null;
}

/** A committed farming cycle as gathering sees it. */
export interface GatheringCycle {
  areaId: AreaId;
  outcome: 'kill' | 'death' | 'timeout';
  enemyId: EnemyId;
}

/** Units per find at a profession level: `1 + bonusUnitsPerLevel · (level − 1)`, randomised. */
export function unitsPerFind(level: number, rng: Rng, config: ProfessionConfig): number {
  const bonus = config.bonusUnitsPerLevel * (level - 1);
  const whole = Math.floor(bonus);
  // Always one draw (also at level 1), so the stream advances the same way at every level.
  return 1 + whole + (rng.next() < bonus - whole ? 1 : 0);
}

/**
 * Rolls one cycle's gathering. The hero gathers on every committed cycle it survives (kill or
 * timeout; a death ends the cycle at the respawn), one roll per yield of the area; undead kills
 * additionally roll the area's undead drops. `rng` must be the cycle's own stream
 * (`${seed}:gather:${index}`), so results do not depend on how a window is split.
 *
 * Pure: reads `professions` (the levels at the start of the cycle) and returns the finds; the
 * caller applies profession XP.
 */
export function rollGathering(
  cycle: GatheringCycle,
  professions: ProfessionLevels,
  rng: Rng,
  config: ProfessionConfig = DEFAULT_PROFESSION_CONFIG,
): GatheredUnits[] {
  if (cycle.outcome === 'death') return [];
  const area = config.areas[cycle.areaId];
  if (!area) return [];
  const found: GatheredUnits[] = [];
  for (const y of area.yields) {
    // Always draw, so one node's result never shifts another node's roll.
    const hit = rng.next() < y.chance;
    const professionId = getMaterial(y.materialId).profession;
    const level = professionId ? professions[professionId].level : 1;
    const quantity = unitsPerFind(level, rng, config);
    if (hit) found.push({ materialId: y.materialId, quantity, professionId });
  }
  if (cycle.outcome === 'kill' && getEnemy(cycle.enemyId).undead) {
    for (const d of area.undeadDrops) {
      if (rng.chance(d.chance))
        found.push({ materialId: d.materialId, quantity: 1, professionId: null });
    }
  }
  return found;
}
