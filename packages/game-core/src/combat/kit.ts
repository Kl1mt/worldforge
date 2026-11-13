import type { ClassId } from '../classes.js';
import type { WorldProgress } from '../world/unlocks.js';
import {
  ACTIVE_SKILLS,
  AUTO_SKILLS,
  PASSIVE_SKILLS,
  PULSE_MS,
  RESOURCE_RULES,
  type ActiveSkillDefinition,
  type PassiveModifiers,
  type PassiveSkillDefinition,
  type ResourceRules,
} from './skills.js';

/**
 * Ticket 9.1: the skill-loadout prototype (`docs/SKILLS.md`). Pure rules for resources, cooldowns
 * and damage over time on the fight's timeline, read by both farming simulations, dungeon and boss
 * fights, and duels. **Off by default**: with the switch off, no encounter carries a kit and every
 * fight is exactly today's (no loadout is even read).
 *
 * Modes:
 * - `off` (default): today's rules; loadouts are ignored.
 * - `on`: every encounter carries a kit, the hero's loadout or, without one, the default loadout
 *   (today's class skill alone); the fight runs through the kit rules.
 * - `shadow`: as `on`, and every fight whose loadout is the default one is resolved a second time
 *   with today's rules and must match bit for bit (outcome, RNG draws, log, exact distribution),
 *   or the call throws. `WF_SKILLS_PROTOTYPE=shadow pnpm --filter @worldforge/game-core test` runs
 *   every existing suite like that: the default-loadout replay.
 */
export type SkillsPrototypeMode = 'off' | 'on' | 'shadow';

/** The switch's state in play: off (9.2 switches it on after the owner's yes). */
export const DEFAULT_SKILLS_PROTOTYPE_MODE: SkillsPrototypeMode = 'off';

let prototypeMode: SkillsPrototypeMode = DEFAULT_SKILLS_PROTOTYPE_MODE;

export function skillsPrototypeMode(): SkillsPrototypeMode {
  return prototypeMode;
}

/** Test and tooling only (9.1); the server never calls it, so the switch stays off in play. */
export function setSkillsPrototype(mode: SkillsPrototypeMode): void {
  if (mode !== 'off' && mode !== 'on' && mode !== 'shadow')
    throw new RangeError(`Unknown skills prototype mode: ${String(mode)}`);
  prototypeMode = mode;
}

/** A replay mismatch: the default loadout did not fight exactly like today. */
export class SkillsReplayMismatch extends Error {
  constructor(where: string, detail: string) {
    super(`Skills replay mismatch in ${where}: ${detail}`);
    this.name = 'SkillsReplayMismatch';
  }
}

export function shadowCompare(where: string, legacy: unknown, kit: unknown): void {
  const a = JSON.stringify(legacy);
  const b = JSON.stringify(kit);
  if (a !== b) {
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    throw new SkillsReplayMismatch(
      where,
      `today …${a.slice(Math.max(0, i - 80), i + 80)}… vs kit …${b.slice(Math.max(0, i - 80), i + 80)}…`,
    );
  }
}

/**
 * Ticket 9.1: the proposed duel normalisation of loadouts (`PVP_RULES_VERSION` 3, docs/SKILLS.md
 * "PvP"): a duel keeps this share of a spender's and a damage over time's extra damage, and a
 * passive's damage bonuses are PvE only (its damage-taken change counts × `effectKeep`).
 */
export const PVP_V3_SKILL_KEEP = 0.5;

/* --- Loadouts ------------------------------------------------------------------------------- */

/** Three active slots (slot 1 a core skill, slots 2 and 3 spenders or empty) and one passive. */
export interface Loadout {
  actives: readonly (string | null)[];
  passive?: string | null;
}

export const LOADOUT_ACTIVE_SLOTS = 3;
/** Owner default (9.1): three saved loadout presets per hero (9.2 stores them). */
export const LOADOUT_PRESETS = 3;

export function defaultLoadout(classId: ClassId): Loadout {
  return { actives: [AUTO_SKILLS[classId].id, null, null], passive: null };
}

const activeById = new Map(ACTIVE_SKILLS.map((s) => [s.id, s]));
const passiveById = new Map(PASSIVE_SKILLS.map((s) => [s.id, s]));

export function getActiveSkill(id: string): ActiveSkillDefinition | undefined {
  return activeById.get(id);
}
export function getPassiveSkill(id: string): PassiveSkillDefinition | undefined {
  return passiveById.get(id);
}

/** The hero facts a loadout's unlocks read. */
export interface LoadoutHero {
  level: number;
  progress?: Partial<WorldProgress>;
}

