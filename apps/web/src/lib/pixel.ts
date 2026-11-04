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
