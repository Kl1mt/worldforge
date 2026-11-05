import type { ClassId } from '../classes.js';
import { canClassUseItem, type ItemBaseDefinition } from '../items/bases.js';
import { DEFAULT_EFFECT_CAPS, EFFECTS, findEffect } from './registry.js';
import type {
  CombatEffects,
  EffectCaps,
  EffectComponent,
  EffectDefinition,
  EffectInstance,
  EffectParam,
} from './types.js';

/** Parameters that are not magnitudes: `strength` does not scale them. */
const STRUCTURAL_PARAMS = new Set(['threshold', 'maxStacks', 'decayMs']);

/** Rolls are stored on a 0.05 grid (21 positions). */
export const EFFECT_ROLL_STEPS = 20;

const round4 = (v: number): number => Math.round(v * 10_000) / 10_000;

function paramValue(param: EffectParam, roll: number): number {
  if (typeof param === 'number') return param;
  return round4(param.min + (param.max - param.min) * roll);
}

const clampRoll = (roll: number): number =>
  Number.isFinite(roll) ? Math.min(1, Math.max(0, roll)) : 0;

/** The concrete components of one effect instance (roll mapped into the ranges, × strength). */
export function resolveEffectComponents(
  instance: EffectInstance,
  definition: EffectDefinition | undefined = findEffect(instance.effectId),
): EffectComponent[] {
  if (!definition) return [];
  const roll = clampRoll(instance.roll);
  const strength =
    instance.strength !== undefined && Number.isFinite(instance.strength) && instance.strength > 0
      ? instance.strength
      : 1;
  return definition.components.map((spec) => {
    const out: Record<string, number | string> = { type: spec.type };
    for (const [key, param] of Object.entries(spec) as [string, EffectParam | string][]) {
      if (key === 'type') continue;
      const value = paramValue(param as EffectParam, roll);
      out[key] = STRUCTURAL_PARAMS.has(key) ? value : round4(value * strength);
    }
    return out as unknown as EffectComponent;
  });
}

