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
  kitAfterAttack,
  kitBlow,
  kitPulse,
  kitStart,
  pulseAt,
  shadowCompare,
  skillsPrototypeMode,
  withoutKit,
  type Loadout,
} from './kit.js';
import {
  DEFAULT_COMBAT_CONFIG,
  attackHit,
  kitAttack,
  rollEncounter,
  thornsDamage,
  type CombatConfig,
  type EncounterModifiers,
  type EncounterSetup,
  type FightOutcome,
} from './encounter.js';
import {
  distributionKey,
  killDistribution,
  sampleFight,
  type KillEvent,
} from './fightDistribution.js';
import { MAX_LEVEL, applyXp, xpToNextLevel } from './progression.js';
import { hasCombatEffects } from '../effects/resolve.js';
import type { CombatEffects } from '../effects/types.js';

export interface FarmingCharacter {
  classId: ClassId;
  level: number;
  /** Experience toward the next level. */
  xp: number;
  /** Current health; defaults to full. Clamped to [1, max health]. */
  health?: number;
  /** Bloodrush stacks after the last committed cycle (ticket 3.2); default 0. */
  momentum?: number;
  /**
   * Ticket 9.1 (prototype): Soul Fragments the last kill left for the next fight (warlock; read
   * only while the skills prototype is on, with a loadout that uses them).
   */
  soulFragments?: number;
}

/**
 * Bloodrush stacks the hero brings into a fight after `idleMs` out of combat: one stack fades for
 * every full `decayMs`. Zero when bloodrush is not active.
 */
export function momentumAfterIdle(
  stacks: number,
  idleMs: number,
  effects: CombatEffects | undefined,
): number {
  if (!effects || effects.bloodrush.perStack <= 0) return 0;
  const { maxStacks, decayMs } = effects.bloodrush;
  const faded = decayMs > 0 ? Math.floor(idleMs / decayMs) : 0;
  return Math.min(maxStacks, Math.max(0, Math.floor(stacks) - faded));
}

/** Health a kill restores (life on kill, ticket 3.2). */
export function lifeOnKillHeal(maxHealth: number, effects: CombatEffects | undefined): number {
  return effects && effects.lifeOnKill > 0 ? Math.floor(maxHealth * effects.lifeOnKill) : 0;
}

