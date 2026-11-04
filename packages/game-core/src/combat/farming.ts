import { isClassId, type ClassId } from '../classes.js';
import { createRng, type Rng } from '../rng.js';
import { getArea, isAreaId, type AreaId } from '../world/areas.js';
import type { EnemyId } from '../world/enemies.js';
import {
  deriveCharacterStats,
  type EquipmentStatContribution,
  type StatBlock,
} from './characterStats.js';
import {
  DEFAULT_COMBAT_CONFIG,
  rollEncounter,
  type CombatConfig,
  type EncounterSetup,
  type FightOutcome,
} from './encounter.js';
import { distributionKey, hitsToKillDistribution, sampleFight } from './fightDistribution.js';
import { MAX_LEVEL, applyXp, xpToNextLevel } from './progression.js';

export interface FarmingCharacter {
  classId: ClassId;
  level: number;
  /** Experience toward the next level. */
  xp: number;
  /** Current health; defaults to full. Clamped to [1, max health]. */
  health?: number;
}

export interface FarmingInput {
  character: FarmingCharacter;
  /** Stat contributions of the equipped items. */
  equipment?: readonly EquipmentStatContribution[];
  areaId: AreaId;
  /** Server-derived seed. Never accept a seed from the client. */
  seed: number | string;
  /** Simulated time window in milliseconds (non-negative integer). */
  durationMs: number;
  /**
   * Per-cycle RNG. When set, cycle `i` of this window draws from its own stream seeded with
   * `${seed}:${firstCycle + i}` instead of one stream for the whole window. A cycle's outcome then
   * depends only on the seed, its global index and the state at its start — not on where a
   * settlement window happened to end — so settling more or less often cannot re-roll an
   * unfinished cycle (ticket 1.9). Offline settlement always sets it.
   */
  firstCycle?: number;
}

/** A committed cycle, reported to `SimulationOptions.onCycle`. */
export interface CycleRecord {
  /** Global cycle index (`firstCycle` + position in the window); position when unset. */
  index: number;
  outcome: 'kill' | 'death' | 'timeout';
  enemyId: EnemyId;
  /** Character level at the start of the cycle (before any level-up from this kill). */
  level: number;
}

/** Compact combat log entry; `t` is milliseconds since the start of the window. */
export type CombatEvent =
  | { t: number; type: 'spawn'; enemyId: EnemyId; enemyLevel: number }
  | { t: number; type: 'attack'; damage: number; crit: boolean; skill: boolean }
  | { t: number; type: 'enemyAttack'; damage: number }
  | { t: number; type: 'kill'; enemyId: EnemyId; xp: number }
  | { t: number; type: 'timeout'; enemyId: EnemyId }
  | { t: number; type: 'death'; enemyId: EnemyId }
  | { t: number; type: 'respawn' }
  | { t: number; type: 'levelUp'; level: number };

export interface FarmingResult {
  durationMs: number;
  /**
   * Time covered by completed encounter cycles. An encounter that would end
   * after the window is not applied; its time is returned in `unusedMs` so the
   * caller can carry it into the next settlement.
   */
  simulatedMs: number;
  unusedMs: number;
  encounters: number;
  kills: number;
  /** Kills per enemy of the area's roster (every roster enemy present, possibly 0). */
  killsByEnemy: Partial<Record<EnemyId, number>>;
  deaths: number;
  timeouts: number;
  damageTaken: number;
  xpGained: number;
  startLevel: number;
  level: number;
  xp: number;
  levelsGained: number;
  health: number;
  maxHealth: number;
  /** Most recent events (detailed simulation only; empty for the aggregate one). */
  events: CombatEvent[];
  /** Older events dropped to respect `maxEvents`. */
  eventsDropped: number;
}

export interface SimulationOptions {
  config?: CombatConfig;
  /** Called once per committed cycle, in order (e.g. to roll loot per kill). */
  onCycle?: (cycle: CycleRecord) => void;
}

export interface DetailedSimulationOptions extends SimulationOptions {
  /** Keep at most this many of the most recent events (default 200). */
  maxEvents?: number;
}

type FightResolver = (
  setup: EncounterSetup,
  health: number,
  rng: Rng,
  startMs: number,
) => FightOutcome;

interface EventSink {
  /** Called once a cycle is committed, with the events buffered for it. */
  commit(events: CombatEvent[]): void;
}

