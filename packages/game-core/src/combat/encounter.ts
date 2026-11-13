import { getClass, type ClassId } from '../classes.js';
import type { AreaDefinition } from '../world/areas.js';
import { getEnemy, type EnemyDefinition, type EnemyId } from '../world/enemies.js';
import type { Rng } from '../rng.js';
import { STAT_LIMITS, type StatBlock } from './characterStats.js';
import { AUTO_SKILLS } from './skills.js';
import { hasCombatEffects } from '../effects/resolve.js';
import type { CombatEffects } from '../effects/types.js';
import {
  compileKit,
  kitSpenderFor,
  kitSpenderMultiplier,
  resolveLoadout,
  shadowCompare,
  skillsPrototypeMode,
  withoutKit,
  type KitState,
  type Loadout,
  type ResolvedLoadout,
  type SetupKit,
} from './kit.js';

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
  /**
   * In-fight effects (ticket 3.2). Absent when none is active: then every hit is `auto` or
   * `skill`, exactly as before effects existed. Read hits through `attackHit`.
   */
  effects?: SetupEffects;
  /**
   * Ticket 9.1: the hero's loadout compiled for this fight. Only present while the skills
   * prototype is on (`setSkillsPrototype`); absent, every fight is exactly today's.
   */
  kit?: SetupKit;
}

/**
 * The numbers `attackHit` needs to price a hit under effects. Health thresholds are absolute
 * (whole health points), so both simulations compare the same integers.
 */
export interface SetupEffects {
  /** Damage of a 1× hit after mitigation, before rounding (boss bonuses included). */
  dealt: number;
  /** The same before mitigation (crit burn ignores defences). */
  raw: number;
  critDamage: number;
  critChance: number;
  /** The class skill's damage multiplier (skill-damage affix included) and bonus crit chance. */
  skillMultiplier: number;
  skillBonusCrit: number;
  /** The hero's max health. */
  maxHealth: number;
  critBurn: number;
  /** Execute applies while the enemy has at most this much health left (0 = off). */
  executeHealth: number;
  executeBonus: number;
  /** Fortitude applies while the hero has at least this much health (0 = off). */
  fortitudeHealth: number;
  fortitudeBonus: number;
  skillRage: number;
  skillSurge: number;
  skillOpener: number;
  skillRot: number;
  /** Thorns damage per enemy hit (0 = off); `thornsRaw` before rounding, for enraged hits. */
  thornsDamage: number;
  thornsRaw: number;
}

/** What the hero's `attack`-th attack (1-based) of a fight deals. */
export interface AttackHit extends HitProfile {
  skill: boolean;
  /**
   * Ticket B.2: a crit turned this attack into the class skill (skill surge). Its own crit does not
   * surge the next attack (no chains); the simulations carry `crit && !surged` as the next
   * attack's `prevCrit`.
   */
  surged: boolean;
}

/**
 * Prices one hero attack: the class skill on every `skillEvery`-th attack, otherwise a basic
 * attack, with the effects that apply in this moment. Both simulations price every attack here.
 * - `prevCrit`: the previous attack of this fight crit and was not itself a surge (Mana Surge);
 * - `heroHealth`: the hero's health when the attack lands (fortitude, rage);
 * - `enemyHealth`: the enemy's remaining health (execute, rot).
 */
export function attackHit(
  setup: EncounterSetup,
  attack: number,
  prevCrit: boolean,
  heroHealth: number,
  enemyHealth: number,
): AttackHit {
  const scheduled = attack % setup.skillEvery === 0;
  const fx = setup.effects;
  if (!fx) return { ...(scheduled ? setup.skill : setup.auto), skill: scheduled, surged: false };
  const opener = attack === 1 && fx.skillOpener > 0;
  const surged = !scheduled && !opener && prevCrit && fx.skillSurge > 0;
  const skill = scheduled || opener || surged;
  return priceHit(
    fx,
    skill,
    surged,
    opener,
    heroHealth,
    enemyHealth,
    skill ? fx.skillMultiplier : 1,
    skill ? fx.skillBonusCrit : 0,
    skill,
  );
}

/**
 * Prices a hit under effects. `base` and `bonusCrit` are the hit's own multiplier and crit bonus;
 * class-skill effects (rage, rot) apply only when `classSkill` (ticket 9.1: the core skill in
 * slot 1, never a spender).
 */
