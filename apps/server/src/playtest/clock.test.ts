import { describe, expect, it } from 'vitest';
import { playtestClock, startOffsetMs } from './clock.js';

describe('playtestClock', () => {
  it('is the real clock when the scale is 1 and there is no offset', () => {
    let real = 1_000_000;
    const clock = playtestClock({ scale: 1, offsetMs: 0, real: () => real });
    real += 5000;
    expect(clock.now().getTime()).toBe(1_005_000);
    expect(clock.offsetMs()).toBe(0);
  });

  it('runs `scale` times faster and reports the offset it has built up', () => {
    let real = 1_000_000;
    const clock = playtestClock({ scale: 60, offsetMs: 0, real: () => real });
    real += 1000;
    expect(clock.now().getTime()).toBe(1_000_000 + 60_000);
    expect(clock.offsetMs()).toBe(59_000);
  });

  it('continues from a saved offset, so a restart never moves time backwards', () => {
    let real = 1_000_000;
    const first = playtestClock({ scale: 60, offsetMs: 0, real: () => real });
    real += 10_000;
    const before = first.now().getTime();
    const saved = first.offsetMs();
    // Restart with fast time switched off: time keeps going forward from where it was.
    const second = playtestClock({ scale: 1, offsetMs: saved, real: () => real });
    expect(second.now().getTime()).toBe(before);
    real += 1000;
    expect(second.now().getTime()).toBe(before + 1000);
  });

  it('rejects a scale below 1 and a negative offset', () => {
    expect(() => playtestClock({ scale: 0.5, offsetMs: 0 })).toThrow(RangeError);
    expect(() => playtestClock({ scale: Number.NaN, offsetMs: 0 })).toThrow(RangeError);
    expect(() => playtestClock({ scale: 1, offsetMs: -1 })).toThrow(RangeError);
  });
});

describe('startOffsetMs', () => {
  it('uses the saved offset', () => {
    expect(startOffsetMs(5000, null, 1_000_000)).toBe(5000);
  });

  it('is raised to the newest stored farming time when that is ahead', () => {
    expect(startOffsetMs(undefined, 1_090_000, 1_000_000)).toBe(90_000);
    expect(startOffsetMs(5000, 1_090_000, 1_000_000)).toBe(90_000);
  });

  it('ignores missing, invalid or negative values', () => {
    expect(startOffsetMs(undefined, null, 1_000_000)).toBe(0);
    expect(startOffsetMs(Number.NaN, 900_000, 1_000_000)).toBe(0);
    expect(startOffsetMs(-5, null, 1_000_000)).toBe(0);
  });
});
