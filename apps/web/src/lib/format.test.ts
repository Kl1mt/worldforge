import { describe, expect, it } from 'vitest';
import { formatDuration, formatStatDelta, formatStatValue } from './format';

describe('stat formatting', () => {
  it('formats by the stat definition in game-core (percent stats are fractions)', () => {
    expect(formatStatValue('health', 1240)).toBe('1,240');
    expect(formatStatValue('critChance', 0.125)).toBe('12.5%');
    expect(formatStatValue('critDamage', 1.5)).toBe('150%');
    expect(formatStatValue('attackSpeed', 1.4)).toBe('1.40/s');
    expect(formatStatValue('goldFind', 0.05)).toBe('5%');
  });

  it('signs deltas with a true minus', () => {
    expect(formatStatDelta('armor', 18)).toBe('+18');
    expect(formatStatDelta('critChance', -0.03)).toBe('−3%');
  });
});

describe('formatDuration', () => {
  it('picks seconds, minutes or hours', () => {
    expect(formatDuration(45_000)).toBe('45 s');
    expect(formatDuration(12 * 60_000 + 10_000)).toBe('12 min');
    expect(formatDuration(2 * 3_600_000 + 5 * 60_000)).toBe('2 h 05 min');
    expect(formatDuration(-5)).toBe('0 s');
  });
});
