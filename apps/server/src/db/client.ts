import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';
import { pingDatabase } from './ping.js';
import type { DatabaseHandle, DbSession } from './types.js';

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
  const dedicated = async (name: string) => {
    const client = new pg.Client({
      connectionString: url,
      keepAlive: true,
      connectionTimeoutMillis: 5000,
      application_name: name,
    });
    await client.connect();
    return client;
  };
  return {
    db,
    ping: (timeoutMs) => pingDatabase(db, timeoutMs),
    close: () => pool.end(),
    // Ticket 6.9: the scheduler leader's lock connection and the cache notify listener.
    session: async (): Promise<DbSession> => {
      const client = await dedicated('worldforge-leader');
      let failed: ((err: Error) => void) | null = null;
      client.on('error', (err) => failed?.(err));
      client.on('end', () => failed?.(new Error('leader connection ended')));
      return {
        query: async (text, params) => (await client.query(text, params)).rows,
        onError: (cb) => {
          let once = false;
          failed = (err) => {
            if (once) return;
            once = true;
            cb(err);
          };
        },
        end: async () => {
          failed = null;
          await client.end();
        },
      };
    },
    listen: async (channel, onNotify, onError) => {
      const client = await dedicated('worldforge-listen');
      let open = true;
      const fail = (err: Error) => {
        if (!open) return;
        open = false;
        void client.end().catch(() => undefined);
        onError(err);
      };
      client.on('error', fail);
      client.on('end', () => fail(new Error('listen connection ended')));
      client.on('notification', (m) => {
        if (m.channel === channel) onNotify(m.payload ?? '');
      });
      await client.query(`listen ${pg.escapeIdentifier(channel)}`);
      return async () => {
        open = false;
        await client.end().catch(() => undefined);
      };
    },
  };
}
