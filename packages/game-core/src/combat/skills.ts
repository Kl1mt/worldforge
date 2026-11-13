import type { ClassId } from '../classes.js';

/**
 * One basic auto-skill per class (GDD §6.3). It replaces every `everyNthAttack`
 * basic attack within an encounter (the counter resets per encounter), deals
 * `damageMultiplier` × the class's primary damage and may add crit chance.
 * Resource costs and loadouts come in a later phase.
 */
export interface AutoSkillDefinition {
  id: string;
  name: string;
  classId: ClassId;
  everyNthAttack: number;
  damageMultiplier: number;
  bonusCritChance: number;
}

export const AUTO_SKILLS: Readonly<Record<ClassId, AutoSkillDefinition>> = {
  warrior: {
    id: 'heavyStrike',
    name: 'Heavy Strike',
    classId: 'warrior',
    everyNthAttack: 4,
    damageMultiplier: 2.0,
    bonusCritChance: 0,
  },
  mage: {
    id: 'firebolt',
    name: 'Firebolt',
    classId: 'mage',
    everyNthAttack: 3,
    damageMultiplier: 1.8,
    bonusCritChance: 0,
  },
  hunter: {
    id: 'aimedShot',
    name: 'Aimed Shot',
    classId: 'hunter',
    everyNthAttack: 4,
    damageMultiplier: 1.6,
    bonusCritChance: 0.25,
  },
  warlock: {
    id: 'shadowBolt',
    name: 'Shadow Bolt',
    classId: 'warlock',
    everyNthAttack: 3,
    damageMultiplier: 1.7,
    bonusCritChance: 0,
  },
};

/* ------------------------------------------------------------------------------------------------
 * Ticket 9.1: skills, resources and loadouts (design prototype, `docs/SKILLS.md`).
 *
 * Content only. The rules live in `combat/kit.ts` and act only while the prototype switch is on
 * (`setSkillsPrototype`); it is off, so nothing here changes a fight yet (9.2 switches it on).
 * ---------------------------------------------------------------------------------------------- */

/**
 * A class resource on the fight's timeline (GDD §5.2). Every gain is deterministic (attacks
 * landed, blows taken, the fight's pulse), except `perCrit`: crits are the only random input.
 * - `start`: the value at the fight's start (`'full'` = `max`); the warlock's starts with the
 *   fragments its last kill left (`carryOnKill`, 0 after a death or a timeout).
 * - `perAttack` per hero attack, `perBlowTaken` per enemy blow, `perPulse` on every pulse,
 *   `perUnhitPulse` on a pulse with no blow taken since the previous one, `perDotPulse` on a pulse
 *   in which at least one damage-over-time ticks, `perCrit` per hero crit.
 */
export interface ResourceRules {
  max: number;
  start: number | 'full';
  perAttack: number;
  perBlowTaken: number;
  perPulse: number;
  perUnhitPulse: number;
  perDotPulse: number;
  perCrit: number;
  /** Warlock: fragments a kill leaves for the next fight (cross-fight state, like bloodrush). */
  carryOnKill: number;
}

/** The fight's pulse: damage over time ticks and timed resources move every `PULSE_MS`. */
export const PULSE_MS = 1_000;

export const RESOURCE_RULES: Readonly<Record<ClassId, ResourceRules>> = {
  // Rage builds as the warrior hits and is hit; spent by heavy skills.
  warrior: {
    max: 100,
    start: 0,
    perAttack: 4,
    perBlowTaken: 4,
    perPulse: 0,
    perUnhitPulse: 0,
    perDotPulse: 0,
    perCrit: 0,
    carryOnKill: 0,
  },
  // Mana starts full (the search between fights refills it) and regenerates; skills cost it.
  mage: {
    max: 100,
    start: 'full',
    perAttack: 0,
    perBlowTaken: 0,
    perPulse: 3,
    perUnhitPulse: 0,
    perDotPulse: 0,
    perCrit: 0,
    carryOnKill: 0,
  },
  // Focus builds while the hunter isn't hit; crits refund some.
  hunter: {
    max: 100,
    start: 20,
    perAttack: 0,
    perBlowTaken: 0,
    perPulse: 0,
    perUnhitPulse: 15,
    perDotPulse: 0,
    perCrit: 5,
    carryOnKill: 0,
  },
  // Soul Fragments come from kills and damage-over-time ticks and empower shadow skills.
  warlock: {
    max: 3,
    start: 0,
    perAttack: 0,
    perBlowTaken: 0,
    perPulse: 0,
    perUnhitPulse: 0,
    perDotPulse: 1,
    perCrit: 0,
    carryOnKill: 2,
  },
};

