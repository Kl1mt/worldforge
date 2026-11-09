import type { ClassId } from '../classes.js';
import type { WorldFlags } from '../world/projects.js';
import type { WorldProgress } from '../world/unlocks.js';
import type { ScoredItem } from './equipment.js';
import { gearScore } from './gear.js';
import { levelScore } from './level.js';
import { powerScore } from './power.js';
import { pveProgressScore } from './progress.js';
import {
  FORMULA_VERSIONS,
  SUPPORTED_FORMULA_VERSIONS,
  type FormulaVersions,
  type Score,
  type ScoreMetric,
} from './types.js';

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

/**
 * One metric's score of a hero at a formula version (default: the newest). Pure and
 * deterministic. Ticket 6.1: every version in `SUPPORTED_FORMULA_VERSIONS` can be computed, so the
 * server can keep an older one in force until the season ends.
 */
export function computeScore(
  metric: ScoreMetric,
  input: ScoringInput,
  version: number = FORMULA_VERSIONS[metric],
): Score {
  if (!SUPPORTED_FORMULA_VERSIONS[metric].includes(version))
    throw new RangeError(`Unsupported ${metric} formula version: ${version}`);
  switch (metric) {
    case 'level':
      return levelScore(input.level, input.experience);
    case 'gearScore':
      return gearScore(input.classId, input.equipment);
    case 'power':
      return powerScore(input.classId, input.level, input.equipment, version);
    case 'pveProgress':
      return pveProgressScore(
        {
          level: input.level,
          progress: input.progress,
          ...(input.world ? { world: input.world } : {}),
          guildBossStage: input.guildBossStage,
        },
        version,
      );
  }
}

/** All four scores of a hero at the given versions (default: the newest). Pure. */
export function computeScores(
  input: ScoringInput,
  versions: FormulaVersions = FORMULA_VERSIONS,
): Scores {
  return {
    formulaVersions: versions,
    level: computeScore('level', input, versions.level),
    gearScore: computeScore('gearScore', input, versions.gearScore),
    power: computeScore('power', input, versions.power),
    pveProgress: computeScore('pveProgress', input, versions.pveProgress),
  };
}
