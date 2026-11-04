import { getClass, type ClassId } from '../classes.js';
import type { AreaDefinition } from '../world/areas.js';
import { getEnemy, type EnemyDefinition, type EnemyId } from '../world/enemies.js';
import type { Rng } from '../rng.js';
import type { StatBlock } from './characterStats.js';
import { AUTO_SKILLS } from './skills.js';

/** Tunables shared by the detailed and the aggregate simulation. */
export interface CombatConfig {
  /** Time between encounters (looking for the next enemy). */
  searchMs: number;
  /** Fraction of max health regained per second while searching. */
  outOfCombatRegenPerSecond: number;
  /** Delay after the character dies before farming resumes at full health. */
  respawnMs: number;
  /** An encounter that lasts longer is abandoned without reward. */
  maxFightMs: number;
  /** Mitigation = defense / (defense + base + perAttackerLevel · attackerLevel), capped. */
  mitigation: { base: number; perAttackerLevel: number; cap: number };
  /** XP is reduced by `perLevel` for each level the character is above the enemy beyond `graceLevels`. */
  xpLevelPenalty: { graceLevels: number; perLevel: number; min: number };
  /** Enemy level = clamp(character level + uniform offset in [-spread, spread], area range). */
  enemyLevelSpread: number;
  /** Upper bound for one simulation call. */
  maxDurationMs: number;
}

export const DEFAULT_COMBAT_CONFIG: Readonly<CombatConfig> = {
  searchMs: 2_000,
  outOfCombatRegenPerSecond: 0.1,
  respawnMs: 10_000,
  maxFightMs: 30_000,
  mitigation: { base: 50, perAttackerLevel: 10, cap: 0.75 },
  xpLevelPenalty: { graceLevels: 2, perLevel: 0.15, min: 0.1 },
  enemyLevelSpread: 1,
  maxDurationMs: 7 * 24 * 60 * 60 * 1000,
};

/** Fraction of incoming damage removed by `defense` (armor or resistance). */
export function mitigation(
  defense: number,
  attackerLevel: number,
  config: CombatConfig = DEFAULT_COMBAT_CONFIG,
): number {
  const { base, perAttackerLevel, cap } = config.mitigation;
  if (defense <= 0) return 0;
  return Math.min(cap, defense / (defense + base + perAttackerLevel * attackerLevel));
}

/** Multiplier applied to an enemy's XP for over-levelled characters. */
export function xpLevelFactor(
  characterLevel: number,
  enemyLevel: number,
  config: CombatConfig = DEFAULT_COMBAT_CONFIG,
): number {
  const { graceLevels, perLevel, min } = config.xpLevelPenalty;
  const over = Math.max(0, characterLevel - enemyLevel - graceLevels);
  return Math.max(min, 1 - perLevel * over);
}

export interface EnemyStats {
  health: number;
  damage: number;
  armor: number;
  resistance: number;
  xp: number;
}

export function enemyStatsAtLevel(enemy: EnemyDefinition, level: number): EnemyStats {
  const at = (s: { base: number; perLevel: number }) => s.base + s.perLevel * (level - 1);
  return {
    health: Math.max(1, Math.round(at(enemy.health))),
    damage: Math.max(0, at(enemy.damage)),
    armor: Math.max(0, at(enemy.armor)),
    resistance: Math.max(0, at(enemy.resistance)),
    xp: Math.max(0, Math.round(at(enemy.xp))),
  };
}

/** Integer damage of one hit: normal and critical value plus the crit probability. */
export interface HitProfile {
  normal: number;
  crit: number;
  critChance: number;
}

/** Everything about one encounter that is fixed before the fight's random rolls. */
export interface EncounterSetup {
  enemyId: EnemyId;
  enemyLevel: number;
  enemyHealth: number;
  /** Integer damage of every enemy hit after mitigation (enemies do not crit). */
  enemyHit: number;
  enemyIntervalMs: number;
  playerIntervalMs: number;
  /** Basic attack. */
  auto: HitProfile;
  /** Class auto-skill, used on every `skillEvery`-th attack. */
  skill: HitProfile;
  skillEvery: number;
  xpReward: number;
  maxFightMs: number;
}

