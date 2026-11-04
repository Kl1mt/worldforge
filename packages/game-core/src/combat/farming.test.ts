import { describe, expect, it } from 'vitest';
import {
  CLASS_IDS,
  DEFAULT_COMBAT_CONFIG,
  getArea,
  MAX_LEVEL,
  simulateFarming,
  simulateFarmingAggregate,
  xpToNextLevel,
  type FarmingInput,
  type FarmingResult,
} from '../index.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

const input = (overrides: Partial<FarmingInput> = {}): FarmingInput => ({
  character: { classId: 'warrior', level: 1, xp: 0 },
  areaId: 'abandonedFields',
  seed: 'farm',
  durationMs: 30 * MIN,
  ...overrides,
});

const sims = [
  ['detailed', simulateFarming],
  ['aggregate', simulateFarmingAggregate],
] as const;

function expectValid(r: FarmingResult, i: FarmingInput): void {
  for (const [key, value] of Object.entries(r)) {
    if (typeof value === 'number') {
      expect(Number.isFinite(value), key).toBe(true);
      expect(value, key).toBeGreaterThanOrEqual(0);
    }
  }
  expect(r.simulatedMs + r.unusedMs).toBe(i.durationMs);
  expect(r.unusedMs).toBeLessThanOrEqual(
    DEFAULT_COMBAT_CONFIG.searchMs +
      DEFAULT_COMBAT_CONFIG.maxFightMs +
      DEFAULT_COMBAT_CONFIG.respawnMs,
  );
  expect(r.encounters).toBe(r.kills + r.deaths + r.timeouts);
  expect(Object.values(r.killsByEnemy).reduce((s, n) => s + n, 0)).toBe(r.kills);
  expect(Object.keys(r.killsByEnemy).sort()).toEqual(
    getArea(i.areaId)
      .enemies.map((e) => e.enemyId)
      .sort(),
  );
  expect(r.level).toBeGreaterThanOrEqual(r.startLevel);
  expect(r.levelsGained).toBe(r.level - r.startLevel);
  expect(r.level).toBeLessThanOrEqual(MAX_LEVEL);
  expect(r.health).toBeGreaterThanOrEqual(1);
  expect(r.health).toBeLessThanOrEqual(r.maxHealth);
  if (r.level < MAX_LEVEL) expect(r.xp).toBeLessThan(xpToNextLevel(r.level));
  for (const [key, value] of [
    ['xp', r.xp],
    ['damageTaken', r.damageTaken],
    ['health', r.health],
  ] as const) {
    expect(Number.isInteger(value), key).toBe(true);
  }
}

describe.each(sims)('%s simulation', (_name, simulate) => {
  it('is deterministic for the same seed', () => {
    expect(simulate(input())).toEqual(simulate(input()));
  });

  it('differs between seeds', () => {
    const a = simulate(input({ seed: 'a' }));
    const b = simulate(input({ seed: 'b' }));
    expect([a.kills, a.damageTaken, a.xpGained]).not.toEqual([b.kills, b.damageTaken, b.xpGained]);
  });

  it('produces valid, non-negative results for every class and many seeds', () => {
    for (const classId of CLASS_IDS) {
      for (let seed = 0; seed < 15; seed++) {
        for (const level of [1, 4, 30]) {
          const i = input({
            character: { classId, level, xp: 0 },
            seed,
            durationMs: 20 * MIN + seed * 997,
          });
          expectValid(simulate(i), i);
        }
      }
    }
  });

  it('makes progress over time and is monotonic in the window length', () => {
    let prev: FarmingResult | null = null;
    for (const minutes of [0, 1, 5, 15, 60, 180]) {
      const r = simulate(input({ durationMs: minutes * MIN }));
      if (prev) {
        // The same seed replays the same cycles, so a longer window extends a shorter one.
        expect(r.kills).toBeGreaterThanOrEqual(prev.kills);
        expect(r.xpGained).toBeGreaterThanOrEqual(prev.xpGained);
        expect(r.encounters).toBeGreaterThanOrEqual(prev.encounters);
        expect(r.damageTaken).toBeGreaterThanOrEqual(prev.damageTaken);
        expect(r.level * 1e9 + r.xp).toBeGreaterThanOrEqual(prev.level * 1e9 + prev.xp);
      }
      prev = r;
    }
    expect(prev!.kills).toBeGreaterThan(100);
    expect(prev!.levelsGained).toBeGreaterThan(3);
  });

  it('returns nothing for an empty window', () => {
    const r = simulate(input({ durationMs: 0 }));
    expect(r).toMatchObject({
      kills: 0,
      encounters: 0,
      xpGained: 0,
      simulatedMs: 0,
      unusedMs: 0,
      events: [],
    });
  });

  it('stays at the level cap', () => {
    const i = input({
      character: { classId: 'mage', level: MAX_LEVEL, xp: 0 },
      durationMs: 10 * MIN,
    });
    const r = simulate(i);
    expect(r).toMatchObject({ level: MAX_LEVEL, xp: 0, levelsGained: 0 });
    expectValid(r, i);
  });

  it('carries unfinished time forward', () => {
    const r = simulate(input({ durationMs: 1_500 }));
    expect(r).toMatchObject({ encounters: 0, simulatedMs: 0, unusedMs: 1_500 });
  });

  it('starts from the given health and clamps it', () => {
    const low = simulate(
      input({ character: { classId: 'warrior', level: 1, xp: 0, health: -50 }, durationMs: 0 }),
    );
    expect(low.health).toBe(1);
    const high = simulate(
      input({ character: { classId: 'warrior', level: 1, xp: 0, health: 1e9 }, durationMs: 0 }),
    );
    expect(high.health).toBe(high.maxHealth);
  });

  it('rewards better equipment', () => {
    let plain = 0;
    let geared = 0;
    for (let seed = 0; seed < 20; seed++) {
      plain += simulate(input({ seed, character: { classId: 'mage', level: 3, xp: 0 } })).kills;
      geared += simulate(
        input({
          seed,
          character: { classId: 'mage', level: 3, xp: 0 },
          equipment: [{ magicDamage: 15 }, { attackSpeed: 0.3 }],
        }),
      ).kills;
    }
    expect(geared).toBeGreaterThan(plain * 1.2);
  });

  it('rejects invalid input', () => {
    const bad: FarmingInput[] = [
      input({ durationMs: -1 }),
      input({ durationMs: 1.5 }),
      input({ durationMs: Number.NaN }),
      input({ durationMs: DEFAULT_COMBAT_CONFIG.maxDurationMs + 1 }),
      input({ areaId: 'nowhere' as never }),
      input({ character: { classId: 'bard' as never, level: 1, xp: 0 } }),
      input({ character: { classId: 'warrior', level: 0, xp: 0 } }),
      input({ character: { classId: 'warrior', level: 1, xp: -1 } }),
      input({ character: { classId: 'warrior', level: 1, xp: xpToNextLevel(1) } }),
      input({ character: { classId: 'warrior', level: 1, xp: 0, health: Number.NaN } }),
      input({ equipment: [{ armor: Number.POSITIVE_INFINITY }] }),
    ];
    for (const i of bad) expect(() => simulate(i)).toThrow(RangeError);
  });
});

