import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { and, eq, gt, lt } from 'drizzle-orm';
import { idempotencyKeys } from '../db/schema.js';
import type { Transaction } from '../db/types.js';
import { ApiError } from '../errors.js';

/** How long a stored response is replayed (docs/API_CONVENTIONS.md). */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export interface IdempotencyRequest {
  accountId: string;
  key: string;
  requestHash: string;
}

/**
 * Reads and validates the `Idempotency-Key` header and fingerprints the request (method, route
 * with its parameters, body). Throws `400 idempotency_key_required` without a usable key.
 */
export function idempotencyRequest(request: FastifyRequest, accountId: string): IdempotencyRequest {
  const raw = request.headers['idempotency-key'];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    throw new ApiError(
      400,
      'idempotency_key_required',
      'This request needs an Idempotency-Key header (8–128 letters, digits, - or _).',
    );
  }
  const requestHash = createHash('sha256')
    .update(
      `${request.method} ${request.url.split('?')[0]}\n${JSON.stringify(request.body ?? null)}`,
    )
    .digest('hex');
  return { accountId, key, requestHash };
}

export interface IdempotentResult<T> {
  statusCode: number;
  body: T;
  /** True when the stored response of an earlier request with the same key was returned. */
  replayed: boolean;
}

/**
 * Runs `fn` at most once per `(account, key)`: a retry with the same key and request returns the
 * stored response; the same key with another request is `409 idempotency_conflict`. The response is
 * stored in the caller's transaction, so it commits (or rolls back) with the mutation. Errors are
 * not stored: a failed request may be retried with the same key.
 *
 * Call it **after** taking the row lock that serialises the operation (e.g. the character lock):
 * a concurrent request with the same key then waits for that lock and, under READ COMMITTED,
 * sees the first one's committed key row here. The primary key is the last line of defence.
 */
export async function idempotent<T>(
  tx: Transaction,
  req: IdempotencyRequest,
  now: Date,
  fn: () => Promise<{ statusCode: number; body: T }>,
): Promise<IdempotentResult<T>> {
  const cutoff = new Date(now.getTime() - IDEMPOTENCY_TTL_MS);
  const match = and(eq(idempotencyKeys.accountId, req.accountId), eq(idempotencyKeys.key, req.key));
  const [stored] = await tx
    .select()
    .from(idempotencyKeys)
    .where(and(match, gt(idempotencyKeys.createdAt, cutoff)))
    .limit(1);
  if (stored) {
    if (stored.requestHash !== req.requestHash) throw conflict();
    return { statusCode: stored.statusCode, body: stored.response as T, replayed: true };
  }
  await tx.delete(idempotencyKeys).where(and(match, lt(idempotencyKeys.createdAt, cutoff)));

  const result = await fn();
  const inserted = await tx
    .insert(idempotencyKeys)
    .values({
      accountId: req.accountId,
      key: req.key,
      requestHash: req.requestHash,
      statusCode: result.statusCode,
      response: result.body,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ key: idempotencyKeys.key });
  // Another request with this key committed first (not serialised by the caller's lock).
  if (inserted.length === 0) throw conflict();
  return { ...result, replayed: false };
}

const conflict = () =>
  new ApiError(
    409,
    'idempotency_conflict',
    'This Idempotency-Key was already used for a different request.',
  );
