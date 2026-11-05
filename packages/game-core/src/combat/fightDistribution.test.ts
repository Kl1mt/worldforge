import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMBAT_CONFIG,
  ENEMIES,
  buildEncounter,
  createRng,
  deriveCharacterStats,
  hitsToKillDistribution,
  killDistribution,
  resolveFightDetailed,
  sampleFight,
  type ClassId,
  type EncounterSetup,
  type FightOutcome,
} from '../index.js';

const setupFor = (
  classId: ClassId,
  level: number,
  enemyIndex: number,
  enemyLevel: number,
): EncounterSetup =>
  buildEncounter(
    ENEMIES[enemyIndex]!,
    enemyLevel,
    classId,
    level,
    deriveCharacterStats(classId, level),
    DEFAULT_COMBAT_CONFIG,
  );

const sum = (a: Float64Array) => a.reduce((s, v) => s + v, 0);

describe('hitsToKillDistribution', () => {
  it('is a valid (sub-)probability distribution', () => {
    for (const classId of ['warrior', 'mage', 'hunter', 'warlock'] as const) {
      // The Abandoned Fields enemies (the first three); later areas are covered by world.test.ts.
      for (let e = 0; e < 3; e++) {
        const d = hitsToKillDistribution(setupFor(classId, 2, e, 3));
        expect(d[0]).toBe(0);
        for (const p of d) expect(p).toBeGreaterThanOrEqual(0);
        expect(sum(d)).toBeLessThanOrEqual(1 + 1e-9);
        expect(sum(d)).toBeGreaterThan(0.999);
      }
    }
  });

  it('is deterministic without crits', () => {
    const base = setupFor('warrior', 1, 0, 1);
    const s: EncounterSetup = {
      ...base,
      enemyHealth: 50,
      skillEvery: 3,
      auto: { normal: 10, crit: 20, critChance: 0 },
      skill: { normal: 25, crit: 50, critChance: 0 },
    };
    // 10 + 10 + 25 = 45, the 4th attack (10) kills.
    const d = hitsToKillDistribution(s);
    expect(d[4]).toBe(1);
    expect(sum(d)).toBe(1);
  });

  it('leaves the timeout mass when the enemy cannot die in time', () => {
    const base = setupFor('warrior', 1, 0, 1);
    const s: EncounterSetup = {
      ...base,
      enemyHealth: 1_000_000,
      auto: { normal: 1, crit: 2, critChance: 0.5 },
      skill: { normal: 1, crit: 2, critChance: 0.5 },
    };
    expect(sum(hitsToKillDistribution(s))).toBe(0);
    const outcome = sampleFight(s, 1_000_000, createRng(1), killDistribution(s, 1_000_000));
    expect(outcome.kind).toBe('timeout');
    expect(outcome.offsetMs).toBe(s.maxFightMs);
    expect(outcome.enemyHits).toBe(Math.floor(s.maxFightMs / s.enemyIntervalMs));
  });
});

describe('sampled fights match detailed fights', () => {
  const trials = 20_000;

  const compare = (setup: EncounterSetup, health: number) => {
    const detailedRng = createRng(`detailed:${health}`);
    const sampledRng = createRng(`sampled:${health}`);
    const distribution = killDistribution(setup, health);
    const tally = () => ({ kill: 0, death: 0, timeout: 0, hits: 0, offset: 0 });
    const a = tally();
    const b = tally();
    const add = (t: ReturnType<typeof tally>, o: FightOutcome) => {
      t[o.kind]++;
      t.hits += o.enemyHits;
      t.offset += o.offsetMs;
    };
    for (let i = 0; i < trials; i++) {
      add(a, resolveFightDetailed(setup, health, detailedRng));
      add(b, sampleFight(setup, health, sampledRng, distribution));
    }
    for (const k of ['kill', 'death', 'timeout'] as const) {
      expect(Math.abs(a[k] - b[k]) / trials).toBeLessThan(0.015);
    }
    expect(Math.abs(a.hits - b.hits) / Math.max(1, a.hits)).toBeLessThan(0.03);
    expect(Math.abs(a.offset - b.offset) / Math.max(1, a.offset)).toBeLessThan(0.03);
  };

  it.each([
    ['warrior', 1, 0, 1, 140],
    ['mage', 2, 2, 3, 40],
    ['hunter', 4, 1, 5, 25],
    ['warlock', 3, 2, 6, 30],
  ] as const)(
    '%s level %i vs enemy #%i level %i at %i health',
    (classId, level, enemy, enemyLevel, health) => {
      compare(setupFor(classId, level, enemy, enemyLevel), health);
    },
  );

  it('agrees on outcome when nothing is random', () => {
    const base = setupFor('warrior', 1, 0, 1);
    const s: EncounterSetup = {
      ...base,
      auto: { ...base.auto, critChance: 0 },
      skill: { ...base.skill, critChance: 0 },
    };
    for (const health of [1, 5, 10, 20, 40, 140]) {
      expect(sampleFight(s, health, createRng(1), killDistribution(s, health))).toEqual(
        resolveFightDetailed(s, health, createRng(1)),
      );
    }
  });
});
