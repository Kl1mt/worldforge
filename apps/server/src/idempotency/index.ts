import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { idempotencyKeys } from '../db/schema.js';
import type { Transaction } from '../db/types.js';
import { ApiError } from '../errors.js';

/**
 * `Idempotency-Key` support (docs/API_CONVENTIONS.md, ticket 2.4). Endpoints that grant or move
 * value and are not repeat-safe by state require the header. The key is claimed inside the
 * mutation's transaction, so the stored response commits (or rolls back) together with the change.
 */
export const IDEMPOTENCY_HEADER = 'idempotency-key';
/** How long a stored response is replayed. Older keys may be reused for a new request. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/** Reads and validates the header: `400 idempotency_key_required` / `idempotency_key_invalid`. */
export function readIdempotencyKey(request: FastifyRequest): string {
  const raw = request.headers[IDEMPOTENCY_HEADER];
  if (raw === undefined || raw === '') {
    throw new ApiError(
      400,
      'idempotency_key_required',
      'This request needs an Idempotency-Key header (a client-generated UUID).',
    );
  }
  if (typeof raw !== 'string' || !KEY_PATTERN.test(raw)) {
    throw new ApiError(
      400,
      'idempotency_key_invalid',
      'Idempotency-Key must be 8–128 letters, digits, "-" or "_".',
    );
  }
  return raw;
}

/** Fingerprint of a request: method, path and JSON body. */
export function requestHash(request: FastifyRequest): string {
  return createHash('sha256')
    .update(
      `${request.method} ${request.url.split('?')[0]}\n${JSON.stringify(request.body ?? null)}`,
    )
    .digest('hex');
}

export interface StoredResponse {
  statusCode: number;
  body: unknown;
}

/**
 * Claims `key` for this request inside `tx`. Returns null when the caller should run the mutation
 * (and then call `storeIdempotentResponseTx`), or the stored response of an earlier request with
 * the same key and body. The same key with another body is `409 idempotency_conflict`.
 *
 * Concurrent requests with one key: the second insert waits on the first transaction's row; after
 * it commits the second one sees the stored response (or claims the key if the first rolled back).
 */
export async function claimIdempotencyKeyTx(
  tx: Transaction,
  accountId: string,
  key: string,
  hash: string,
  now: Date,
): Promise<StoredResponse | null> {
  const inserted = await tx
    .insert(idempotencyKeys)
    .values({ accountId, key, requestHash: hash, statusCode: 0, response: {}, createdAt: now })
    .onConflictDoNothing()
    .returning({ key: idempotencyKeys.key });
  if (inserted.length > 0) return null;

  const where = and(eq(idempotencyKeys.accountId, accountId), eq(idempotencyKeys.key, key));
  const [row] = await tx.select().from(idempotencyKeys).where(where).for('update');
  if (!row) throw new Error('idempotency key vanished while locked');
  if (now.getTime() - row.createdAt.getTime() >= IDEMPOTENCY_TTL_MS) {
    // Expired: the key starts over for this request.
    await tx
      .update(idempotencyKeys)
      .set({ requestHash: hash, statusCode: 0, response: {}, createdAt: now })
      .where(where);
    return null;
  }
  if (row.requestHash !== hash) {
    throw new ApiError(
      409,
      'idempotency_conflict',
      'This Idempotency-Key was already used for a different request.',
    );
  }
  return { statusCode: row.statusCode, body: row.response };
}

export async function storeIdempotentResponseTx(
  tx: Transaction,
  accountId: string,
  key: string,
  response: StoredResponse,
): Promise<void> {
  await tx
    .update(idempotencyKeys)
    .set({ statusCode: response.statusCode, response: response.body })
    .where(and(eq(idempotencyKeys.accountId, accountId), eq(idempotencyKeys.key, key)));
}

/**
 * Runs `mutate` once per idempotency key: claims the key in `tx`, runs the mutation, stores its
 * response. A replay sends the stored response with `Idempotent-Replayed: true`. Only successful
 * responses are stored; a failed request rolls the claim back, so a retry runs again (and fails
 * again by state, or succeeds if the state changed).
 */
export async function idempotentTx(
  tx: Transaction,
  request: FastifyRequest,
  reply: FastifyReply,
  { accountId, key, now }: { accountId: string; key: string; now: Date },
  mutate: () => Promise<StoredResponse>,
): Promise<unknown> {
  const stored = await claimIdempotencyKeyTx(tx, accountId, key, requestHash(request), now);
  if (stored) {
    reply.header('idempotent-replayed', 'true');
    reply.code(stored.statusCode);
    return stored.body;
  }
  const response = await mutate();
  await storeIdempotentResponseTx(tx, accountId, key, response);
  reply.code(response.statusCode);
  return response.body;
}
