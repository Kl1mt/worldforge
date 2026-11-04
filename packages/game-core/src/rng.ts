/**
 * Seeded, deterministic pseudo-random number generator (mulberry32 with a
 * string/number seed hashed through xmur3-style mixing).
 *
 * Gameplay code must take an `Rng` instead of calling `Math.random()`, so the
 * server can reproduce and audit any roll from its seed. The state is a single
 * 32-bit integer and can be persisted and restored.
 */
export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  /** True with the given probability (0..1). */
  chance(probability: number): boolean;
  /** Uniformly picks one element. Throws on an empty array. */
  pick<T>(items: readonly T[]): T;
  /** Picks an element by non-negative weight. Throws if all weights are 0. */
  weighted<T>(items: readonly T[], weight: (item: T) => number): T;
  /** Current internal state; pass to `createRng` to resume the same sequence. */
  readonly state: number;
}

/** Hashes a string seed into a 32-bit unsigned integer. */
export function hashSeed(seed: string): number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

export function createRng(seed: number | string): Rng {
  let state = typeof seed === 'string' ? hashSeed(seed) : seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng: Rng = {
    next,
    int(min, max) {
      if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
        throw new RangeError(`Invalid integer range [${min}, ${max}]`);
      }
      return min + Math.floor(next() * (max - min + 1));
    },
    chance(probability) {
      if (probability <= 0) return false;
      if (probability >= 1) return true;
      return next() < probability;
    },
    pick(items) {
      if (items.length === 0) throw new RangeError('Cannot pick from an empty array');
      return items[Math.floor(next() * items.length)] as (typeof items)[number];
    },
    weighted(items, weight) {
      let total = 0;
      for (const item of items) {
        const w = weight(item);
        if (!Number.isFinite(w) || w < 0) throw new RangeError(`Invalid weight: ${w}`);
        total += w;
      }
      if (total <= 0) throw new RangeError('Total weight must be positive');
      let roll = next() * total;
      for (const item of items) {
        roll -= weight(item);
        if (roll < 0) return item;
      }
      // Floating-point edge case: fall back to the last item with positive weight.
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i] as (typeof items)[number];
        if (weight(item) > 0) return item;
      }
      throw new RangeError('Total weight must be positive');
    },
    get state() {
      return state;
    },
  };
  return rng;
}
