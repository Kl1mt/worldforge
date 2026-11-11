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
  type Sub = { channel: string; onNotify: (p: string) => void; onError: (e: Error) => void };
  const subscribers = new Set<Sub>();
  const listening = new Set<string>();
  let listenClient: Promise<pg.Client> | null = null;
  const dropListener = async () => {
    const c = listenClient;
    listenClient = null;
    listening.clear();
    if (c) await (await c.catch(() => null))?.end().catch(() => undefined);
  };
  const listener = (): Promise<pg.Client> => {
    listenClient ??= dedicated('worldforge-listen').then((client) => {
      let open = true;
      const fail = (err: Error) => {
        if (!open) return;
        open = false;
        listenClient = null;
        listening.clear();
        void client.end().catch(() => undefined);
        // Every subscriber hears it and listens again (a new connection).
        for (const sub of [...subscribers]) {
          subscribers.delete(sub);
          sub.onError(err);
        }
      };
      client.on('error', fail);
      client.on('end', () => fail(new Error('listen connection ended')));
      client.on('notification', (m) => {
        for (const sub of subscribers) if (sub.channel === m.channel) sub.onNotify(m.payload ?? '');
      });
      return client;
    });
    listenClient.catch(() => {
      listenClient = null;
    });
    return listenClient;
  };
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
    close: async () => {
      subscribers.clear();
      await dropListener();
      await pool.end();
    },
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
    // One listening connection per database handle, shared by every subscriber (each app built
    // on this handle), so many apps in one process cost one connection.
    listen: async (channel, onNotify, onError) => {
      const sub = { channel, onNotify, onError };
      subscribers.add(sub);
      try {
        const client = await listener();
        if (!listening.has(channel)) {
          await client.query(`listen ${pg.escapeIdentifier(channel)}`);
          listening.add(channel);
        }
      } catch (err) {
        subscribers.delete(sub);
        throw err;
      }
      return async () => {
        subscribers.delete(sub);
        if (subscribers.size === 0) await dropListener();
      };
    },
  };
}
