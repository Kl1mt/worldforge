import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type * as schema from './schema.js';

export type Schema = typeof schema;

/** Driver-agnostic Drizzle database: node-postgres in production, PGlite in tests. */
export type Database = PgDatabase<PgQueryResultHKT, Schema>;

/** The handle passed to a `db.transaction()` callback. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Either the root database or an open transaction; repository functions accept both. */
export type Executor = Database | Transaction;

/** A connected database plus lifecycle helpers, owned by whoever created it. */
export interface DatabaseHandle {
  db: Database;
  /** Resolves when the database answers a trivial query; rejects otherwise. */
  ping(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}