export function skillUnlocked(
  skill: ActiveSkillDefinition | PassiveSkillDefinition,
  hero: LoadoutHero,
): boolean {
  if (hero.level < skill.unlock.level) return false;
  return skill.unlock.deed === undefined || hero.progress?.[skill.unlock.deed] === true;
}

/** The class's skills a hero has unlocked (actives, then passives), in content order. */
export function unlockedSkills(classId: ClassId, hero: LoadoutHero) {
  return {
    actives: ACTIVE_SKILLS.filter((s) => s.classId === classId && skillUnlocked(s, hero)),
    passives: PASSIVE_SKILLS.filter((s) => s.classId === classId && skillUnlocked(s, hero)),
  };
}

/**
 * Problems with a loadout for a class (empty = valid). With `hero`, locked skills are problems too
 * (9.2 validates the stored loadout on save and the server re-checks it before every settlement).
 */
export function validateLoadout(classId: ClassId, loadout: Loadout, hero?: LoadoutHero): string[] {
  const problems: string[] = [];
  const actives = loadout.actives;
  if (!Array.isArray(actives) || actives.length < 1 || actives.length > LOADOUT_ACTIVE_SLOTS)
    return [`a loadout has 1–${LOADOUT_ACTIVE_SLOTS} active slots`];
  const seen = new Set<string>();
  actives.forEach((id, slot) => {
    if (id === null) {
      if (slot === 0) problems.push('slot 1 needs a core skill');
      return;
    }
    const s = activeById.get(id);
    if (!s) return problems.push(`unknown skill ${id}`);
    if (s.classId !== classId) problems.push(`${id} is not a ${classId} skill`);
    if (slot === 0 && s.kind !== 'core') problems.push(`slot 1 holds a core skill, not ${id}`);
    if (slot > 0 && s.kind !== 'spender') problems.push(`slot ${slot + 1} holds a spender`);
    if (seen.has(id)) problems.push(`${id} twice`);
    seen.add(id);
    if (hero && !skillUnlocked(s, hero)) problems.push(`${id} is locked`);
  });
  if (loadout.passive !== undefined && loadout.passive !== null) {
    const p = passiveById.get(loadout.passive);
    if (!p) problems.push(`unknown passive ${loadout.passive}`);
    else {
      if (p.classId !== classId) problems.push(`${p.id} is not a ${classId} passive`);
      if (hero && !skillUnlocked(p, hero)) problems.push(`${p.id} is locked`);
    }
  }
  return problems;
}

export function loadoutKey(loadout: Loadout): string {
  return `${loadout.actives.map((a) => a ?? '-').join(',')}/${loadout.passive ?? '-'}`;
}

export function isDefaultLoadout(classId: ClassId, loadout: Loadout): boolean {
  return loadoutKey(loadout) === loadoutKey(defaultLoadout(classId));
}

/** What `buildEncounter` reads from a loadout before it prices hits. */
export interface ResolvedLoadout {
  classId: ClassId;
  key: string;
  isDefault: boolean;
  core: ActiveSkillDefinition;
  spenders: ActiveSkillDefinition[];
  passive: PassiveModifiers;
}

/** Resolves a loadout (default when absent); throws on an invalid one. */
export function resolveLoadout(classId: ClassId, loadout?: Loadout | null): ResolvedLoadout {
  const l = loadout ?? defaultLoadout(classId);
  const problems = validateLoadout(classId, l);
  if (problems.length > 0) throw new RangeError(`Invalid loadout: ${problems.join('; ')}`);
  const ids = l.actives.filter((a): a is string => a !== null);
  return {
    classId,
    key: loadoutKey(l),
    isDefault: isDefaultLoadout(classId, l),
    core: activeById.get(ids[0]!)!,
    spenders: ids.slice(1).map((id) => activeById.get(id)!),
    passive: l.passive ? passiveById.get(l.passive)!.modifiers : {},
  };
}

/* --- The compiled kit of one encounter ------------------------------------------------------ */

export interface KitDot {
  ticks: number;
  /** Integer damage of one tick (at least 1). */
  damage: number;
}

export interface KitSpender {
  id: string;
  cost: number;
  consumeAll: boolean;
  perUnit: number;
  gain: number;
  cooldownMs: number;
  readyAtMs: number;
  opener: boolean;
  /** Usable while the foe has at most this much health (0 = no condition). */
  enemyBelowHealth: number;
  /** The skill's damage multiplier × the passive's spender bonus. */
  multiplier: number;
  baseMultiplier: number;
  bonus: number;
  bonusCrit: number;
  /** Index into the kit's dots, or −1. */
  dot: number;
}

