import { describe, expect, it } from 'vitest';
import {
  DOLL_LARGE_MIN_WIDTH,
  PACK_LARGE_MIN_WIDTH,
  pixelScale,
  sceneSpriteScale,
  socketSize,
} from './pixel';

describe('pixelScale', () => {
  it('returns the largest integer scale that fits', () => {
    expect(pixelScale(100, 32)).toBe(3);
    expect(pixelScale(128, 32)).toBe(4);
  });

  it('never returns less than min, even when the sprite overflows', () => {
    expect(pixelScale(20, 32)).toBe(1);
    expect(pixelScale(390, 384, { min: 2 })).toBe(2);
  });

  it('respects step so a half-scale layer stays integral', () => {
    expect(pixelScale(1000, 384, { step: 2 })).toBe(2);
    expect(pixelScale(1200, 384, { step: 2 })).toBe(2);
    expect(pixelScale(1536, 384, { step: 2 })).toBe(4);
    expect(pixelScale(100, 384, { step: 2, min: 1 })).toBe(2);
  });

  it('clamps to max', () => {
    expect(pixelScale(1000, 32, { max: 3 })).toBe(3);
  });

  it('falls back to min for invalid input', () => {
    expect(pixelScale(Number.NaN, 32)).toBe(1);
    expect(pixelScale(100, 0, { min: 2 })).toBe(2);
  });
});

describe('desktop pixel-art scales (ticket 0.4)', () => {
  it('keeps phone scene sprites at half the backdrop scale', () => {
    expect(sceneSpriteScale(2, true)).toBe(1);
    expect(sceneSpriteScale(4, true)).toBe(2);
  });

  it('matches the backdrop scale on wider screens', () => {
    expect(sceneSpriteScale(2, false)).toBe(2);
    expect(sceneSpriteScale(4, false)).toBe(4);
  });

  it('sizes sockets from the 32 px icon plus frame chrome', () => {
    expect(socketSize(2)).toBe(72);
    expect(socketSize(3)).toBe(104);
    expect(socketSize(2.7)).toBe(72);
  });

  it('fits the large doll and pack at the 1440 px desktop content width (1272 px)', () => {
    const content = 1272;
    const dollWidth = content - 300 - 24; // side column + gap
    expect(dollWidth).toBeGreaterThanOrEqual(DOLL_LARGE_MIN_WIDTH);
    expect(content).toBeGreaterThanOrEqual(PACK_LARGE_MIN_WIDTH);
    expect(390).toBeLessThan(PACK_LARGE_MIN_WIDTH);
  });
});