export interface FarmingInput {
  character: FarmingCharacter;
  /** Stat contributions of the equipped items. */
  equipment?: readonly EquipmentStatContribution[];
  /** Capped secondary modifiers of the equipped items (XP gain, skill and boss damage; ticket 3.1). */
  modifiers?: EncounterModifiers;
  /** Combined effects of the equipped items (ticket 3.2, `combineEffects`). */
  effects?: CombatEffects;
  /** Ticket 9.1 (prototype): the hero's loadout; read only while the skills prototype is on. */
  loadout?: Loadout | null;
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
  /**
   * Stop after this many committed cycles (ticket 2.2: an area switch lets the cycle in progress
   * finish in the old area first). The rest of the window comes back as `unusedMs`.
   */
  maxCycles?: number;
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
  /** Bloodrush stacks after the last committed cycle; carry it into the next window. */
  momentum: number;
  /**
   * Ticket 9.1 (prototype): Soul Fragments for the next fight; carry it into the next window. Only
   * present when a kit carries fragments (never with the switch off or the default loadout).
   */
  soulFragments?: number;
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
    character.momentum !== undefined &&
    (!Number.isInteger(character.momentum) || character.momentum < 0)
  ) {
    throw new RangeError(`Invalid momentum: ${character.momentum}`);
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
  if (
    input.maxCycles !== undefined &&
    (!Number.isInteger(input.maxCycles) || input.maxCycles < 0)
  ) {
    throw new RangeError(`Invalid maxCycles: ${input.maxCycles}`);
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
  const effects = hasCombatEffects(input.effects) ? input.effects : undefined;
  const healOnKill = (max: number) => lifeOnKillHeal(max, effects);

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
  // Bloodrush stacks after the last committed cycle (ticket 3.2). Only committed cycles change it,
  // so a window cut short leaves it as it was and the next settlement replays the same fight.
  let momentum = effects ? Math.max(0, input.character.momentum ?? 0) : 0;
  // Ticket 9.1: Soul Fragments carried between fights (only an active kit reads or changes them).
  const kitOn = skillsPrototypeMode() !== 'off';
  let fragments = kitOn ? Math.max(0, Math.floor(input.character.soulFragments ?? 0)) : 0;
  let carries = false;

  const maxCycles = input.maxCycles ?? Infinity;
  for (;;) {
    if (encounters >= maxCycles) break;
    const cycleStart = now;
    if (buffer) buffer.length = 0;

    const regen = Math.floor(
      (stats.health * config.outOfCombatRegenPerSecond * config.searchMs) / 1000,
    );
    const fightStart = cycleStart + config.searchMs;
    if (fightStart > input.durationMs) break;
    const healthAtFight = Math.min(stats.health, health + regen);
    if (perCycle) rng = createRng(`${input.seed}:${firstCycle + encounters}`);

    const fightMomentum = momentumAfterIdle(momentum, config.searchMs, effects);
    const setup = rollEncounter(
      rng,
      area,
      classId,
      level,
      stats,
      config,
      input.modifiers,
      effects ? { effects, momentum: fightMomentum } : undefined,
      kitOn ? { loadout: input.loadout ?? null, fragments } : undefined,
    );
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
    if (effects)
      momentum =
        outcome.kind === 'kill' ? Math.min(effects.bloodrush.maxStacks, fightMomentum + 1) : 0;
    if (setup.kit?.active && setup.kit.rules.carryOnKill > 0) {
      carries = true;
      fragments = outcome.kind === 'kill' ? setup.kit.rules.carryOnKill : 0;
    }
    if (outcome.kind === 'kill') {
      health = Math.min(stats.health, health + healOnKill(stats.health));
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
    momentum,
    ...(carries ? { soulFragments: fragments } : {}),
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
  if (!setup.kit) return resolveFightToday(setup, health, rng, startMs, log);
  if (setup.kit.isDefault && skillsPrototypeMode() === 'shadow') {
    const today = withoutKit(setup);
    const twin = createRng(rng.state);
    const todayLog: CombatEvent[] | null = log ? [] : null;
    const before = log?.length ?? 0;
    const a = resolveFightToday(today, health, twin, startMs, todayLog);
    const b = resolveFightKit(setup, health, rng, startMs, log);
    shadowCompare(
      'resolveFightDetailed',
      [a, twin.state, todayLog],
      [b, rng.state, log?.slice(before) ?? null],
    );
    return b;
  }
  return resolveFightKit(setup, health, rng, startMs, log);
}

/**
 * Ticket 9.1: one fight under a kit, attack by attack. The timeline adds the fight's pulses
 * (damage over time, timed resources) between the hero's attacks and the enemy's blows: hero
 * first, then the pulse, then the enemy on equal times. With an inactive kit there are no pulses
 * and every step is `resolveFightToday`'s.
 */
function resolveFightKit(
  setup: EncounterSetup,
  health: number,
  rng: Rng,
  startMs: number,
  log: CombatEvent[] | null,
): FightOutcome {
  const kit = setup.kit!;
  let st = kitStart(kit);
  let enemyHealth = setup.enemyHealth;
  let hp = health;
  let attack = 1;
  let enemyAttack = 1;
  let pulse = 1;
  let enemyHits = 0;
  let prevCrit = false;
  const thorns = thornsDamage(setup);
  for (;;) {
    const p = attack * setup.playerIntervalMs;
    const e = enemyAttack * setup.enemyIntervalMs;
    const q = kit.pulses ? pulseAt(pulse) : Infinity;
    if (p <= setup.maxFightMs && p <= e && p <= q) {
      const { hit, action } = kitAttack(setup, st, attack, p, prevCrit, hp, enemyHealth);
      const crit = rng.chance(hit.critChance);
      prevCrit = crit && !hit.surged;
      const damage = crit ? hit.crit : hit.normal;
      enemyHealth -= damage;
      log?.push({ t: startMs + p, type: 'attack', damage, crit, skill: hit.skill });
      if (enemyHealth <= 0) return { kind: 'kill', offsetMs: p, enemyHits };
      if (kit.active) st = kitAfterAttack(kit, st, action, crit, p);
      attack++;
    } else if (q <= setup.maxFightMs && q <= e) {
      const { damage, state } = kitPulse(kit, st);
      st = state;
      enemyHealth -= damage;
      if (enemyHealth <= 0) return { kind: 'kill', offsetMs: q, enemyHits };
      pulse++;
    } else if (e <= setup.maxFightMs) {
      const damage = Math.min(hp, setup.enemyHit);
      hp -= damage;
      enemyHits++;
      log?.push({ t: startMs + e, type: 'enemyAttack', damage });
      if (hp <= 0) return { kind: 'death', offsetMs: e, enemyHits };
      if (kit.active) st = kitBlow(kit, st);
      if (thorns > 0) {
        enemyHealth -= thorns;
        if (enemyHealth <= 0) return { kind: 'kill', offsetMs: e, enemyHits };
      }
      enemyAttack++;
    } else {
      return { kind: 'timeout', offsetMs: setup.maxFightMs, enemyHits };
    }
  }
}

function resolveFightToday(
  setup: EncounterSetup,
  health: number,
  rng: Rng,
  startMs: number,
  log: CombatEvent[] | null,
): FightOutcome {
  let enemyHealth = setup.enemyHealth;
  let hp = health;
  let attack = 1;
  let enemyAttack = 1;
  let enemyHits = 0;
  let prevCrit = false;
  const thorns = thornsDamage(setup);
  for (;;) {
    const p = attack * setup.playerIntervalMs;
    const e = enemyAttack * setup.enemyIntervalMs;
    if (p <= setup.maxFightMs && p <= e) {
      const hit = attackHit(setup, attack, prevCrit, hp, enemyHealth);
      const crit = rng.chance(hit.critChance);
      prevCrit = crit && !hit.surged;
      const damage = crit ? hit.crit : hit.normal;
      enemyHealth -= damage;
      log?.push({ t: startMs + p, type: 'attack', damage, crit, skill: hit.skill });
      if (enemyHealth <= 0) return { kind: 'kill', offsetMs: p, enemyHits };
      attack++;
    } else if (e <= setup.maxFightMs) {
      const damage = Math.min(hp, setup.enemyHit);
      hp -= damage;
      enemyHits++;
      log?.push({ t: startMs + e, type: 'enemyAttack', damage });
      if (hp <= 0) return { kind: 'death', offsetMs: e, enemyHits };
      if (thorns > 0) {
        // Thorns (ticket 3.2): the attacker takes its share of the blow once it has landed.
        enemyHealth -= thorns;
        if (enemyHealth <= 0) return { kind: 'kill', offsetMs: e, enemyHits };
      }
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
  const cache = new Map<string, KillEvent[]>();
  const resolver: FightResolver = (setup, health, rng) => {
    const key = distributionKey(setup, health);
    let distribution = cache.get(key);
    if (!distribution) {
      distribution = killDistribution(setup, health);
      cache.set(key, distribution);
    }
    return sampleFight(setup, health, rng, distribution);
  };
  return runFarming(input, config, resolver, null, null, options.onCycle);
}
