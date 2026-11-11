import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from '../test/db.js';
import type { DatabaseHandle } from '../db/types.js';
import {
  createMemoryLimitStore,
  createPostgresLimitStore,
  type LimitStore,
} from '../shared/limit-store.js';
import {
  DEFAULT_LOGIN_THROTTLE,
  createKeyedLimiter,
  createLoginThrottle,
  throttleKey,
} from './login-throttle.js';

function clock(start = Date.UTC(2026, 10, 8, 12)) {
  let t = start;
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

// Ticket 6.9: the same rules on both stores (the in-process map and the PostgreSQL tables).
let db: DatabaseHandle;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.close();
});

describe.each(['memory', 'postgres'] as const)('login throttle (ticket 5.7) — %s store', (kind) => {
  const store = (): LimitStore =>
    kind === 'memory' ? createMemoryLimitStore() : createPostgresLimitStore(db.db);
  const limit = DEFAULT_LOGIN_THROTTLE;

  it('keys by the address, case- and space-insensitively, without keeping it', async () => {
    expect(throttleKey(' Wren@Example.TEST ')).toBe(throttleKey('wren@example.test'));
    expect(throttleKey('wren@example.test')).toMatch(/^[0-9a-f]{64}$/);
    expect(throttleKey('wren@example.test')).not.toBe(throttleKey('wren2@example.test'));
  });

  it('allows the free attempts, then locks with exponential backoff up to the cap', async () => {
    const c = clock();
    const th = createLoginThrottle(limit, c.now, store());
    const k = throttleKey('a@example.test');
    for (let i = 0; i < limit.freeAttempts; i += 1) {
      expect(await th.fail(k)).toBe(0);
      expect(await th.lockedFor(k)).toBe(0);
    }
    const locks: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const lock = await th.fail(k);
      expect(await th.lockedFor(k)).toBe(lock);
      locks.push(lock);
      c.advance(lock); // the lock runs out, the next guess fails again
      expect(await th.lockedFor(k)).toBe(0);
    }
    expect(locks).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000]);
  });

  it('starts fresh after the reset window without failures, or after clear', async () => {
    const c = clock();
    const th = createLoginThrottle(limit, c.now, store());
    const k = throttleKey('b@example.test');
    for (let i = 0; i <= limit.freeAttempts; i += 1) await th.fail(k);
    expect(await th.lockedFor(k)).toBe(limit.baseLockMs);
    // Just inside the window the count is kept: the next failure locks longer.
    c.advance(limit.resetAfterMs - 1);
    expect(await th.fail(k)).toBe(limit.baseLockMs * 2);
    // A full window after the last failure: free attempts again.
    c.advance(limit.resetAfterMs);
    expect(await th.fail(k)).toBe(0);
    for (let i = 1; i < limit.freeAttempts; i += 1) expect(await th.fail(k)).toBe(0);
    expect(await th.fail(k)).toBe(limit.baseLockMs);
    await th.clear(k);
    expect(await th.lockedFor(k)).toBe(0);
    expect(await th.fail(k)).toBe(0);
  });

  it('keeps keys apart', async () => {
    const c = clock();
    const th = createLoginThrottle(limit, c.now, store());
    const a = throttleKey('c@example.test');
    for (let i = 0; i <= limit.freeAttempts; i += 1) await th.fail(a);
    expect(await th.lockedFor(a)).toBeGreaterThan(0);
    expect(await th.lockedFor(throttleKey('d@example.test'))).toBe(0);
  });
});

describe.each(['memory', 'postgres'] as const)('keyed limiter (ticket 5.7) — %s store', (kind) => {
  const store = (): LimitStore =>
    kind === 'memory' ? createMemoryLimitStore() : createPostgresLimitStore(db.db);
  it('allows max uses per window and says how long to wait', async () => {
    const c = clock();
    const take = createKeyedLimiter({ max: 3, windowMs: 60 * 60_000 }, c.now, store());
    expect([await take('x'), await take('x'), await take('x')]).toEqual([0, 0, 0]);
    expect(await take('x')).toBe(3600);
    expect(await take('y')).toBe(0);
    c.advance(30 * 60_000);
    expect(await take('x')).toBe(1800);
    c.advance(30 * 60_000);
    expect(await take('x')).toBe(0);
  });
});
