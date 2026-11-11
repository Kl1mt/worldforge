import { CLASS_IDS, getClass, type ClassId } from '../classes.js';
import { STAT_LIMITS } from '../combat/characterStats.js';
import {
  DEFAULT_COMBAT_CONFIG,
  attackHit,
  buildEncounter,
  thornsDamage,
  type EncounterSetup,
} from '../combat/encounter.js';
import { hasCombatEffects } from '../effects/resolve.js';
import { createRng } from '../rng.js';
import type { StatBlock } from '../combat/characterStats.js';
import type { EnemyDefinition, EnemyId } from '../world/enemies.js';
import {
  DEFAULT_PVP_CONFIG,
  PVP_RULES_VERSION,
  findPvpBracket,
  normaliseFighter,
  pvpReferenceStats,
  pvpBracketOf,
  type PvpBracket,
  type PvpConfig,
  type PvpFighter,
  type PvpFighterInput,
} from './normalise.js';

/**
 * Hero-vs-hero duels (ticket 5.4, docs/PVP.md, GDD §10.3): a challenger against a defender's saved
 * snapshot, resolved at once on the PvE combat engine (`buildEncounter`, `attackHit`,
 * `thornsDamage`) with both fighters normalised toward their bracket. Pure and deterministic: the
 * same input and seed always give the same duel. The seed is a server secret (5.5 draws it with
 * `crypto`); never accept one from a client.
 */

export type DuelSide = 'challenger' | 'defender';
export const DUEL_SIDES: readonly DuelSide[] = ['challenger', 'defender'];
const other = (side: DuelSide): DuelSide => (side === 'challenger' ? 'defender' : 'challenger');

export type DuelOutcome = DuelSide | 'draw';
/** `defeat`: a fighter fell; `timeLimit`: the time ran out and health decided (or a draw). */
export type DuelEndReason = 'defeat' | 'timeLimit';

/**
 * The duel's log, in the style of the crypt log (`DungeonEvent`): `t` is ms since the duel began,
 * health values are after the event.
 */
export type DuelEvent =
  /** Both fighters at full health; `initiative` acts first when both strike in the same moment. */
  | {
      t: number;
      type: 'start';
      initiative: DuelSide;
      health: Record<DuelSide, number>;
    }
  /** `side` struck; `health` is the target's health after the blow. */
  | {
      t: number;
      type: 'attack';
      side: DuelSide;
      damage: number;
      crit: boolean;
      skill: boolean;
      health: number;
    }
  /** `side`'s thorns hurt the fighter who just struck them; `health` is the striker's. */
  | { t: number; type: 'thorns'; side: DuelSide; damage: number; health: number }
  /** Sudden death began: every blow grows stronger from here on. */
  | { t: number; type: 'suddenDeath' }
  | { t: number; type: 'defeat'; side: DuelSide }
  | { t: number; type: 'timeLimit' }
  | { t: number; type: 'end'; outcome: DuelOutcome; reason: DuelEndReason };

export interface DuelInput {
  challenger: PvpFighterInput;
  defender: PvpFighterInput;
  /** Server-generated secret of this duel. */
  seed: string;
  /**
   * The bracket both fight in. Default: the fighters' shared bracket (a RangeError if their levels
   * fall into different brackets). Given explicitly, fighters from other brackets are normalised
   * toward this one (e.g. a friendly challenge).
   */
  bracketId?: string;
}

export interface DuelSideResult {
  classId: ClassId;
  level: number;
  /** Normalised stats (health is the duel's max health). */
  stats: StatBlock;
  maxHealth: number;
  /** Health at the end. */
  health: number;
  attacks: number;
  crits: number;
  damageDealt: number;
}

export interface DuelResult {
  rulesVersion: number;
  bracketId: string;
  outcome: DuelOutcome;
  reason: DuelEndReason;
  durationMs: number;
  initiative: DuelSide;
  sides: Record<DuelSide, DuelSideResult>;
  events: DuelEvent[];
}

/**
 * The opponent as the encounter rules read an enemy: their normalised health, primary damage and
 * defences, class attack speed. `rank: 'normal'`, so no boss bonus applies.
 */
function asEnemy(f: PvpFighter): EnemyDefinition {
  const cls = getClass(f.classId);
  const damage = cls.primaryDamage === 'physical' ? f.stats.physicalDamage : f.stats.magicDamage;
  const flat = (v: number) => ({ base: v, perLevel: 0 });
  return {
    id: `pvp:${f.classId}` as EnemyId,
    name: cls.name,
    assetId: 'pvp',
    damageType: cls.primaryDamage,
    undead: false,
    rank: 'normal',
    attackSpeed: f.stats.attackSpeed,
    health: flat(f.maxHealth),
    damage: flat(damage),
    armor: flat(f.stats.armor),
    resistance: flat(f.stats.resistance),
    xp: flat(0),
  };
}

