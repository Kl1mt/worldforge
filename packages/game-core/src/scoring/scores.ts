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

/**
 * The part of the input each metric reads (ticket 5.2). The server hashes each slice to tell which
 * scores an event can have moved, so a farming settlement that only adds XP recomputes Character
 * Level and not Power. Keep in sync with `computeScore`: `scoring.test.ts` checks that changing a
 * field outside a metric's slice never changes that metric.
 */
export function metricInput(metric: ScoreMetric, input: ScoringInput): unknown {
  switch (metric) {
    case 'level':
      return { level: input.level, experience: input.experience };
    case 'gearScore':
      return { classId: input.classId, equipment: input.equipment };
    case 'power':
      return { classId: input.classId, level: input.level, equipment: input.equipment };
    case 'pveProgress':
      return {
        level: input.level,
        progress: input.progress,
        world: input.world ?? null,
        guildBossStage: input.guildBossStage,
      };
  }
}

/** One metric's score of a hero. Pure and deterministic. */
export function computeScore(metric: ScoreMetric, input: ScoringInput): Score {
  switch (metric) {
    case 'level':
      return levelScore(input.level, input.experience);
    case 'gearScore':
      return gearScore(input.classId, input.equipment);
    case 'power':
      return powerScore(input.classId, input.level, input.equipment);
    case 'pveProgress':
      return pveProgressScore({
        level: input.level,
        progress: input.progress,
        ...(input.world ? { world: input.world } : {}),
        guildBossStage: input.guildBossStage,
      });
  }
}

/** All four scores of a hero. Pure and deterministic. */
export function computeScores(input: ScoringInput): Scores {
  return {
    formulaVersions: FORMULA_VERSIONS,
    level: computeScore('level', input),
    gearScore: computeScore('gearScore', input),
    power: computeScore('power', input),
    pveProgress: computeScore('pveProgress', input),
  };
}
