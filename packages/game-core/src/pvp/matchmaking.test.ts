import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MATCHMAKING,
  PVP_BRACKETS,
  BRACKET_POWER_VERSION,
  bracketPower,
  characterPower,
  matchOdds,
  pickOpponents,
  powerGap,
  type MatchCandidate,
  CLASS_IDS,
  DUEL_POWER_SCALE,
  MATCHMAKING_VERSION,
  duelPower,
  expectedDuelTimes,
  matchmakingConfig,
  referenceFighter,
  usesDuelPower,
} from '../index.js';

const cand = (i: number, power: number, rating = 1500, account = `a${i}`): MatchCandidate => ({
  defenceId: `d${String(i).padStart(3, '0')}`,
  accountId: account,
  power,
  rating,
  deviation: 200,
});
const seeker = { power: 1000, rating: 1500, deviation: 200 };

describe('matchmaking (ticket 5.6)', () => {
  it('Power gaps are relative to the stronger side, with a floor', () => {
    expect(powerGap(1000, 1100)).toBeCloseTo(100 / 1100, 12);
    expect(powerGap(1100, 1000)).toBeCloseTo(100 / 1100, 12);
    expect(powerGap(100, 200)).toBeCloseTo(100 / DEFAULT_MATCHMAKING.powerFloor, 12);
  });

  it('keeps to the narrowest range that has enough accounts', () => {
    const near = [0, 1, 2, 3, 4, 5].map((i) => cand(i, 1000 + i * 5));
    const far = [10, 11, 12].map((i) => cand(i, 1150));
    const r = pickOpponents(seeker, [...far, ...near], 's', 5);
    expect(r.widened).toBe(0);
    expect(r.powerStep).toBe(DEFAULT_MATCHMAKING.powerSteps[0]);
    expect(r.picks).toHaveLength(5);
    for (const p of r.picks) expect(p.powerGap).toBeLessThanOrEqual(0.05);
  });

  it('widens only when needed, and never past the last step', () => {
    const list = [cand(1, 1030), cand(2, 1080), cand(3, 1150), cand(4, 1240), cand(5, 2000)];
    const r = pickOpponents(seeker, list, 's', 5);
    expect(r.powerStep).toBe(0.2);
    expect(r.widened).toBe(2);
    expect(r.picks.map((p) => p.candidate.accountId).sort()).toEqual(['a1', 'a2', 'a3', 'a4']);
    // Nobody in any range: an empty list, never a lopsided pair.
    const none = pickOpponents(seeker, [cand(9, 3000), cand(8, 300)], 's', 5);
    expect(none.picks).toEqual([]);
    expect(none.powerStep).toBe(null);
  });

  it('prefers the closest ratings in range, one defence per account', () => {
    const list = [
      ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => cand(i, 1000, 1500 + i * 10)),
      ...[20, 21, 22].map((i) => cand(i, 1000, 2400)),
      cand(30, 1000, 1500, 'a0'),
    ];
    const r = pickOpponents(seeker, list, 's', 5);
    const ids = r.picks.map((p) => p.candidate.accountId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of r.picks) expect(p.candidate.rating).toBeLessThan(1600);
    for (const p of r.picks) expect(p.expected).toBeGreaterThan(0.35);
  });

  it('is deterministic for a seed', () => {
    const list = Array.from({ length: 40 }, (_, i) => cand(i, 980 + i, 1400 + i * 7));
    expect(pickOpponents(seeker, list, 'x', 5)).toEqual(pickOpponents(seeker, list, 'x', 5));
    expect(pickOpponents(seeker, [...list].reverse(), 'x', 5)).toEqual(
      pickOpponents(seeker, list, 'x', 5),
    );
  });

  it('odds in plain words', () => {
    expect(matchOdds(0.65)).toBe('favoured');
    expect(matchOdds(0.5)).toBe('even');
    expect(matchOdds(0.3)).toBe('underdog');
  });

  it('bracket Power is 5.1 Power (version 1) at the reference level', () => {
    const b = PVP_BRACKETS.find((x) => x.id === '10-19')!;
    const f = { classId: 'warrior' as const, level: 19, equipment: [] };
    // Ticket 6.1: matchmaking keeps Power 1 when the board moves to Power 2. Ticket 6.5b: bracket
    // Power 2 is Power 1 × the awakening factor (1 without an awakening).
    // Ticket B.5: bracket Power 3 is version 2 outside the duel-Power brackets (1–29).
    expect(BRACKET_POWER_VERSION).toBe(3);
    expect(bracketPower(f, b, 1)).toBe(bracketPower(f, b, 2));
    expect(bracketPower(f, b, 3)).toBe(bracketPower(f, b, 2));
    expect(bracketPower(f, b)).toBe(
      characterPower({ classId: 'warrior', level: b.referenceLevel, equipment: [] }, 1).power,
    );
    expect(bracketPower({ ...f, level: 11 }, b)).toBe(bracketPower(f, b));
  });

  it('30+ bracket Power 3 is duel Power: the reference kit 1000, deterministic, rising with gear', () => {
    const b = PVP_BRACKETS.find((x) => x.id === '30-plus')!;
    expect(usesDuelPower('30-plus')).toBe(true);
    expect(usesDuelPower('20-29')).toBe(false);
    for (const classId of CLASS_IDS) {
      const naked = { classId, level: 34, equipment: [] };
      const p = bracketPower(naked, b);
      expect(p).toBe(duelPower(naked, b));
      expect(bracketPower(naked, b)).toBe(p);
      // Level does not count inside a bracket (levelKeep 0), as for Power.
      expect(bracketPower({ ...naked, level: 31 }, b)).toBe(p);
      // A naked hero is weaker than the reference kit (rare, item level 29).
      expect(p).toBeLessThan(DUEL_POWER_SCALE);
    }
    // The reference hero against itself falls at the same moment both ways.
    for (const classId of CLASS_IDS) {
      const ref = referenceFighter(classId, b);
      const t = expectedDuelTimes(ref, ref, b);
      expect(t.a).toBe(t.b);
    }
  });

  it('matchmaking 4: 30+ compares duel Power with its own class scale; other brackets as before', () => {
    expect(MATCHMAKING_VERSION).toBe(4);
    expect(matchmakingConfig('20-29')).toBe(DEFAULT_MATCHMAKING);
    expect(matchmakingConfig('30-plus').classPowerScale).toEqual({
      warrior: 1.02,
      mage: 1,
      hunter: 1,
      warlock: 1,
    });
    expect({ ...matchmakingConfig('30-plus'), classPowerScale: null }).toEqual({
      ...DEFAULT_MATCHMAKING,
      classPowerScale: null,
    });
  });
});