/**
 * `attacker` striking `target`: an encounter setup with the target as the enemy. Both fight at
 * the bracket's reference level, so the mitigation formula's attacker level is the same for
 * everyone (level only counts through the normalised stats).
 */
function duelSetup(
  attacker: PvpFighter,
  target: PvpFighter,
  bracket: PvpBracket,
  config: PvpConfig,
): EncounterSetup {
  const level = bracket.referenceLevel;
  const blend = (f: PvpFighter): PvpFighter => {
    if (!config.blendDefences) return f;
    const mean = (f.stats.armor + f.stats.resistance) / 2;
    return { ...f, stats: { ...f.stats, armor: mean, resistance: mean } };
  };
  attacker = blend(attacker);
  target = blend(target);
  const fx = hasCombatEffects(attacker.effects) ? attacker.effects : undefined;
  return buildEncounter(
    asEnemy(target),
    level,
    attacker.classId,
    level,
    { ...attacker.stats, health: attacker.maxHealth },
    DEFAULT_COMBAT_CONFIG,
    { skillDamage: attacker.skillDamage },
    fx ? { effects: fx, momentum: 0 } : undefined,
  );
}

function resolveBracket(input: DuelInput, config: PvpConfig): PvpBracket {
  if (input.bracketId !== undefined) {
    const b = findPvpBracket(input.bracketId, config);
    if (!b) throw new RangeError(`Unknown PvP bracket: ${input.bracketId}`);
    return b;
  }
  const a = pvpBracketOf(input.challenger.level, config);
  const d = pvpBracketOf(input.defender.level, config);
  if (a.id !== d.id)
    throw new RangeError(`Fighters are in different brackets (${a.id} vs ${d.id}).`);
  return a;
}

/**
 * Plays one duel. Timeline (as in PvE): each fighter strikes at `j · interval` of their own attack
 * speed (j ≥ 1); when both strike in the same millisecond, the side with the initiative (one coin
 * flip per duel) goes first. A blow that drops the target to 0 ends the duel at once; thorns
 * answer every blow the target survives. From `suddenDeath.atMs` every blow (and thorns) grows
 * by `perSecond` per second; at `maxDuelMs` the fighter with the larger share of their health
 * left wins, an exact tie is a draw.
 *
 * RNG streams: `${seed}:initiative` (one draw), `${seed}:challenger` and `${seed}:defender` (each
 * fighter's crit rolls), so one fighter's rolls never shift the other's.
 */
