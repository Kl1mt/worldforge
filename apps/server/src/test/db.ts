import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../db/schema.js';
import { migrateDatabase } from '../db/migrate.js';
import { pingDatabase } from '../db/ping.js';
import { createPostgresDatabase } from '../db/client.js';
import type { DatabaseHandle } from '../db/types.js';

/**
 * A fresh, fully migrated, in-memory PostgreSQL (PGlite: real Postgres compiled to WASM)
 * for one test file. No Docker or external server needed. See docs/TECH_STACK.md.
 */
export async function createTestDatabase(): Promise<DatabaseHandle> {
  return createPgliteDatabase();
}

/**
 * A migrated PGlite database, in memory or (with `dataDir`) persisted to a local directory.
 * The persisted form is only for the local playtest server (`src/playtest/serve.ts`).
 */
export async function createPgliteDatabase(dataDir?: string): Promise<DatabaseHandle> {
  const client = dataDir === undefined ? new PGlite() : new PGlite(dataDir);
  const db = drizzle(client, { schema, casing: 'snake_case' });
  await migrateDatabase(db);
  return {
    db,
    ping: (timeoutMs) => pingDatabase(db, timeoutMs),
    close: () => client.close(),
    // Ticket 6.9: PGlite's own LISTEN (one process; notifies arrive on commit like PostgreSQL's).
    listen: async (channel, onNotify) => {
      const stop = await client.listen(channel, onNotify);
      return async () => {
        if (!client.closed) await stop();
      };
    },
  };
}

/**
 * A fresh, migrated database on a real PostgreSQL server, for tests that need true parallel
 * transactions (PGlite runs one at a time). Connects to `DATABASE_URL`, creates a throwaway
 * database `wf_test_<random>` next to the one named in the URL (the role needs CREATEDB; the
 * CI service user and the docker-compose user are superusers), migrates it, and drops it again
 * on `close()`. The database named in the URL is never touched, so a dev database is safe.
 */
export async function createPostgresTestDatabase(
  url: string,
  { poolMax = 20 }: { poolMax?: number } = {},
): Promise<DatabaseHandle> {
  const name = `wf_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    await admin.query(`create database ${name}`);
  } finally {
    await admin.end();
  }
  const testUrl = new URL(url);
  testUrl.pathname = `/${name}`;
  const handle = createPostgresDatabase({ url: testUrl.toString(), poolMax });
  await migrateDatabase(handle.db);
  return {
    ...handle,
    close: async () => {
      await handle.close();
      const dropper = new pg.Client({ connectionString: url });
      await dropper.connect();
      try {
        await dropper.query(`drop database if exists ${name} with (force)`);
      } finally {
        await dropper.end();
      }
    },
  };
}
