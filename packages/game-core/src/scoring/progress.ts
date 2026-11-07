import { getArea, isAreaUnlocked, type AreaId } from '../world/areas.js';
import { cryptTierCleared, type WorldProgress } from '../world/unlocks.js';
import { NO_WORLD_FLAGS, type WorldFlags } from '../world/projects.js';
import { GUILD_BOSSES } from '../guild-boss/definitions.js';
import { FORMULA_VERSIONS, type Score, type ScoreLine } from './types.js';

/**
 * PvE Progress (ticket 5.1, docs/LEADERBOARDS.md): an ordered list of milestones, from the first
 * field to the Ashen Warden. The value is how many of them the hero has reached; ties go to the
 * hero whose furthest milestone is further along the list, then to the highest guild boss stage
 * the hero helped break (5.2 then breaks ties by who got there first). Only server state counts:
 * the hero's level and `characters.progress`, the world flags and the guild boss rewards.
 */
export type ProgressMilestone =
  /** The area is open to the hero (its unlock rule holds: level, Gravewarden, world flag). */
  | { id: string; kind: 'area'; areaId: AreaId }
  /** This Nameless Crypt tier cleared (boss killed). */
  | { id: string; kind: 'cryptTier'; tier: number; name: string }
  /** The Ashen Warden fell to this hero (the Warden's Watch). */
  | { id: string; kind: 'ashenWarden'; name: string };

/** In order: what a hero meets on the way up. Data; a new place adds a line (and a version). */
export const PVE_MILESTONES: readonly ProgressMilestone[] = [
  { id: 'area:abandonedFields', kind: 'area', areaId: 'abandonedFields' },
  { id: 'area:crowwood', kind: 'area', areaId: 'crowwood' },
  { id: 'area:oldBurialGrounds', kind: 'area', areaId: 'oldBurialGrounds' },
  { id: 'area:blackwater', kind: 'area', areaId: 'blackwater' },
  { id: 'crypt:1', kind: 'cryptTier', tier: 1, name: 'The Nameless Crypt, tier I cleared' },
  { id: 'area:sunkenAbbey', kind: 'area', areaId: 'sunkenAbbey' },
  { id: 'crypt:2', kind: 'cryptTier', tier: 2, name: 'The Nameless Crypt, tier II cleared' },
  { id: 'crypt:3', kind: 'cryptTier', tier: 3, name: 'The Nameless Crypt, tier III cleared' },
  { id: 'area:ashenPass', kind: 'area', areaId: 'ashenPass' },
  { id: 'watch', kind: 'ashenWarden', name: 'The Ashen Warden defeated' },
];

export interface PveProgressInput {
  level: number;
  progress: Partial<WorldProgress>;
  world?: WorldFlags;
  /**
   * The highest guild boss stage (0 = none) of a week in which this hero fought for the guild and
   * its account earned that stage's reward (docs/GUILD_BOSS.md "When a reward is earned").
   */
  guildBossStage: number;
}

export function milestoneName(m: ProgressMilestone): string {
  return m.kind === 'area' ? `${getArea(m.areaId).name} reached` : m.name;
}

function reached(m: ProgressMilestone, input: PveProgressInput): boolean {
  const progress: WorldProgress = {
    gravewardenDefeated: input.progress.gravewardenDefeated === true,
    ...(input.progress.cryptTierCleared !== undefined
      ? { cryptTierCleared: input.progress.cryptTierCleared }
      : {}),
  };
  switch (m.kind) {
    case 'area':
      return isAreaUnlocked(
        m.areaId,
        { level: input.level, world: input.world ?? NO_WORLD_FLAGS },
        progress,
      );
    case 'cryptTier':
      return cryptTierCleared(input.progress) >= m.tier;
    case 'ashenWarden':
      return input.progress.ashenWardenDefeated === true;
  }
}

const GUILD_STAGES = GUILD_BOSSES[0]!.stages;
/** The guild boss stage counted: a whole number within the boss's stages, else 0. */
export function countedGuildStage(stage: number): number {
  return Number.isInteger(stage) && stage >= 0 ? Math.min(stage, GUILD_STAGES.length) : 0;
}

export function pveProgressScore(input: PveProgressInput): Score {
  const lines: ScoreLine[] = [];
  let count = 0;
  let furthest = 0;
  for (const [i, m] of PVE_MILESTONES.entries()) {
    const ok = reached(m, input);
    if (ok) {
      count++;
      furthest = i + 1;
    }
    lines.push({
      id: m.id,
      label: milestoneName(m),
      detail: `Milestone ${i + 1} of ${PVE_MILESTONES.length}`,
      points: ok ? 1 : 0,
      counted: ok,
      ...(ok ? {} : { reason: 'not_reached' }),
    });
  }
  const stage = countedGuildStage(input.guildBossStage);
  const stageName = stage > 0 ? GUILD_STAGES.find((s) => s.stage === stage)!.name : null;
  lines.push({
    id: 'guildBoss',
    label: 'Guild boss: highest stage helped break',
    detail: stageName
      ? `Stage ${stage} of ${GUILD_STAGES.length}, ${stageName}: breaks ties`
      : 'No stage yet: breaks ties',
    points: stage,
    counted: stage > 0,
    ...(stage > 0 ? {} : { reason: 'not_reached' }),
  });
  return {
    metric: 'pveProgress',
    formulaVersion: FORMULA_VERSIONS.pveProgress,
    value: count,
    sortKey: [count, furthest, stage],
    summary: `How many of the ${PVE_MILESTONES.length} milestones of Graumark and the Ashen Pass you have reached; ties go to the furthest milestone, then the guild boss.`,
    lines,
  };
}
