import type { ClassId } from '@worldforge/game-core';
import * as assets from './assets';
import type { SpriteAsset } from './assets';

/**
 * Ticket 6.8: the art of the collection book's cosmetics, read from what the art ticket (A.13)
 * provides, with graceful fallbacks while it is missing:
 * - **hero appearances** are palette swaps of the class sprites, rendered in code from palette data
 *   in `content/palettes.ts` (a map of appearance id → per class → colour substitutions). The
 *   file is optional: without it (or without an entry for the class) the hero wears its own
 *   colours, the default palette;
 * - **banner styles** and **crest styles** are 32×32 sprites (`bannerStyleAsset(id)` /
 *   `crestStyleAsset(id)` when the art ticket adds them, else the asset registered under the
 *   cosmetic id); without art: a plain banner and a plain crest rim in CSS;
 * - **title colours** are code only (CSS, `cosmetics/cosmetics.css`).
 */

/** `#rrggbb` (lower case) → `#rrggbb`. */
export type PaletteSwap = ReadonlyMap<string, string>;

// The palette data is optional until the art ticket lands: `import.meta.glob` finds no module and
// yields `{}` instead of failing the build.
const PALETTE_MODULES = import.meta.glob('./palettes.ts', { eager: true }) as Record<
  string,
  Record<string, unknown>
>;

const HEX = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i;
function hex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = HEX.exec(value.trim());
  return m ? `#${m[1]!.toLowerCase()}` : null;
}

/** Accepts `{ from: to }`, `[[from, to], …]` or `[{ from, to }, …]`. */
function readSwap(raw: unknown): PaletteSwap | null {
  const pairs: [unknown, unknown][] = [];
  if (Array.isArray(raw)) {
    for (const p of raw) {
      if (Array.isArray(p)) pairs.push([p[0], p[1]]);
      else if (p && typeof p === 'object') {
        const o = p as Record<string, unknown>;
        pairs.push([o.from ?? o.source, o.to ?? o.target]);
      }
    }
  } else if (raw && typeof raw === 'object') {
    pairs.push(...Object.entries(raw as Record<string, unknown>));
  }
  const out = new Map<string, string>();
  for (const [from, to] of pairs) {
    const f = hex(from);
    const t = hex(to);
    if (f && t) out.set(f, t);
  }
  return out.size > 0 ? out : null;
}

/** id → class → swap; a `default`/`all` entry applies to every class without its own. */
export function readPaletteData(
  modules: Record<string, Record<string, unknown>>,
): Map<string, Map<string, PaletteSwap>> {
  const out = new Map<string, Map<string, PaletteSwap>>();
  for (const mod of Object.values(modules)) {
    for (const value of Object.values(mod)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      for (const [id, perClass] of Object.entries(value as Record<string, unknown>)) {
        if (!id.startsWith('appearance.') || !perClass || typeof perClass !== 'object') continue;
        const byClass = out.get(id) ?? new Map<string, PaletteSwap>();
        for (const [classId, raw] of Object.entries(perClass as Record<string, unknown>)) {
          const swap = readSwap(raw);
          if (swap) byClass.set(classId, swap);
        }
        if (byClass.size > 0) out.set(id, byClass);
      }
    }
  }
  return out;
}

const PALETTES = readPaletteData(PALETTE_MODULES);

/** The colour swap of an appearance for a class, or null (own colours: default or no art). */
export function appearancePalette(
  id: string | null | undefined,
  classId: ClassId,
  data: Map<string, Map<string, PaletteSwap>> = PALETTES,
): PaletteSwap | null {
  if (!id || id === 'appearance.default') return null;
  const byClass = data.get(id);
  return byClass?.get(classId) ?? byClass?.get('default') ?? byClass?.get('all') ?? null;
}

/** Whether the art ticket's palette for this appearance has arrived (any class). */
export function hasPaletteArt(id: string): boolean {
  return PALETTES.has(id);
}

type AssetLookup = (id: string) => SpriteAsset | null;
const mod = assets as unknown as Record<string, unknown>;
const lookup = (fn: string): AssetLookup => {
  const f = mod[fn];
  return (id) => {
    if (typeof f === 'function') {
      try {
        const got = (f as AssetLookup)(id);
        if (got && typeof got === 'object' && 'path' in got) return got;
      } catch {
        // An unknown id: fall through to the registry.
      }
    }
    return assets.findSprite(id);
  };
};

/** A banner style's 32×32 sprite, or null (draw the plain banner). */
export const bannerStyleSprite: AssetLookup = lookup('bannerStyleAsset');
/** A crest style's frame sprite, or null (draw the plain rim). */
export const crestStyleSprite: AssetLookup = lookup('crestStyleAsset');
