import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import {
  accountTokens,
  accounts,
  sessions,
  type Account,
  type AccountToken,
  type AccountTokenPurpose,
} from '../db/schema.js';
import type { Executor } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';

/**
 * Mailed account tokens (ticket 5.7, SECURITY.md "Accounts"): email verification and password
 * reset. 256 random bits, base64url, only ever in the mail; the database keeps the SHA-256.
 *
 * - **Short-lived:** a verification link lasts 24 hours, a reset link 30 minutes.
 * - **Single use:** consuming is a conditional update (`used_at is null and expires_at > now`), so of
 *   two requests racing with one token exactly one wins, on any isolation level.
 * - **Latest wins:** issuing a token withdraws the account's older unused tokens of that purpose; a
 *   reset or an email change withdraws every outstanding token.
 * - **Tied to the address:** a token only works while the account still has the email it was sent to.
 */
export const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

export const TOKEN_TTL_MS: Record<AccountTokenPurpose, number> = {
  verify_email: VERIFY_TOKEN_TTL_MS,
  reset_password: RESET_TOKEN_TTL_MS,
};

/** Token shape on the wire: 43 base64url characters (32 bytes). */
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Withdraws the account's unused tokens of these purposes. Returns how many. */
export async function withdrawTokens(
  executor: Executor,
  accountId: string,
  purposes: readonly AccountTokenPurpose[],
  now: Date,
): Promise<number> {
  const rows = await executor
    .update(accountTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(accountTokens.accountId, accountId),
        inArray(accountTokens.purpose, [...purposes]),
        isNull(accountTokens.usedAt),
      ),
    )
    .returning({ id: accountTokens.id });
  return rows.length;
}

/**
 * A new token for the account's current address (pass the transaction that also writes the audit
 * row). Withdraws the older ones of the same purpose first.
 */
export async function issueToken(
  executor: Executor,
  account: Pick<Account, 'id' | 'email'>,
  purpose: AccountTokenPurpose,
  now: Date,
): Promise<{ token: string; expiresAt: Date }> {
  await withdrawTokens(executor, account.id, [purpose], now);
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS[purpose]);
  await executor.insert(accountTokens).values({
    id: uuidv7(),
    accountId: account.id,
    purpose,
    tokenHash: tokenHash(token),
    email: account.email,
    createdAt: now,
    expiresAt,
  });
  return { token, expiresAt };
}

export type TokenCheck =
  { status: 'ok'; row: AccountToken } | { status: 'invalid' } | { status: 'expired' };

/**
 * What a token would do at `now`, without using it: `invalid` (unknown, used, withdrawn, wrong
 * purpose, or the account's email changed since) or `expired`. A cheap early answer before slow
 * work; `consumeToken` is the guard.
 */
export async function checkToken(
  executor: Executor,
  purpose: AccountTokenPurpose,
  token: string,
  now: Date,
): Promise<TokenCheck> {
  if (!TOKEN_RE.test(token)) return { status: 'invalid' };
  const [found] = await executor
    .select({ token: accountTokens, email: accounts.email })
    .from(accountTokens)
    .innerJoin(accounts, eq(accounts.id, accountTokens.accountId))
    .where(and(eq(accountTokens.tokenHash, tokenHash(token)), eq(accountTokens.purpose, purpose)))
    .limit(1);
  if (!found || found.token.usedAt !== null) return { status: 'invalid' };
  if (found.email.toLowerCase() !== found.token.email.toLowerCase()) return { status: 'invalid' };
  if (found.token.expiresAt.getTime() <= now.getTime()) return { status: 'expired' };
  return { status: 'ok', row: found.token };
}

/**
 * Uses a token inside the caller's transaction: locks the account row (so a reset and an email
 * change, or two resets with different tokens, are serialised), re-checks the address, then marks
 * the token used with a conditional update. Exactly one of any number of racing requests gets
 * `ok`; the rest get `invalid` (or `expired`).
 */
export async function consumeToken(
  tx: Executor,
  purpose: AccountTokenPurpose,
  token: string,
  now: Date,
): Promise<
  { status: 'ok'; row: AccountToken; account: Account } | { status: 'invalid' | 'expired' }
