import type { FastifyReply } from 'fastify';
import { ApiError } from '../errors.js';

/**
 * Per-account rate limits on the game routes (ticket 3.9, docs/API_CONVENTIONS.md "Rate limits").
 *
 * Every route behind `app.requireAccount` counts against the account of the session, so a player
 * cannot spread load over several characters, tabs or IP addresses. Two fixed windows per account:
 * one for all requests, a smaller one for actions (any method but GET/HEAD). Rewards never depend
 * on how often the client calls (Phase 1/2 invariance rules); these limits bound the database time
 * one account can cost, before trading and leaderboards arrive.
 *
 * In-process memory, like the login limits: correct for the single API instance assumed in
 * docs/TECH_STACK.md. A multi-instance deployment needs a shared store (Redis or Postgres).
 */
export interface AccountRateLimit {
  /** Requests per window, any method. */
  requests: number;
  /** Actions (POST, PUT, PATCH, DELETE) per window. */
  actions: number;
  windowMs: number;
}

/**
 * Generous for normal play: each open tab polls with POSTs (farming settle every 8 s, the crypt run
 * every 2 s), and a busy player clicks about one action a second; bulk sell and salvage take up to
 * 100 items in one request. Three tabs of that still fit. The playtest servers and the browser e2e
 * runs stay far below them (ticket 3.9).
 */
export const DEFAULT_ACCOUNT_RATE_LIMIT: AccountRateLimit = {
  requests: 900,
  actions: 300,
  windowMs: 60_000,
};

interface Window {
  startedAt: number;
  requests: number;
  actions: number;
}

const READ_METHODS = new Set(['GET', 'HEAD']);
/** Stale windows are swept once the map holds this many accounts. */
const SWEEP_AT = 10_000;

export function createAccountRateLimiter(limit: AccountRateLimit, now: () => Date) {
  const windows = new Map<string, Window>();

  const sweep = (t: number) => {
    for (const [id, w] of windows) if (t - w.startedAt >= limit.windowMs) windows.delete(id);
  };

  /** Counts one request; throws `429 rate_limited` (and sets `Retry-After`) over either limit. */
  return function check(accountId: string, method: string, reply: FastifyReply): void {
    const t = now().getTime();
    let w = windows.get(accountId);
    if (!w || t - w.startedAt >= limit.windowMs || t < w.startedAt) {
      if (!w && windows.size >= SWEEP_AT) sweep(t);
      w = { startedAt: t, requests: 0, actions: 0 };
      windows.set(accountId, w);
    }
    const action = !READ_METHODS.has(method.toUpperCase());
    // A refused request is not counted, so a client that waits `Retry-After` gets through.
    if (w.requests >= limit.requests || (action && w.actions >= limit.actions)) {
      const retryAfterSeconds = Math.max(1, Math.ceil((w.startedAt + limit.windowMs - t) / 1000));
      void reply.header('retry-after', String(retryAfterSeconds));
      throw new ApiError(
        429,
        'rate_limited',
        `Too many requests. Try again in ${retryAfterSeconds} s.`,
        { retryAfterSeconds, limit: action && w.actions >= limit.actions ? 'actions' : 'requests' },
      );
    }
    w.requests += 1;
    if (action) w.actions += 1;
  };
}