/** How a skill unlocks: a level, and for the later-content skills a deed (a boss's progress flag). */
export interface SkillUnlock {
  level: number;
  /** Ticket 9.1: the Phase 6 and 8 skills ask for a boss this hero has felled. */
  deed?: 'forgeTyrantDefeated' | 'hollowSovereignDefeated';
}

/** Damage over time: `perTick` × the 1× hit (after mitigation) on each of the next `ticks` pulses. */
export interface DotDefinition {
  ticks: number;
  perTick: number;
}

/**
 * An active skill. A **core** skill sits in slot 1 and fires on every `everyNthAttack`-th attack,
 * like today's class skill; Legendary and set effects that name "the class skill" read slot 1. A
 * **spender** (slots 2 and 3) replaces a basic attack when it is ready: its `cost` is paid (or,
 * with `consumeAll`, every unit, at least `cost`, each adding `perUnit` to the multiplier), its
 * cooldown is over, and its condition holds (`opener`: only as the fight's first attack;
 * `enemyBelow`: only while the foe is at or below that share of its health; a spender with a
 * damage over time only while its own one has run out).
 */
export interface ActiveSkillDefinition {
  id: string;
  name: string;
  classId: ClassId;
  kind: 'core' | 'spender';
  unlock: SkillUnlock;
  damageMultiplier: number;
  bonusCritChance: number;
  everyNthAttack?: number;
  cost?: number;
  consumeAll?: boolean;
  perUnit?: number;
  /** Resource gained when the skill fires (a builder). */
  gain?: number;
  cooldownMs?: number;
  /** First moment of a fight the skill is ready (default 0). */
  readyAtMs?: number;
  opener?: boolean;
  enemyBelow?: number;
  dot?: DotDefinition;
  description: string;
}

/** Constant modifiers of a passive (per fight; nothing random, nothing that heals). */
export interface PassiveModifiers {
  /** Every hit and tick × (1 + damage). */
  damage?: number;
  /** Against foes that are not bosses only: × (1 + normalDamage). */
  normalDamage?: number;
  /** Against bosses only: × (1 + bossDamage). */
  bossDamage?: number;
  /** Every enemy blow × (1 + damageTaken) (negative = less). */
  damageTaken?: number;
  /** Spenders' multiplier × (1 + spenderDamage). */
  spenderDamage?: number;
  /** Damage-over-time ticks × (1 + dotDamage). */
  dotDamage?: number;
  /** Added to the class's resource rules. */
  resource?: Partial<Omit<ResourceRules, 'start'>>;
}

export interface PassiveSkillDefinition {
  id: string;
  name: string;
  classId: ClassId;
  unlock: SkillUnlock;
  modifiers: PassiveModifiers;
  description: string;
}

const core = (
  d: Omit<ActiveSkillDefinition, 'kind' | 'bonusCritChance'> & { bonusCritChance?: number },
): ActiveSkillDefinition => ({ kind: 'core', bonusCritChance: 0, ...d });
const spender = (
  d: Omit<ActiveSkillDefinition, 'kind' | 'bonusCritChance'> & { bonusCritChance?: number },
): ActiveSkillDefinition => ({ kind: 'spender', bonusCritChance: 0, ...d });
const fromAuto = (c: ClassId, level: number, description: string): ActiveSkillDefinition => {
  const a = AUTO_SKILLS[c];
  return core({
    id: a.id,
    name: a.name,
    classId: c,
    unlock: { level },
    everyNthAttack: a.everyNthAttack,
    damageMultiplier: a.damageMultiplier,
    bonusCritChance: a.bonusCritChance,
    description,
  });
};

