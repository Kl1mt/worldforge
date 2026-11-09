import type { FastifyReply } from 'fastify';
import { createSocialWriteLimiter, type SocialWriteLimit } from '../social/social-write.js';

/**
 * The `trade` rate-limit class (ticket T.4, docs/SOCIAL.md "Social writes" and docs/TRADING.md
 * "Per-account limits"): every trade write (T.5's send, accept, decline, cancel) counts against
 * one budget per account, on top of 3.9's per-account limits and separate from the social class.
 * **20 a minute** (TRADING.md's value). `429 rate_limited`, `details.limit:
 * 'trade'`, `Retry-After`. Refused writes are not counted. In process memory, like the others.
 */
export const DEFAULT_TRADE_WRITE_LIMIT: SocialWriteLimit = {
  windows: [{ windowMs: 60_000, max: 20 }],
};

export function createTradeWriteLimiter(limit: SocialWriteLimit, now: () => Date) {
  return createSocialWriteLimiter(limit, now, {
    limit: 'trade',
    message: 'Too many trade actions.',
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Counts one trade write for the account (ticket T.4, the `trade` class). */
    tradeWriteLimit: (accountId: string, reply: FastifyReply) => void;
  }
}
