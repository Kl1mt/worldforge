import { describe, expect, it } from 'vitest';
import {
  ITEM_BASES,
  MAX_LEVEL,
  NO_WORLD_FLAGS,
  canClassUseItem,
  createRng,
  equipmentSlotsForKind,
  generateItem,
} from '../index.js';
import {
  LEVEL_BRACKETS,
  SCORE_METRICS,
  compareBoardEntries,
  compareSortKeys,
  computeScore,
  computeScores,
  levelBracketOf,
  metricInput,
  type ScoredItem,
  type ScoringInput,
} from './index.js';

function kit(itemLevel: number, seed: string): ScoredItem[] {
  const rng = createRng(seed);
  const out: ScoredItem[] = [];
  const taken = new Set<string>();
  for (const base of ITEM_BASES.filter(
    (b) => !b.unique && b.minItemLevel <= itemLevel && canClassUseItem(b, 'warlock'),
  ).sort((a, b) => b.tier - a.tier)) {
    if (taken.has(base.slot)) continue;
    taken.add(base.slot);
    for (const slot of equipmentSlotsForKind(base.slot)) {
      const item = generateItem({
        seed: rng.int(0, 2 ** 31),
        itemLevel,
        baseId: base.id,
        rarityId: 'rare',
        classId: 'warlock',
      })!;
      out.push({ ...item, slot, upgradeLevel: 2 });
    }
  }
  return out;
}

const base: ScoringInput = {
  classId: 'warlock',
  level: 18,
  experience: 400,
  equipment: kit(17, 'boards:a'),
  progress: { gravewardenDefeated: true, cryptTierCleared: 1 },
  world: NO_WORLD_FLAGS,
  guildBossStage: 1,
};

/** One change per input field, each moving at least one metric. */
const CHANGES: [string, Partial<ScoringInput>][] = [
  ['experience', { experience: 900 }],
  ['level', { level: 19, experience: 0 }],
  ['equipment', { equipment: kit(18, 'boards:b') }],
  ['classId', { classId: 'mage' }],
  ['progress', { progress: { gravewardenDefeated: true, cryptTierCleared: 3 } }],
  ['world', { world: { ...NO_WORLD_FLAGS, ashenPassCleared: true } }],
  ['guildBossStage', { guildBossStage: 4 }],
];

describe('per-metric inputs (5.2 debounce)', () => {
  it('computeScore is computeScores, metric by metric', () => {
    const all = computeScores(base);
    for (const m of SCORE_METRICS) expect(computeScore(m, base)).toEqual(all[m]);
  });

  it('a change outside a metric’s slice never moves that metric', () => {
    for (const [field, change] of CHANGES) {
      const next = { ...base, ...change };
      for (const m of SCORE_METRICS) {
        const sliceSame =
          JSON.stringify(metricInput(m, next)) === JSON.stringify(metricInput(m, base));
        if (sliceSame)
          expect(computeScore(m, next), `${field} → ${m}`).toEqual(computeScore(m, base));
      }
    }
  });

  it('every field is in some slice', () => {
    for (const [field, change] of CHANGES) {
      const next = { ...base, ...change };
      const moved = SCORE_METRICS.filter(
        (m) => JSON.stringify(metricInput(m, next)) !== JSON.stringify(metricInput(m, base)),
      );
      expect(moved.length, field).toBeGreaterThan(0);
    }
  });
});

describe('level brackets', () => {
  it('cover every level exactly once, in order', () => {
    for (let level = 1; level <= MAX_LEVEL; level++) {
      const hits = LEVEL_BRACKETS.filter(
        (b) => level >= b.min && (b.max === null || level <= b.max),
      );
      expect(hits, `level ${level}`).toHaveLength(1);
      expect(levelBracketOf(level)).toBe(hits[0]);
    }
    expect(new Set(LEVEL_BRACKETS.map((b) => b.id)).size).toBe(LEVEL_BRACKETS.length);
  });
});

describe('board order', () => {
  it('compares sort keys lexicographically, higher first', () => {
    expect(compareSortKeys([5, 10], [5, 9])).toBeLessThan(0);
    expect(compareSortKeys([4, 99], [5, 0])).toBeGreaterThan(0);
    expect(compareSortKeys([3, 3, 1], [3, 3, 1])).toBe(0);
  });

  it('breaks ties by who reached the key first, then by id', () => {
    const t = (iso: string, id: string, sortKey = [7, 7, 2]) => ({ sortKey, achievedAt: iso, id });
    const entries = [
      t('2026-11-05T10:00:00Z', 'c'),
      t('2026-11-04T10:00:00Z', 'b'),
      t('2026-11-04T10:00:00Z', 'a'),
      t('2026-11-01T00:00:00Z', 'z', [7, 6, 9]),
      t('2026-11-09T00:00:00Z', 'y', [8, 0, 0]),
    ];
    expect([...entries].sort(compareBoardEntries).map((e) => e.id)).toEqual([
      'y',
      'a',
      'b',
      'c',
      'z',
    ]);
  });
});
