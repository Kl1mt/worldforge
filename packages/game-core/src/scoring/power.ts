import { isClassId, type ClassId } from '../classes.js';
import { DEFAULT_ACTIVITY_CONFIG } from '../activity/config.js';
import { equipmentModifiers, type EquippedItem } from '../activity/equipment.js';
import { setBonusInstances } from '../items/sets.js';
import { hasCombatEffects } from '../effects/resolve.js';
import { deriveCharacterStats } from '../combat/characterStats.js';
import { DEFAULT_COMBAT_CONFIG, buildEncounter } from '../combat/encounter.js';
import { lifeOnKillHeal, momentumAfterIdle } from '../combat/farming.js';
import { MAX_LEVEL } from '../combat/progression.js';
import { DEFAULT_LOOT_CONFIG } from '../loot/config.js';
import { createRng } from '../rng.js';
import { resolveDungeonFight, type DungeonEvent } from '../dungeon/run.js';
import type { EnemyDefinition, EnemyId } from '../world/enemies.js';
import type { ResolvedEnrage } from '../world/dungeons.js';
import { checkEquipment, type ScoredItem } from './equipment.js';
import { FORMULA_VERSIONS, type Score, type ScoreLine } from './types.js';

/**
 * Character Power (ticket 5.1, docs/LEADERBOARDS.md): a deterministic combat evaluation, the
 * **Proving Grounds**. The hero, as equipped, runs a ladder of trials at fixed levels; each trial
 * is three foes back to back and a champion, with the crypt's rules (health carries between
 * fights, the 2 s search heals, kill effects and bloodrush streaks count, the champion enrages).
 * A trial scores for how far the hero gets and, once cleared, for how fast. Power is the sum.
 *
 * Fixed: the foes are this module's own data (not the world's enemies, so a content retune never
 * moves Power), every fight draws from a fixed seed (`power:v<version>:<rung>:<trial>:<fight>`),
 * and the enrage moment is fixed. The same hero gives the same Power in every call and process.
 */
export const POWER_FORMULA_VERSION = FORMULA_VERSIONS.power;

/** A reference foe: an `EnemyDefinition` that is not in the world (its id is a label only). */
type ReferenceFoe = Omit<EnemyDefinition, 'id'> & { id: string };

/** The physical foe (a sturdy, armoured brute). */
export const PROVING_BRUTE: ReferenceFoe = {
  id: 'provingBrute',
  name: 'Proving Brute',
  assetId: 'enemy.fallen-knight',
  damageType: 'physical',
  undead: false,
  rank: 'normal',
  attackSpeed: 0.8,
  health: { base: 70, perLevel: 16 },
  damage: { base: 8, perLevel: 2.2 },
  armor: { base: 14, perLevel: 2.8 },
  resistance: { base: 7, perLevel: 1.5 },
  xp: { base: 0, perLevel: 0 },
};
/** The magic foe (frail, warded, hits harder). */
export const PROVING_CASTER: ReferenceFoe = {
  id: 'provingCaster',
  name: 'Proving Hexer',
  assetId: 'enemy.abbey-wraith',
  damageType: 'magic',
  undead: false,
  rank: 'normal',
  attackSpeed: 0.9,
  health: { base: 55, perLevel: 13 },
  damage: { base: 9, perLevel: 2.5 },
  armor: { base: 6, perLevel: 1.2 },
  resistance: { base: 13, perLevel: 2.4 },
  xp: { base: 0, perLevel: 0 },
};
/** The champion: a boss (boss-damage bonuses count), fought last, enraging. */
export const PROVING_CHAMPION: ReferenceFoe = {
  id: 'provingChampion',
  name: 'Proving Champion',
  assetId: 'enemy.gravewarden',
  damageType: 'physical',
  undead: false,
  rank: 'boss',
  attackSpeed: 0.6,
  health: { base: 700, perLevel: 160 },
  damage: { base: 6, perLevel: 1.5 },
  armor: { base: 18, perLevel: 3.2 },
  resistance: { base: 12, perLevel: 2.4 },
  xp: { base: 0, perLevel: 0 },
};

export interface PowerConfig {
  /** Trial levels, low to high. */
  rungs: readonly number[];
  /**
   * Ticket 6.1: the seed prefix of each trial (parallel to `rungs`). Version 2 keeps version 1's
   * seeds for its 20 trials, so each of them scores exactly what it did; only the new trials draw
   * new seeds. Absent: `power:v<version>:<index>`.
   */
  seeds?: readonly string[];
  /** The foes of a trial, in order, then the champion at `rung + championLevelOffset`. */
  foes: readonly ReferenceFoe[];
  champion: ReferenceFoe;
  championLevelOffset: number;
  championFightMs: number;
  enrage: ResolvedEnrage;
  /** Fights per trial are averaged over this many fixed seeds. */
  trials: number;
  /** Points for reaching the end of a trial (spread over its fights, see `fightShares`). */
  clearPoints: number;
  /** Share of `clearPoints` per fight (foes…, champion); sums to 1. */
  fightShares: readonly number[];
  /** Extra points for a cleared trial: `speedPoints · max(0, 1 − time / parMs)`. */
  speedPoints: number;
  parMs: number;
}

