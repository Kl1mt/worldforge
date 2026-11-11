import { eq, sql } from 'drizzle-orm';
import { loginThrottle } from '../db/schema.js';
import { queryRows } from '../db/query.js';
import { withTransaction } from '../db/transaction.js';
import type { Database, Executor, Transaction } from '../db/types.js';

/**
 * The rate-limit store (ticket 6.9, docs/DEPLOY.md "Running two API instances"). Every limiter in
 * the server (3.9's account class, the social, trade, board-read, reconcile and mail classes, the
 * per-IP auth limits and 5.7's per-address login lock) keeps its counts here, so the limits hold
 * across API instances. Two implementations with the same rules:
 *
 * - `postgres` (production default, `SHARED_STATE=postgres`): the `rate_limit_counters` and
 *   `login_throttle` tables. A counter hit is one statement (`insert … on conflict … do update …
 *   returning`), atomic under the row lock, so parallel requests on several instances count
 *   exactly like sequential ones.
 * - `memory` (`SHARED_STATE=memory`, tests and tools): a `Map` in the process, for one instance.
 *
 * **Fixed windows** start at a key's first counted request and end `windowMs` later (as before
 * 6.9). A class may have several windows (social: a minute and an hour); a request is allowed only
 * if every window it counts in has room, and **a refused request is counted in none**. Times are
 * milliseconds on the caller's injected clock, never the database's `now()`.
 */
export interface WindowSpec {
  windowMs: number;
  max: number;
}

export interface HitResult {
  refused: boolean;
  /** Per window: when it started (ms) and how many requests it holds after this one. */
  starts: number[];
  hits: number[];
}

/** 5.7's per-address login state (see `auth/login-throttle.ts` for the rules). */
export interface ThrottleEntry {
  failures: number;
  lastFailureAt: number;
  lockedUntil: number;
  inFlight: number;
  inFlightUntil: number;
}

export type ThrottleStep<T> = (entry: ThrottleEntry | null) => {
  next: ThrottleEntry | null;
  result: T;
};

export interface LimitStore {
  readonly kind: 'memory' | 'postgres';
  /**
   * Counts one request against `windows` (`inc[i]` per window: 0 means the window is neither
   * counted nor checked). Refused when a counted window would pass its `max`.
   */
  hit(
    key: string,
    windows: readonly WindowSpec[],
    inc: readonly number[],
    t: number,
  ): Promise<HitResult>;
  /** Reads a login entry without changing it. */
  readThrottle(key: string, tx?: Executor): Promise<ThrottleEntry | null>;
  /** Applies `step` to a login entry atomically (row lock in PostgreSQL); `next: null` deletes. */
  updateThrottle<T>(key: string, step: ThrottleStep<T>, tx?: Transaction): Promise<T>;
  /** Deletes expired counters and login entries idle for `throttleIdleMs`. Returns rows removed. */
  prune(t: number, throttleIdleMs: number): Promise<number>;
}

/**
 * Whether a window started at `s` is over at `t`, or the clock went back by more than a window.
 * A request whose `t` is a little before `s` belongs to the window: with several instances,
 * requests reach the store slightly out of clock order (one read the clock first, the other
 * wrote first), and must not start a new window (ticket 6.9, found by the two-instance test).
 */
const isFresh = (t: number, s: number, windowMs: number) => t - s >= windowMs || s - t > windowMs;

/** A limiter key with the class's windows in it, so a class with other windows never shares rows. */
export function limitKey(cls: string, windows: readonly WindowSpec[], id: string): string {
  return `${cls}|${windows.map((w) => `${w.windowMs}x${w.max}`).join(',')}|${id}`;
}

const isThrottleIdle = (e: ThrottleEntry, t: number, idleMs: number) =>
  t - e.lastFailureAt >= idleMs && t >= e.lockedUntil && t >= e.inFlightUntil;

/** Stale counters are swept once the memory map holds this many keys (as before 6.9). */
const SWEEP_AT = 10_000;

