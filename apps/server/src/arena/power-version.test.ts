import { describe, expect, it } from 'vitest';
import {
  BRACKET_POWER_VERSION,
  bracketPower,
  duelFighter,
  duelSnapshot,
  findPvpBracket,
} from '@worldforge/game-core';
import { defencePower } from './model.js';

/**
 * Ticket B.5: bracket Power 3 (duel Power in 30+) and stored defences. A stored value is reused
 * only when it is what version 3 would compute: its own version, version 2 outside 30+ (equal
 * there), version 1 outside 30+ without an awakening (6.5b). A 30+ defence stored under an
 * older version is recomputed when matchmaking reads it.
 */
const snap = (level: number) =>
  duelSnapshot({ classId: 'mage', level, xp: 0, name: 'x', equipment: [] });
const STALE = 12_345;

describe('stored bracket Power across versions (ticket B.5)', () => {
  it('reuses a value of the current version', () => {
    expect(BRACKET_POWER_VERSION).toBe(3);
    for (const [level, bracketId] of [
      [25, '20-29'],
      [34, '30-plus'],
    ] as const) {
      const d = { snapshot: snap(level), power: STALE, powerVersion: 3 };
      expect(defencePower(d, bracketId)).toBe(STALE);
    }
  });

  it('outside 30+: version 2 and (without an awakening) version 1 are still right', () => {
    for (const powerVersion of [1, 2]) {
      expect(defencePower({ snapshot: snap(25), power: STALE, powerVersion }, '20-29')).toBe(STALE);
    }
  });

  it('in 30+: an older version is recomputed as duel Power', () => {
    const snapshot = snap(34);
    const fresh = bracketPower(duelFighter(snapshot), findPvpBracket('30-plus')!);
    for (const powerVersion of [1, 2, null]) {
      const d = { snapshot, power: powerVersion === null ? null : STALE, powerVersion };
      expect(defencePower(d, '30-plus')).toBe(fresh);
    }
    expect(fresh).not.toBe(STALE);
  });
});
