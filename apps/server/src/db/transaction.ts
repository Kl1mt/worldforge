import { flushTelemetry } from '../telemetry/record.js';
import type { Database, Transaction } from './types.js';

export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

export interface TransactionOptions {
  /** Default `read committed` (PostgreSQL's default). Use `serializable` for economy operations. */
  isolationLevel?: IsolationLevel;
  /** Total attempts when PostgreSQL reports a serialization failure or deadlock (default 3). */
  maxAttempts?: number;
}

/** SQLSTATEs that mean "the transaction was aborted by a concurrent one; retrying is safe". */
const RETRYABLE_SQLSTATES = new Set(['40001', '40P01']);

/** Finds a PostgreSQL SQLSTATE on an error or anywhere in its `cause` chain (Drizzle wraps driver errors). */
export function sqlStateOf(err: unknown): string | undefined {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 5; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** The violated constraint's name, searched along the `cause` chain (Drizzle wraps driver errors). */
export function constraintOf(err: unknown): string | undefined {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 5; depth++) {
    const c = (e as { constraint?: unknown }).constraint;
    if (typeof c === 'string') return c;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Process-wide count of transactions retried after a serialization failure or deadlock. Retries
 * are correct but hide lock-order problems, so the real-PostgreSQL concurrency tests assert that
 * their races cause none (ticket 1.9).
 */
export const transactionStats = { retries: 0 };

export function isRetryableTransactionError(err: unknown): boolean {
  const state = sqlStateOf(err);
  return state !== undefined && RETRYABLE_SQLSTATES.has(state);
}

/**
 * Runs `fn` in a database transaction: commit on success, roll back on any thrown error.
 * Serialization failures and deadlocks are retried with the whole callback re-run, so `fn`
 * must not have side effects outside the transaction (no HTTP calls, no in-memory mutation
 * that survives a retry). All value-changing operations go through this helper.
 *
 * Telemetry counters recorded on `tx` (`recordTelemetry`, ticket 3.8) are written as the
 * transaction's last statement, after `fn` returns; a thrown error discards them with the rest.
 */
export async function withTransaction<T>(
  db: Database,
  fn: (tx: Transaction) => Promise<T>,
  { isolationLevel = 'read committed', maxAttempts = 3 }: TransactionOptions = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction(
        async (tx) => {
          const result = await fn(tx);
          await flushTelemetry(tx);
          return result;
        },
        { isolationLevel },
      );
    } catch (err) {
      if (attempt >= maxAttempts || !isRetryableTransactionError(err)) throw err;
      transactionStats.retries++;
      // Short jittered backoff so competing transactions don't collide again in lockstep.
      await new Promise((r) => setTimeout(r, Math.random() * 10 * attempt));
    }
  }
}