function priceHit(
  fx: SetupEffects,
  skill: boolean,
  surged: boolean,
  opener: boolean,
  heroHealth: number,
  enemyHealth: number,
  base: number,
  bonusCrit: number,
  classSkill: boolean,
): AttackHit {
  let multiplier = base;
  if (surged) multiplier *= fx.skillSurge;
  if (opener) multiplier *= 1 + fx.skillOpener;
  if (classSkill && fx.skillRage > 0) {
    const missingDeciles = Math.floor((10 * (fx.maxHealth - heroHealth)) / fx.maxHealth);
    multiplier *= 1 + fx.skillRage * Math.max(0, missingDeciles);
  }
  if (fx.executeHealth > 0 && enemyHealth <= fx.executeHealth) multiplier *= 1 + fx.executeBonus;
  if (fx.fortitudeHealth > 0 && heroHealth >= fx.fortitudeHealth) {
    multiplier *= 1 + fx.fortitudeBonus;
  }
  const hit = fx.dealt * multiplier;
  const rot = classSkill && fx.skillRot > 0 ? Math.min(hit, fx.skillRot * enemyHealth) : 0;
  return {
    skill,
    surged,
    normal: hitDamage(hit + rot),
    crit: hitDamage(hit * fx.critDamage + fx.raw * multiplier * fx.critBurn + rot),
    critChance: Math.min(1, Math.max(0, fx.critChance + bonusCrit)),
  };
}

/**
 * Ticket 9.1: what the hero's attack does under a kit. The core skill fires exactly as today's
 * class skill (`attackHit`: its cadence, an opener, a surge); otherwise the first ready spender in
 * slot order replaces the basic attack. `action`: −2 basic attack, −1 core skill, i ≥ 0 spender i.
 */
export function kitAttack(
  setup: EncounterSetup,
  state: KitState,
  attack: number,
  t: number,
  prevCrit: boolean,
  heroHealth: number,
  enemyHealth: number,
): { hit: AttackHit; action: number } {
  const kit = setup.kit!;
  const today = attackHit(setup, attack, prevCrit, heroHealth, enemyHealth);
  if (today.skill || !kit.active) return { hit: today, action: today.skill ? -1 : -2 };
  const i = kitSpenderFor(kit, state, attack, t, enemyHealth);
  if (i < 0) return { hit: today, action: -2 };
  const m = kitSpenderMultiplier(kit, state, i);
  const bonusCrit = kit.spenders[i]!.bonusCrit;
  const fx = setup.effects;
  if (fx)
    return {
      hit: priceHit(fx, true, false, false, heroHealth, enemyHealth, m, bonusCrit, false),
      action: i,
    };
  return {
    hit: {
      skill: true,
      surged: false,
      normal: hitDamage(kit.dealt * m),
      crit: hitDamage(kit.dealt * m * kit.critDamage),
      critChance: Math.min(1, Math.max(0, kit.critChance + bonusCrit)),
    },
    action: i,
  };
}

/** Thorns damage of one enemy hit (`damageMultiplier` > 1 for enraged hits); 0 without thorns. */
export function thornsDamage(setup: EncounterSetup, damageMultiplier = 1): number {
  const fx = setup.effects;
  if (!fx || fx.thornsDamage <= 0) return 0;
  return damageMultiplier === 1 ? fx.thornsDamage : hitDamage(fx.thornsRaw * damageMultiplier);
}

/** Effects input of an encounter (ticket 3.2). */
export interface EncounterEffectContext {
  effects: CombatEffects;
  /** Bloodrush stacks the hero brings into this fight. */
  momentum?: number;
}

const hitDamage = (raw: number): number => Math.max(1, Math.round(raw));

/**
 * Secondary modifiers that change an encounter (ticket 3.1), as already-capped fractions from
 * `equipmentModifiers`. Both simulations build encounters here, so they stay equivalent.
 * - `xpGain`: XP reward × (1 + xpGain);
 * - `skillDamage`: the auto-skill's damage multiplier × (1 + skillDamage);
 * - `bossDamage`: damage dealt × (1 + bossDamage) against `boss`-rank enemies.
 */
export interface EncounterModifiers {
  xpGain?: number;
  skillDamage?: number;
  bossDamage?: number;
}

