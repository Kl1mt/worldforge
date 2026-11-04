export interface PixelScaleOptions {
  /** Smallest scale returned, even if the sprite then overflows. Default 1. */
  min?: number;
  /** Largest scale returned. Default unbounded. */
  max?: number;
  /** Scales are multiples of this step (2 keeps a half-scale sprite layer integral). Default 1. */
  step?: number;
}

/**
 * Integer scale for pixel art (docs/ASSET_GUIDELINES.md): the largest multiple of `step`
 * at which `native` pixels fit into `available` pixels, clamped to [min, max].
 */
export function pixelScale(available: number, native: number, options: PixelScaleOptions = {}) {
  const step = Math.max(1, Math.floor(options.step ?? 1));
  const min = Math.max(step, Math.ceil((options.min ?? 1) / step) * step);
  const max = options.max ?? Number.POSITIVE_INFINITY;
  if (!(native > 0) || !Number.isFinite(available)) return min;
  const fit = Math.floor(available / native / step) * step;
  return Math.min(Math.max(fit, min), Math.max(min, max));
}

/** Shared with the CSS phone breakpoint (`@media (max-width: 760px)`). */
export const PHONE_QUERY = '(max-width: 760px)';

/** Item icons are 32 px; an ItemFrame adds 3 px padding and a 1 px border on each side. */
export const ITEM_NATIVE = 32;
export const SOCKET_CHROME = 8;

/** Outer size in CSS pixels of an item socket at `scale`. */
export function socketSize(scale: number) {
  return ITEM_NATIVE * Math.max(1, Math.floor(scale)) + SOCKET_CHROME;
}

/**
 * Scene sprites: on phones they stay at half the backdrop scale (the approved 0.3 look);
 * on wider screens they match the backdrop, so sprites and scenery share one pixel density.
 */
export function sceneSpriteScale(backdropScale: number, phone: boolean) {
  return phone ? Math.max(1, Math.floor(backdropScale / 2)) : backdropScale;
}

/**
 * Paper doll: the large variant (portrait ×4, sockets ×3) needs the 512 px niche plus,
 * on each side, a ×3 socket, its gap and ~84 px of slot text.
 */
export const DOLL_LARGE_MIN_WIDTH = 4 * 128 + 2 * (socketSize(3) + 12 + 84) + 2 * 12;

/** Inventory: the large variant shows 8 × 5 sockets at ×3 beside a ≥300 px tooltip column. */
export const STASH_LARGE = { columns: 8, gap: 6, chrome: 24 + 48 } as const;
export const STASH_LARGE_WIDTH =
  STASH_LARGE.columns * socketSize(3) +
  (STASH_LARGE.columns - 1) * STASH_LARGE.gap +
  STASH_LARGE.chrome;
export const PACK_LARGE_MIN_WIDTH = STASH_LARGE_WIDTH + 24 + 300;