const hitDamage = (raw: number): number => Math.max(1, Math.round(raw));

/** Interval in whole milliseconds for an attack rate (attacks per second). */
export function attackIntervalMs(attacksPerSecond: number): number {
  return Math.max(1, Math.round(1000 / attacksPerSecond));
}

/**
 * Rolls the enemy and its level (always two RNG draws, in this order), then
 * computes the encounter's fixed numbers. Shared by both simulations.
 */
export function rollEncounter(
  rng: Rng,
  area: AreaDefinition,
  classId: ClassId,
  characterLevel: number,
  stats: StatBlock,
  config: CombatConfig,
): EncounterSetup {
  const entry = rng.weighted(area.enemies, (e) => e.weight);
  const spread = config.enemyLevelSpread;
  const offset = rng.int(-spread, spread);
  const enemyLevel = Math.min(area.maxLevel, Math.max(area.minLevel, characterLevel + offset));
  return buildEncounter(
    getEnemy(entry.enemyId),
    enemyLevel,
    classId,
    characterLevel,
    stats,
    config,
  );
}

export function buildEncounter(
  enemy: EnemyDefinition,
  enemyLevel: number,
  classId: ClassId,
  characterLevel: number,
  stats: StatBlock,
  config: CombatConfig,
): EncounterSetup {
  const e = enemyStatsAtLevel(enemy, enemyLevel);
  const cls = getClass(classId);
  const skillDef = AUTO_SKILLS[classId];

  const playerRaw = cls.primaryDamage === 'physical' ? stats.physicalDamage : stats.magicDamage;
  const enemyDefense = cls.primaryDamage === 'physical' ? e.armor : e.resistance;
  const dealt = playerRaw * (1 - mitigation(enemyDefense, characterLevel, config));

  const playerDefense = enemy.damageType === 'physical' ? stats.armor : stats.resistance;
  const taken = e.damage * (1 - mitigation(playerDefense, enemyLevel, config));

  const profile = (multiplier: number, bonusCrit: number): HitProfile => ({
    normal: hitDamage(dealt * multiplier),
    crit: hitDamage(dealt * multiplier * stats.critDamage),
    critChance: Math.min(1, Math.max(0, stats.critChance + bonusCrit)),
  });

  return {
    enemyId: enemy.id,
    enemyLevel,
    enemyHealth: e.health,
    enemyHit: hitDamage(taken),
    enemyIntervalMs: attackIntervalMs(enemy.attackSpeed),
    playerIntervalMs: attackIntervalMs(stats.attackSpeed),
    auto: profile(1, 0),
    skill: profile(skillDef.damageMultiplier, skillDef.bonusCritChance),
    skillEvery: skillDef.everyNthAttack,
    xpReward: Math.round(e.xp * xpLevelFactor(characterLevel, enemyLevel, config)),
    maxFightMs: config.maxFightMs,
  };
}

/**
 * How an encounter ended, as an offset from the fight start.
 * Timeline rules (both simulations): the character attacks at `j · playerIntervalMs`,
 * the enemy at `k · enemyIntervalMs` (j, k ≥ 1); on equal timestamps the character
 * acts first; nothing happens after `maxFightMs`.
 */
export type FightOutcome =
  | { kind: 'kill'; offsetMs: number; enemyHits: number }
  | { kind: 'death'; offsetMs: number; enemyHits: number }
  | { kind: 'timeout'; offsetMs: number; enemyHits: number };

/** Number of enemy hits the character survives when starting a fight with `health`. */
export function hitsToDie(health: number, enemyHit: number): number {
  return Math.ceil(health / enemyHit);
}