/**
 * Six actives per class by level (1–36) plus one from the Forge Tyrant (Phase 6). Today's skill is
 * each class's first core skill, with today's numbers (read from `AUTO_SKILLS`).
 */
export const ACTIVE_SKILLS: readonly ActiveSkillDefinition[] = [
  // Warrior: Rage.
  fromAuto('warrior', 1, 'Every 4th attack is a heavy blow for 200 %.'),
  spender({
    id: 'shieldSlam',
    name: 'Shield Slam',
    classId: 'warrior',
    unlock: { level: 5 },
    cost: 50,
    damageMultiplier: 1.6,
    description: 'Spends 50 Rage on a blow for 160 %.',
  }),
  spender({
    id: 'charge',
    name: 'Charge',
    classId: 'warrior',
    unlock: { level: 12 },
    opener: true,
    damageMultiplier: 1.5,
    gain: 15,
    description: 'Opens every fight with a charge for 150 % that builds 15 Rage.',
  }),
  core({
    id: 'rend',
    name: 'Rend',
    classId: 'warrior',
    unlock: { level: 20 },
    everyNthAttack: 4,
    damageMultiplier: 1.2,
    dot: { ticks: 4, perTick: 0.25 },
    description: 'Every 4th attack cuts for 120 % and bleeds 25 % a second for 4 seconds.',
  }),
  spender({
    id: 'execute',
    name: 'Execute',
    classId: 'warrior',
    unlock: { level: 28 },
    cost: 30,
    enemyBelow: 0.3,
    damageMultiplier: 1.8,
    description: 'Below 30 % of its health, a foe takes a finishing blow for 180 % (30 Rage).',
  }),
  spender({
    id: 'earthsplitter',
    name: 'Earthsplitter',
    classId: 'warrior',
    unlock: { level: 36 },
    cost: 40,
    readyAtMs: 8_000,
    cooldownMs: 15_000,
    damageMultiplier: 2.6,
    description: 'Ready 8 s into a fight, then every 15 s: 260 % for 40 Rage.',
  }),
  spender({
    id: 'forgebreaker',
    name: 'Forgebreaker',
    classId: 'warrior',
    unlock: { level: 36, deed: 'forgeTyrantDefeated' },
    cost: 60,
    consumeAll: true,
    damageMultiplier: 1,
    perUnit: 0.012,
    description:
      'Taught by the Forge Tyrant’s fall: spends all Rage (at least 60), 100 % +1.2 % per point.',
  }),

  // Mage: Mana.
  fromAuto('mage', 1, 'Every 3rd attack is a Firebolt for 180 %.'),
  spender({
    id: 'arcaneBolt',
    name: 'Arcane Bolt',
    classId: 'mage',
    unlock: { level: 5 },
    cost: 30,
    damageMultiplier: 1.35,
    description: 'Spends 30 Mana on a bolt for 135 %.',
  }),
  spender({
    id: 'pyroblast',
    name: 'Pyroblast',
    classId: 'mage',
    unlock: { level: 12 },
    cost: 80,
    damageMultiplier: 1.9,
    description: 'Spends 80 Mana on a blast for 190 %.',
  }),
  core({
    id: 'scorch',
    name: 'Scorch',
    classId: 'mage',
    unlock: { level: 20 },
    everyNthAttack: 3,
    damageMultiplier: 1.2,
    dot: { ticks: 4, perTick: 0.2 },
    description: 'Every 3rd attack scorches for 120 % and burns 20 % a second for 4 seconds.',
  }),
  spender({
    id: 'shatter',
    name: 'Shatter',
    classId: 'mage',
    unlock: { level: 28 },
    cost: 25,
    enemyBelow: 0.35,
    damageMultiplier: 1.5,
    description: 'Below 35 % of its health, a foe shatters for 150 % (25 Mana).',
  }),
  spender({
    id: 'meteor',
    name: 'Meteor',
    classId: 'mage',
    unlock: { level: 36 },
    cost: 40,
    readyAtMs: 6_000,
    cooldownMs: 15_000,
    damageMultiplier: 2.2,
    description: 'Ready 6 s into a fight, then every 15 s: 220 % for 40 Mana.',
  }),
  spender({
    id: 'emberstorm',
    name: 'Emberstorm',
    classId: 'mage',
    unlock: { level: 36, deed: 'forgeTyrantDefeated' },
    cost: 0,
    readyAtMs: 10_000,
    cooldownMs: 15_000,
    damageMultiplier: 1.8,
    description:
      'Taught by the Forge Tyrant’s fall: 10 s into a fight, then every 15 s, 180 % at no cost.',
  }),

  // Hunter: Focus.
  fromAuto('hunter', 1, 'Every 4th attack is an Aimed Shot for 160 % with +25 % crit chance.'),
  spender({
    id: 'quickShot',
    name: 'Quick Shot',
    classId: 'hunter',
    unlock: { level: 5 },
    cost: 25,
    damageMultiplier: 1.4,
    description: 'Spends 25 Focus on a shot for 140 %.',
  }),
  spender({
    id: 'firstBlood',
    name: 'First Blood',
    classId: 'hunter',
    unlock: { level: 12 },
    opener: true,
    damageMultiplier: 1.4,
    bonusCritChance: 0.3,
    description: 'Opens every fight with a shot for 140 % with +30 % crit chance.',
  }),
  core({
    id: 'serratedArrow',
    name: 'Serrated Arrow',
    classId: 'hunter',
    unlock: { level: 20 },
    everyNthAttack: 4,
    damageMultiplier: 1.1,
    bonusCritChance: 0.25,
    dot: { ticks: 4, perTick: 0.15 },
    description: 'Every 4th attack: 110 % with +25 % crit chance, bleeding 15 % a second for 4 s.',
  }),
  spender({
    id: 'killShot',
    name: 'Kill Shot',
    classId: 'hunter',
    unlock: { level: 28 },
    cost: 30,
    enemyBelow: 0.3,
    damageMultiplier: 1.8,
    description: 'Below 30 % of its health, a foe takes a shot for 180 % (30 Focus).',
  }),
  spender({
    id: 'volley',
    name: 'Volley',
    classId: 'hunter',
    unlock: { level: 36 },
    cost: 40,
    readyAtMs: 5_000,
    cooldownMs: 10_000,
    damageMultiplier: 2.2,
    bonusCritChance: 0.2,
    description:
      'Ready 5 s into a fight, then every 10 s: 220 % with +20 % crit chance (40 Focus).',
  }),
  spender({
    id: 'trueShot',
    name: 'True Shot',
    classId: 'hunter',
    unlock: { level: 36, deed: 'forgeTyrantDefeated' },
    cost: 50,
    damageMultiplier: 1.6,
    bonusCritChance: 0.4,
    description: 'Taught by the Forge Tyrant’s fall: 160 % with +40 % crit chance (50 Focus).',
  }),

  // Warlock: Soul Fragments.
  fromAuto('warlock', 1, 'Every 3rd attack is a Shadow Bolt for 170 %.'),
  spender({
    id: 'corruption',
    name: 'Corruption',
    classId: 'warlock',
    unlock: { level: 5 },
    damageMultiplier: 0.6,
    dot: { ticks: 12, perTick: 0.08 },
    description: 'Curses the foe: 60 %, then 8 % a second for 12 seconds (recast when it ends).',
  }),
  spender({
    id: 'soulBurn',
    name: 'Soul Burn',
    classId: 'warlock',
    unlock: { level: 12 },
    cost: 2,
    consumeAll: true,
    damageMultiplier: 1.0,
    perUnit: 0.25,
    cooldownMs: 12_000,
    description:
      'Spends every Soul Fragment (at least 2): 100 %, +25 % per fragment; every 12 s at most.',
  }),
  core({
    id: 'agony',
    name: 'Agony',
    classId: 'warlock',
    unlock: { level: 20 },
    everyNthAttack: 3,
    damageMultiplier: 1.1,
    dot: { ticks: 4, perTick: 0.2 },
    description: 'Every 3rd attack: 110 %, then 20 % a second for 4 seconds.',
  }),
  spender({
    id: 'drainSoul',
    name: 'Drain Soul',
    classId: 'warlock',
    unlock: { level: 28 },
    cost: 1,
    enemyBelow: 0.25,
    damageMultiplier: 1.5,
    description: 'Below 25 % of its health, a foe’s soul is drained for 150 % (1 fragment).',
  }),
  spender({
    id: 'doom',
    name: 'Doom',
    classId: 'warlock',
    unlock: { level: 36 },
    readyAtMs: 6_000,
    cooldownMs: 16_000,
    damageMultiplier: 0.6,
    dot: { ticks: 10, perTick: 0.25 },
    description: 'Ready 6 s into a fight, then every 16 s: 60 %, then 25 % a second for 10 s.',
  }),
  spender({
    id: 'soulHarvest',
    name: 'Soul Harvest',
    classId: 'warlock',
    unlock: { level: 36, deed: 'forgeTyrantDefeated' },
    cost: 4,
    consumeAll: true,
    damageMultiplier: 1.0,
    perUnit: 0.15,
    cooldownMs: 6_000,
    description:
      'Taught by the Forge Tyrant’s fall: spends every fragment (at least 4), 100 % +15 % each; every 6 s at most.',
  }),
];