function validateInput(input: FarmingInput, config: CombatConfig): void {
  const { character, durationMs } = input;
  if (!isClassId(character.classId))
    throw new RangeError(`Unknown class: ${String(character.classId)}`);
  if (!isAreaId(input.areaId)) throw new RangeError(`Unknown area: ${String(input.areaId)}`);
  if (!Number.isInteger(character.level) || character.level < 1 || character.level > MAX_LEVEL) {
    throw new RangeError(`Invalid level: ${character.level}`);
  }
  const need = xpToNextLevel(character.level);
  if (
    !Number.isInteger(character.xp) ||
    character.xp < 0 ||
    (need > 0 && character.xp >= need) ||
    (need === 0 && character.xp !== 0)
  ) {
    throw new RangeError(`Invalid xp: ${character.xp}`);
  }
  if (character.health !== undefined && !Number.isFinite(character.health)) {
    throw new RangeError(`Invalid health: ${character.health}`);
  }
  if (
    input.firstCycle !== undefined &&
    (!Number.isSafeInteger(input.firstCycle) || input.firstCycle < 0)
  ) {
    throw new RangeError(`Invalid firstCycle: ${input.firstCycle}`);
  }
  if (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > config.maxDurationMs) {
    throw new RangeError(`Invalid duration: ${durationMs}`);
  }
}

/**
 * The farming loop shared by both simulations. One cycle = search (with
 * regeneration) → fight → (on death) respawn. Only the fight resolution differs.
 */
function runFarming(
  input: FarmingInput,
  config: CombatConfig,
  resolveFight: FightResolver,
  buffer: CombatEvent[] | null,
  sink: EventSink | null,
  onCycle?: (cycle: CycleRecord) => void,
): FarmingResult {
  validateInput(input, config);
  const perCycle = input.firstCycle !== undefined;
  const firstCycle = input.firstCycle ?? 0;
  let rng = createRng(input.seed);
  const area = getArea(input.areaId);
  const { classId } = input.character;
  const equipment = input.equipment ?? [];

  let level = input.character.level;
  let xp = input.character.xp;
  let stats: StatBlock = deriveCharacterStats(classId, level, equipment);
  let health = Math.min(
    stats.health,
    Math.max(1, Math.floor(input.character.health ?? stats.health)),
  );

  // One counter per enemy of the area's roster (all zero at the start).
  const killsByEnemy: Partial<Record<EnemyId, number>> = Object.fromEntries(
    area.enemies.map((e) => [e.enemyId, 0]),
  );
  let now = 0;
  let encounters = 0;
  let kills = 0;
  let deaths = 0;
  let timeouts = 0;
  let damageTaken = 0;
  let xpGained = 0;

  for (;;) {
    const cycleStart = now;
    if (buffer) buffer.length = 0;

    const regen = Math.floor(
      (stats.health * config.outOfCombatRegenPerSecond * config.searchMs) / 1000,
    );
    const fightStart = cycleStart + config.searchMs;
    if (fightStart > input.durationMs) break;
    const healthAtFight = Math.min(stats.health, health + regen);
    if (perCycle) rng = createRng(`${input.seed}:${firstCycle + encounters}`);

    const setup = rollEncounter(rng, area, classId, level, stats, config);
    buffer?.push({
      t: fightStart,
      type: 'spawn',
      enemyId: setup.enemyId,
      enemyLevel: setup.enemyLevel,
    });
    const outcome = resolveFight(setup, healthAtFight, rng, fightStart);
    const fightEnd = fightStart + outcome.offsetMs;
    const cycleEnd = outcome.kind === 'death' ? fightEnd + config.respawnMs : fightEnd;
    if (cycleEnd > input.durationMs) break;

    // Commit the cycle.
    onCycle?.({
      index: firstCycle + encounters,
      outcome: outcome.kind,
      enemyId: setup.enemyId,
      level,
    });
    encounters++;
    const lost = Math.min(healthAtFight, outcome.enemyHits * setup.enemyHit);
    damageTaken += lost;
    health = healthAtFight - lost;
    if (outcome.kind === 'kill') {
      kills++;
      killsByEnemy[setup.enemyId] = (killsByEnemy[setup.enemyId] ?? 0) + 1;
      xpGained += setup.xpReward;
      buffer?.push({ t: fightEnd, type: 'kill', enemyId: setup.enemyId, xp: setup.xpReward });
      const after = applyXp({ level, xp }, setup.xpReward);
      if (after.level !== level) {
        // A level-up recomputes stats and restores full health.
        for (let l = level + 1; l <= after.level; l++)
          buffer?.push({ t: fightEnd, type: 'levelUp', level: l });
        stats = deriveCharacterStats(classId, after.level, equipment);
        health = stats.health;
      }
      level = after.level;
      xp = after.xp;
    } else if (outcome.kind === 'death') {
      deaths++;
      buffer?.push({ t: fightEnd, type: 'death', enemyId: setup.enemyId });
      buffer?.push({ t: cycleEnd, type: 'respawn' });
      health = stats.health;
    } else {
      timeouts++;
      buffer?.push({ t: fightEnd, type: 'timeout', enemyId: setup.enemyId });
    }
    if (buffer && sink) sink.commit(buffer);
    now = cycleEnd;
  }

  return {
    durationMs: input.durationMs,
    simulatedMs: now,
    unusedMs: input.durationMs - now,
    encounters,
    kills,
    killsByEnemy,
    deaths,
    timeouts,
    damageTaken,
    xpGained,
    startLevel: input.character.level,
    level,
    xp,
    levelsGained: level - input.character.level,
    health,
    maxHealth: stats.health,
    events: [],
    eventsDropped: 0,
  };
}

