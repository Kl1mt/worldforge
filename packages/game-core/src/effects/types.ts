import type { ClassId } from '../classes.js';
import type { ItemSlotKind } from '../items/bases.js';

/**
 * Effect registry types (ticket 3.2, GDD §7.4). One data-driven system for every unique effect:
 * Legendary effects, Mythic signatures (3.2), set bonuses (3.3) and the rare Void modification of
 * a Legendary effect (3.5). An effect is a list of *components*; each component is one mechanic
 * the combat rules understand. Both combat simulations resolve the same combined numbers
 * (`CombatEffects`), so they stay equivalent.
 */

/**
 * The mechanics. Every one changes how a fight plays, not only a number:
 * - `critBurn`: crits add `bonus` × the hit's damage *before* mitigation (fire that ignores armor
 *   and resistance), so crit builds scale past heavy defences.
 * - `execute`: hits deal × (1 + `bonus`) while the enemy is at or below `threshold` of its health.
 * - `bossSlayer`: damage × (1 + `bonus`) against bosses (additive with the boss-damage affix).
 * - `lifeOnKill`: a kill heals `heal` × max health.
 * - `bloodrush`: each kill grants a stack of + `perStack` attack speed (up to `maxStacks`); a death
 *   or timeout ends the streak, and a stack fades for every full `decayMs` out of combat.
 * - `thorns`: an enemy that hits the hero takes `reflect` × the hit's damage before mitigation.
 * - `fortitude`: hits deal × (1 + `bonus`) while the hero is at or above `threshold` of max health.
 * - `skillRage`: the class skill deals + `perDecile` for every full 10 % of missing health.
 * - `skillSurge`: a crit makes the next attack a class skill at `power` × its damage.
 * - `skillOpener`: the first attack of every fight is the class skill with + `bonus` damage.
 * - `skillRot`: the class skill adds `fraction` × the enemy's remaining health (at most the
 *   skill's own damage), so it shines against big health pools.
 */
export type EffectComponent =
  | { type: 'critBurn'; bonus: number }
  | { type: 'execute'; threshold: number; bonus: number }
  | { type: 'bossSlayer'; bonus: number }
  | { type: 'lifeOnKill'; heal: number }
  | { type: 'bloodrush'; perStack: number; maxStacks: number; decayMs: number }
  | { type: 'thorns'; reflect: number }
  | { type: 'fortitude'; threshold: number; bonus: number }
  | { type: 'skillRage'; perDecile: number }
  | { type: 'skillSurge'; power: number }
  | { type: 'skillOpener'; bonus: number }
  | { type: 'skillRot'; fraction: number };

export type EffectComponentType = EffectComponent['type'];

/** A parameter: fixed, or a range the item's roll (0…1) picks from. */
export type EffectParam = number | { min: number; max: number };

/** A component with ranged parameters, as stored in the registry. */
export type EffectComponentSpec = {
  [T in EffectComponent as T['type']]: { type: T['type'] } & {
    [K in Exclude<keyof T, 'type'>]: EffectParam;
  };
}[EffectComponentType];

/** Where an effect comes from. Sets (3.3) add `set` entries; nothing else is needed for them. */
export type EffectKind = 'legendary' | 'mythic' | 'set';

export interface EffectDefinition {
  id: string;
  name: string;
  kind: EffectKind;
  /**
   * Legendary pool only: slot kinds the effect can roll on, its pick weight, and for class
   * effects the one class it is for (rolled only for that class, on bases that class can use).
   */
  slots?: readonly ItemSlotKind[];
  weight?: number;
  classId?: ClassId;
  components: readonly EffectComponentSpec[];
  /** Tooltip text; `{0}`, `{1}` … are the components' formatted parameters (see `describeEffect`). */
  text: string;
}

/**
 * One effect a character has active: from an item (`effectId` + `effectRoll`), a set bonus (3.3,
 * fixed roll) or a Void-modified Legendary (3.5, `strength` > 1).
 */
export interface EffectInstance {
  effectId: string;
  /** Position in the parameter ranges, 0…1. Fixed parameters ignore it. */
  roll: number;
  /** Scales every magnitude (not thresholds, stack counts or decay); default 1. */
  strength?: number;
}

/**
 * The combined effects of everything equipped, after caps. A zero magnitude means "off". This is
 * the only effect input of the combat rules.
 */
export interface CombatEffects {
  critBurn: number;
  execute: { threshold: number; bonus: number };
  bossSlayer: number;
  lifeOnKill: number;
  bloodrush: { perStack: number; maxStacks: number; decayMs: number };
  thorns: number;
  fortitude: { threshold: number; bonus: number };
  skillRage: number;
  skillSurge: number;
  skillOpener: number;
  skillRot: number;
}

/** Upper bounds of the combined effects (several sources of one mechanic add up to these). */
export interface EffectCaps {
  critBurn: number;
  execute: { threshold: number; bonus: number };
  bossSlayer: number;
  lifeOnKill: number;
  bloodrush: { perStack: number; maxStacks: number };
  thorns: number;
  /** Fortitude's threshold can be lowered by stacking, down to `minThreshold`. */
  fortitude: { minThreshold: number; bonus: number };
  skillRage: number;
  skillSurge: number;
  skillOpener: number;
  skillRot: number;
}
