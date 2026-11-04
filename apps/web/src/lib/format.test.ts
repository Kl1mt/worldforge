import { describe, expect, it } from 'vitest';
import { formatStatDelta, formatStatValue } from './format';

describe('stat formatting', () => {
  it('formats by the stat definition in game-core', () => {
    expect(formatStatValue('health', 1240)).toBe('1,240');
    expect(formatStatValue('critChance', 12.5)).toBe('12.5%');
    expect(formatStatValue('attackSpeed', 1.4)).toBe('1.40/s');
  });

  it('signs deltas with a true minus', () => {
    expect(formatStatDelta('armor', 18)).toBe('+18');
    expect(formatStatDelta('critChance', -3)).toBe('−3%');
  });
});
