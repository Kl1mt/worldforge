import { createHash } from 'node:crypto';
import type { Executor, Transaction } from '../db/types.js';
import {
  createMemoryLimitStore,
  type LimitStore,
  type ThrottleEntry,
} from '../shared/limit-store.js';
import { createWindowLimiter } from '../shared/limiter.js';

/**
 * Per-account login throttling (ticket 5.7, SECURITY.md "Accounts"), on top of the per-IP limit.
 *
 * Keyed by the normalised email the attempt names, whether or not an account has it: an unknown
 * address locks exactly like a known one, so the lock itself reveals nothing (no enumeration).
 * Counts failed logins (and wrong passwords on the email change). The first `freeAttempts`
 * failures are free; each further failure locks the key for `baseLockMs`, doubling up to
 * `maxLockMs`. While locked, attempts are refused without checking the password (and are not
 * counted). After `resetAfterMs` without a failure, or after a successful login or a password
 * reset, the key starts fresh.
 *
 * A guesser spread over many IPs gets about four tries an hour per account once locked at the
 * maximum. The price is that someone can keep a player locked out by guessing on purpose: the
 * password reset is never throttled by this and clears the lock.
 *
 * Ticket 6.9: kept in the shared limit store (`login_throttle` in PostgreSQL), so the lock and the
 * parallel-guess rule hold across API instances. Keys are SHA-256 of the lowercased email, so no
 * address is stored.
 */
export interface LoginThrottleLimit {
  freeAttempts: number;
  baseLockMs: number;
  maxLockMs: number;
  resetAfterMs: number;
}

export const DEFAULT_LOGIN_THROTTLE: LoginThrottleLimit = {
  freeAttempts: 5,
  baseLockMs: 30_000,
  maxLockMs: 15 * 60_000,
  resetAfterMs: 60 * 60_000,
};

/**
 * Ticket 6.9: a check reserved by `begin` counts as under way for this long at most, so an API
 * instance that dies mid-check (the shared store outlives it) frees its reservation.
 */
export const CHECK_LEASE_MS = 60_000;

export function throttleKey(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

export interface LoginThrottle {
  /** Milliseconds the key is still locked at `now`, or 0. `tx` reads inside a transaction. */
  lockedFor(key: string, tx?: Executor): Promise<number>;
  /**
   * Ticket 5.8: asks to check a password for the key. Returns 0 and reserves a check (the caller
   * must `end` it once, whatever the outcome), or the milliseconds to wait: the key is locked, or
   * as many checks are already under way as could still fail before the next lock, so a burst of
   * parallel guesses gets no more checks than the same guesses one after another (the free
   * attempts and the one that starts the lock). Ticket 6.9: across every API instance.
   */
  begin(key: string): Promise<number>;
  /** Ends a check `begin` reserved (after `fail` or `clear`, or on any error). */
  end(key: string): Promise<void>;
  /** Counts a failure. Returns the lock it started (ms), or 0 when it started none. */
  fail(key: string): Promise<number>;
  /** A success or a password reset: the key starts fresh. `tx` clears inside a transaction. */
  clear(key: string, tx?: Transaction): Promise<void>;
}

/**
 * The rules as pure steps on one entry (ticket 6.9), so the memory and PostgreSQL stores apply
 * exactly the same ones (the PostgreSQL store runs each step under the key's row lock).
 */
export function createLoginThrottle(
  limit: LoginThrottleLimit,
  now: () => Date,
  store: LimitStore = createMemoryLimitStore(),
): LoginThrottle {
  const inFlightAt = (e: ThrottleEntry, t: number) => (e.inFlightUntil > t ? e.inFlight : 0);
  /** The entry, or null once it has nothing to remember (reset time over, unlocked, no checks). */
  const live = (e: ThrottleEntry | null, t: number): ThrottleEntry | null => {
    if (!e) return null;
    if (t - e.lastFailureAt >= limit.resetAfterMs && t >= e.lockedUntil && inFlightAt(e, t) === 0)
      return null;
    return { ...e, inFlight: inFlightAt(e, t) };
  };
  const fresh = (t: number): ThrottleEntry => ({
    failures: 0,
    lastFailureAt: t,
    lockedUntil: 0,
    inFlight: 0,
    inFlightUntil: 0,
  });
  const lockFor = (over: number) =>
    Math.min(limit.maxLockMs, limit.baseLockMs * 2 ** Math.min(over - 1, 30));

  return {
    async lockedFor(key, tx) {
      const t = now().getTime();
      const e = live(await store.readThrottle(key, tx), t);
      return e && e.lockedUntil > t ? e.lockedUntil - t : 0;
    },
    begin(key) {
      const t = now().getTime();
      return store.updateThrottle(key, (stored) => {
        const e = live(stored, t) ?? fresh(t);
        if (e.lockedUntil > t) return { next: e, result: e.lockedUntil - t };
        // Failures still possible before a lock: the free ones left, and the one that locks.
        const room = Math.max(1, limit.freeAttempts + 1 - e.failures);
        if (e.inFlight >= room) {
          // Not locked yet, but the checks under way may lock it: wait as long as that lock would.
          const over = Math.max(1, e.failures + e.inFlight + 1 - limit.freeAttempts);
          return { next: e, result: lockFor(over) };
        }
        return {
          next: { ...e, inFlight: e.inFlight + 1, inFlightUntil: t + CHECK_LEASE_MS },
          result: 0,
        };
      });
    },
    async end(key) {
      const t = now().getTime();
      await store.updateThrottle(key, (stored) => {
        if (!stored) return { next: null, result: undefined };
        const inFlight = Math.max(0, inFlightAt(stored, t) - 1);
        return { next: live({ ...stored, inFlight }, t), result: undefined };
      });
    },
    fail(key) {
      const t = now().getTime();
      return store.updateThrottle(key, (stored) => {
        const e = live(stored, t) ?? fresh(t);
        const failures = e.failures + 1;
        const over = failures - limit.freeAttempts;
        const lockMs = over <= 0 ? 0 : lockFor(over);
        return {
          next: {
            ...e,
            failures,
            lastFailureAt: t,
            lockedUntil: lockMs > 0 ? t + lockMs : e.lockedUntil,
          },
          result: lockMs,
        };
      });
    },
    async clear(key, tx) {
      await store.updateThrottle(key, () => ({ next: null, result: undefined }), tx);
    },
  };
}

/**
 * A small fixed-window counter per key (ticket 5.7): mails an account may trigger (resend, email
 * change) and reset mails per address. `take` returns the seconds to wait when over, else 0 (and
 * counts the use). Ticket 6.9: in the shared limit store.
 */
export interface KeyedLimit {
  max: number;
  windowMs: number;
}

export function createKeyedLimiter(
  limit: KeyedLimit,
  now: () => Date,
  store: LimitStore = createMemoryLimitStore(),
  cls = 'mail',
) {
  const take = createWindowLimiter(store, cls, [limit], now);
  return async function (key: string): Promise<number> {
    const out = await take(key);
    return out.retryAfterMs > 0 ? Math.max(1, Math.ceil(out.retryAfterMs / 1000)) : 0;
  };
}
