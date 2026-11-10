import { browserMotionFlags, sceneMotionMode } from '../scene/motion';

/**
 * Ticket A.12: how a variant is drawn on an item frame. The frame picks its treatment from the
 * variant's id only (`ItemView.variant.id`), so the rule lives in game-core (`activeVariant`) and
 * the web layer never decides whether an item is Void or Prismatic.
 *
 * - `void` (ticket 3.5): drained art with a voidlight edge, in a dark rift, a hollow diamond ◇;
 *   in motion (A.12b) the edge breathes and glitches, and motes are pulled inward through the rift.
 * - `prismatic`: the art keeps its colour under a stepped opal tint, a slow light sweep crosses it
 *   in whole art pixels, an opal hairline runs inside the rarity ring and an open star ✧ marks the
 *   lower left corner (docs/DESIGN_SYSTEM.md "Prismatic").
 *
 * Ids are read as strings so the frame draws any variant game-core names (a variant without a
 * treatment here falls back to the plain frame).
 */
export type VariantTreatment = 'void' | 'prismatic';

export function variantTreatment(id: string | null | undefined): VariantTreatment | null {
  return id === 'void' || id === 'prismatic' ? id : null;
}

/** The corner mark: a shape, not only a colour (colour-blind players). */
export const VARIANT_MARK: Readonly<Record<VariantTreatment, string>> = {
  void: '◇',
  prismatic: '✧',
};

/**
 * Whether a variant's motion may play: Prismatic's sweep (A.12), Void's breathing edge and
 * inward motes (A.12b).
 * - `auto` (everywhere in the game): on unless this browser is driven by automation
 *   (`navigator.webdriver`, e2e and screenshot runs) or the A.14 override says `off`;
 *   `prefers-reduced-motion` is honoured in CSS (the treatment stays still: Prismatic's tint, Void's 3.5 look).
 * - `forced`: the admin gallery after Play (moves even under reduced motion, there only).
 * - `still`: never moves.
 */
export type ShimmerMode = 'auto' | 'forced' | 'still';

export function shimmerClass(
  mode: ShimmerMode,
  flags: { automated: boolean; override: string | null } = browserMotionFlags(),
): string {
  if (mode === 'forced') return 'item-frame--shimmer-forced';
  if (mode === 'still') return '';
  // Reduced motion is the stylesheet's job; here only automation and the override count.
  return sceneMotionMode({ reducedMotion: false, ...flags }) === 'full'
    ? 'item-frame--shimmer'
    : '';
}

/**
 * Ticket 6.5b: the awakened mark, an ember sigil. A shape of its own next to Void's ◇ and
 * Prismatic's ✧ (an awakened Void item shows both).
 */
export const AWAKENED_MARK = '☼';

/**
 * Ticket 6.5b: whether an awakened item's ember glow may pulse, by the same rule as the Prismatic
 * sweep (`shimmerClass`): still under automation, the A.14 override and (in CSS) reduced motion;
 * `forced` in the admin gallery after Play.
 */
export function emberClass(
  mode: ShimmerMode,
  flags: { automated: boolean; override: string | null } = browserMotionFlags(),
): string {
  if (mode === 'forced') return 'item-frame--ember-forced';
  if (mode === 'still') return '';
  return sceneMotionMode({ reducedMotion: false, ...flags }) === 'full' ? 'item-frame--ember' : '';
}
