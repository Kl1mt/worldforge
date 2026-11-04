import { describe, expect, it } from 'vitest';
import { createRng, hashSeed } from './rng.js';

const take = (seed: number | string, n: number) => {
  const rng = createRng(seed);
  return Array.from({ length: n }, () => rng.next());
};

describe('createRng', () => {
  it('is deterministic for the same seed', () => {
    expect(take(42, 20)).toEqual(take(42, 20));
    expect(take('char-1:fight-7', 20)).toEqual(take('char-1:fight-7', 20));
  });

  it('produces different sequences for different seeds', () => {
    expect(take(1, 10)).not.toEqual(take(2, 10));
    expect(take('a', 10)).not.toEqual(take('b', 10));
  });

  it('matches a pinned reference sequence (guards against accidental algorithm changes)', () => {
    expect(take(12345, 3).map((x) => Math.floor(x * 1e9))).toMatchInlineSnapshot(`
      [
        979728267,
        306752264,
        484205421,
      ]
    `);
  });

  it('returns floats in [0, 1)', () => {
    for (const x of take(7, 10_000)) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('can resume from a saved state', () => {
    const a = createRng('resume');
    a.next();
    a.next();
    const b = createRng(a.state);
    expect([b.next(), b.next()]).toEqual([a.next(), a.next()]);
  });

  it('int() stays in the inclusive range and hits both ends', () => {
    const rng = createRng(99);
    const seen = new Set<number>();
    for (let i = 0; i < 2_000; i++) {
      const v = rng.int(1, 6);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
      seen.add(v);
    }
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rng.int(3, 3)).toBe(3);
  });

  it('int() rejects invalid ranges', () => {
    const rng = createRng(1);
    expect(() => rng.int(5, 1)).toThrow(RangeError);
    expect(() => rng.int(0.5, 2)).toThrow(RangeError);
  });

  it('is roughly uniform', () => {
    const rng = createRng('uniform');
    const buckets = new Array<number>(10).fill(0);
    const n = 100_000;
    for (let i = 0; i < n; i++) buckets[Math.floor(rng.next() * 10)]!++;
    for (const count of buckets) expect(Math.abs(count - n / 10)).toBeLessThan(n * 0.01);
  });

  it('chance() handles edge probabilities', () => {
    const rng = createRng(3);
    expect(rng.chance(0)).toBe(false);
    expect(rng.chance(1)).toBe(true);
    let hits = 0;
    for (let i = 0; i < 10_000; i++) if (rng.chance(0.25)) hits++;
    expect(hits).toBeGreaterThan(2_300);
    expect(hits).toBeLessThan(2_700);
  });

  it('pick() returns an element and rejects empty arrays', () => {
    const rng = createRng(5);
    const items = ['a', 'b', 'c'] as const;
    for (let i = 0; i < 100; i++) expect(items).toContain(rng.pick(items));
    expect(() => rng.pick([])).toThrow(RangeError);
  });

  it('weighted() respects weights and never picks zero-weight items', () => {
    const rng = createRng('weights');
    const items = [
      { id: 'never', w: 0 },
      { id: 'low', w: 1 },
      { id: 'high', w: 9 },
    ];
    const counts: Record<string, number> = { never: 0, low: 0, high: 0 };
    for (let i = 0; i < 10_000; i++) counts[rng.weighted(items, (x) => x.w).id]!++;
    expect(counts.never).toBe(0);
    expect(counts.high! / counts.low!).toBeGreaterThan(7);
    expect(counts.high! / counts.low!).toBeLessThan(11);
  });

  it('weighted() rejects invalid weights', () => {
    const rng = createRng(1);
    expect(() => rng.weighted([1, 2], () => 0)).toThrow(RangeError);
    expect(() => rng.weighted([1], () => -1)).toThrow(RangeError);
    expect(() => rng.weighted([1], () => Number.NaN)).toThrow(RangeError);
  });
});

describe('hashSeed', () => {
  it('is stable and returns an unsigned 32-bit integer', () => {
    expect(hashSeed('worldforge')).toBe(hashSeed('worldforge'));
    const h = hashSeed('worldforge');
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(2 ** 32);
  });
});