/**
 * Plays one fight attack by attack, rolling every crit. Hits are appended to
 * `log` (timestamps offset by `startMs`) when given.
 */
export function resolveFightDetailed(
  setup: EncounterSetup,
  health: number,
  rng: Rng,
  startMs = 0,
  log: CombatEvent[] | null = null,
): FightOutcome {
  let enemyHealth = setup.enemyHealth;
  let hp = health;
  let attack = 1;
  let enemyAttack = 1;
  let enemyHits = 0;
  for (;;) {
    const p = attack * setup.playerIntervalMs;
    const e = enemyAttack * setup.enemyIntervalMs;
    if (p <= setup.maxFightMs && p <= e) {
      const skill = attack % setup.skillEvery === 0;
      const hit = skill ? setup.skill : setup.auto;
      const crit = rng.chance(hit.critChance);
      const damage = crit ? hit.crit : hit.normal;
      enemyHealth -= damage;
      log?.push({ t: startMs + p, type: 'attack', damage, crit, skill });
      if (enemyHealth <= 0) return { kind: 'kill', offsetMs: p, enemyHits };
      attack++;
    } else if (e <= setup.maxFightMs) {
      const damage = Math.min(hp, setup.enemyHit);
      hp -= damage;
      enemyHits++;
      log?.push({ t: startMs + e, type: 'enemyAttack', damage });
      if (hp <= 0) return { kind: 'death', offsetMs: e, enemyHits };
      enemyAttack++;
    } else {
      return { kind: 'timeout', offsetMs: setup.maxFightMs, enemyHits };
    }
  }
}

/**
 * Detailed, deterministic farming simulation: resolves every attack and returns
 * a compact event log. Use it for live play and short windows.
 */
export function simulateFarming(
  input: FarmingInput,
  options: DetailedSimulationOptions = {},
): FarmingResult {
  const config = options.config ?? DEFAULT_COMBAT_CONFIG;
  const maxEvents = options.maxEvents ?? 200;
  if (!Number.isInteger(maxEvents) || maxEvents < 0)
    throw new RangeError(`Invalid maxEvents: ${maxEvents}`);
  const buffer: CombatEvent[] = [];
  let events: CombatEvent[] = [];
  let total = 0;
  const sink: EventSink = {
    commit(cycleEvents) {
      total += cycleEvents.length;
      events.push(...cycleEvents);
      if (events.length > maxEvents * 2) events = events.slice(-maxEvents);
    },
  };
  const result = runFarming(
    input,
    config,
    (setup, health, rng, startMs) => resolveFightDetailed(setup, health, rng, startMs, buffer),
    buffer,
    sink,
    options.onCycle,
  );
  events = maxEvents === 0 ? [] : events.slice(-maxEvents);
  return { ...result, events, eventsDropped: total - events.length };
}

/**
 * Aggregate farming simulation for offline settlement. Each fight costs one RNG
 * draw (sampled from the exact hits-to-kill distribution) instead of one per
 * attack, and no events are recorded. Uses the same cycle rules as
 * `simulateFarming`, so outcomes follow the same distribution (results for a
 * given seed differ because the RNG is consumed differently).
 */
export function simulateFarmingAggregate(
  input: FarmingInput,
  options: SimulationOptions = {},
): FarmingResult {
  const config = options.config ?? DEFAULT_COMBAT_CONFIG;
  const cache = new Map<string, Float64Array>();
  const resolver: FightResolver = (setup, health, rng) => {
    const key = distributionKey(setup);
    let distribution = cache.get(key);
    if (!distribution) {
      distribution = hitsToKillDistribution(setup);
      cache.set(key, distribution);
    }
    return sampleFight(setup, health, rng, distribution);
  };
  return runFarming(input, config, resolver, null, null, options.onCycle);
}