> {
  const check = await checkToken(tx, purpose, token, now);
  if (check.status !== 'ok') return check;
  const [account] = await tx
    .select()
    .from(accounts)
    .where(eq(accounts.id, check.row.accountId))
    .for('update');
  if (!account || account.email.toLowerCase() !== check.row.email.toLowerCase()) {
    return { status: 'invalid' };
  }
  const [used] = await tx
    .update(accountTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(accountTokens.id, check.row.id),
        isNull(accountTokens.usedAt),
        gt(accountTokens.expiresAt, now),
      ),
    )
    .returning();
  if (!used) return { status: 'invalid' };
  return { status: 'ok', row: used, account };
}

/** Whether the account has a live (unused, unexpired) token of this purpose. */
export async function hasLiveToken(
  executor: Executor,
  accountId: string,
  purpose: AccountTokenPurpose,
  now: Date,
): Promise<boolean> {
  const [row] = await executor
    .select({ id: accountTokens.id })
    .from(accountTokens)
    .where(
      and(
        eq(accountTokens.accountId, accountId),
        eq(accountTokens.purpose, purpose),
        isNull(accountTokens.usedAt),
        gt(accountTokens.expiresAt, now),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Ticket 5.7, for trading (T.4, docs/TRADING.md): whether the account's current email is
 * verified. False for an unknown account. Every account from before 5.7 is unverified until it
 * verifies; changing the email makes it unverified again.
 */
export async function isEmailVerified(executor: Executor, accountId: string): Promise<boolean> {
  const [row] = await executor
    .select({ at: accounts.emailVerifiedAt })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  return row?.at != null;
}

/** Revoked sessions are kept this long (audit context) before pruning; expired ones go at once. */
export const REVOKED_SESSION_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 5_000;

/**
 * Ticket 5.7: removes expired sessions, sessions revoked more than a week ago and expired tokens
 * (in batches, so one run never holds long locks). Run hourly by the scheduler on the real clock.
 */
export async function pruneAuthRows(
  executor: Executor,
  now: Date,
): Promise<{ sessions: number; tokens: number }> {
  const revokedBefore = new Date(now.getTime() - REVOKED_SESSION_KEEP_MS);
  const deadSessions = await executor
    .delete(sessions)
    .where(
      inArray(
        sessions.id,
        executor
          .select({ id: sessions.id })
          .from(sessions)
          .where(or(lte(sessions.expiresAt, now), lte(sessions.revokedAt, revokedBefore)))
          .limit(PRUNE_BATCH),
      ),
    )
    .returning({ id: sessions.id });
  const deadTokens = await executor
    .delete(accountTokens)
    .where(
      inArray(
        accountTokens.id,
        executor
          .select({ id: accountTokens.id })
          .from(accountTokens)
          .where(lte(accountTokens.expiresAt, now))
          .limit(PRUNE_BATCH),
      ),
    )
    .returning({ id: accountTokens.id });
  return { sessions: deadSessions.length, tokens: deadTokens.length };
}

/** Revokes every live session of the account except `keep`. Returns how many. */
export async function revokeSessions(
  executor: Executor,
  accountId: string,
  now: Date,
  keep: string | null = null,
): Promise<number> {
  const rows = await executor
    .update(sessions)
    .set({ revokedAt: now })
    .where(
      and(
        eq(sessions.accountId, accountId),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
        ...(keep === null ? [] : [sql`${sessions.id} <> ${keep}`]),
      ),
    )
    .returning({ id: sessions.id });
  return rows.length;
}

/** Live sessions of the account other than `current`. */
export async function countOtherSessions(
  executor: Executor,
  accountId: string,
  current: string,
  now: Date,
): Promise<number> {
  const [row] = await executor
    .select({ n: sql<number>`count(*)::int` })
    .from(sessions)
    .where(
      and(
        eq(sessions.accountId, accountId),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
        sql`${sessions.id} <> ${current}`,
      ),
    );
  return row?.n ?? 0;
}