/** Version 1 (ticket 5.1): 20 trials at levels 4, 8, … 80. */
const RUNGS_V1 = Array.from({ length: 20 }, (_, i) => 4 * (i + 1));

export const DEFAULT_POWER_CONFIG: Readonly<PowerConfig> = {
  rungs: RUNGS_V1,
  foes: [PROVING_BRUTE, PROVING_CASTER, PROVING_BRUTE],
  champion: PROVING_CHAMPION,
  championLevelOffset: 2,
  championFightMs: 90_000,
  enrage: { atMs: 40_000, damageMultiplier: 2, attackSpeedMultiplier: 1.4 },
  trials: 2,
  clearPoints: 100,
  fightShares: [0.15, 0.15, 0.15, 0.55],
  speedPoints: 100,
  parMs: 120_000,
};

/**
 * Ticket 6.1: every Power version's config, so a stored row of any version can be recomputed and
 * the server can keep the older version in force until a season ends (docs/LEADERBOARDS.md
 * "Formula versions between seasons"). Version 2 adds trials at levels 30 and 34 (the Ashfall
 * Verge's entry and top), so the Cinderwastes' gear shows where heroes now farm: 22 trials, at
 * most 4,400. The foes, every other number and the 20 old trials' seeds are version 1's, so
 * version 2 = version 1 + the two new trials (`scoring.test.ts` asserts it).
 */
export const POWER_CONFIGS: Readonly<Record<number, Readonly<PowerConfig>>> = {
  1: DEFAULT_POWER_CONFIG,
  2: (() => {
    const rungs = [...RUNGS_V1, 30, 34].sort((a, b) => a - b);
    const seeds = rungs.map((level) => {
      const v1 = RUNGS_V1.indexOf(level);
      return v1 >= 0 ? `power:v1:${v1}` : `power:v2:L${level}`;
    });
    return { ...DEFAULT_POWER_CONFIG, rungs, seeds };
  })(),
  // Ticket 8.1: trials at 42 and 46 (the Pale Marches' middle and top; 40 and 44 exist), so the
  // Hollow Reach's gear shows: 24 trials, at most 4,800. Every other trial keeps version 2's seed,
  // so version 3 = version 2 + the two new trials.
  3: (() => {
    const v2 = [...RUNGS_V1, 30, 34];
    const rungs = [...v2, 42, 46].sort((a, b) => a - b);
    const seeds = rungs.map((level) => {
      const v1 = RUNGS_V1.indexOf(level);
      if (v1 >= 0) return `power:v1:${v1}`;
      return v2.includes(level) ? `power:v2:L${level}` : `power:v3:L${level}`;
    });
    return { ...DEFAULT_POWER_CONFIG, rungs, seeds };
  })(),
};

/** The config of a Power version (throws for one that never existed). */
export function powerConfig(version: number = POWER_FORMULA_VERSION): Readonly<PowerConfig> {
  const config = POWER_CONFIGS[version];
  if (!config) throw new RangeError(`Unknown Power version: ${version}`);
  return config;
}

export interface PowerTrialResult {
  level: number;
  /** Fights won (of foes + champion). */
  fightsWon: number;
  cleared: boolean;
  /** Mean over the seeds, ms (only meaningful when cleared in every seed). */
  timeMs: number;
  progressPoints: number;
  speedPoints: number;
  points: number;
}

export interface PowerResult {
  formulaVersion: number;
  power: number;
  trials: PowerTrialResult[];
}

export interface PowerInput {
  classId: ClassId;
  level: number;
  equipment: readonly EquippedItem[];
}

