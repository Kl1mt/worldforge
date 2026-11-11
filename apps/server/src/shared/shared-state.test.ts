/**
 * Ticket 6.9: the shared-state building blocks on PGlite (the real-PostgreSQL, two-instance tests
 * are `scale.pg.test.ts`): the PostgreSQL limit store follows exactly the rules of the in-process
 * one (fixed windows from the first request, several windows at once, refused requests counted in
 * none, the account class's requests and actions), pruning, cache invalidation between two apps on
 * one database by NOTIFY and by the version check, and the leader on a single-session database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { createAccountRateLimiter } from '../auth/account-rate-limit.js';
import { createSocialWriteLimiter } from '../social/social-write.js';
import { worldFlags } from '../db/schema.js';
import { queryRows } from '../db/query.js';
import { withTransaction } from '../db/transaction.js';
import type { DatabaseHandle } from '../db/types.js';
import { ApiError } from '../errors.js';
import { createTestDatabase } from '../test/db.js';
import { bumpCacheVersion } from './cache-sync.js';
import {
  createMemoryLimitStore,
  createPostgresLimitStore,
  limitKey,
  type LimitStore,
} from './limit-store.js';
import { SchedulerLeader } from './leader.js';

let database: DatabaseHandle;
const apps: FastifyInstance[] = [];
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
  await database.close();
});

/** A stand-in for Fastify's reply: the limiters only set `Retry-After`. */
const reply = () => {
  const headers: Record<string, string> = {};
  return {
    headers,
    header(k: string, v: string) {
      headers[k] = v;
      return this;
    },
  } as unknown as Parameters<ReturnType<typeof createAccountRateLimiter>>[2] & {
    headers: Record<string, string>;
  };
};
const outcome = async (p: Promise<void>) => {
  try {
    await p;
    return 'ok';
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 429) {
      const d = err.details as { retryAfterSeconds: number; limit: string };
      return `429 ${d.limit} ${d.retryAfterSeconds}s`;
    }
    throw err;
  }
};

describe.each(['memory', 'postgres'] as const)('limit store rules — %s', (kind) => {
  const store = (): LimitStore =>
    kind === 'memory' ? createMemoryLimitStore() : createPostgresLimitStore(database.db);
  let t = Date.UTC(2026, 10, 11, 9);
  const now = () => new Date(t);

  it('account class: requests and actions in one window from the first request', async () => {
    const check = createAccountRateLimiter(
      { requests: 5, actions: 2, windowMs: 60_000 },
      now,
      store(),
    );
    const id = `acct-${kind}`;
    const seen: string[] = [];
    for (const m of ['POST', 'POST', 'POST', 'GET', 'GET', 'GET', 'GET', 'GET']) {
      seen.push(await outcome(check(id, m, reply())));
      t += 1_000;
    }
    expect(seen).toEqual([
      'ok',
      'ok',
      '429 actions 58s',
      'ok',
      'ok',
      'ok',
      '429 requests 54s',
      '429 requests 53s',
    ]);
    t += 53_000; // the window that began with the first request is over
    expect(await outcome(check(id, 'POST', reply()))).toBe('ok');
  });

  it('several windows: counted in all or (refused) none; the longest decides the wait', async () => {
    const check = createSocialWriteLimiter(
      {
        windows: [
          { windowMs: 60_000, max: 2 },
          { windowMs: 10 * 60_000, max: 3 },
        ],
      },
      now,
      undefined,
      store(),
    );
    const id = `social-${kind}`;
    const r = reply();
    expect(await outcome(check(id, r))).toBe('ok');
    expect(await outcome(check(id, r))).toBe('ok');
    expect(await outcome(check(id, r))).toBe('429 social 60s');
    expect(r.headers['retry-after']).toBe('60');
    t += 60_000;
    expect(await outcome(check(id, r))).toBe('ok');
    // The minute has room again, but the ten minutes are full (3): refused, counted in neither.
    expect(await outcome(check(id, r))).toBe('429 social 540s');
    t += 9 * 60_000;
    expect(await outcome(check(id, r))).toBe('ok');
  });

  it('a request a little behind the window start counts in it (out of order across instances)', async () => {
    const s = store();
    const w = [{ windowMs: 60_000, max: 2 }];
    const key = limitKey('order', w, `late-${kind}`);
    expect((await s.hit(key, w, [1], t + 1_000)).refused).toBe(false);
    // Read the clock earlier, arrived later: the same window, not a fresh one.
    expect((await s.hit(key, w, [1], t + 400)).refused).toBe(false);
    expect((await s.hit(key, w, [1], t + 1_200)).refused).toBe(true);
    // A clock set back by more than a window starts a new one.
    expect((await s.hit(key, w, [1], t - 120_000)).refused).toBe(false);
  });

  it('prunes windows that are over (and keeps live ones)', async () => {
    const s = store();
    const w = [{ windowMs: 1_000, max: 1 }];
    await s.hit(limitKey('prune', w, `old-${kind}`), w, [1], t);
    await s.hit(limitKey('prune', w, `live-${kind}`), w, [1], t + 5_000);
    expect(await s.prune(t + 2_000, 60_000)).toBeGreaterThanOrEqual(1);
    const again = await s.hit(limitKey('prune', w, `live-${kind}`), w, [1], t + 5_500);
    expect(again.refused).toBe(true);
  });
});

