import type { ClassId } from '../classes.js';
import type { WorldFlags } from '../world/projects.js';
import type { WorldProgress } from '../world/unlocks.js';
import type { ScoredItem } from './equipment.js';
import { gearScore } from './gear.js';
import { levelScore } from './level.js';
import { powerScore } from './power.js';
import { pveProgressScore } from './progress.js';
import { FORMULA_VERSIONS, type Score, type ScoreMetric } from './types.js';

/**
 * Everything the four scores read (ticket 5.1). The server builds it from its own rows; 5.2 stores
 * it next to each value, so any stored value can be recomputed with `computeScores`.
 */
export interface ScoringInput {
  classId: ClassId;
  level: number;
  experience: number;
  /** Equipped items only, with their slots (the `item_instances` columns). */
  equipment: readonly ScoredItem[];
  progress: Partial<WorldProgress>;
  world?: WorldFlags;
  /** See `PveProgressInput.guildBossStage`. */
  guildBossStage: number;
}

export interface Scores {
  formulaVersions: Readonly<Record<ScoreMetric, number>>;
  level: Score;
  gearScore: Score;
  power: Score;
  pveProgress: Score;
}

/** All four scores of a hero. Pure and deterministic. */
export function computeScores(input: ScoringInput): Scores {
  return {
    formulaVersions: FORMULA_VERSIONS,
    level: levelScore(input.level, input.experience),
    gearScore: gearScore(input.classId, input.equipment),
    power: powerScore(input.classId, input.level, input.equipment),
    pveProgress: pveProgressScore({
      level: input.level,
      progress: input.progress,
      ...(input.world ? { world: input.world } : {}),
      guildBossStage: input.guildBossStage,
    }),
  };
}