describe('detailed event log', () => {
  it('is ordered, inside the simulated window and consistent with the totals', () => {
    const i = input({ durationMs: 10 * MIN });
    const r = simulateFarming(i, { maxEvents: 100_000 });
    expect(r.eventsDropped).toBe(0);
    let last = 0;
    for (const e of r.events) {
      expect(e.t).toBeGreaterThanOrEqual(last);
      expect(e.t).toBeLessThanOrEqual(r.simulatedMs);
      last = e.t;
    }
    const count = (type: string) => r.events.filter((e) => e.type === type).length;
    expect(count('kill')).toBe(r.kills);
    expect(count('death')).toBe(r.deaths);
    expect(count('respawn')).toBe(r.deaths);
    expect(count('timeout')).toBe(r.timeouts);
    expect(count('spawn')).toBe(r.encounters);
    expect(count('levelUp')).toBe(r.levelsGained);
    const taken = r.events.reduce((s, e) => s + (e.type === 'enemyAttack' ? e.damage : 0), 0);
    expect(taken).toBe(r.damageTaken);
    const xp = r.events.reduce((s, e) => s + (e.type === 'kill' ? e.xp : 0), 0);
    expect(xp).toBe(r.xpGained);
  });

  it('keeps only the most recent events', () => {
    const full = simulateFarming(input(), { maxEvents: 1_000_000 });
    const r = simulateFarming(input(), { maxEvents: 50 });
    expect(r.events).toEqual(full.events.slice(-50));
    expect(r.eventsDropped).toBe(full.events.length - 50);
    expect(simulateFarming(input(), { maxEvents: 0 }).events).toEqual([]);
    expect(() => simulateFarming(input(), { maxEvents: -1 })).toThrow(RangeError);
  });

  it('has the same outcome regardless of log size', () => {
    const outcome = (r: FarmingResult) => ({ ...r, events: [], eventsDropped: 0 });
    expect(outcome(simulateFarming(input(), { maxEvents: 0 }))).toEqual(
      outcome(simulateFarming(input(), { maxEvents: 10_000 })),
    );
  });
});

describe('aggregate vs detailed distribution', () => {
  const seeds = 300;
  const keys = ['kills', 'deaths', 'xpGained', 'damageTaken', 'encounters', 'level'] as const;

  const stats = (values: number[]) => {
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
    return { mean, variance };
  };

  it.each([
    ['warrior', 1],
    ['mage', 1],
    ['hunter', 3],
    ['warlock', 5],
  ] as const)('%s from level %i over 20 minutes', (classId, level) => {
    const detailed: FarmingResult[] = [];
    const aggregate: FarmingResult[] = [];
    for (let s = 0; s < seeds; s++) {
      const i = input({
        seed: `dist-${s}`,
        character: { classId, level, xp: 0 },
        durationMs: 20 * MIN,
      });
      detailed.push(simulateFarming(i, { maxEvents: 0 }));
      aggregate.push(simulateFarmingAggregate(i));
    }
    for (const key of keys) {
      const a = stats(detailed.map((r) => r[key]));
      const b = stats(aggregate.map((r) => r[key]));
      const standardError = Math.sqrt(a.variance / seeds + b.variance / seeds);
      // Within 4 standard errors (or exactly equal when there is no variance).
      expect(Math.abs(a.mean - b.mean), key).toBeLessThanOrEqual(4 * standardError + 1e-9);
    }
  });

  it('settles a full 3 h offline window quickly', () => {
    const start = Date.now();
    const r = simulateFarmingAggregate(input({ durationMs: 3 * HOUR }));
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(r.kills).toBeGreaterThan(500);
  });
});