export function createMemoryLimitStore(): LimitStore {
  const counters = new Map<string, { starts: number[]; hits: number[]; expiresAt: number }>();
  const throttles = new Map<string, ThrottleEntry>();
  return {
    kind: 'memory',
    async hit(key, windows, inc, t) {
      let row = counters.get(key);
      if (!row) {
        if (counters.size >= SWEEP_AT)
          for (const [k, r] of counters) if (r.expiresAt <= t) counters.delete(k);
        row = { starts: windows.map(() => t), hits: windows.map(() => 0), expiresAt: 0 };
        counters.set(key, row);
      }
      const fresh = windows.map((w, i) => isFresh(t, row.starts[i]!, w.windowMs));
      const base = row.hits.map((h, i) => (fresh[i] ? 0 : h));
      const ok = windows.every((w, i) => inc[i] === 0 || base[i]! + inc[i]! <= w.max);
      row.starts = row.starts.map((s, i) => (fresh[i] ? t : s));
      row.hits = base.map((h, i) => h + (ok ? inc[i]! : 0));
      row.expiresAt = Math.max(...windows.map((w, i) => row.starts[i]! + w.windowMs));
      return { refused: !ok, starts: [...row.starts], hits: [...row.hits] };
    },
    async readThrottle(key) {
      const e = throttles.get(key);
      return e ? { ...e } : null;
    },
    async updateThrottle(key, step) {
      const e = throttles.get(key);
      const { next, result } = step(e ? { ...e } : null);
      if (next) {
        if (!e && throttles.size >= SWEEP_AT) {
          // Same idle rule as `prune`, with the reset time unknown here: drop only unlocked,
          // check-free entries older than an hour (5.7's default reset).
          const t = next.lastFailureAt;
          for (const [k, v] of throttles)
            if (isThrottleIdle(v, t, 60 * 60_000)) throttles.delete(k);
        }
        throttles.set(key, next);
      } else throttles.delete(key);
      return result;
    },
    async prune(t, throttleIdleMs) {
      let n = 0;
      for (const [k, r] of counters) if (r.expiresAt <= t && counters.delete(k)) n++;
      for (const [k, e] of throttles)
        if (isThrottleIdle(e, t, throttleIdleMs) && throttles.delete(k)) n++;
      return n;
    },
  };
}

const bigintArray = (xs: readonly number[]) => `{${xs.map((x) => Math.trunc(x)).join(',')}}`;
const toNumbers = (xs: unknown): number[] => {
  if (Array.isArray(xs)) return xs.map(Number);
  // A driver that hands back the array literal ("{1,2}").
  return String(xs).replace(/[{}]/g, '').split(',').filter(Boolean).map(Number);
};

/**
 * The PostgreSQL store. `hit` is a single statement: the first request of a key inserts its row;
 * every later one updates it under the row lock, resetting windows that are over, then counting in
 * all of them or (refused) in none. `refused` is written with the row so `returning` reports it.
 */
