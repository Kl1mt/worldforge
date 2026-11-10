/**
 * Ticket 6.5 (evaluation prototype, switched off): the state an awakened item would carry, and the
 * two readers combat would use. No stored row, snapshot, route or generator carries this field
 * today (there is no column; `awakenItem` refuses while `DEFAULT_AWAKENING_SETTINGS.enabled` is
 * false), so for every item that can exist each reader returns exactly the neutral value and every
 * number is unchanged (`effects/noEffects.test.ts`, the balance suites). See `docs/AWAKENING.md`.
 *
 * Runtime-import free on purpose: `effects/resolve.ts` and `items/sets.ts` read it.
 */

/** The options the evaluation compares (docs/AWAKENING.md "Options"). */
export const AWAKENING_OPTION_IDS = ['affixSlot', 'effect'] as const;
export type AwakeningOptionId = (typeof AWAKENING_OPTION_IDS)[number];

/**
 * An awakened item's state.
 * - `affixSlot` (option a): the item's affix list holds one affix more than its rarity rolls; the
 *   awakened affix is `affixes[affixIndex]`. Combat reads it as any affix, so no reader is needed.
 * - `effect` (option b): the item's own effect (a Legendary effect or a Mythic signature) counts
 *   × `effectStrength` (magnitudes only, like Void's strength: never thresholds, stack counts or
 *   decay, and still under the registry's caps). A set piece's awakening counts toward its set
 * (`setBonusInstances`).
 */
export type ItemAwakening =
  { option: 'affixSlot'; affixIndex: number } | { option: 'effect'; effectStrength: number };

/** Item fields an awakening reader looks at. */
export interface AwakeningCarrier {
  awakening?: ItemAwakening | null;
}

/** Upper bound a reader accepts for an effect strength (anything else is ignored). */
export const MAX_AWAKENED_EFFECT_STRENGTH = 2;

/**
 * The factor an item's awakening puts on its own effect: 1 without an `effect` awakening or with
 * an invalid strength, so an item without the field reads exactly as before.
 */
export function awakenedEffectStrength(item: AwakeningCarrier): number {
  const a = item.awakening;
  if (!a || a.option !== 'effect') return 1;
  const s = a.effectStrength;
  return Number.isFinite(s) && s > 1 && s <= MAX_AWAKENED_EFFECT_STRENGTH ? s : 1;
}
