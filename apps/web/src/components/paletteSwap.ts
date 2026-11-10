import { useEffect, useState } from 'react';
import type { PaletteSwap } from '../content/appearance';

/**
 * Ticket 6.8: a hero appearance is the class sprite (portrait or frame sheet) with some colours
 * swapped, drawn in code: the image is read into a canvas once, every opaque pixel whose colour
 * the palette names takes the new colour (alpha kept, whole pixels, no blending), and the result
 * is used as the image's source. Results are cached per image and palette. Where a canvas is
 * unavailable (tests, a failed read) the sprite keeps its own colours.
 */

const toHex = (r: number, g: number, b: number) =>
  `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;

/** Swaps the colours of RGBA pixel data in place; returns how many pixels changed. */
export function applySwap(data: Uint8ClampedArray, swap: PaletteSwap): number {
  const parsed = new Map<string, [number, number, number]>();
  for (const [from, to] of swap) {
    const n = Number.parseInt(to.slice(1), 16);
    parsed.set(from, [(n >> 16) & 255, (n >> 8) & 255, n & 255]);
  }
  let changed = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const to = parsed.get(toHex(data[i]!, data[i + 1]!, data[i + 2]!));
    if (!to) continue;
    data[i] = to[0];
    data[i + 1] = to[1];
    data[i + 2] = to[2];
    changed += 1;
  }
  return changed;
}

export function swapKey(path: string, swap: PaletteSwap): string {
  return `${path}|${[...swap].map(([f, t]) => `${f}>${t}`).join(',')}`;
}

const cache = new Map<string, Promise<string | null>>();

function render(path: string, swap: PaletteSwap): Promise<string | null> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx || canvas.width === 0) return resolve(null);
        ctx.drawImage(img, 0, 0);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
        applySwap(pixels.data, swap);
        ctx.putImageData(pixels, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = path;
  });
}

/** The swapped image's source for `path`, or null (not ready, unavailable, or no palette). */
export function usePaletteSwap(path: string, swap: PaletteSwap | null | undefined): string | null {
  const key = swap ? swapKey(path, swap) : null;
  const [ready, setReady] = useState<{ key: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!key || !swap) return;
    let live = true;
    let job = cache.get(key);
    if (!job) {
      job = render(path, swap);
      cache.set(key, job);
    }
    void job.then((url) => {
      if (live) setReady({ key, url });
    });
    return () => {
      live = false;
    };
  }, [key, path, swap]);
  return key && ready?.key === key ? ready.url : null;
}
