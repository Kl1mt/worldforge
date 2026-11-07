import type { BossEnrage, EnemyScale } from '../world/dungeons.js';
import type { EnemyId } from '../world/enemies.js';
import type { MaterialId } from '../world/materials.js';
import type { GuildBossWeek } from './week.js';

/**
 * The weekly guild boss (ticket 4.9, GDD §10.1 "group activities", docs/GUILD_BOSS.md). Content
 * is data: a boss reuses an existing enemy (its stats and art) with a scale, a fight window and a
 * ladder of stages. The owner-confirmed default is asynchronous: members fight it alone, at their
 * own time, and the damage adds up to their guild's total for the week.
 */

/** What each participant earns once their guild reaches a stage (personal, capped, no power). */
export interface GuildBossStageReward {
  gold: number;
  materials: Partial<Record<MaterialId, number>>;
}

export interface GuildBossStage {
  /** 1-based. */
  stage: number;
  name: string;
  /** The guild's weekly total (counted damage) that reaches this stage. */
  threshold: number;
  reward: GuildBossStageReward;
}

export interface GuildBossDefinition {
  id: string;
  name: string;
  /** One line for the guild page. */
  description: string;
  /** The enemy it is built from (stats, damage type, art: `getEnemy(enemyId).assetId`). */
  enemyId: EnemyId;
  /** The boss fights at the hero's level plus this (a match for every hero). */
  levelOffset: number;
  /** Scales the enemy's damage (and resistance); its health is unbounded (`BOSS_HEALTH`). */
  scale: EnemyScale;
  /** An attempt ends when the hero falls or after this long. */
  fightMs: number;
  /** The boss's rage: from a moment drawn per attempt in this window, it hits harder and faster. */
  enrage: BossEnrage;
  /**
   * The most damage one attempt counts toward the guild (no monopoly, GDD §12.2: a single
   * high-power hero adds at most this much per attempt; the rest is shown but not counted).
   */
  attemptDamageCap: number;
  /** Heroes below this level cannot fight it. */
  minLevel: number;
  /** In ascending threshold order. */
  stages: readonly GuildBossStage[];
}

/** Attempts per **account** per week, whatever guild it is in and whichever hero fights. */
export const GUILD_BOSS_ATTEMPTS_PER_WEEK = 3;

/**
 * The boss's health in an attempt: far more than any hero can deal in `fightMs`, so a fight is a
 * damage race against the boss's rage, never a kill.
 */
export const BOSS_HEALTH = 1_000_000_000;

export const GUILD_BOSSES: readonly GuildBossDefinition[] = [
  {
    id: 'risenGravewarden',
    name: 'The Risen Gravewarden',
    description:
      'Bound beneath the Nameless Crypt, it rises each week. No one hero can fell it; a guild can break it.',
    enemyId: 'gravewarden',
    levelOffset: 2,
    scale: { health: 1, damage: 1.6 },
    fightMs: 60_000,
    enrage: {
      atMs: { min: 20_000, max: 40_000 },
      damageMultiplier: 2.2,
      attackSpeedMultiplier: 1.5,
    },
    attemptDamageCap: 30_000,
    minLevel: 10,
    stages: [
      {
        stage: 1,
        name: 'Cracked',
        threshold: 18_000,
        reward: { gold: 250, materials: { soulShard: 3 } },
      },
      {
        stage: 2,
        name: 'Staggered',
        threshold: 120_000,
        reward: { gold: 400, materials: { soulShard: 5 } },
      },
      {
        stage: 3,
        name: 'Broken',
        threshold: 400_000,
        reward: { gold: 600, materials: { soulShard: 6, gravewardenSeal: 1 } },
      },
      {
        stage: 4,
        name: 'Shattered',
        threshold: 1_000_000,
        reward: { gold: 800, materials: { soulShard: 8 } },
      },
      {
        stage: 5,
        name: 'Laid to Rest',
        threshold: 2_200_000,
        reward: { gold: 1_000, materials: { soulShard: 10, gravewardenSeal: 1 } },
      },
    ],
  },
];

export type GuildBossId = string;

const BY_ID = new Map(GUILD_BOSSES.map((b) => [b.id, b]));

export function isGuildBossId(value: unknown): value is GuildBossId {
  return typeof value === 'string' && BY_ID.has(value);
}

export function getGuildBoss(id: GuildBossId): GuildBossDefinition {
  const boss = BY_ID.get(id);
  if (!boss) throw new RangeError(`Unknown guild boss: ${id}`);
  return boss;
}

/**
 * The boss of a week. One boss for now; a rotation would index `GUILD_BOSSES` by the week number,
 * so the choice stays a pure function of the (public) week and never of a player or a seed.
 */
export function guildBossOfWeek(week: GuildBossWeek): GuildBossDefinition {
  const n = Math.round(week.startMs / (7 * 24 * 60 * 60 * 1000));
  return GUILD_BOSSES[((n % GUILD_BOSSES.length) + GUILD_BOSSES.length) % GUILD_BOSSES.length]!;
}

/** The highest stage a weekly total reaches (0 = none). */
export function guildBossStageOf(boss: GuildBossDefinition, total: number): number {
  let reached = 0;
  for (const s of boss.stages) if (total >= s.threshold) reached = s.stage;
  return reached;
}

/** What one attempt adds to the guild's total. */
export function countedDamage(boss: GuildBossDefinition, damage: number): number {
  return Math.max(0, Math.min(Math.floor(damage), boss.attemptDamageCap));
}

/** Sum of the stage rewards of `stages` (for a claim). */
export function sumStageRewards(
  boss: GuildBossDefinition,
  stages: readonly number[],
): GuildBossStageReward {
  const out: GuildBossStageReward = { gold: 0, materials: {} };
  for (const n of stages) {
    const s = boss.stages.find((x) => x.stage === n);
    if (!s) throw new RangeError(`Unknown stage ${n} of ${boss.id}`);
    out.gold += s.reward.gold;
    for (const [m, q] of Object.entries(s.reward.materials) as [MaterialId, number][])
      out.materials[m] = (out.materials[m] ?? 0) + q;
  }
  return out;
}
