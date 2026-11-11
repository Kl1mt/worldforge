import { createHash } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { sql } from 'drizzle-orm';
import { ApiError } from '../errors.js';
import { queryRows } from '../db/query.js';
import type { Database } from '../db/types.js';
import { limitKey, type LimitStore, type WindowSpec } from './limit-store.js';

/** The outcome of one counted request: 0 when allowed, else the wait and the windows that are full. */
export interface LimitOutcome {
  retryAfterMs: number;
  /** Indexes of the windows that refused (empty when allowed). */
  full: number[];
}

/**
 * A fixed-window limiter of one class over the shared store (ticket 6.9): `take(id, inc)` counts
 * one request for `id` (an account, an address hash) in each window with `inc[i] > 0`.
 */
export function createWindowLimiter(
  store: LimitStore,
  cls: string,
  windows: readonly WindowSpec[],
  now: () => Date,
) {
  const all = windows.map(() => 1);
  return async function take(id: string, inc: readonly number[] = all): Promise<LimitOutcome> {
    const t = now().getTime();
    const r = await store.hit(limitKey(cls, windows, id), windows, inc, t);
    if (!r.refused) return { retryAfterMs: 0, full: [] };
    const full = windows.flatMap((w, i) =>
      inc[i]! > 0 && r.hits[i]! + inc[i]! > w.max ? [i] : [],
    );
    // At most a window (a request a little behind the window's start, ticket 6.9).
    const retryAfterMs = Math.max(
      1,
      ...full.map((i) => Math.min(windows[i]!.windowMs, r.starts[i]! + windows[i]!.windowMs - t)),
    );
    return { retryAfterMs, full };
  };
}

/** Sets `Retry-After` and throws the `429 rate_limited` every limiter answers with. */
export function rateLimited(
  reply: FastifyReply,
  retryAfterMs: number,
  limit: string,
  message: string,
): never {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  void reply.header('retry-after', String(retryAfterSeconds));
  throw new ApiError(429, 'rate_limited', `${message} Try again in ${retryAfterSeconds} s.`, {
    retryAfterSeconds,
    limit,
  });
}

/** The plugin's key (the client address) as stored: a hash, never the address. */
const ipKey = (key: string) => createHash('sha256').update(`ip:${key}`).digest('hex').slice(0, 32);

type IncrCallback = (err: Error | null, res?: { current: number; ttl: number }) => void;
const NO_MAX = 2 ** 31 - 1;

/**
 * A `@fastify/rate-limit` store over the shared limit store, for the per-IP auth limits (login,
 * register, forgot password, tokens). Counts every request, refused or not, like the plugin's own
 * memory store, on the real clock (as the plugin does); one key per route and client address.
 * The address is stored only as a SHA-256 (no IP address in the database or its backups), and the
 * row goes with the pruning once its window is over.
 */
export function fastifyRateLimitStore(store: LimitStore, db: Database) {
  class SharedRateLimitStore {
    private readonly route: string;
    /** The plugin calls `new Store(globalParams)`; `child` passes the route. */
    constructor(route?: unknown) {
      this.route = typeof route === 'string' ? route : '';
    }

    incr(key: string, cb: IncrCallback, timeWindow: number): void {
      const windows = [{ windowMs: timeWindow, max: NO_MAX }];
      key = ipKey(key);
      const t = Date.now();
      store
        .hit(limitKey(`ip:${this.route}`, windows, key), windows, [1], t)
        .then((r) =>
          cb(null, { current: r.hits[0]!, ttl: Math.max(0, r.starts[0]! + timeWindow - t) }),
        )
        .catch((err: Error) => cb(err));
    }

    read(key: string, cb: IncrCallback, timeWindow: number): void {
      const windows = [{ windowMs: timeWindow, max: NO_MAX }];
      key = ipKey(key);
      const k = limitKey(`ip:${this.route}`, windows, key);
      const t = Date.now();
      if (store.kind === 'memory') {
        // Only the plugin's `{ increment: false }` reads; the routes here never use it.
        cb(null, { current: 0, ttl: 0 });
        return;
      }
      queryRows<{ starts: number[]; hits: number[] }>(
        db,
        sql`select starts, hits from rate_limit_counters where key = ${k}`,
      )
        .then(([row]) => {
          const s = row ? Number(row.starts[0]) : 0;
          if (!row || t - s >= timeWindow) return cb(null, { current: 0, ttl: 0 });
          cb(null, { current: Number(row.hits[0]), ttl: s + timeWindow - t });
        })
        .catch((err: Error) => cb(err));
    }

    child(routeOptions: { routeInfo?: { method?: string | string[]; url?: string } }) {
      const info = routeOptions.routeInfo ?? {};
      const method = Array.isArray(info.method) ? info.method.join(',') : (info.method ?? '');
      const max = (routeOptions as { max?: unknown }).max;
      return new SharedRateLimitStore(
        `${method} ${info.url ?? ''}${typeof max === 'number' ? ` max ${max}` : ''}`.trim(),
      );
    }
  }
  return SharedRateLimitStore;
}