export function createPostgresLimitStore(db: Database): LimitStore {
  return {
    kind: 'postgres',
    async hit(key, windows, inc, t) {
      const w = bigintArray(windows.map((x) => x.windowMs));
      const m = bigintArray(windows.map((x) => x.max));
      const i = bigintArray(inc);
      const [row] = await queryRows<{ starts: unknown; hits: unknown; refused: boolean }>(
        db,
        sql`
          insert into rate_limit_counters as c (key, starts, hits, expires_at, refused)
          select ${key},
            array_fill(${t}::bigint, array[cardinality(${w}::bigint[])]),
            (select array_agg(case when x.inc <= x.m then x.inc else 0 end order by x.i)
               from unnest(${m}::int[], ${i}::int[]) with ordinality as x(m, inc, i)),
            ${t}::bigint + (select max(x) from unnest(${w}::bigint[]) as x),
            not (select bool_and(x.inc = 0 or x.inc <= x.m)
                   from unnest(${m}::int[], ${i}::int[]) as x(m, inc))
          on conflict (key) do update set (starts, hits, expires_at, refused) = (
            select array_agg(case when u.fresh then ${t}::bigint else u.s end order by u.i),
                   array_agg((case when u.fresh then 0 else u.h end)
                     + (case when u.ok then u.inc else 0 end) order by u.i),
                   max((case when u.fresh then ${t}::bigint else u.s end) + u.w),
                   not bool_and(u.ok)
            from (
              select x.s, x.h, x.w, x.inc, x.i, (${t}::bigint - x.s >= x.w or x.s - ${t}::bigint > x.w) as fresh,
                bool_and(x.inc = 0 or (case when ${t}::bigint - x.s >= x.w or x.s - ${t}::bigint > x.w
                  then 0 else x.h end) + x.inc <= x.m) over () as ok
              from unnest(c.starts, c.hits, ${w}::bigint[], ${m}::int[], ${i}::int[])
                with ordinality as x(s, h, w, m, inc, i)
            ) u
          )
          returning starts, hits, refused`,
      );
      return { refused: row!.refused, starts: toNumbers(row!.starts), hits: toNumbers(row!.hits) };
    },
    async readThrottle(key, tx) {
      const [row] = await (tx ?? db).select().from(loginThrottle).where(eq(loginThrottle.key, key));
      return row ? entryOf(row) : null;
    },
    async updateThrottle(key, step, tx) {
      const run = async (x: Transaction) => {
        const [row] = await x
          .select()
          .from(loginThrottle)
          .where(eq(loginThrottle.key, key))
          .for('update');
        let current = row ? entryOf(row) : null;
        if (!row) {
          // The first check of a key: two instances may start it at once; one insert wins and the
          // other waits for its row lock, then reads it.
          const inserted = await x
            .insert(loginThrottle)
            .values({ key, lastFailureAt: 0 })
            .onConflictDoNothing()
            .returning({ key: loginThrottle.key });
          const [locked] = await x
            .select()
            .from(loginThrottle)
            .where(eq(loginThrottle.key, key))
            .for('update');
          current = inserted.length > 0 || !locked ? null : entryOf(locked);
        }
        const { next, result } = step(current);
        if (next) {
          const values = {
            failures: next.failures,
            lastFailureAt: Math.trunc(next.lastFailureAt),
            lockedUntil: Math.trunc(next.lockedUntil),
            inFlight: next.inFlight,
            inFlightUntil: Math.trunc(next.inFlightUntil),
          };
          await x
            .insert(loginThrottle)
            .values({ key, ...values })
            .onConflictDoUpdate({ target: loginThrottle.key, set: values });
        } else {
          await x.delete(loginThrottle).where(eq(loginThrottle.key, key));
        }
        return result;
      };
      return tx ? run(tx) : withTransaction(db, run);
    },
    async prune(t, throttleIdleMs) {
      const a = await queryRows<{ n: number }>(
        db,
        sql`with d as (delete from rate_limit_counters where expires_at <= ${t}::bigint returning 1)
            select count(*)::int as n from d`,
      );
      const b = await queryRows<{ n: number }>(
        db,
        sql`with d as (delete from login_throttle
              where ${t}::bigint - last_failure_at >= ${throttleIdleMs}::bigint
                and locked_until <= ${t}::bigint and in_flight_until <= ${t}::bigint
              returning 1)
            select count(*)::int as n from d`,
      );
      return Number(a[0]?.n ?? 0) + Number(b[0]?.n ?? 0);
    },
  };
}

function entryOf(row: typeof loginThrottle.$inferSelect): ThrottleEntry {
  return {
    failures: row.failures,
    lastFailureAt: Number(row.lastFailureAt),
    lockedUntil: Number(row.lockedUntil),
    inFlight: row.inFlight,
    inFlightUntil: Number(row.inFlightUntil),
  };
}

/**
 * Makes the limiter tables `UNLOGGED` (no WAL: each counted request is a cheap write; the price is
 * that a database crash empties them, which forgets the counts as an API restart did before 6.9,
 * and that they are not replicated: there is no replica). Run by `db:migrate` after the
 * migrations; a no-op when already unlogged.
 */
export async function makeLimiterTablesUnlogged(db: Database): Promise<string[]> {
  const changed: string[] = [];
  for (const table of ['rate_limit_counters', 'login_throttle']) {
    const [row] = await queryRows<{ p: string }>(
      db,
      sql`select relpersistence as p from pg_class where oid = to_regclass(${table})`,
    );
    if (row && row.p === 'p') {
      await db.execute(sql.raw(`alter table ${table} set unlogged`));
      changed.push(table);
    }
  }
  return changed;
}
