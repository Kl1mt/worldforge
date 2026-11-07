import { describe, expect, it } from 'vitest';
import { trackProgress, untilText } from './guildBoss';

describe('guild boss helpers', () => {
  it('fills equal stage segments in proportion', () => {
    const t = [100, 1_000, 10_000];
    expect(trackProgress(0, t)).toBe(0);
    expect(trackProgress(50, t)).toBeCloseTo(1 / 6);
    expect(trackProgress(100, t)).toBeCloseTo(1 / 3);
    expect(trackProgress(550, t)).toBeCloseTo(0.5);
    expect(trackProgress(10_000, t)).toBe(1);
    expect(trackProgress(5, [])).toBe(0);
  });

  it('says how long until the week turns', () => {
    const now = Date.parse('2026-11-07T12:00:00Z');
    expect(untilText('2026-11-09T00:00:00Z', now)).toBe('1 d 12 h');
    expect(untilText('2026-11-07T17:12:30Z', now)).toBe('5 h 12 min');
    expect(untilText('2026-11-07T12:00:30Z', now)).toBe('under a minute');
  });
});
