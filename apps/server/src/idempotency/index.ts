import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, lt } from 'drizzle-orm';
import { idempotencyKeys } from '../db/schema.js';
import { withTransaction } from '../db/transaction.js';
import type { Database, Transaction } from '../db/types.js';
import { ApiError } from '../errors.js';

/**
 * `Idempotency-Key` support for endpoints that are not repeat-safe by state (ticket 2.6,
 * docs/API_CONVENTIONS.md). Use `idempotentTransaction` in place of `withTransaction` in the
 * route handler:
 *
 *   return idempotentTransaction(app, request, reply, { now }, async (tx) => { …; return body; });
 *
 * The key is claimed with an insert at the start of the mutation's own transaction, so:
 * - a retry after the commit finds the stored response and replays it (`Idempotency-Replayed`);
 * - a concurrent request with the same key blocks on the unique key until the first commits, then
 *   replays (or, if the first failed and rolled back, runs itself);
 * - a failed request (any thrown error) rolls back the claim too, so it stores nothing and the
 *   same key may be retried;
 * - the same key with another method, path or body is `409 idempotency_conflict`.
 * Keys are per account and expire after `IDEMPOTENCY_TTL_MS`; an expired key is reusable.
 */

export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const IDEMPOTENCY_REPLAYED_HEADER = 'idempotency-replayed';
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** Visible ASCII, 8–128 characters (a UUID fits; so do other client schemes). */
const KEY_PATTERN = /^[\x21-\x7e]{8,128}$/;

/** JSON with object keys sorted, so `{a,b}` and `{b,a}` hash the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function requestHash(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()} ${path}\n${canonicalJson(body)}`)
    .digest('hex');
}

/** Reads and validates the header; throws `400` when it is missing or malformed. */
export function readIdempotencyKey(request: FastifyRequest): string {
  const raw = request.headers[IDEMPOTENCY_HEADER];
  if (raw === undefined || raw === '') {
    throw new ApiError(
      400,
      'idempotency_key_required',
      'This action needs an Idempotency-Key header (a fresh UUID per action).',
    );
  }
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    throw new ApiError(400, 'validation_failed', 'Malformed Idempotency-Key header.', {
      fields: { 'Idempotency-Key': 'Use 8–128 visible ASCII characters, e.g. a UUID.' },
    });
  }
  return key;
}

export interface IdempotencyOptions {
  /** Server clock (injectable for tests). */
  now: () => Date;
  /** Status of a fresh success (default 200). */
  status?: number;
  ttlMs?: number;
}

/**
 * Runs `fn` in a transaction guarded by the request's `Idempotency-Key` (see the module comment)
 * and returns the body to send. Requires `request.auth` (use after `app.requireAccount`).
 */
export async function idempotentTransaction<T>(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  options: IdempotencyOptions,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const accountId = request.auth!.account.id;
  const key = readIdempotencyKey(request);
  const path = request.url.split('?')[0]!;
  const hash = requestHash(request.method, path, request.body ?? null);
  const outcome = await runIdempotent(app.db, { accountId, key, hash, ...options }, fn);
  void reply.code(outcome.status);
  if (outcome.replayed) void reply.header(IDEMPOTENCY_REPLAYED_HEADER, 'true');
  return outcome.body;
}

export interface IdempotentRun<T> {
  replayed: boolean;
  status: number;
  body: T;
}

/**
 * The core of `idempotentTransaction` for one stored key (ticket 8.5 also runs it once per item
 * of a batch, `batchItemKey`): claims `key` in the transaction that runs `fn`, replays a stored
 * response, `409 idempotency_conflict` for another `hash`.
 */
export async function runIdempotent<T>(
  db: Database,
  options: IdempotencyOptions & { accountId: string; key: string; hash: string },
  fn: (tx: Transaction) => Promise<T>,
): Promise<IdempotentRun<T>> {
  const { accountId, key, hash } = options;
  const status = options.status ?? 200;
  const ttlMs = options.ttlMs ?? IDEMPOTENCY_TTL_MS;
  return withTransaction(db, async (tx) => {
    const now = options.now();
    const fresh = {
      requestHash: hash,
      statusCode: 0,
      response: {},
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
    };
    // Claim the key. A live row (committed, or in flight: the insert waits for it) wins; an
    // expired one is taken over.
    const claimed = await tx
      .insert(idempotencyKeys)
      .values({ accountId, key, ...fresh })
      .onConflictDoUpdate({
        target: [idempotencyKeys.accountId, idempotencyKeys.key],
        set: fresh,
        where: lt(idempotencyKeys.expiresAt, now),
      })
      .returning({ key: idempotencyKeys.key });
    if (claimed.length === 0) {
      const [stored] = await tx
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.accountId, accountId), eq(idempotencyKeys.key, key)));
      if (!stored) throw new Error('unreachable: idempotency key conflict without a row');
      if (stored.requestHash !== hash) {
        throw new ApiError(
          409,
          'idempotency_conflict',
          'This Idempotency-Key was already used for a different request.',
        );
      }
      return { replayed: true, status: stored.statusCode, body: stored.response as T };
    }
    const body = await fn(tx);
    await tx
      .update(idempotencyKeys)
      .set({ statusCode: status, response: body as unknown })
      .where(and(eq(idempotencyKeys.accountId, accountId), eq(idempotencyKeys.key, key)));
    return { replayed: false, status, body };
  });
}

/**
 * The stored key of one item of a batch request (ticket 8.5): derived from the batch's own key and
 * the item, so a retried batch replays each item it already did and runs only the rest, and the
 * same item in two batches with one key is paid once.
 */
export function batchItemKey(batchKey: string, item: string): string {
  return `batch:${createHash('sha256').update(`${batchKey}\n${item}`).digest('hex').slice(0, 48)}`;
}

/** Deletes expired keys; returns how many. Run periodically (the settlement scheduler does). */
export async function pruneIdempotencyKeys(db: Database, now: Date): Promise<number> {
  const rows = await db
    .delete(idempotencyKeys)
    .where(lt(idempotencyKeys.expiresAt, now))
    .returning({ key: idempotencyKeys.key });
  return rows.length;
}
