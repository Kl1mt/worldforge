import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { blockingSanction, type SocialWriteAction } from '@worldforge/game-core';
import { accounts, type Account } from '../db/schema.js';
import { withTransaction } from '../db/transaction.js';
import type { Transaction, Executor } from '../db/types.js';
import { ApiError } from '../errors.js';
import { activeSanctions, sanctionError } from './sanctions.js';
import { createMemoryLimitStore, type LimitStore } from '../shared/limit-store.js';
import { createWindowLimiter, rateLimited } from '../shared/limiter.js';

/**
 * The social-write rate-limit class (ticket 4.1, docs/SOCIAL.md "Social writes"): on top of
 * 3.9's per-account limits, every social write (report, rename; later profile edits, friend
 * requests, guild actions, chat messages) counts against one tighter budget per account, in
 * several fixed windows at once. Shared across API instances since ticket 6.9.
 */
export interface SocialWriteLimit {
  windows: { windowMs: number; max: number }[];
}

/** Sized for guild chat (one message every 5 s on average, short bursts). */
export const DEFAULT_SOCIAL_WRITE_LIMIT: SocialWriteLimit = {
  windows: [
    { windowMs: 60_000, max: 12 },
    { windowMs: 60 * 60_000, max: 240 },
  ],
};

/**
 * A per-account limiter over several fixed windows. `limit` names the class in the `429` body
 * (`details.limit`): `social` (4.1) or `trade` (T.4, `createTradeWriteLimiter`). Ticket 6.9: the
 * counts are in the shared limit store, and a write is counted in every window or (refused) none.
 */
export function createSocialWriteLimiter(
  limit: SocialWriteLimit,
  now: () => Date,
  label: { limit: string; message: string } = {
    limit: 'social',
    message: 'Too many posts and reports.',
  },
  store: LimitStore = createMemoryLimitStore(),
) {
  const take = createWindowLimiter(store, label.limit, limit.windows, now);

  /** Counts one social write; throws `429 rate_limited` (`details.limit: 'social'`) when over. */
  return async function check(accountId: string, reply: FastifyReply): Promise<void> {
    const out = await take(accountId);
    if (out.retryAfterMs > 0) rateLimited(reply, out.retryAfterMs, label.limit, label.message);
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Counts one social write for the account (see `createSocialWriteLimiter`). */
    socialWriteLimit: (accountId: string, reply: FastifyReply) => Promise<void>;
    /** The auth clock: sessions, sanctions and social limits use it. */
    authNow: () => Date;
  }
}

/**
 * Inside a transaction: share-locks the account row (a sanction being issued holds it for update,
 * so the two serialise) and throws `403 account_suspended` / `403 muted` if an active sanction
 * blocks this social write. Returns the locked account. For routes that need their own
 * transaction helper (e.g. `idempotentTransaction`); everything else uses `socialWrite`.
 */
export async function assertSocialWriteAllowed(
  tx: Executor,
  accountId: string,
  action: SocialWriteAction,
  now: Date,
): Promise<Account> {
  const [account] = await tx.select().from(accounts).where(eq(accounts.id, accountId)).for('share');
  if (!account) throw new ApiError(401, 'unauthenticated', 'Not logged in.');
  const block = blockingSanction(await activeSanctions(tx, accountId, now), action);
  if (block) throw sanctionError(block);
  return account;
}

/**
 * The one entry point for social writes (docs/SOCIAL.md "Social writes"): counts the request in
 * the social rate-limit class (before any work, so a refused write changes nothing), then runs
 * `fn` in a transaction after `assertSocialWriteAllowed`. Call it from a route behind
 * `app.requireAccount`.
 */
export async function socialWrite<T>(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  action: SocialWriteAction,
  fn: (tx: Transaction, ctx: { account: Account; now: Date }) => Promise<T>,
): Promise<T> {
  const accountId = request.auth!.account.id;
  await app.socialWriteLimit(accountId, reply);
  const now = app.authNow();
  return withTransaction(app.db, async (tx) => {
    const account = await assertSocialWriteAllowed(tx, accountId, action, now);
    return fn(tx, { account, now });
  });
}