/** One trial, one seed: the points before rounding. */
function runTrial(
  input: PowerInput,
  rung: number,
  seedPrefix: string,
  config: PowerConfig,
): { won: number; cleared: boolean; timeMs: number; progress: number } {
  const { classId, level } = input;
  const combat = DEFAULT_COMBAT_CONFIG;
  const modifiers = equipmentModifiers(
    input.equipment,
    DEFAULT_ACTIVITY_CONFIG.modifierCaps,
    DEFAULT_LOOT_CONFIG,
    { classId, extraEffects: setBonusInstances(input.equipment) },
  );
  const effects = hasCombatEffects(modifiers.effects) ? modifiers.effects : undefined;
  const stats = deriveCharacterStats(classId, level, modifiers.stats);
  const encounterModifiers = {
    xpGain: modifiers.xpGain,
    skillDamage: modifiers.skillDamage,
    bossDamage: modifiers.bossDamage,
  };
  let health = stats.health;
  let momentum = 0;
  let now = 0;
  let progress = 0;
  let won = 0;
  const fights = [...config.foes, config.champion];
  const log: DungeonEvent[] = [];
  for (let k = 0; k < fights.length; k++) {
    const foe = fights[k]! as EnemyDefinition;
    const isChampion = k === fights.length - 1;
    if (k > 0) {
      now += combat.searchMs;
      health = Math.min(
        stats.health,
        health +
          Math.floor((stats.health * combat.outOfCombatRegenPerSecond * combat.searchMs) / 1000),
      );
    }
    const fightMomentum = effects
      ? momentumAfterIdle(momentum, k > 0 ? combat.searchMs : 0, effects)
      : 0;
    const foeLevel = isChampion ? rung + config.championLevelOffset : rung;
    const setup = {
      ...buildEncounter(
        { ...foe, id: foe.id as EnemyId },
        foeLevel,
        classId,
        level,
        stats,
        combat,
        encounterModifiers,
        effects ? { effects, momentum: fightMomentum } : undefined,
      ),
      ...(isChampion ? { maxFightMs: config.championFightMs } : {}),
    };
    log.length = 0;
    const outcome = resolveDungeonFight(
      setup,
      health,
      createRng(`${seedPrefix}:${k}`),
      0,
      log,
      isChampion ? config.enrage : undefined,
    );
    now += outcome.offsetMs;
    const share = config.fightShares[k]! * config.clearPoints;
    if (outcome.kind !== 'kill') {
      let dealt = 0;
      for (const e of log) if (e.type === 'attack' || e.type === 'thorns') dealt += e.damage;
      progress += share * Math.min(1, dealt / setup.enemyHealth);
      return { won, cleared: false, timeMs: now, progress };
    }
    won++;
    progress += share;
    health = outcome.health;
    if (effects) {
      momentum = Math.min(effects.bloodrush.maxStacks, fightMomentum + 1);
      health = Math.min(stats.health, health + lifeOnKillHeal(stats.health, effects));
    }
  }
  return { won, cleared: true, timeMs: now, progress };
}

/** Character Power of a hero as equipped. Pure and deterministic. */
export function characterPower(
  input: PowerInput,
  version: number = POWER_FORMULA_VERSION,
): PowerResult {
  const config = powerConfig(version);
  if (!isClassId(input.classId)) throw new RangeError(`Unknown class: ${String(input.classId)}`);
  if (!Number.isInteger(input.level) || input.level < 1 || input.level > MAX_LEVEL)
    throw new RangeError(`Invalid level: ${input.level}`);
  const trials: PowerTrialResult[] = [];
  let total = 0;
  for (const [r, rung] of config.rungs.entries()) {
    let progress = 0;
    let speed = 0;
    let time = 0;
    let won = 0;
    let clearedAll = true;
    for (let t = 0; t < config.trials; t++) {
      const prefix = config.seeds?.[r] ?? `power:v${version}:${r}`;
      const res = runTrial(input, rung, `${prefix}:${t}`, config);
      progress += res.progress;
      won += res.won;
      time += res.timeMs;
      if (res.cleared) speed += config.speedPoints * Math.max(0, 1 - res.timeMs / config.parMs);
      else clearedAll = false;
    }
    const n = config.trials;
    const result: PowerTrialResult = {
      level: rung,
      fightsWon: won / n,
      cleared: clearedAll,
      timeMs: Math.round(time / n),
      progressPoints: progress / n,
      speedPoints: speed / n,
      points: (progress + speed) / n,
    };
    trials.push(result);
    total += result.points;
  }
  return { formulaVersion: version, power: Math.round(total), trials };
}

/**
 * Character Power as a score: the equipped items are checked first (`checkEquipment`); a
 * rejected item is left out of the evaluation, as if the slot were empty.
 */
export function powerScore(
  classId: ClassId,
  level: number,
  equipment: readonly ScoredItem[],
  version: number = POWER_FORMULA_VERSION,
): Score {
  const config = powerConfig(version);
  const checked = checkEquipment(classId, equipment);
  const counted = checked.flatMap((c) => (c.equipped ? [c.equipped] : []));
  const result = characterPower({ classId, level, equipment: counted }, version);
  const lines: ScoreLine[] = result.trials.map((t) => ({
    id: `trial:${t.level}`,
    label: `Trial ${t.level}`,
    detail: t.cleared
      ? `Cleared in ${Math.round(t.timeMs / 1000)} s`
      : `${Math.floor(t.fightsWon)} of ${config.foes.length + 1} fights won`,
    points: Math.round(t.points),
    counted: t.points > 0,
  }));
  const left = checked.length - counted.length;
  if (left > 0) {
    lines.push({
      id: 'excluded',
      label: 'Items left out',
      detail: `${left} equipped ${left === 1 ? 'item fails' : 'items fail'} the server’s item check and ${left === 1 ? 'does' : 'do'} not fight.`,
      points: 0,
      counted: false,
      reason: 'invalid_item',
    });
  }
  return {
    metric: 'power',
    formulaVersion: result.formulaVersion,
    value: result.power,
    sortKey: [result.power],
    summary: `Your hero as equipped, tested in the Proving Grounds: ${config.rungs.length} trials from level ${config.rungs[0]} to ${config.rungs.at(-1)}, each three foes and a champion. Points for how far you get and how fast you clear.`,
    lines,
  };
}
