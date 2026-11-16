import {
  ACTIVE_SKILLS,
  PASSIVE_SKILLS,
  RESOURCES,
  RESOURCE_RULES,
  defaultLoadout,
  getClass,
  validateLoadout,
  type ActiveSkillDefinition,
  type ClassId,
  type Loadout,
  type LoadoutHero,
  type PassiveSkillDefinition,
  type ResourceRules,
  type WorldProgress,
} from '@worldforge/game-core';
import { apiRequest, type ApiFailure, type ApiResult } from '../lib/api';
import { describeGameFailure } from './api';

/**
 * Ticket 9.2: the Skills screen's API calls and wording (docs/SKILLS.md). Every number comes from
 * game-core's content; the server validates and stores the loadouts, this only explains them.
 */

/* --- API ------------------------------------------------------------------------------------ */

export interface SkillsPresetView {
  preset: number;
  actives: (string | null)[];
  passive: string | null;
  isDefault: boolean;
  /** Why the stored preset can't be fielded now (it then fights as the default); empty = fine. */
  problems: string[];
}

export interface SkillsResponse {
  characterId: string;
  classId: ClassId;
  level: number;
  resource: { max: number; start: number };
  activePreset: number;
  inForce: { actives: (string | null)[]; passive: string | null };
  presets: SkillsPresetView[];
  /** The class's skills this hero has unlocked (level and boss deeds). */
  unlocked: string[];
  soulFragments: number;
}

/** What a preset holds, as the screen edits it (three active slots, one passive). */
export interface LoadoutDraft {
  actives: [string | null, string | null, string | null];
  passive: string | null;
}

type Signal = { signal?: AbortSignal };
const c = (id: string) => `/characters/${encodeURIComponent(id)}/skills`;

/** Saving the same loadout again or switching to the preset in force changes nothing: no key. */
export const skillsApi = {
  get: (id: string, o: Signal = {}, f?: typeof fetch): Promise<ApiResult<SkillsResponse>> =>
    apiRequest(c(id), o, f),
  savePreset: (
    id: string,
    preset: number,
    loadout: LoadoutDraft,
    f?: typeof fetch,
  ): Promise<ApiResult<SkillsResponse>> =>
    apiRequest(
      `${c(id)}/presets/${preset}`,
      { method: 'PUT', body: { actives: loadout.actives, passive: loadout.passive } },
      f,
    ),
  switchPreset: (
    id: string,
    preset: number,
    f?: typeof fetch,
  ): Promise<ApiResult<SkillsResponse>> =>
    apiRequest(`${c(id)}/preset`, { method: 'POST', body: { preset } }, f),
};

/* --- Content lookups ------------------------------------------------------------------------ */

export type SkillDefinition = ActiveSkillDefinition | PassiveSkillDefinition;
export const isActive = (s: SkillDefinition): s is ActiveSkillDefinition => 'kind' in s;

const BY_ID = new Map<string, SkillDefinition>(
  [...ACTIVE_SKILLS, ...PASSIVE_SKILLS].map((s) => [s.id, s]),
);
export const skillById = (id: string | null | undefined): SkillDefinition | undefined =>
  id ? BY_ID.get(id) : undefined;

/** The class's skills in content order (unlock order): class skills, spenders, passives. */
export function classSkills(classId: ClassId) {
  const actives = ACTIVE_SKILLS.filter((s) => s.classId === classId);
  return {
    core: actives.filter((s) => s.kind === 'core'),
    spenders: actives.filter((s) => s.kind === 'spender'),
    passives: PASSIVE_SKILLS.filter((s) => s.classId === classId),
  };
}

/** Slot indices 0–2 are the actives, 3 the passive. */
export type SlotIndex = 0 | 1 | 2 | 3;
export const PASSIVE_SLOT = 3 as const;

export const SLOT_LABELS: Record<SlotIndex, string> = {
  0: 'Class skill (slot 1)',
  1: 'Spender (slot 2)',
  2: 'Spender (slot 3)',
  3: 'Passive',
};

