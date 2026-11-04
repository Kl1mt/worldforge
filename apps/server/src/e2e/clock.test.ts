import { describe, expect, it } from 'vitest';
import { scaledClock } from './clock.js';

describe('scaledClock', () => {
  it('runs scale times faster than real time from the origin', () => {
    let real = 1_000_000;
    const now = scaledClock(60, 1_000_000, () => real);
    expect(now().getTime()).toBe(1_000_000);
    real += 1000;
    expect(now().getTime()).toBe(1_000_000 + 60_000);
  });

  it('rejects slowing or reversing time', () => {
    expect(() => scaledClock(0)).toThrow(RangeError);
    expect(() => scaledClock(0.5)).toThrow(RangeError);
    expect(() => scaledClock(Number.NaN)).toThrow(RangeError);
  });
});