/** A loadout compiled against one encounter (`EncounterSetup.kit`). */
export interface SetupKit {
  key: string;
  isDefault: boolean;
  /** Resources, cooldowns and pulses matter (a spender or a damage over time is slotted). */
  active: boolean;
  pulses: boolean;
  listensToBlows: boolean;
  rules: Omit<ResourceRules, 'start'>;
  /** Resource at the fight's start (the warlock's: the fragments brought in). */
  start: number;
  coreGain: number;
  /** Index into `dots` of the core skill's damage over time, or −1. */
  coreDot: number;
  spenders: KitSpender[];
  dots: KitDot[];
  /** The 1× hit after mitigation, crit damage and chance (for spender prices without effects). */
  dealt: number;
  critDamage: number;
  critChance: number;
}

export interface KitState {
  /** Resource. */
  r: number;
  /** Per spender: the fight time it is ready again. */
  cd: number[];
  /** Per damage over time: ticks left. */
  dot: number[];
  /** No blow taken since the previous pulse. */
  unhit: boolean;
}

const hitDamage = (raw: number): number => Math.max(1, Math.round(raw));

/** Adds a passive's resource modifiers to the class's rules. */
export function kitRules(classId: ClassId, passive: PassiveModifiers): ResourceRules {
  const base = RESOURCE_RULES[classId];
  const add = passive.resource ?? {};
  const out = { ...base };
  for (const k of Object.keys(add) as (keyof typeof add)[]) out[k] = base[k] + add[k]!;
  return out;
}

/**
 * Compiles a resolved loadout for one encounter. `dealt` is the 1× hit after mitigation (boss and
 * passive bonuses included), `fragments` what the warlock brings into the fight.
 */
export function compileKit(
  resolved: ResolvedLoadout,
  numbers: { dealt: number; critDamage: number; critChance: number; enemyHealth: number },
  fragments = 0,
  /** Ticket 9.1 (duels): the share of extra damage kept (`PVP_V3_SKILL_KEEP`); 1 in PvE. */
  keep = 1,
): SetupKit {
  const p = resolved.passive;
  const kept = (m: number) => (keep === 1 ? m : 1 + (m - 1) * keep);
  const rules = kitRules(resolved.classId, p);
  const dots: KitDot[] = [];
  const addDot = (s: ActiveSkillDefinition): number => {
    if (!s.dot) return -1;
    const factor = 1 + (p.dotDamage ?? 0);
    const perTick = keep === 1 ? s.dot.perTick : s.dot.perTick * keep;
    dots.push({ ticks: s.dot.ticks, damage: hitDamage(numbers.dealt * perTick * factor) });
    return dots.length - 1;
  };
  const coreDot = addDot(resolved.core);
  const spenderBonus = 1 + (p.spenderDamage ?? 0);
  const spenders = resolved.spenders.map((s): KitSpender => ({
    id: s.id,
    cost: s.cost ?? 0,
    consumeAll: s.consumeAll === true,
    perUnit: (s.perUnit ?? 0) * keep,
    gain: s.gain ?? 0,
    cooldownMs: s.cooldownMs ?? 0,
    readyAtMs: s.readyAtMs ?? 0,
    opener: s.opener === true,
    enemyBelowHealth:
      s.enemyBelow !== undefined ? Math.max(1, Math.floor(s.enemyBelow * numbers.enemyHealth)) : 0,
    multiplier: kept(s.damageMultiplier * spenderBonus),
    baseMultiplier: kept(s.damageMultiplier),
    bonus: kept(spenderBonus),
    bonusCrit: s.bonusCritChance,
    dot: addDot(s),
  }));
  const active = spenders.length > 0 || dots.length > 0;
  const start =
    rules.carryOnKill > 0
      ? Math.min(rules.max, Math.max(0, Math.floor(fragments)))
      : resolvedStart(resolved.classId, rules);
  return {
    key: resolved.key,
    isDefault: resolved.isDefault,
    active,
    pulses:
      active &&
      (dots.length > 0 ||
        rules.perPulse !== 0 ||
        rules.perUnhitPulse !== 0 ||
        rules.perDotPulse !== 0 ||
        spenders.some((s) => s.cooldownMs > 0 || s.readyAtMs > 0)),
    listensToBlows: active && (rules.perBlowTaken !== 0 || rules.perUnhitPulse !== 0),
    rules,
    start,
    coreGain: resolved.core.gain ?? 0,
    coreDot,
    spenders,
    dots,
    dealt: numbers.dealt,
    critDamage: numbers.critDamage,
    critChance: numbers.critChance,
  };
}

