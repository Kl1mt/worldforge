import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMBAT_CONFIG,
  MAX_LEVEL,
  applyXp,
  totalXpForLevel,
  xpLevelFactor,
  xpToNextLevel,
} from '../index.js';

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

  // Ticket 6.1: the curve continues above 28 (the Cinderwastes) without moving a value at or below
  // 28: these are B.1's numbers, pinned.
  it('keeps every requirement up to level 28 as B.1 set it, and grows faster above', () => {
    const pinned = Array.from({ length: 28 }, (_, i) => xpToNextLevel(i + 1));
    expect(pinned).toEqual(Array.from({ length: 28 }, (_, i) => 700 * (i + 1) ** 2));
    expect(totalXpForLevel(29)).toBe(pinned.reduce((a, b) => a + b, 0));
    expect(totalXpForLevel(29)).toBe(5_399_800);
    // Above 28 every step asks for more than the one before, and more again each level.
    for (let level = 29; level < MAX_LEVEL; level++) {
      const step = xpToNextLevel(level) - xpToNextLevel(level - 1);
      expect(step, `L${level}`).toBeGreaterThan(
        xpToNextLevel(level - 1) - xpToNextLevel(level - 2),
      );
    }
    // Never below the Phase 1 curve (stored XP must stay below any later requirement).
    for (let level = 1; level < MAX_LEVEL; level++) {
      expect(xpToNextLevel(level)).toBeGreaterThanOrEqual(Math.round(80 * level ** 1.6));
    }
  });

  it('keeps the XP penalty as B.1 set it: 15 % per level past two above the foe, at least 10 %', () => {
    expect(DEFAULT_COMBAT_CONFIG.xpLevelPenalty).toEqual({
      graceLevels: 2,
      perLevel: 0.15,
      min: 0.1,
    });
    for (let hero = 1; hero <= MAX_LEVEL; hero++) {
      let prev = Number.POSITIVE_INFINITY;
      for (let foe = Math.max(1, hero - 12); foe <= hero; foe++) {
        // Monotone in the gap: a foe further below the hero never pays more.
        const f = xpLevelFactor(hero, foe);
        expect(f).toBeGreaterThanOrEqual(0.1);
        expect(f).toBeLessThanOrEqual(1);
        if (foe > Math.max(1, hero - 12)) expect(f).toBeGreaterThanOrEqual(prev);
        prev = f;
      }
    }
    // With the Cinderwastes' top foes at 34–35, the floor arrives at hero level 42 (was 35 with
    // the Pass's 28–29): the soft cap moved with the content (balance.test.ts measures it).
    expect(xpLevelFactor(41, 35)).toBeCloseTo(0.4);
    expect(xpLevelFactor(42, 34)).toBeCloseTo(0.1);
    expect(xpLevelFactor(43, 34)).toBe(0.1);
    // Ticket 8.1: with the Pale Marches' top foes at 46–47 the floor arrives at about 54 (was 48
    // with the Depths' 40–41): the soft cap moved to about 54–55 with the content, no constant
    // changed (balance.test.ts "the Pale Marches" measures it).
    expect(xpLevelFactor(53, 47)).toBeCloseTo(0.4);
    expect(xpLevelFactor(54, 46)).toBeCloseTo(0.1);
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
