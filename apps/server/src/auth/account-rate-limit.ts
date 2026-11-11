import type { FastifyReply } from 'fastify';
import { ApiError } from '../errors.js';
import { createMemoryLimitStore, type LimitStore } from '../shared/limit-store.js';
import { createWindowLimiter } from '../shared/limiter.js';

/**
 * Per-account rate limits on the game routes (ticket 3.9, docs/API_CONVENTIONS.md "Rate limits").
 *
 * Every route behind `app.requireAccount` counts against the account of the session, so a player
 * cannot spread load over several characters, tabs or IP addresses. Two fixed windows per account:
 * one for all requests, a smaller one for actions (any method but GET/HEAD). Rewards never depend
 * on how often the client calls (Phase 1/2 invariance rules); these limits bound the database time
 * one account can cost, before trading and leaderboards arrive.
 *
 * Since ticket 6.9 the counts are in the shared limit store (PostgreSQL in production), so they
 * hold across API instances.
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

const READ_METHODS = new Set(['GET', 'HEAD']);

/**
 * Ticket 6.9: the counts live in the shared limit store (`shared/limit-store.ts`), so the limits
 * hold across API instances: two windows of the same length per account, `requests` counting every
 * request and `actions` only the actions; both start at the account's first request.
 */
export function createAccountRateLimiter(
  limit: AccountRateLimit,
  now: () => Date,
  store: LimitStore = createMemoryLimitStore(),
) {
  const take = createWindowLimiter(
    store,
    'account',
    [
      { windowMs: limit.windowMs, max: limit.requests },
      { windowMs: limit.windowMs, max: limit.actions },
    ],
    now,
  );

  /** Counts one request; throws `429 rate_limited` (and sets `Retry-After`) over either limit. */
  return async function check(
    accountId: string,
    method: string,
    reply: FastifyReply,
  ): Promise<void> {
    const action = !READ_METHODS.has(method.toUpperCase());
    // A refused request is not counted, so a client that waits `Retry-After` gets through.
    const out = await take(accountId, [1, action ? 1 : 0]);
    if (out.retryAfterMs === 0) return;
    const retryAfterSeconds = Math.max(1, Math.ceil(out.retryAfterMs / 1000));
    void reply.header('retry-after', String(retryAfterSeconds));
    throw new ApiError(
      429,
      'rate_limited',
      `Too many requests. Try again in ${retryAfterSeconds} s.`,
      { retryAfterSeconds, limit: out.full.includes(1) ? 'actions' : 'requests' },
    );
  };
}
