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
  | { id: string; kind: 'ashenWarden'; name: string }
  /** Ticket 6.1: the area is open to the hero and the hero has reached this level. */
  | { id: string; kind: 'areaLevel'; areaId: AreaId; level: number; name: string }
  /** Ticket 6.2: the Forge Tyrant fell to this hero (the Tyrant's Forge). */
  | { id: string; kind: 'forgeTyrant'; name: string };

/** In order: what a hero meets on the way up. Data; a new place adds a line (and a version). */
const MILESTONES_V1: readonly ProgressMilestone[] = [
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

/**
 * Version 2 (ticket 6.1) adds the Cinderwastes: the Ashfall Verge reached (level 28 and the
 * Warden), then holding its middle and its top (the hero at level 31 and 34 with the Verge open).
 */
const MILESTONES_V2: readonly ProgressMilestone[] = [
  ...MILESTONES_V1,
  { id: 'area:ashfallVerge', kind: 'area', areaId: 'ashfallVerge' },
  {
    id: 'verge:31',
    kind: 'areaLevel',
    areaId: 'ashfallVerge',
    level: 31,
    name: 'The Ashfall Verge, level 31',
  },
  {
    id: 'verge:34',
    kind: 'areaLevel',
    areaId: 'ashfallVerge',
    level: 34,
    name: 'The Ashfall Verge, level 34',
  },
];

/** Version 3 (ticket 6.2): the Cinder Depths and the Forge Tyrant. */
const MILESTONES_V3: readonly ProgressMilestone[] = [
  ...MILESTONES_V2,
  { id: 'area:cinderDepths', kind: 'area', areaId: 'cinderDepths' },
  {
    id: 'depths:37',
    kind: 'areaLevel',
    areaId: 'cinderDepths',
    level: 37,
    name: 'The Cinder Depths, level 37',
  },
  { id: 'forge', kind: 'forgeTyrant', name: 'The Forge Tyrant defeated' },
  {
    id: 'depths:40',
    kind: 'areaLevel',
    areaId: 'cinderDepths',
    level: 40,
    name: 'The Cinder Depths, level 40',
  },
];

const MILESTONES_V4: readonly ProgressMilestone[] = [
  ...MILESTONES_V3,
  { id: 'crypt:4', kind: 'cryptTier', tier: 4, name: 'The Nameless Crypt, Heroic cleared' },
];

/**
 * Every version's milestones (ticket 6.1), so stored rows of any of them recompute. Version 2
 * adds the Ashfall Verge (13 milestones); version 3 (ticket 6.2) the Cinder Depths reached (level
 * 34 and the Warden), its middle (level 37), the Forge Tyrant defeated and its top (level 40): 17;
 * version 4 (ticket 6.3) the Heroic crypt cleared (tier IV, level 32 and tier III): 18. It comes
 * last: the hardest crypt clear, often the last milestone a hero takes. Version 5 (ticket 8.1) the
 * Hollow Reach: the Pale Marches reached (level 40 and the Forge Tyrant), its middle (43) and its
 * top (46): 21.
 */
export const PVE_MILESTONES_BY_VERSION: Readonly<Record<number, readonly ProgressMilestone[]>> = {
  1: MILESTONES_V1,
  2: MILESTONES_V2,
  3: MILESTONES_V3,
  4: MILESTONES_V4,
  5: [
    ...MILESTONES_V4,
    { id: 'area:paleMarches', kind: 'area', areaId: 'paleMarches' },
    {
      id: 'marches:43',
      kind: 'areaLevel',
      areaId: 'paleMarches',
      level: 43,
      name: 'The Pale Marches, level 43',
    },
    {
      id: 'marches:46',
      kind: 'areaLevel',
      areaId: 'paleMarches',
      level: 46,
      name: 'The Pale Marches, level 46',
    },
  ],
};

/** The milestones of a version (throws for one that never existed). */
export function pveMilestones(
  version: number = FORMULA_VERSIONS.pveProgress,
): readonly ProgressMilestone[] {
  const list = PVE_MILESTONES_BY_VERSION[version];
  if (!list) throw new RangeError(`Unknown PvE Progress version: ${version}`);
  return list;
}

/** The current version's milestones. */
export const PVE_MILESTONES: readonly ProgressMilestone[] = pveMilestones();

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
    ...(input.progress.ashenWardenDefeated === true ? { ashenWardenDefeated: true } : {}),
    // Ticket 8.1: the Pale Marches' unlock reads it; no older milestone's area does.
    ...(input.progress.forgeTyrantDefeated === true ? { forgeTyrantDefeated: true } : {}),
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
    case 'forgeTyrant':
      return input.progress.forgeTyrantDefeated === true;
    case 'areaLevel':
      return (
        input.level >= m.level &&
        isAreaUnlocked(
          m.areaId,
          { level: input.level, world: input.world ?? NO_WORLD_FLAGS },
          progress,
        )
      );
  }
}

const GUILD_STAGES = GUILD_BOSSES[0]!.stages;
/** The guild boss stage counted: a whole number within the boss's stages, else 0. */
export function countedGuildStage(stage: number): number {
  return Number.isInteger(stage) && stage >= 0 ? Math.min(stage, GUILD_STAGES.length) : 0;
}

export function pveProgressScore(
  input: PveProgressInput,
  version: number = FORMULA_VERSIONS.pveProgress,
): Score {
  const milestones = pveMilestones(version);
  const lines: ScoreLine[] = [];
  let count = 0;
  let furthest = 0;
  for (const [i, m] of milestones.entries()) {
    const ok = reached(m, input);
    if (ok) {
      count++;
      furthest = i + 1;
    }
    lines.push({
      id: m.id,
      label: milestoneName(m),
      detail: `Milestone ${i + 1} of ${milestones.length}`,
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
    formulaVersion: version,
    value: count,
    sortKey: [count, furthest, stage],
    summary: `How many of the ${milestones.length} milestones of ${version >= 2 ? 'Graumark, the Ashen Pass and the Cinderwastes' : 'Graumark and the Ashen Pass'} you have reached; ties go to the furthest milestone, then the guild boss.`,
    lines,
  };
}
