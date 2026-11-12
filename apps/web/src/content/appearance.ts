import type { ClassId } from '@worldforge/game-core';
import {
  bannerStyleAsset,
  crestStyleAsset,
  type CrestStyleSprite,
  type SpriteAsset,
} from './assets';
import { heroPaletteSwaps } from './palettes';

/**
 * Ticket 6.8: the art of the collection book's cosmetics (A.13), with graceful fallbacks:
 * - **hero appearances** are palette swaps of the class sprites (portrait and frame sheet), drawn
 *   in code from A.13's data (`palettes.ts`). An unknown look, the default, or a class without
 *   data wears its own colours;
 * - **banner styles** are 32×32 sprites (`bannerStyleAsset`); without art, a plain banner;
 * - **crest styles** are 48×56 frames around a crest window (`crestStyleAsset`); without art, a
 *   plain rim;
 * - **title colours** are code only (CSS, `cosmetics/cosmetics.css`).
 * Ticket 6.11: the exchange's banner and crests reuse A.13's art (`ART_TINTS`), recoloured in CSS
 * (`.cosm-banner--<name>` / `.cosm-crest--<name>` filters); no new art. Ticket 8.3's Lantern
 * Procession does the same for its two banners and its crest.
 */

/** Ticket 6.11: cosmetics drawn with another style's art and a CSS tint (cosmetics.css). */
export const ART_TINTS: Readonly<Record<string, string>> = {
  'banner.silvered-seal': 'banner.crypt-seal',
  'crest.abbey-silver': 'crest.iron',
  'crest.seal-wax': 'crest.iron',
  // Ticket 8.3: the Lantern Procession's banners and crest (recoloured in cosmetics.css).
  'banner.procession-lantern': 'banner.warden-flame',
  'banner.hollow-procession': 'banner.ember-standard',
  'crest.lantern-brass': 'crest.iron',
};

/** `#rrggbb` → `#rrggbb`. */
export type PaletteSwap = ReadonlyMap<string, string>;

const cache = new Map<string, PaletteSwap | null>();

/** The colour swap of an appearance for a class, or null (own colours). */
export function appearancePalette(
  id: string | null | undefined,
  classId: ClassId,
): PaletteSwap | null {
  if (!id || id === 'appearance.default') return null;
  const key = `${id}|${classId}`;
  if (!cache.has(key)) {
    const swaps = heroPaletteSwaps(id, classId);
    cache.set(
      key,
      swaps && swaps.length > 0
        ? new Map(swaps.map(([from, to]) => [from.toLowerCase(), to.toLowerCase()]))
        : null,
    );
  }
  return cache.get(key)!;
}

/** Whether this appearance has palette data (for any class). */
export function hasPaletteArt(id: string): boolean {
  return (['warrior', 'mage', 'hunter', 'warlock'] as const).some(
    (c) => appearancePalette(id, c) !== null,
  );
}

/** A banner style's 32×32 sprite, or null (draw the plain banner). */
export function bannerStyleSprite(id: string): SpriteAsset | null {
  return bannerStyleAsset(ART_TINTS[id] ?? id);
}

/** A crest style's frame, or null (draw the plain rim). */
export function crestStyleSprite(id: string): CrestStyleSprite | null {
  return crestStyleAsset(ART_TINTS[id] ?? id);
}