/** Four passives per class by level (8–32) plus one from the Hollow Sovereign (Phase 8). */
export const PASSIVE_SKILLS: readonly PassiveSkillDefinition[] = [
  {
    id: 'unyielding',
    name: 'Unyielding',
    classId: 'warrior',
    unlock: { level: 8 },
    modifiers: { damageTaken: -0.08, resource: { perBlowTaken: 2 } },
    description: 'Blows hurt 8 % less and build 2 more Rage.',
  },
  {
    id: 'berserker',
    name: 'Berserker',
    classId: 'warrior',
    unlock: { level: 16 },
    modifiers: { normalDamage: 0.06, damageTaken: 0.1 },
    description: '+6 % damage to foes that are not bosses, but blows hurt 10 % more.',
  },
  {
    id: 'battleRhythm',
    name: 'Battle Rhythm',
    classId: 'warrior',
    unlock: { level: 24 },
    modifiers: { resource: { perAttack: 2 } },
    description: 'Every attack builds 2 more Rage.',
  },
  {
    id: 'juggernaut',
    name: 'Juggernaut',
    classId: 'warrior',
    unlock: { level: 32 },
    modifiers: { resource: { perBlowTaken: 4 }, bossDamage: 0.04 },
    description: 'Blows taken build 4 more Rage; +4 % damage to bosses.',
  },
  {
    id: 'hollowWrath',
    name: 'Hollow Wrath',
    classId: 'warrior',
    unlock: { level: 46, deed: 'hollowSovereignDefeated' },
    modifiers: { spenderDamage: 0.1 },
    description: 'Taught by the Hollow Sovereign’s fall: Rage skills +10 %.',
  },
  {
    id: 'manaWell',
    name: 'Mana Well',
    classId: 'mage',
    unlock: { level: 8 },
    modifiers: { resource: { perPulse: 2 } },
    description: 'Mana regenerates 2 more a second.',
  },
  {
    id: 'arcanePower',
    name: 'Arcane Power',
    classId: 'mage',
    unlock: { level: 16 },
    modifiers: { normalDamage: 0.06, damageTaken: 0.1 },
    description: '+6 % damage to foes that are not bosses, but blows hurt 10 % more.',
  },
  {
    id: 'manaShield',
    name: 'Mana Shield',
    classId: 'mage',
    unlock: { level: 24 },
    modifiers: { damageTaken: -0.06, resource: { perPulse: -1 } },
    description: 'Blows hurt 6 % less; Mana regenerates 1 less a second.',
  },
  {
    id: 'deepReserves',
    name: 'Deep Reserves',
    classId: 'mage',
    unlock: { level: 32 },
    modifiers: { resource: { max: 40 } },
    description: '40 more Mana, and every fight starts with it full.',
  },
  {
    id: 'kindling',
    name: 'Kindling',
    classId: 'mage',
    unlock: { level: 46, deed: 'hollowSovereignDefeated' },
    modifiers: { dotDamage: 0.4, spenderDamage: 0.05 },
    description: 'Taught by the Hollow Sovereign’s fall: burns +40 %, Mana skills +5 %.',
  },
  {
    id: 'steadyAim',
    name: 'Steady Aim',
    classId: 'hunter',
    unlock: { level: 8 },
    modifiers: { resource: { perUnhitPulse: 8 } },
    description: 'Focus builds 8 more a second while you are not hit.',
  },
  {
    id: 'predator',
    name: 'Predator',
    classId: 'hunter',
    unlock: { level: 16 },
    modifiers: { resource: { perCrit: 7 } },
    description: 'Crits refund 7 more Focus.',
  },
  {
    id: 'skirmisher',
    name: 'Skirmisher',
    classId: 'hunter',
    unlock: { level: 24 },
    modifiers: { normalDamage: 0.06, damageTaken: 0.08 },
    description: '+6 % damage to foes that are not bosses, but blows hurt 8 % more.',
  },
  {
    id: 'eagleEye',
    name: 'Eagle Eye',
    classId: 'hunter',
    unlock: { level: 32 },
    modifiers: { bossDamage: 0.05 },
    description: '+5 % damage to bosses.',
  },
  {
    id: 'hollowMark',
    name: 'Hollow Mark',
    classId: 'hunter',
    unlock: { level: 46, deed: 'hollowSovereignDefeated' },
    modifiers: { dotDamage: 0.4, spenderDamage: 0.05 },
    description: 'Taught by the Hollow Sovereign’s fall: bleeds +40 %, Focus skills +5 %.',
  },
  {
    id: 'darkPact',
    name: 'Dark Pact',
    classId: 'warlock',
    unlock: { level: 8 },
    modifiers: { normalDamage: 0.04, resource: { carryOnKill: 1 } },
    description:
      'A kill leaves one more Soul Fragment for the next fight; +4 % damage to foes that are not bosses.',
  },
  {
    id: 'malice',
    name: 'Malice',
    classId: 'warlock',
    unlock: { level: 16 },
    modifiers: { dotDamage: 0.4 },
    description: 'Curses tick 40 % harder.',
  },
  {
    id: 'demonSkin',
    name: 'Demon Skin',
    classId: 'warlock',
    unlock: { level: 24 },
    modifiers: { damageTaken: -0.1, damage: -0.02 },
    description: 'Blows hurt 10 % less; 2 % less damage.',
  },
  {
    id: 'soulSiphon',
    name: 'Soul Siphon',
    classId: 'warlock',
    unlock: { level: 32 },
    modifiers: { resource: { max: 2, perDotPulse: 1 } },
    description: 'Hold 2 more fragments, and every curse pulse yields one more.',
  },
  {
    id: 'hollowCovenant',
    name: 'Hollow Covenant',
    classId: 'warlock',
    unlock: { level: 46, deed: 'hollowSovereignDefeated' },
    modifiers: { spenderDamage: 0.1, dotDamage: 0.1 },
    description: 'Taught by the Hollow Sovereign’s fall: shadow skills +10 %, curses +10 %.',
  },
];
