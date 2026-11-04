import { describe, expect, it } from 'vitest';
import {
  CLASS_IDS,
  CORE_STAT_IDS,
  CLASS_STAT_PROFILES,
  MAX_LEVEL,
  STAT_LIMITS,
  deriveCharacterStats,
} from '../index.js';

describe('deriveCharacterStats', () => {
  it('returns the class base at level 1', () => {
    for (const id of CLASS_IDS) {
      const stats = deriveCharacterStats(id, 1);
      expect(stats).toEqual(CLASS_STAT_PROFILES[id].base);
    }
  });

  it('grows with level and never decreases', () => {
    for (const id of CLASS_IDS) {
      let prev = deriveCharacterStats(id, 1);
      for (let level = 2; level <= MAX_LEVEL; level++) {
        const cur = deriveCharacterStats(id, level);
        for (const stat of CORE_STAT_IDS) expect(cur[stat]).toBeGreaterThanOrEqual(prev[stat]);
        expect(cur.health).toBeGreaterThan(prev.health);
        prev = cur;
      }
    }
  });

  it('adds equipment contributions', () => {
    const base = deriveCharacterStats('warrior', 5);
    const geared = deriveCharacterStats('warrior', 5, [
      { physicalDamage: 4, armor: 10 },
      { health: 25.7, critChance: 0.02 },
      {},
    ]);
    expect(geared.physicalDamage).toBeCloseTo(base.physicalDamage + 4);
    expect(geared.armor).toBeCloseTo(base.armor + 10);
    expect(geared.health).toBe(Math.floor(base.health + 25.7));
    expect(geared.critChance).toBeCloseTo(base.critChance + 0.02);
  });

  it('clamps to the stat limits and never goes negative', () => {
    const huge = deriveCharacterStats('hunter', 1, [
      { critChance: 5, attackSpeed: 50, critDamage: 100 },
    ]);
    expect(huge.critChance).toBe(STAT_LIMITS.critChance.max);
    expect(huge.attackSpeed).toBe(STAT_LIMITS.attackSpeed.max);
    expect(huge.critDamage).toBe(STAT_LIMITS.critDamage.max);
    const cursed = deriveCharacterStats('mage', 1, [
      { health: -10_000, armor: -500, magicDamage: -99, attackSpeed: -9, critDamage: -9 },
    ]);
    expect(cursed.health).toBe(1);
    expect(cursed.armor).toBe(0);
    expect(cursed.magicDamage).toBe(0);
    expect(cursed.attackSpeed).toBe(STAT_LIMITS.attackSpeed.min);
    expect(cursed.critDamage).toBe(1);
  });

  it('rejects invalid input', () => {
    expect(() => deriveCharacterStats('warrior', 0)).toThrow(RangeError);
    expect(() => deriveCharacterStats('warrior', 1.5)).toThrow(RangeError);
    expect(() => deriveCharacterStats('warrior', MAX_LEVEL + 1)).toThrow(RangeError);
    expect(() => deriveCharacterStats('paladin' as never, 1)).toThrow(RangeError);
    expect(() => deriveCharacterStats('warrior', 1, [{ armor: Number.NaN }])).toThrow(RangeError);
    expect(() => deriveCharacterStats('warrior', 1, [{ armor: Infinity }])).toThrow(RangeError);
  });
});