function resolvedStart(classId: ClassId, rules: ResourceRules): number {
  const s = RESOURCE_RULES[classId].start;
  return s === 'full' ? rules.max : Math.min(rules.max, s);
}

/* --- The kit on the timeline ---------------------------------------------------------------- */

export function kitStart(kit: SetupKit): KitState {
  return {
    r: kit.start,
    cd: kit.spenders.map((s) => s.readyAtMs),
    dot: kit.dots.map(() => 0),
    unhit: true,
  };
}

export function kitStateKey(s: KitState): string {
  return `${s.r}|${s.cd.join(',')}|${s.dot.join(',')}|${s.unhit ? 1 : 0}`;
}

const clampR = (kit: SetupKit, r: number) => Math.min(kit.rules.max, Math.max(0, r));

/** Which spender (index) replaces this basic attack, or −1. Only called when the core doesn't fire. */
export function kitSpenderFor(
  kit: SetupKit,
  s: KitState,
  attack: number,
  t: number,
  enemyHealth: number,
): number {
  for (let i = 0; i < kit.spenders.length; i++) {
    const sp = kit.spenders[i]!;
    if (t < s.cd[i]!) continue;
    if (s.r < sp.cost || (sp.consumeAll && s.r < Math.max(1, sp.cost))) continue;
    if (sp.opener && attack !== 1) continue;
    if (sp.enemyBelowHealth > 0 && enemyHealth > sp.enemyBelowHealth) continue;
    if (sp.dot >= 0 && s.dot[sp.dot]! > 0) continue;
    return i;
  }
  return -1;
}

/** The spender's multiplier for this state (consume-all skills scale with what they spend). */
export function kitSpenderMultiplier(kit: SetupKit, s: KitState, i: number): number {
  const sp = kit.spenders[i]!;
  if (!sp.consumeAll) return sp.multiplier;
  return (sp.baseMultiplier + sp.perUnit * s.r) * sp.bonus;
}

/**
 * The state after a hero attack. `action`: −2 a basic attack, −1 the core skill, i ≥ 0 spender i.
 */
export function kitAfterAttack(
  kit: SetupKit,
  s: KitState,
  action: number,
  crit: boolean,
  t: number,
): KitState {
  let r = s.r;
  let cd = s.cd;
  let dot = s.dot;
  if (action >= 0) {
    const sp = kit.spenders[action]!;
    r = sp.consumeAll ? 0 : r - sp.cost;
    r += sp.gain;
    if (sp.cooldownMs > 0) {
      cd = cd.slice();
      cd[action] = t + sp.cooldownMs;
    }
    if (sp.dot >= 0) {
      dot = dot.slice();
      dot[sp.dot] = kit.dots[sp.dot]!.ticks;
    }
  } else if (action === -1) {
    r += kit.coreGain;
    if (kit.coreDot >= 0) {
      dot = dot.slice();
      dot[kit.coreDot] = kit.dots[kit.coreDot]!.ticks;
    }
  }
  r += kit.rules.perAttack + (crit ? kit.rules.perCrit : 0);
  return { r: clampR(kit, r), cd, dot, unhit: s.unhit };
}

/** A pulse: damage over time ticks and timed resources move. */
export function kitPulse(kit: SetupKit, s: KitState): { damage: number; state: KitState } {
  let damage = 0;
  let ticked = false;
  let dot = s.dot;
  for (let i = 0; i < dot.length; i++) {
    if (dot[i]! > 0) {
      if (!ticked) dot = dot.slice();
      ticked = true;
      damage += kit.dots[i]!.damage;
      dot[i] = dot[i]! - 1;
    }
  }
  let r = s.r + kit.rules.perPulse;
  if (s.unhit) r += kit.rules.perUnhitPulse;
  if (ticked) r += kit.rules.perDotPulse;
  return { damage, state: { r: clampR(kit, r), cd: s.cd, dot, unhit: true } };
}

/** The hero took a blow. */
export function kitBlow(kit: SetupKit, s: KitState): KitState {
  return { r: clampR(kit, s.r + kit.rules.perBlowTaken), cd: s.cd, dot: s.dot, unhit: false };
}

/** Pulse times are fixed: every `PULSE_MS` from the fight's start. */
export const pulseAt = (k: number): number => k * PULSE_MS;

/** A copy of an encounter setup without its kit: today's fight (the shadow replay's twin). */
export function withoutKit<T extends { kit?: SetupKit }>(setup: T): Omit<T, 'kit'> {
  const copy = { ...setup };
  delete copy.kit;
  return copy;
}