/** No effects at all. */
export function emptyCombatEffects(): CombatEffects {
  return {
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
}

/**
 * Combines effect instances into the numbers combat uses. Magnitudes add up to their cap;
 * execute takes the highest threshold, fortitude the lowest (not below the cap's minimum), and
 * bloodrush the most stacks and the slowest decay. Class effects only count for their class.
 */
export function combineEffects(
  instances: readonly EffectInstance[],
  classId: ClassId,
  caps: EffectCaps = DEFAULT_EFFECT_CAPS,
): CombatEffects {
  const fx = emptyCombatEffects();
  let fortitudeThreshold = Infinity;
  for (const instance of instances) {
    const definition = findEffect(instance.effectId);
    if (!definition || (definition.classId !== undefined && definition.classId !== classId)) {
      continue;
    }
    for (const c of resolveEffectComponents(instance, definition)) {
      switch (c.type) {
        case 'critBurn':
          fx.critBurn += c.bonus;
          break;
        case 'execute':
          fx.execute.bonus += c.bonus;
          fx.execute.threshold = Math.max(fx.execute.threshold, c.threshold);
          break;
        case 'bossSlayer':
          fx.bossSlayer += c.bonus;
          break;
        case 'lifeOnKill':
          fx.lifeOnKill += c.heal;
          break;
        case 'bloodrush':
          fx.bloodrush.perStack += c.perStack;
          fx.bloodrush.maxStacks = Math.max(fx.bloodrush.maxStacks, c.maxStacks);
          fx.bloodrush.decayMs = Math.max(fx.bloodrush.decayMs, c.decayMs);
          break;
        case 'thorns':
          fx.thorns += c.reflect;
          break;
        case 'fortitude':
          fx.fortitude.bonus += c.bonus;
          fortitudeThreshold = Math.min(fortitudeThreshold, c.threshold);
          break;
        case 'skillRage':
          fx.skillRage += c.perDecile;
          break;
        case 'skillSurge':
          fx.skillSurge += c.power;
          break;
        case 'skillOpener':
          fx.skillOpener += c.bonus;
          break;
        case 'skillRot':
          fx.skillRot += c.fraction;
          break;
      }
    }
  }
  const cap = (v: number, max: number) => round4(Math.min(max, Math.max(0, v)));
  fx.critBurn = cap(fx.critBurn, caps.critBurn);
  fx.execute.bonus = cap(fx.execute.bonus, caps.execute.bonus);
  fx.execute.threshold =
    fx.execute.bonus > 0 ? cap(fx.execute.threshold, caps.execute.threshold) : 0;
  fx.bossSlayer = cap(fx.bossSlayer, caps.bossSlayer);
  fx.lifeOnKill = cap(fx.lifeOnKill, caps.lifeOnKill);
  fx.bloodrush.perStack = cap(fx.bloodrush.perStack, caps.bloodrush.perStack);
  if (fx.bloodrush.perStack > 0) {
    fx.bloodrush.maxStacks = Math.min(caps.bloodrush.maxStacks, Math.floor(fx.bloodrush.maxStacks));
    fx.bloodrush.decayMs = Math.max(1, Math.round(fx.bloodrush.decayMs));
  } else {
    fx.bloodrush = { perStack: 0, maxStacks: 0, decayMs: 0 };
  }
  fx.thorns = cap(fx.thorns, caps.thorns);
  fx.fortitude.bonus = cap(fx.fortitude.bonus, caps.fortitude.bonus);
  fx.fortitude.threshold =
    fx.fortitude.bonus > 0
      ? Math.min(1, Math.max(caps.fortitude.minThreshold, fortitudeThreshold))
      : 0;
  fx.skillRage = cap(fx.skillRage, caps.skillRage);
  fx.skillSurge = cap(fx.skillSurge, caps.skillSurge);
  fx.skillOpener = cap(fx.skillOpener, caps.skillOpener);
  fx.skillRot = cap(fx.skillRot, caps.skillRot);
  return fx;
}

/** Whether any effect is on. */
export function hasCombatEffects(fx: CombatEffects | undefined): fx is CombatEffects {
  if (!fx) return false;
  return (
    fx.critBurn > 0 ||
    fx.execute.bonus > 0 ||
    fx.bossSlayer > 0 ||
    fx.lifeOnKill > 0 ||
    fx.bloodrush.perStack > 0 ||
    fx.thorns > 0 ||
    fx.fortitude.bonus > 0 ||
    fx.skillRage > 0 ||
    fx.skillSurge > 0 ||
    fx.skillOpener > 0 ||
    fx.skillRot > 0
  );
}

/** Item fields that carry an effect (`effect_id`, `effect_roll` columns). */
export interface EffectCarrier {
  effectId?: string | null;
  effectRoll?: number | null;
}

/** The effect instance an item carries, or none (unknown ids are ignored). */
export function itemEffectInstances(item: EffectCarrier): EffectInstance[] {
  if (!item.effectId || !findEffect(item.effectId)) return [];
  return [{ effectId: item.effectId, roll: item.effectRoll ?? 1 }];
}

/** Legendary effects that can roll on a base (slot, and class effects only for their class). */
export function legendaryEffectPool(
  base: Pick<ItemBaseDefinition, 'slot' | 'classes'>,
  classId?: ClassId,
): EffectDefinition[] {
  return EFFECTS.filter(
    (e) =>
      e.kind === 'legendary' &&
      (e.weight ?? 0) > 0 &&
      e.slots?.includes(base.slot) === true &&
      (e.classId === undefined ||
        (e.classId === classId && canClassUseItem(base as ItemBaseDefinition, e.classId))),
  );
}

/** Whether a Legendary effect could have rolled on a base for *some* class (validation). */
export function legendaryEffectPossibleOn(
  effect: EffectDefinition,
  base: Pick<ItemBaseDefinition, 'slot' | 'classes'>,
): boolean {
  return (
    effect.kind === 'legendary' &&
    (effect.weight ?? 0) > 0 &&
    effect.slots?.includes(base.slot) === true &&
    (effect.classId === undefined || base.classes.includes(effect.classId))
  );
}

function formatParam(key: string, value: number): string {
  if (key === 'maxStacks') return String(value);
  if (key === 'decayMs') return `${Math.round(value / 100) / 10} s`;
  return `${Math.round(value * 1000) / 10} %`;
}

/**
 * Tooltip text of an effect at a roll (and strength): the registry text with every `{i.param}`
 * replaced by the resolved value, e.g. "Deal 60 % more damage to enemies below 30 % health."
 */
export function describeEffect(instance: EffectInstance): string {
  const definition = findEffect(instance.effectId);
  if (!definition) return '';
  const components = resolveEffectComponents(instance, definition);
  return definition.text.replace(/\{(\d+)\.(\w+)\}/g, (match, i: string, key: string) => {
    const value = (components[Number(i)] as unknown as Record<string, unknown> | undefined)?.[key];
    return typeof value === 'number' ? formatParam(key, value) : match;
  });
}