export function fitsSlot(skill: SkillDefinition, slot: SlotIndex): boolean {
  if (slot === PASSIVE_SLOT) return !isActive(skill);
  if (!isActive(skill)) return false;
  return slot === 0 ? skill.kind === 'core' : skill.kind === 'spender';
}

/* --- Wording -------------------------------------------------------------------------------- */

export function resourceName(classId: ClassId): string {
  const id = getClass(classId).resource;
  return RESOURCES.find((r) => r.id === id)?.name ?? id;
}

/** "160 %", "1.2 %": whole or one decimal, with the house's space before the sign. */
export function percent(share: number): string {
  const v = Math.round(share * 1000) / 10;
  return `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)} %`;
}

const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`;

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The unit a "per unit" bonus counts: a point of Rage, Mana or Focus, or one Soul Fragment. */
function unitOf(classId: ClassId): string {
  return getClass(classId).resource === 'soulFragments' ? 'fragment' : 'point';
}

const DOT_VERB: Record<ClassId, string> = {
  warrior: 'bleeds',
  mage: 'burns',
  hunter: 'bleeds',
  warlock: 'withers',
};

/** The class's resource and its rule in one sentence, from `RESOURCE_RULES`. */
export function describeResource(classId: ClassId, rules: ResourceRules = RESOURCE_RULES[classId]) {
  const name = resourceName(classId);
  const plural = getClass(classId).resource === 'soulFragments';
  const verb = (one: string, many: string) => (plural ? many : one);
  const start =
    rules.start === 'full'
      ? verb('starts full', 'start full')
      : rules.start === 0
        ? verb('starts empty', 'start empty')
        : verb(`starts at ${rules.start}`, `start at ${rules.start}`);
  const gains: string[] = [];
  if (rules.perAttack > 0) gains.push(`${rules.perAttack} with every attack`);
  if (rules.perBlowTaken > 0) gains.push(`${rules.perBlowTaken} with every blow taken`);
  if (rules.perPulse > 0) gains.push(`${rules.perPulse} a second`);
  if (rules.perUnhitPulse > 0) gains.push(`${rules.perUnhitPulse} each second you are not hit`);
  if (rules.perDotPulse > 0) gains.push(`${rules.perDotPulse} each second a curse ticks`);
  const onlyRegen = rules.perPulse > 0 && gains.length === 1;
  let line = `${name} (up to ${rules.max}) ${start}`;
  if (gains.length > 0) {
    line += ` and ${onlyRegen ? verb('comes back', 'come back') : verb('builds', 'build')} ${joinAnd(gains)}`;
  }
  if (rules.perCrit > 0) line += `; every crit gives ${rules.perCrit} back`;
  if (rules.carryOnKill > 0) line += `; a kill leaves ${rules.carryOnKill} for the next fight`;
  return `${line}.`;
}

/** The plain-number facts of an active skill: "50 Rage · 160 % damage". */
export function activeFacts(skill: ActiveSkillDefinition): string[] {
  const res = resourceName(skill.classId);
  const facts: string[] = [];
  if (skill.kind === 'core' && skill.everyNthAttack) {
    facts.push(`every ${ordinal(skill.everyNthAttack)} attack`);
  }
  if (skill.consumeAll) {
    facts.push(`all ${res} (at least ${skill.cost ?? 0})`);
    facts.push(
      `${percent(skill.damageMultiplier)} damage +${percent(skill.perUnit ?? 0)} per ${unitOf(skill.classId)}`,
    );
  } else {
    if (skill.kind === 'spender') {
      facts.push(skill.cost && skill.cost > 0 ? `${skill.cost} ${res}` : 'no cost');
    }
    facts.push(`${percent(skill.damageMultiplier)} damage`);
  }
  if (skill.bonusCritChance > 0) facts.push(`+${percent(skill.bonusCritChance)} crit chance`);
  if (skill.dot) {
    facts.push(
      `${DOT_VERB[skill.classId]} ${percent(skill.dot.perTick)} a second for ${skill.dot.ticks} s`,
    );
  }
  if (skill.gain) facts.push(`builds ${skill.gain} ${res}`);
  if (skill.opener) facts.push('opens every fight');
  if (skill.enemyBelow !== undefined) facts.push(`foe below ${percent(skill.enemyBelow)} health`);
  const readyAt = skill.readyAtMs ?? 0;
  if (readyAt > 0 && skill.cooldownMs) {
    facts.push(`ready ${seconds(readyAt)} into a fight, then every ${seconds(skill.cooldownMs)}`);
  } else if (readyAt > 0) {
    facts.push(`ready ${seconds(readyAt)} into a fight`);
  } else if (skill.cooldownMs) {
    facts.push(`every ${seconds(skill.cooldownMs)} at most`);
  }
  if (skill.kind === 'spender' && skill.dot) facts.push('recast when it ends');
  return facts;
}

const signed = (share: number) => `${share >= 0 ? '+' : '−'}${percent(Math.abs(share))}`;
const signedN = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n)}`;