describe('the PostgreSQL limit store keeps one row per key', () => {
  it('stores starts and counts per window, refused flagged', async () => {
    const s = createPostgresLimitStore(database.db);
    const w = [
      { windowMs: 60_000, max: 1 },
      { windowMs: 3_600_000, max: 5 },
    ];
    const key = limitKey('rows', w, 'acc');
    const t = 1_800_000_000_000;
    expect((await s.hit(key, w, [1, 1], t)).refused).toBe(false);
    expect((await s.hit(key, w, [1, 1], t + 1)).refused).toBe(true);
    const rows = await queryRows<{ starts: unknown; hits: unknown; refused: boolean }>(
      database.db,
      sql`select starts, hits, refused from rate_limit_counters where key = ${key}`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.refused).toBe(true);
    expect((rows[0]!.hits as unknown[]).map(Number)).toEqual([1, 1]);
  });
});

describe('cache invalidation between two apps on one database', () => {
  const flag = 'ashenPassCleared' as const;
  const setFlag = (on: boolean) =>
    withTransaction(database.db, async (tx) => {
      if (on)
        await tx
          .insert(worldFlags)
          .values({ flagId: flag, projectId: null, setAt: new Date() })
          .onConflictDoNothing();
      else await tx.delete(worldFlags).where(eq(worldFlags.flagId, flag));
      await bumpCacheVersion(tx, 'world');
    });
  const until = async (check: () => Promise<boolean>, ms = 5_000) => {
    const end = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > end) return false;
      await new Promise((r) => setTimeout(r, 20));
    }
    return true;
  };
  const make = async (shared: NonNullable<Parameters<typeof buildApp>[0]['shared']>) => {
    const a = buildApp({ database, shared });
    apps.push(a);
    await a.ready();
    return a;
  };

  it('by NOTIFY (no version check, the 60 s TTL never runs out here)', async () => {
    const other = await make({ cachePollMs: 0 });
    await setFlag(false);
    expect(await until(async () => !(await other.worldState.flags())[flag])).toBe(true);
    await setFlag(true);
    expect(await until(async () => (await other.worldState.flags())[flag])).toBe(true);
    expect(await until(async () => other.cacheSync.stats.notified > 0)).toBe(true);
  });

  it('by the version check when the notify is missed', async () => {
    const deaf = await make({ cachePollMs: 50, cacheListen: false });
    await setFlag(false);
    expect(await until(async () => !(await deaf.worldState.flags())[flag])).toBe(true);
    await setFlag(true);
    expect(await until(async () => (await deaf.worldState.flags())[flag])).toBe(true);
    expect(deaf.cacheSync.stats.notified).toBe(0);
    expect(deaf.cacheSync.stats.invalidatedByPoll).toBeGreaterThan(0);
  });

  it('an admin settings save reaches the other instance (T.2)', async () => {
    const other = await make({ cachePollMs: 0 });
    const before = await other.gameSettings.get();
    await withTransaction(database.db, async (tx) => {
      await bumpCacheVersion(tx, 'settings');
    });
    expect(await until(async () => (await other.gameSettings.get()) !== before)).toBe(true);
  });
});

describe('scheduler leader on a single-session database', () => {
  it('always leads (PGlite is one process; there is no second instance to elect)', async () => {
    const leader = new SchedulerLeader(database);
    expect(await leader.lead('settlement')).toBe(true);
    expect(await leader.runOnce('backfills', async () => undefined)).toBe(true);
  });
});