const bonusOf = (value: number | undefined): number =>
  value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;

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
  area: Pick<AreaDefinition, 'enemies' | 'minLevel' | 'maxLevel'>,
  classId: ClassId,
  characterLevel: number,
  stats: StatBlock,
  config: CombatConfig,
  modifiers?: EncounterModifiers,
  effects?: EncounterEffectContext,
  skills?: SkillContext,
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
    modifiers,
    effects,
    skills,
  );
}

/** Ticket 9.1: the loadout input of an encounter (read only while the prototype is on). */
export interface SkillContext {
  loadout?: Loadout | null;
  /** Warlock: Soul Fragments brought into this fight (left by the last kill). */
  fragments?: number;
  /**
   * Duels (the `PVP_RULES_VERSION` 3 proposal): the share of a loadout's extra damage kept, and
   * the share of a passive's damage-taken change (`effectKeep`); a passive's damage bonuses are off.
   */
  pvp?: { skillKeep: number; effectKeep: number };
}

/**
 * Builds the fixed numbers of an encounter. Ticket 9.1: while the skills prototype is on, the
 * hero's loadout (`skills`, default when absent) sets the class skill (slot 1), the passive's
 * constant modifiers and the compiled kit; off, `skills` is never read.
 */
export function buildEncounter(
  enemy: EnemyDefinition,
  enemyLevel: number,
  classId: ClassId,
  characterLevel: number,
  stats: StatBlock,
  config: CombatConfig,
  modifiers?: EncounterModifiers,
  context?: EncounterEffectContext,
  skills?: SkillContext,
): EncounterSetup {
  const mode = skillsPrototypeMode();
  const args = [
    enemy,
    enemyLevel,
    classId,
    characterLevel,
    stats,
    config,
    modifiers,
    context,
  ] as const;
  if (mode === 'off') return buildEncounterWith(...args);
  const resolved = resolveLoadout(classId, skills?.loadout);
  const setup = buildEncounterWith(...args, resolved, skills?.fragments ?? 0, skills?.pvp);
  if (mode === 'shadow' && resolved.isDefault) {
    shadowCompare('buildEncounter', buildEncounterWith(...args), withoutKit(setup));
  }
  return setup;
}

