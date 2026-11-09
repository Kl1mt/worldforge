/**
 * Ticket A.14: whether the fight scene moves.
 *
 * - `full`: idle bob, swings, flashes, falls and rises.
 * - `reduced`: the player asked for less motion (`prefers-reduced-motion: reduce`): the scene is
 *   static, exactly as before A.14.
 * - `off`: a browser driven by automation (Playwright e2e and screenshot runs set
 *   `navigator.webdriver`), so screenshots never catch a sprite mid-swing. The local override
 *   `localStorage['worldforge.sceneMotion'] = 'on'` turns it back on (used to film the scene).
 */
export type SceneMotion = 'full' | 'reduced' | 'off';

export const SCENE_MOTION_KEY = 'worldforge.sceneMotion';
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export function sceneMotionMode(input: {
  reducedMotion: boolean;
  automated: boolean;
  override: string | null;
}): SceneMotion {
  if (input.reducedMotion) return 'reduced';
  if (input.override === 'off') return 'off';
  if (input.automated && input.override !== 'on') return 'off';
  return 'full';
}

/** Reads the automation flag and the override from the browser; safe without a DOM. */
export function browserMotionFlags(): { automated: boolean; override: string | null } {
  let override: string | null;
  try {
    override = globalThis.localStorage?.getItem(SCENE_MOTION_KEY) ?? null;
  } catch {
    override = null; // storage blocked: no override
  }
  const automated = Boolean((globalThis.navigator as Navigator | undefined)?.webdriver);
  return { automated, override };
}
