import { useEffect, useState } from 'react';
import type { PaletteSwap } from '../content/appearance';
import { recolourPixels } from '../content/palettes';

/**
 * Ticket 6.8: a hero appearance is the class sprite (portrait or frame sheet) with some colours
 * swapped, drawn in code: the image is read into a canvas once, every opaque pixel whose colour
 * the palette names takes the new colour (A.13's `recolourPixels`: alpha kept, whole pixels, no
 * blending), and the result is used as the image's source. Results are cached per image and palette. Where a canvas is
 * unavailable (tests, a failed read) the sprite keeps its own colours.
 */

// Palettes are cached objects (`appearancePalette`), so an id per object keys the cache.
const swapIds = new WeakMap<PaletteSwap, number>();
let nextSwapId = 1;
export function swapKey(path: string, swap: PaletteSwap): string {
  let id = swapIds.get(swap);
  if (id === undefined) {
    id = nextSwapId++;
    swapIds.set(swap, id);
  }
  return `${path}|${id}`;
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
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
        pixels.data.set(recolourPixels(pixels.data, [...swap]));
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
