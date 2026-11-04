import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { accounts, sessions, type Account } from '../db/schema.js';
import type { Executor } from '../db/types.js';

/** 256 random bits, base64url. Lives only in the cookie; the database stores its SHA-256. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sessionIdFor(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface CreatedSession {
  token: string;
  sessionId: string;
  expiresAt: Date;
}

export async function createSession(
  executor: Executor,
  accountId: string,
  now: Date,
  ttlMs: number,
): Promise<CreatedSession> {
  const token = newSessionToken();
  const sessionId = sessionIdFor(token);
  const expiresAt = new Date(now.getTime() + ttlMs);
  await executor.insert(sessions).values({ id: sessionId, accountId, createdAt: now, expiresAt });
  return { token, sessionId, expiresAt };
}

export interface ResolvedSession {
  sessionId: string;
  account: Account;
}

/** The session's account if the token is known, not revoked and not expired at `now`. */
export async function resolveSession(
  executor: Executor,
  token: string,
  now: Date,
): Promise<ResolvedSession | null> {
  const sessionId = sessionIdFor(token);
  const [row] = await executor
    .select({ account: accounts })
    .from(sessions)
    .innerJoin(accounts, eq(accounts.id, sessions.accountId))
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)))
    .limit(1);
  return row ? { sessionId, account: row.account } : null;
}

/** Marks the session revoked. Returns whether an active session was revoked. */
export async function revokeSession(
  executor: Executor,
  sessionId: string,
  now: Date,
): Promise<boolean> {
  const rows = await executor
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return rows.length > 0;
}
