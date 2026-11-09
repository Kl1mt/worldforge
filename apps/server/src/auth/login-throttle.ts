import { createHash } from 'node:crypto';

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
 * In-process memory like the other limits (one API instance, docs/TECH_STACK.md); a restart
 * forgets the counts. Keys are SHA-256 of the lowercased email, so no address is kept in memory.
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

interface Entry {
  failures: number;
  lastFailureAt: number;
  lockedUntil: number;
  /** Ticket 5.8: checks under way (begun, not yet ended). */
  inFlight: number;
}

/** Stale entries are swept once the map holds this many keys. */
const SWEEP_AT = 10_000;

export function throttleKey(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

export interface LoginThrottle {
  /** Milliseconds the key is still locked at `now`, or 0. */
  lockedFor(key: string): number;
  /**
   * Ticket 5.8: asks to check a password for the key. Returns 0 and reserves a check (the caller
   * must `end` it once, whatever the outcome), or the milliseconds to wait: the key is locked, or
   * as many checks are already under way as could still fail before the next lock, so a burst of
   * parallel guesses gets no more checks than the same guesses one after another (the free
   * attempts and the one that starts the lock).
   */
  begin(key: string): number;
  /** Ends a check `begin` reserved (after `fail` or `clear`, or on any error). */
  end(key: string): void;
  /** Counts a failure. Returns the lock it started (ms), or 0 when it started none. */
  fail(key: string): number;
  /** A success or a password reset: the key starts fresh. */
  clear(key: string): void;
}

export function createLoginThrottle(limit: LoginThrottleLimit, now: () => Date): LoginThrottle {
  const entries = new Map<string, Entry>();

  const live = (key: string, t: number): Entry | undefined => {
    const e = entries.get(key);
    if (!e) return undefined;
    if (t - e.lastFailureAt >= limit.resetAfterMs && t >= e.lockedUntil && e.inFlight === 0) {
      entries.delete(key);
      return undefined;
    }
    return e;
  };

  const sweep = (t: number) => {
    for (const key of [...entries.keys()]) live(key, t);
  };

  return {
    lockedFor(key) {
      const t = now().getTime();
      const e = live(key, t);
      return e && e.lockedUntil > t ? e.lockedUntil - t : 0;
    },
    begin(key) {
      const t = now().getTime();
      let e = live(key, t);
      if (e && e.lockedUntil > t) return e.lockedUntil - t;
      if (!e) {
        if (entries.size >= SWEEP_AT) sweep(t);
        e = { failures: 0, lastFailureAt: t, lockedUntil: 0, inFlight: 0 };
        entries.set(key, e);
      }
      // Failures still possible before a lock: the free ones left, and the one that locks.
      const room = Math.max(1, limit.freeAttempts + 1 - e.failures);
      if (e.inFlight >= room) {
        // Not locked yet, but the checks under way may lock it: wait as long as that lock would.
        const over = Math.max(1, e.failures + e.inFlight + 1 - limit.freeAttempts);
        return Math.min(limit.maxLockMs, limit.baseLockMs * 2 ** Math.min(over - 1, 30));
      }
      e.inFlight += 1;
      return 0;
    },
    end(key) {
      const e = entries.get(key);
      if (e && e.inFlight > 0) e.inFlight -= 1;
    },
    fail(key) {
      const t = now().getTime();
      let e = live(key, t);
      if (!e) {
        if (entries.size >= SWEEP_AT) sweep(t);
        e = { failures: 0, lastFailureAt: t, lockedUntil: 0, inFlight: 0 };
        entries.set(key, e);
      }
      e.failures += 1;
      e.lastFailureAt = t;
      const over = e.failures - limit.freeAttempts;
      if (over <= 0) return 0;
      const lockMs = Math.min(limit.maxLockMs, limit.baseLockMs * 2 ** Math.min(over - 1, 30));
      e.lockedUntil = t + lockMs;
      return lockMs;
    },
    clear(key) {
      entries.delete(key);
    },
  };
}

/**
 * A small fixed-window counter per key (ticket 5.7): mails an account may trigger (resend, email
 * change) and reset mails per address. `take` returns the seconds to wait when over, else 0 (and
 * counts the use).
 */
export interface KeyedLimit {
  max: number;
  windowMs: number;
}

export function createKeyedLimiter(limit: KeyedLimit, now: () => Date) {
  const windows = new Map<string, { startedAt: number; used: number }>();
  return function take(key: string): number {
    const t = now().getTime();
    let w = windows.get(key);
    if (!w || t - w.startedAt >= limit.windowMs || t < w.startedAt) {
      if (!w && windows.size >= SWEEP_AT) {
        for (const [k, v] of windows) if (t - v.startedAt >= limit.windowMs) windows.delete(k);
      }
      w = { startedAt: t, used: 0 };
      windows.set(key, w);
    }
    if (w.used >= limit.max) {
      return Math.max(1, Math.ceil((w.startedAt + limit.windowMs - t) / 1000));
    }
    w.used += 1;
    return 0;
  };
}