export function simulateDuel(input: DuelInput, config: PvpConfig = DEFAULT_PVP_CONFIG): DuelResult {
  if (typeof input.seed !== 'string' || input.seed.length === 0)
    throw new RangeError('A duel needs a server seed.');
  const bracket = resolveBracket(input, config);
  const fighters: Record<DuelSide, PvpFighter> = {
    challenger: normaliseFighter(input.challenger, bracket, config),
    defender: normaliseFighter(input.defender, bracket, config),
  };
  const setups: Record<DuelSide, EncounterSetup> = {
    challenger: duelSetup(fighters.challenger, fighters.defender, bracket, config),
    defender: duelSetup(fighters.defender, fighters.challenger, bracket, config),
  };
  const rngs = {
    challenger: createRng(`${input.seed}:challenger`),
    defender: createRng(`${input.seed}:defender`),
  };
  const initiative: DuelSide = createRng(`${input.seed}:initiative`).chance(0.5)
    ? 'challenger'
    : 'defender';

  const hp: Record<DuelSide, number> = {
    challenger: fighters.challenger.maxHealth,
    defender: fighters.defender.maxHealth,
  };
  const attack: Record<DuelSide, number> = { challenger: 1, defender: 1 };
  const prevCrit: Record<DuelSide, boolean> = { challenger: false, defender: false };
  const tally = {
    challenger: { attacks: 0, crits: 0, damageDealt: 0 },
    defender: { attacks: 0, crits: 0, damageDealt: 0 },
  };
  const events: DuelEvent[] = [{ t: 0, type: 'start', initiative, health: { ...hp } }];
  const { atMs: suddenAt, perSecond } = config.suddenDeath;
  let suddenLogged = false;
  const surge = (t: number) => (t > suddenAt ? 1 + (perSecond * (t - suddenAt)) / 1000 : 1);
  const scaled = (damage: number, t: number) => {
    const m = surge(t);
    return m === 1 ? damage : Math.max(1, Math.round(damage * m));
  };

  let outcome: DuelOutcome | null = null;
  let reason: DuelEndReason = 'defeat';
  let end = config.maxDuelMs;
  const nextAt = (side: DuelSide) => attack[side] * setups[side].playerIntervalMs;

  while (outcome === null) {
    const tc = nextAt('challenger');
    const td = nextAt('defender');
    const t = Math.min(tc, td);
    if (t > config.maxDuelMs) break;
    if (!suddenLogged && t > suddenAt && suddenAt < config.maxDuelMs) {
      suddenLogged = true;
      events.push({ t: suddenAt, type: 'suddenDeath' });
    }
    const side: DuelSide = tc === td ? initiative : tc < td ? 'challenger' : 'defender';
    const target = other(side);
    const setup = setups[side];
    const hit = attackHit(setup, attack[side], prevCrit[side], hp[side], hp[target]);
    const crit = rngs[side].chance(hit.critChance);
    prevCrit[side] = crit && !hit.surged;
    const spread = config.damageSpread;
    const luck = spread > 0 ? 1 - spread + 2 * spread * rngs[side].next() : 1;
    const rolled = crit ? hit.crit : hit.normal;
    const damage = Math.min(
      hp[target],
      scaled(luck === 1 ? rolled : Math.max(1, Math.round(rolled * luck)), t),
    );
    hp[target] -= damage;
    tally[side].attacks++;
    if (crit) tally[side].crits++;
    tally[side].damageDealt += damage;
    attack[side]++;
    events.push({ t, type: 'attack', side, damage, crit, skill: hit.skill, health: hp[target] });
    if (hp[target] <= 0) {
      events.push({ t, type: 'defeat', side: target });
      outcome = side;
      end = t;
      break;
    }
    const thorns = thornsDamage(setups[target]);
    if (thorns > 0) {
      const back = Math.min(hp[side], scaled(thorns, t));
      hp[side] -= back;
      tally[target].damageDealt += back;
      events.push({ t, type: 'thorns', side: target, damage: back, health: hp[side] });
      if (hp[side] <= 0) {
        events.push({ t, type: 'defeat', side });
        outcome = target;
        end = t;
      }
    }
  }
  if (outcome === null) {
    reason = 'timeLimit';
    events.push({ t: end, type: 'timeLimit' });
    // Compare health shares exactly (integers): hp_c / max_c vs hp_d / max_d.
    const c = hp.challenger * fighters.defender.maxHealth;
    const d = hp.defender * fighters.challenger.maxHealth;
    outcome = c > d ? 'challenger' : d > c ? 'defender' : 'draw';
  }
  events.push({ t: end, type: 'end', outcome, reason });

  const sideResult = (side: DuelSide): DuelSideResult => ({
    classId: fighters[side].classId,
    level: fighters[side].level,
    stats: { ...fighters[side].stats, health: fighters[side].maxHealth },
    maxHealth: fighters[side].maxHealth,
    health: hp[side],
    ...tally[side],
  });
  return {
    rulesVersion: PVP_RULES_VERSION,
    bracketId: bracket.id,
    outcome,
    reason,
    durationMs: end,
    initiative,
    sides: { challenger: sideResult('challenger'), defender: sideResult('defender') },
    events,
  };
}

/** No in-fight effect (the reference hero's: implicit stats only). */
const NO_EFFECTS: PvpFighter['effects'] = {
  critBurn: 0,
  execute: { threshold: 0, bonus: 0 },
  bossSlayer: 0,
  lifeOnKill: 0,
  bloodrush: { perStack: 0, maxStacks: 0, decayMs: 0 },
  thorns: 0,
  fortitude: { threshold: 0, bonus: 0 },
  skillRage: 0,
  skillSurge: 0,
  skillOpener: 0,
  skillRot: 0,
};

/**
 * The bracket's reference hero of a class as a duel fights it (ticket B.5): `pvpReferenceStats`
 * with the class tuning, no effects. `normaliseFighter` maps a hero in the reference kit to these
 * stats, so this is the anchor every hero is pulled toward.
 */
export function referenceFighter(
  classId: ClassId,
  bracket: PvpBracket,
  config: PvpConfig = DEFAULT_PVP_CONFIG,
): PvpFighter {
  const stats = pvpReferenceStats(classId, bracket, config);
  stats.health = Math.max(STAT_LIMITS.health.min, Math.floor(stats.health));
  const tuning = config.classDamage[bracket.id]?.[classId] ?? 1;
  const primary = getClass(classId).primaryDamage === 'physical' ? 'physicalDamage' : 'magicDamage';
  stats[primary] = Math.min(STAT_LIMITS[primary].max, stats[primary] * tuning);
  return {
    classId,
    level: bracket.referenceLevel,
    pveStats: { ...stats },
    stats,
    maxHealth: stats.health,
    skillDamage: 0,
    effects: { ...NO_EFFECTS },
  };
}

