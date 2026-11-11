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
  /**
   * Ticket 6.9: a dedicated connection outside the pool (scheduler leader locks). Only on a real
   * PostgreSQL server; PGlite has a single session.
   */
  session?(): Promise<DbSession>;
  /**
   * Ticket 6.9: `LISTEN channel` on a dedicated connection; `onError` when it drops (listen again).
   * Resolves to a function that stops listening.
   */
  listen?(
    channel: string,
    onNotify: (payload: string) => void,
    onError: (err: Error) => void,
  ): Promise<() => Promise<void>>;
}

/** A dedicated database connection (ticket 6.9). */
export interface DbSession {
  query(text: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  /** Called once if the connection fails or the server ends it. */
  onError(cb: (err: Error) => void): void;
  end(): Promise<void>;
}