/** The plain-number facts of a passive: "−8 % damage taken · +2 Rage per blow taken". */
export function passiveFacts(skill: PassiveSkillDefinition): string[] {
  const m = skill.modifiers;
  const res = resourceName(skill.classId);
  const facts: string[] = [];
  if (m.damage) facts.push(`${signed(m.damage)} damage`);
  if (m.normalDamage) facts.push(`${signed(m.normalDamage)} damage to foes that are not bosses`);
  if (m.bossDamage) facts.push(`${signed(m.bossDamage)} damage to bosses`);
  if (m.spenderDamage) facts.push(`${signed(m.spenderDamage)} spender damage`);
  if (m.dotDamage) facts.push(`${signed(m.dotDamage)} damage over time`);
  if (m.damageTaken) facts.push(`${signed(m.damageTaken)} damage taken`);
  const r = m.resource ?? {};
  if (r.max) facts.push(`${signedN(r.max)} ${res} at most`);
  if (r.perAttack) facts.push(`${signedN(r.perAttack)} ${res} per attack`);
  if (r.perBlowTaken) facts.push(`${signedN(r.perBlowTaken)} ${res} per blow taken`);
  if (r.perPulse) facts.push(`${signedN(r.perPulse)} ${res} a second`);
  if (r.perUnhitPulse) facts.push(`${signedN(r.perUnhitPulse)} ${res} a second while not hit`);
  if (r.perDotPulse) facts.push(`${signedN(r.perDotPulse)} ${res} per curse pulse`);
  if (r.perCrit) facts.push(`${signedN(r.perCrit)} ${res} per crit`);
  if (r.carryOnKill) facts.push(`${signedN(r.carryOnKill)} ${res} kept from a kill`);
  return facts;
}

export function skillFacts(skill: SkillDefinition): string {
  return (isActive(skill) ? activeFacts(skill) : passiveFacts(skill)).join(' · ');
}

const DEED_TEXT: Record<NonNullable<SkillDefinition['unlock']['deed']>, string> = {
  // Ticket 9.3: taught by the skill quests at the Tavern (a boss kill and an older boss's material).
  forgeTyrantSkillLearned: 'Taught by the Tyrant’s Lesson (Tavern)',
  hollowSovereignSkillLearned: 'Taught by the Sovereign’s Lesson (Tavern)',
};

/** "Unlocks at level 12", or "Taught by the Tyrant’s Lesson (Tavern) · level 36". */
export function unlockText(skill: SkillDefinition): string {
  const { level, deed } = skill.unlock;
  return deed ? `${DEED_TEXT[deed]} · level ${level}` : `Unlocks at level ${level}`;
}

/** Legendary and set effects that name "the class skill" act on whatever sits in slot 1. */
export const CLASS_SKILL_NOTE =
  'Legendary and set effects that name the class skill act on your class skill (slot 1).';

/* --- Loadouts ------------------------------------------------------------------------------- */

export function toDraft(l: {
  actives: readonly (string | null)[];
  passive?: string | null;
}): LoadoutDraft {
  const a = l.actives;
  return { actives: [a[0] ?? null, a[1] ?? null, a[2] ?? null], passive: l.passive ?? null };
}