/** How long the expected-value fight of `duelStrength` may run before it extrapolates. */
const EXPECTED_LIMIT_MS = 600_000;

/**
 * Ticket B.5: a duel between two normalised fighters played on **expected** blows instead of
 * rolled ones (each blow = crit chance × crit + the rest × normal, the luck of the blow at its
 * mean 1, a surge weighted by the chance the blow before was a crit), with both sides striking on
 * their own timelines (as `simulateDuel`) and thorns answering every blow. Neither side stops at
 * the other's fall: it returns the time each side's health reaches 0 (extrapolated linearly past
 * `EXPECTED_LIMIT_MS`), without sudden death, which shortens both alike. No random draw.
 */
export function expectedDuelTimes(
  a: PvpFighter,
  b: PvpFighter,
  bracket: PvpBracket,
  config: PvpConfig = DEFAULT_PVP_CONFIG,
): { a: number; b: number } {
  type S = 'a' | 'b';
  const fighters = { a, b };
  const setups = { a: duelSetup(a, b, bracket, config), b: duelSetup(b, a, bracket, config) };
  const hp = { a: a.maxHealth, b: b.maxHealth };
  const pCrit = { a: 0, b: 0 };
  const attack = { a: 1, b: 1 };
  const fall: Record<S, number | null> = { a: null, b: null };
  const expected = (h: { critChance: number; crit: number; normal: number }) =>
    h.critChance * h.crit + (1 - h.critChance) * h.normal;
  while (fall.a === null || fall.b === null) {
    const ta = attack.a * setups.a.playerIntervalMs;
    const tb = attack.b * setups.b.playerIntervalMs;
    const t = Math.min(ta, tb);
    if (t > EXPECTED_LIMIT_MS) break;
    const s: S = ta <= tb ? 'a' : 'b';
    const o: S = s === 'a' ? 'b' : 'a';
    const own = Math.max(1, hp[s]);
    const theirs = Math.max(1, hp[o]);
    const plain = attackHit(setups[s], attack[s], false, own, theirs);
    const afterCrit = attackHit(setups[s], attack[s], true, own, theirs);
    // A fall between blows: the share of this blow's interval its damage needed, so a small
    // edge (one more point per blow) moves the time even when the blow count stays the same.
    const strike = (k: S, damage: number) => {
      const before = hp[k];
      hp[k] -= damage;
      if (hp[k] <= 0 && fall[k] === null) {
        const from = (attack[s] - 1) * setups[s].playerIntervalMs;
        fall[k] = from + ((t - from) * Math.max(0, before)) / Math.max(1e-9, damage);
      }
    };
    strike(o, (1 - pCrit[s]) * expected(plain) + pCrit[s] * expected(afterCrit));
    pCrit[s] =
      (1 - pCrit[s]) * (plain.surged ? 0 : plain.critChance) +
      pCrit[s] * (afterCrit.surged ? 0 : afterCrit.critChance);
    const thorns = thornsDamage(setups[o]);
    if (thorns > 0) strike(s, thorns);
    attack[s]++;
  }
  const time = (k: S) =>
    fall[k] ??
    (EXPECTED_LIMIT_MS * fighters[k].maxHealth) / Math.max(1, fighters[k].maxHealth - hp[k]);
  return { a: time('a'), b: time('b') };
}

/**
 * Ticket B.5: a hero's **duel strength** in a bracket, the measure behind bracket Power 3: the
 * mean over the four classes' reference heroes (`referenceFighter`) of ln(the time the reference
 * needs to fell the hero ÷ the time the hero needs to fell the reference), from the expected-value
 * duel (`expectedDuelTimes`). 0 = as strong as the reference kit; +0.1 = about 10 % faster to win
 * than to lose. Pure and deterministic (no seed); ≈ 0.2 ms.
 */
export function duelStrength(
  input: PvpFighterInput,
  bracket: PvpBracket,
  config: PvpConfig = DEFAULT_PVP_CONFIG,
): number {
  const hero = normaliseFighter(input, bracket, config);
  let sum = 0;
  for (const classId of CLASS_IDS) {
    const t = expectedDuelTimes(hero, referenceFighter(classId, bracket, config), bracket, config);
    sum += Math.log(t.a / t.b);
  }
  return sum / CLASS_IDS.length;
}
