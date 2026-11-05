import type { ClassId } from '../classes.js';
import { CLASS_IDS } from '../classes.js';
import { CORE_STAT_IDS, type CoreStatId } from '../stats.js';
import { MAX_LEVEL } from './progression.js';

/**
 * A full set of core stat values (GDD §6.2). Units:
 * - `health`, `physicalDamage`, `magicDamage`, `armor`, `resistance`: flat points.
 * - `attackSpeed`: attacks per second.
 * - `critChance`: probability in [0, 1].
 * - `critDamage`: multiplier applied to critical hits (1.5 = 150 %).
 */
export type StatBlock = Record<CoreStatId, number>;

/**
 * What one equipped item adds to the character, in the units of `StatBlock`.
 * Contributions are additive. This is an input type only: item generation and
 * affix rolling live in the loot module.
 */
export type EquipmentStatContribution = Partial<Record<CoreStatId, number>>;

export interface ClassStatProfile {
  /** Stats at level 1. */
  base: StatBlock;
  /** Added per level above 1. */
  perLevel: StatBlock;
}

const zero: StatBlock = {
  health: 0,
  physicalDamage: 0,
  magicDamage: 0,
  attackSpeed: 0,
  critChance: 0,
  critDamage: 0,
  armor: 0,
  resistance: 0,
};

export const CLASS_STAT_PROFILES: Readonly<Record<ClassId, ClassStatProfile>> = {
  warrior: {
    base: {
      ...zero,
      health: 140,
      physicalDamage: 10,
      attackSpeed: 1.0,
      critChance: 0.05,
      critDamage: 1.5,
      armor: 20,
      resistance: 8,
    },
    perLevel: { ...zero, health: 14, physicalDamage: 2, armor: 3, resistance: 1.5 },
  },
  mage: {
    base: {
      ...zero,
      health: 125,
      physicalDamage: 2,
      magicDamage: 12,
      attackSpeed: 0.85,
      critChance: 0.05,
      critDamage: 1.5,
      armor: 18,
      resistance: 18,
    },
    perLevel: { ...zero, health: 14, magicDamage: 2.4, armor: 3, resistance: 3 },
  },
  hunter: {
    base: {
      ...zero,
      health: 125,
      physicalDamage: 9,
      attackSpeed: 1.25,
      critChance: 0.1,
      critDamage: 1.6,
      armor: 15,
      resistance: 10,
    },
    perLevel: { ...zero, health: 12.5, physicalDamage: 1.8, armor: 2.5, resistance: 2 },
  },
  warlock: {
    base: {
      ...zero,
      health: 130,
      physicalDamage: 2,
      magicDamage: 11,
      attackSpeed: 0.9,
      critChance: 0.05,
      critDamage: 1.5,
      armor: 17,
      resistance: 16,
    },
    perLevel: { ...zero, health: 14, magicDamage: 2.2, armor: 2.8, resistance: 2.5 },
  },
};

/** Hard limits applied after summing class, level and equipment (GDD §6.2: caps where necessary). */
export const STAT_LIMITS: Readonly<Record<CoreStatId, { min: number; max: number }>> = {
  health: { min: 1, max: 1_000_000 },
  physicalDamage: { min: 0, max: 1_000_000 },
  magicDamage: { min: 0, max: 1_000_000 },
  attackSpeed: { min: 0.25, max: 4 },
  critChance: { min: 0, max: 0.75 },
  critDamage: { min: 1, max: 10 },
  armor: { min: 0, max: 1_000_000 },
  resistance: { min: 0, max: 1_000_000 },
};

function assertLevel(level: number): void {
  if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL) {
    throw new RangeError(`Invalid level: ${level}`);
  }
}

/**
 * Derives a character's effective stats from class base, level and equipment.
 * Pure and deterministic. Health is rounded down to an integer.
 * Throws on unknown classes, invalid levels or non-finite contributions.
 */
export function deriveCharacterStats(
  classId: ClassId,
  level: number,
  equipment: readonly EquipmentStatContribution[] = [],
): StatBlock {
  if (!(CLASS_IDS as readonly string[]).includes(classId)) {
    throw new RangeError(`Unknown class: ${String(classId)}`);
  }
  assertLevel(level);
  const profile = CLASS_STAT_PROFILES[classId];
  const out = { ...zero };
  for (const id of CORE_STAT_IDS) {
    let value = profile.base[id] + profile.perLevel[id] * (level - 1);
    for (const item of equipment) {
      const bonus = item[id];
      if (bonus === undefined) continue;
      if (!Number.isFinite(bonus)) throw new RangeError(`Invalid ${id} contribution: ${bonus}`);
      value += bonus;
    }
    const { min, max } = STAT_LIMITS[id];
    out[id] = Math.min(max, Math.max(min, value));
  }
  out.health = Math.max(STAT_LIMITS.health.min, Math.floor(out.health));
  return out;
}
