import { describe, expect, it } from 'vitest';
import { MAX_LEVEL, applyXp, totalXpForLevel, xpToNextLevel } from '../index.js';

describe('XP curve', () => {
  it('is positive and strictly increasing below the cap', () => {
    let prev = 0;
    for (let level = 1; level < MAX_LEVEL; level++) {
      const need = xpToNextLevel(level);
      expect(Number.isInteger(need)).toBe(true);
      expect(need).toBeGreaterThan(prev);
      prev = need;
    }
    expect(xpToNextLevel(MAX_LEVEL)).toBe(0);
    expect(totalXpForLevel(1)).toBe(0);
    expect(totalXpForLevel(3)).toBe(xpToNextLevel(1) + xpToNextLevel(2));
  });

  it('applies multiple level-ups and keeps the remainder', () => {
    const gained = xpToNextLevel(1) + xpToNextLevel(2) + 7;
    expect(applyXp({ level: 1, xp: 0 }, gained)).toEqual({ level: 3, xp: 7 });
    expect(applyXp({ level: 4, xp: 10 }, 0)).toEqual({ level: 4, xp: 10 });
  });

  it('stops at the level cap', () => {
    expect(applyXp({ level: 1, xp: 0 }, 1e12)).toEqual({ level: MAX_LEVEL, xp: 0 });
    expect(applyXp({ level: MAX_LEVEL, xp: 0 }, 500)).toEqual({ level: MAX_LEVEL, xp: 0 });
  });

  it('rejects invalid gains', () => {
    expect(() => applyXp({ level: 1, xp: 0 }, -1)).toThrow(RangeError);
    expect(() => applyXp({ level: 1, xp: 0 }, Number.NaN)).toThrow(RangeError);
    expect(() => xpToNextLevel(0)).toThrow(RangeError);
  });
});
