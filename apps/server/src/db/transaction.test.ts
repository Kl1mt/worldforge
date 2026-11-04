import { describe, expect, it, vi } from 'vitest';
import { isRetryableTransactionError, sqlStateOf, withTransaction } from './transaction.js';
import type { Database } from './types.js';

function pgError(code: string) {
  return Object.assign(new Error(`pg ${code}`), { code });
}
/** Mimics DrizzleQueryError, which wraps the driver error in `cause`. */
function wrapped(code: string) {
  return new Error('Failed query', { cause: pgError(code) });
}

/** A fake Database whose transaction() fails with the given errors, then succeeds. */
function flakyDb(failures: unknown[]) {
  const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    const next = failures.shift();
    if (next) throw next;
    return fn({});
  });
  return { db: { transaction } as unknown as Database, transaction };
}

describe('sqlStateOf', () => {
  it('finds the SQLSTATE on the error or in its cause chain', () => {
    expect(sqlStateOf(pgError('23505'))).toBe('23505');
    expect(sqlStateOf(wrapped('40001'))).toBe('40001');
    expect(sqlStateOf(new Error('plain'))).toBeUndefined();
    expect(sqlStateOf(Object.assign(new Error(), { code: 'ECONNREFUSED' }))).toBeUndefined();
  });

  it('treats only serialization failures and deadlocks as retryable', () => {
    expect(isRetryableTransactionError(wrapped('40001'))).toBe(true);
    expect(isRetryableTransactionError(wrapped('40P01'))).toBe(true);
    expect(isRetryableTransactionError(wrapped('23505'))).toBe(false);
  });
});

describe('withTransaction retries', () => {
  it('retries serialization failures and deadlocks, then returns', async () => {
    const { db, transaction } = flakyDb([wrapped('40001'), wrapped('40P01')]);
    await expect(withTransaction(db, async () => 42)).resolves.toBe(42);
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it('gives up after maxAttempts', async () => {
    const { db, transaction } = flakyDb([wrapped('40001'), wrapped('40001')]);
    await expect(withTransaction(db, async () => 1, { maxAttempts: 2 })).rejects.toThrow(
      'Failed query',
    );
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('does not retry other errors', async () => {
    const { db, transaction } = flakyDb([wrapped('23505')]);
    await expect(withTransaction(db, async () => 1)).rejects.toThrow('Failed query');
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('passes the isolation level to the driver', async () => {
    const { db, transaction } = flakyDb([]);
    await withTransaction(db, async () => 1, { isolationLevel: 'serializable' });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'serializable',
    });
  });
});