export const defaultDraft = (classId: ClassId): LoadoutDraft => toDraft(defaultLoadout(classId));

export const sameDraft = (a: LoadoutDraft, b: LoadoutDraft): boolean =>
  a.passive === b.passive && a.actives.every((id, i) => id === b.actives[i]);

/** What's in a slot of a draft. */
export const inSlot = (d: LoadoutDraft, slot: SlotIndex): string | null =>
  slot === PASSIVE_SLOT ? d.passive : d.actives[slot];

/**
 * Puts a skill (or nothing) in a slot. A spender already in the other spender slot moves over
 * (the two swap), so a skill is never in two slots. Slot 1 can't be emptied.
 */
export function placeSkill(d: LoadoutDraft, slot: SlotIndex, id: string | null): LoadoutDraft {
  if (slot === PASSIVE_SLOT) return { ...d, passive: id };
  if (slot === 0 && id === null) return d;
  const actives: LoadoutDraft['actives'] = [...d.actives];
  const was = actives[slot] ?? null;
  const other = id === null ? -1 : actives.indexOf(id);
  if (other >= 0 && other !== slot) actives[other] = was;
  actives[slot] = id;
  return { ...d, actives };
}

/** The hero facts the unlocks read, as the server's `unlocked` list tells them. */
export function heroFactsOf(view: Pick<SkillsResponse, 'level' | 'unlocked'>): LoadoutHero {
  const progress: Partial<WorldProgress> = {};
  for (const id of view.unlocked) {
    const deed = skillById(id)?.unlock.deed;
    if (deed) progress[deed] = true;
  }
  return { level: view.level, progress };
}

export const isUnlocked = (view: Pick<SkillsResponse, 'unlocked'>, id: string) =>
  view.unlocked.includes(id);

/** A game-core problem in player words: skill ids become names. */
export function describeProblem(problem: string): string {
  const text = problem.replace(/[A-Za-z]+/g, (word) => BY_ID.get(word)?.name ?? word);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Client-side check, for feedback only (the server decides on save). */
export function loadoutProblems(
  view: Pick<SkillsResponse, 'classId' | 'level' | 'unlocked'>,
  d: LoadoutDraft,
): string[] {
  const loadout: Loadout = { actives: d.actives, passive: d.passive };
  return validateLoadout(view.classId, loadout, heroFactsOf(view)).map(describeProblem);
}

export function describeSkillsFailure(error: Pick<ApiFailure, 'code' | 'details'>): string {
  if (error.code === 'invalid_loadout') {
    const problems = (error.details as { problems?: unknown } | undefined)?.problems;
    const list = Array.isArray(problems)
      ? problems.filter((p): p is string => typeof p === 'string').map(describeProblem)
      : [];
    return list.length > 0
      ? `That loadout cannot be fielded: ${list.join('; ')}.`
      : 'That loadout cannot be fielded.';
  }
  return describeGameFailure(error);
}

export const PRESET_NAMES = ['I', 'II', 'III'] as const;
export const presetName = (preset: number) => `Loadout ${PRESET_NAMES[preset - 1] ?? preset}`;

/**
 * The drafts after the server answered: every preset follows the server, except one with unsaved
 * edits (other than `saved`, the preset just written), which keeps them.
 */
export function nextDrafts(
  drafts: Readonly<Record<number, LoadoutDraft>>,
  before: Pick<SkillsResponse, 'presets'> | null,
  next: Pick<SkillsResponse, 'presets'>,
  saved?: number,
): Record<number, LoadoutDraft> {
  const out: Record<number, LoadoutDraft> = {};
  for (const p of next.presets) {
    const draft = drafts[p.preset];
    const old = before?.presets.find((x) => x.preset === p.preset);
    const dirty = draft !== undefined && old !== undefined && !sameDraft(draft, toDraft(old));
    out[p.preset] = dirty && p.preset !== saved ? draft : toDraft(p);
  }
  return out;
}
