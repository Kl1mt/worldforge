import { describe, expect, it } from 'vitest';
import {
  BRACKET_POWER_VERSION,
  PVP_BRACKETS,
  PVP_RULES_VERSION,
  awakenItem,
  awakenedEffectCount,
  bracketPower,
  duelPower,
  duelFighter,
  duelSnapshot,
  equipmentSlotsForKind,
  getItemBase,
  type ClassId,
  type EquippedItem,
  type GeneratedItem,
  type ScoredItem,
} from '../index.js';
import { RATED_BRACKETS, arenaPopulation, measureFairness } from './arena-fixtures.js';
import { CLASS_IDS, fighter, gear, sampleBuild, winShare } from './pvp-fixtures.js';

/**
 * Ticket 6.5b: awakening counts in duels and in matchmaking (owner decision 2026-11-10, docs/PVP.md
 * "6.5b"). Every duel draws from a fixed seed, so each number is a measurement that is the same in
 * every run.
 */

const SLOW = { timeout: 120_000 };
const awaken = (items: readonly EquippedItem[]) =>
  items.map((item) => {
    const r = awakenItem(item);
    return r.ok ? r.item : item;
  });

/** A +10 Void kit or B.2-shaped build at a level, plain. */
const plainKit = (c: ClassId, level: number, k: number): EquippedItem[] =>
  k < 6
    ? gear(c, level, 'legendary+10void', k)
    : sampleBuild(c, level - 1, k).map((i) => ({
        ...i,
        upgradeLevel: 10,
        variant: 'void' as const,
      }));

describe('duels apply the awakened effect (no duel rule changed)', () => {
  it('the duel rules keep version 2', () => {
    expect(PVP_RULES_VERSION).toBe(2);
  });

  for (const [label, level] of [
    ['20–29', 27],
    ['30+', 38],
  ] as const) {
    it(`${label}: an awakened kit edges out the same kit plain, by a few points`, SLOW, () => {
      let total = 0;
      for (const c of CLASS_IDS) {
        let s = 0;
        for (let k = 0; k < 12; k++) {
          const plain = plainKit(c, level, k);
          s += winShare(
            fighter(c, level, awaken(plain)),
            fighter(c, level, plain),
            48,
            `awakening-duel:${c}:${k}`,
          ).share;
        }
        const share = s / 12;
        // A small edge: 50–56 % per class here (20–29 mean 51.9 %, 30+ 53.3 %; docs/PVP.md
        // "6.5b"). The floor leaves room for the duel's luck at 576 duels per class.
        expect(share).toBeGreaterThanOrEqual(0.45);
        expect(share).toBeLessThanOrEqual(0.62);
        total += share;
      }
      expect(total / CLASS_IDS.length).toBeGreaterThan(0.5);
    });
  }

  it('a stored snapshot keeps the awakening; an awakening below +10 counts 0', () => {
    const awake = awaken(gear('warrior', 38, 'legendary+10void', 0)) as GeneratedItem[];
    const used = new Set<string>();
    const scored: ScoredItem[] = awake.map((i) => {
      const slot = equipmentSlotsForKind(getItemBase(i.baseId).slot).find((s) => !used.has(s))!;
      used.add(slot);
      return { ...i, slot, upgradeLevel: 10 };
    });
    expect(scored.some((i) => i.awakening)).toBe(true);
    const snap = duelSnapshot({
      classId: 'warrior',
      level: 38,
      xp: 0,
      name: 'x',
      equipment: scored,
    });
    expect(snap.rejected).toEqual([]);
    expect(duelFighter(snap).equipment.filter((i) => i.awakening).length).toBe(
      scored.filter((i) => i.awakening).length,
    );
    const forged = duelSnapshot({
      classId: 'warrior',
      level: 38,
      xp: 0,
      name: 'x',
      equipment: scored.map((i) => ({ ...i, upgradeLevel: i.awakening ? 9 : 10 })),
    });
    expect(forged.rejected.length).toBe(scored.filter((i) => i.awakening).length);
  });
});

describe('bracket Power sees awakening', () => {
  const b30 = PVP_BRACKETS.find((b) => b.id === '30-plus')!;

  it('version 2 equals version 1 on every kit without an awakening', () => {
    expect(BRACKET_POWER_VERSION).toBe(3);
    for (const c of CLASS_IDS) {
      for (let k = 0; k < 12; k++) {
        const f = fighter(c, 38, plainKit(c, 38, k));
        expect(bracketPower(f, b30, 2)).toBe(bracketPower(f, b30, 1));
      }
    }
  });

  it('raises an awakened kit by its duel-read awakened effects (a whole kit about 1 %)', () => {
    for (const c of CLASS_IDS) {
      const plain = plainKit(c, 38, 0);
      const awake = awaken(plain);
      const n = awakenedEffectCount(awake, c);
      expect(n).toBeGreaterThan(0);
      const p1 = bracketPower(fighter(c, 38, awake), b30, 1);
      const p2 = bracketPower(fighter(c, 38, awake), b30, 2);
      expect(p2).toBe(Math.round(p1 * (1 + 0.002 * n)));
      expect(p2 / p1 - 1).toBeLessThan(0.03);
    }
  });

  it('version 3 (ticket B.5: duel Power in 30+) raises an awakened kit by its duel edge', () => {
    let rose = 0;
    for (const c of CLASS_IDS) {
      const plain = plainKit(c, 38, 0);
      const p = bracketPower(fighter(c, 38, plain), b30, 3);
      const a = bracketPower(fighter(c, 38, awaken(plain)), b30, 3);
      expect(p).toBe(duelPower(fighter(c, 38, plain), b30));
      // 6.5b measured the awakened kit's duel edge at 52–55 %: a small rise, never a fall.
      expect(a).toBeGreaterThanOrEqual(p);
      if (a > p) rose++;
      expect(a / p - 1).toBeLessThan(0.06);
    }
    expect(rose).toBeGreaterThanOrEqual(3);
  });
});

describe('matchmaking fairness with an awakened population', () => {
  for (const bracket of RATED_BRACKETS.filter((b) => b.min >= 20)) {
    it(`${bracket.label}: every +10 Void hero awakened, bands as without it`, SLOW, () => {
      const pop = arenaPopulation(bracket, 120, { awakened: true });
      expect(pop.some((h) => h.fighter.equipment.some((i) => i.awakening))).toBe(true);
      const mm = measureFairness(bracket, pop, 'matchmaking', 32);
      expect(mm.meanFavourite).toBeLessThanOrEqual(0.72);
      // 20–29 keeps the ≤ 9 % / ≤ 5 % band (measured 3.5 % / 0.8 %). 30+ measured 14.5 % / 6.7 %
      // under bracket Power 2 (over the 14 % band, 6.5b); ticket B.5's duel Power (bracket Power
      // 3, which reads the awakening through the duel's own normalisation) 2.5 % / 0.5 %.
      expect(mm.over90).toBeLessThanOrEqual(0.09);
      expect(mm.over95).toBeLessThanOrEqual(0.05);
      expect(mm.extremePairs).toBeLessThanOrEqual(0.03);
      expect(mm.emptyLists).toBe(0);
      expect(mm.meanListSize).toBeGreaterThanOrEqual(4.9);
    });
  }
});
