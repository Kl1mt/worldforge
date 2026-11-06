import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { blockingSanction, type SocialWriteAction } from '@worldforge/game-core';
import { accounts, type Account } from '../db/schema.js';
import { withTransaction } from '../db/transaction.js';
import type { Transaction, Executor } from '../db/types.js';
import { ApiError } from '../errors.js';
import { activeSanctions, sanctionError } from './sanctions.js';

/**
 * The social-write rate-limit class (ticket 4.1, docs/SOCIAL.md "Social writes"): on top of
 * 3.9's per-account limits, every social write (report, rename; later profile edits, friend
 * requests, guild actions, chat messages) counts against one tighter budget per account, in
 * several fixed windows at once. In-process memory, one API instance (like 3.9's limits).
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

const SWEEP_AT = 10_000;

export function createSocialWriteLimiter(limit: SocialWriteLimit, now: () => Date) {
  const longest = Math.max(...limit.windows.map((w) => w.windowMs));
  const counts = new Map<string, { startedAt: number; used: number }[]>();

  /** Counts one social write; throws `429 rate_limited` (`details.limit: 'social'`) when over. */
  return function check(accountId: string, reply: FastifyReply): void {
    const t = now().getTime();
    let state = counts.get(accountId);
    if (!state) {
      if (counts.size >= SWEEP_AT) {
        for (const [id, s] of counts)
          if (s.every((w) => t - w.startedAt >= longest)) counts.delete(id);
      }
      state = limit.windows.map(() => ({ startedAt: t, used: 0 }));
      counts.set(accountId, state);
    }
    let retryAfterMs = 0;
    limit.windows.forEach((w, i) => {
      const s = state[i]!;
      if (t - s.startedAt >= w.windowMs || t < s.startedAt) {
        s.startedAt = t;
        s.used = 0;
      }
      if (s.used >= w.max) retryAfterMs = Math.max(retryAfterMs, s.startedAt + w.windowMs - t);
    });
    if (retryAfterMs > 0) {
      const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
      void reply.header('retry-after', String(retryAfterSeconds));
      throw new ApiError(
        429,
        'rate_limited',
        `Too many posts and reports. Try again in ${retryAfterSeconds} s.`,
        { retryAfterSeconds, limit: 'social' },
      );
    }
    for (const s of state) s.used += 1;
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Counts one social write for the account (see `createSocialWriteLimiter`). */
    socialWriteLimit: (accountId: string, reply: FastifyReply) => void;
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
  app.socialWriteLimit(accountId, reply);
  const now = app.authNow();
  return withTransaction(app.db, async (tx) => {
    const account = await assertSocialWriteAllowed(tx, accountId, action, now);
    return fn(tx, { account, now });
  });
}
