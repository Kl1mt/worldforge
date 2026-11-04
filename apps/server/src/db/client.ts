import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';
import { pingDatabase } from './ping.js';
import type { DatabaseHandle } from './types.js';

export interface PostgresOptions {
  url: string;
  /** Max pooled connections (default 10). */
  poolMax?: number;
  /** Called when an idle pooled connection dies (e.g. the database restarts). */
  onIdleError?: (err: Error) => void;
}

/** Connects to PostgreSQL via a node-postgres pool. Connections are opened lazily. */
export function createPostgresDatabase({
  url,
  poolMax = 10,
  onIdleError,
}: PostgresOptions): DatabaseHandle {
  const pool = new pg.Pool({ connectionString: url, max: poolMax, connectionTimeoutMillis: 5000 });
  // Without a listener, an idle client's error (database restart, network drop) is an
  // unhandled 'error' event and crashes the process. The pool discards that client and
  // reconnects on the next query; /api/health reports the outage meanwhile.
  pool.on('error', (err) => onIdleError?.(err));
  const db = drizzle(pool, { schema, casing: 'snake_case' });
  return {
    db,
    ping: (timeoutMs) => pingDatabase(db, timeoutMs),
    close: () => pool.end(),
  };
}
