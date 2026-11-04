import { describe, expect, it } from 'vitest';
import { pixelScale } from './pixel';

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
