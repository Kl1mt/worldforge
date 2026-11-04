import type { SQL } from 'drizzle-orm';
import type { Executor } from './types.js';

/**
 * Runs raw SQL and returns its rows. `execute()` is untyped on the driver-agnostic
 * `Database`; both drivers we use (node-postgres, PGlite) return `{ rows }`.
 * Prefer the query builder; use this for things it can't express.
 */
export async function queryRows<T extends Record<string, unknown>>(
  executor: Executor,
  query: SQL,
): Promise<T[]> {
  const result = (await executor.execute(query)) as unknown as { rows: T[] };
  return result.rows;
}