function buildEncounterWith(
  enemy: EnemyDefinition,
  enemyLevel: number,
  classId: ClassId,
  characterLevel: number,
  stats: StatBlock,
  config: CombatConfig,
  modifiers?: EncounterModifiers,
  context?: EncounterEffectContext,
  loadout?: ResolvedLoadout,
  fragments = 0,
  pvp?: { skillKeep: number; effectKeep: number },
): EncounterSetup {
  const e = enemyStatsAtLevel(enemy, enemyLevel);
  // Ticket 9.1: a passive's constant modifiers (none for the default loadout: nothing changes).
  const passive = loadout?.passive;
  const fx = context && hasCombatEffects(context.effects) ? context.effects : undefined;
  const cls = getClass(classId);
  const skillDef = loadout ? loadout.core : AUTO_SKILLS[classId];

  const ownRaw = cls.primaryDamage === 'physical' ? stats.physicalDamage : stats.magicDamage;
  const passiveDamage =
    passive && !pvp
      ? (passive.damage ?? 0) +
        (enemy.rank === 'boss' ? (passive.bossDamage ?? 0) : (passive.normalDamage ?? 0))
      : 0;
  const playerRaw = passiveDamage !== 0 ? ownRaw * (1 + passiveDamage) : ownRaw;
  const enemyDefense = cls.primaryDamage === 'physical' ? e.armor : e.resistance;
  // Boss slayer (ticket 3.2) adds to the boss-damage affix; + 0 leaves the number unchanged.
  const bossBonus =
    enemy.rank === 'boss' ? 1 + bonusOf(modifiers?.bossDamage) + (fx?.bossSlayer ?? 0) : 1;
  const dealt = playerRaw * (1 - mitigation(enemyDefense, characterLevel, config)) * bossBonus;

  // Ticket 8.1: a foe's fight traits (`EnemyTraits`); absent, every number below is as before.
  const traits = enemy.traits;
  const pierce = traits?.defensePierce ?? 0;
  const playerDefense =
    (enemy.damageType === 'physical' ? stats.armor : stats.resistance) *
    (pierce > 0 ? 1 - pierce : 1);
  const mitigated = e.damage * (1 - mitigation(playerDefense, enemyLevel, config));
  const takenShare = (passive?.damageTaken ?? 0) * (pvp ? pvp.effectKeep : 1);
  const taken = takenShare !== 0 ? mitigated * (1 + takenShare) : mitigated;

  const critDamage =
    traits?.critGuard !== undefined
      ? 1 + Math.max(0, stats.critDamage - 1) * (1 - traits.critGuard)
      : stats.critDamage;
  const critChance =
    traits?.critEvasion !== undefined
      ? Math.max(0, stats.critChance - traits.critEvasion)
      : stats.critChance;
  const profile = (multiplier: number, bonusCrit: number): HitProfile => ({
    normal: hitDamage(dealt * multiplier),
    crit: hitDamage(dealt * multiplier * critDamage),
    critChance: Math.min(1, Math.max(0, critChance + bonusCrit)),
  });

  const fullSkill = skillDef.damageMultiplier * (1 + bonusOf(modifiers?.skillDamage));
  const skillMultiplier =
    traits?.skillGuard !== undefined ? 1 + (fullSkill - 1) * (1 - traits.skillGuard) : fullSkill;
  // Bloodrush (ticket 3.2): each stack adds attack speed for this fight.
  const momentum = fx && fx.bloodrush.perStack > 0 ? Math.max(0, context?.momentum ?? 0) : 0;
  const attackSpeed =
    momentum > 0
      ? Math.min(
          STAT_LIMITS.attackSpeed.max,
          stats.attackSpeed * (1 + fx!.bloodrush.perStack * momentum),
        )
      : stats.attackSpeed;

  const setup: EncounterSetup = {
    enemyId: enemy.id,
    enemyLevel,
    enemyHealth: e.health,
    enemyHit: hitDamage(taken),
    enemyIntervalMs: attackIntervalMs(enemy.attackSpeed),
    playerIntervalMs: attackIntervalMs(attackSpeed),
    auto: profile(1, 0),
    skill: profile(skillMultiplier, skillDef.bonusCritChance),
    skillEvery: skillDef.everyNthAttack!,
    xpReward: Math.round(
      e.xp * xpLevelFactor(characterLevel, enemyLevel, config) * (1 + bonusOf(modifiers?.xpGain)),
    ),
    maxFightMs: config.maxFightMs,
  };
  if (fx && hasFightEffects(fx)) {
    const raw = playerRaw * bossBonus;
    const thornsRaw = fx.thorns * e.damage;
    setup.effects = {
      dealt,
      raw,
      critDamage,
      critChance,
      skillMultiplier,
      skillBonusCrit: skillDef.bonusCritChance,
      maxHealth: stats.health,
      critBurn: fx.critBurn,
      executeHealth: fx.execute.bonus > 0 ? Math.floor(fx.execute.threshold * e.health) : 0,
      executeBonus: fx.execute.bonus,
      fortitudeHealth:
        fx.fortitude.bonus > 0 ? Math.max(1, Math.ceil(fx.fortitude.threshold * stats.health)) : 0,
      fortitudeBonus: fx.fortitude.bonus,
      skillRage: fx.skillRage,
      skillSurge: fx.skillSurge,
      skillOpener: fx.skillOpener,
      skillRot: fx.skillRot,
      thornsDamage: fx.thorns > 0 ? hitDamage(thornsRaw) : 0,
      thornsRaw,
    };
  }
  if (loadout) {
    setup.kit = compileKit(
      loadout,
      { dealt, critDamage, critChance, enemyHealth: e.health },
      fragments,
      pvp?.skillKeep ?? 1,
    );
  }
  return setup;
}

/** Effects that act inside a fight (boss slayer, life on kill and bloodrush act around it). */
function hasFightEffects(fx: CombatEffects): boolean {
  return (
    fx.critBurn > 0 ||
    fx.execute.bonus > 0 ||
    fx.fortitude.bonus > 0 ||
    fx.skillRage > 0 ||
    fx.skillSurge > 0 ||
    fx.skillOpener > 0 ||
    fx.skillRot > 0 ||
    fx.thorns > 0
  );
}

/** Whether the fight's hits depend on the hero's health (the distribution then depends on it). */
export function dependsOnHeroHealth(setup: EncounterSetup): boolean {
  const fx = setup.effects;
  return fx !== undefined && (fx.fortitudeHealth > 0 || fx.skillRage > 0);
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
