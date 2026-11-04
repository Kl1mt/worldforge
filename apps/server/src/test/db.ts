import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../db/schema.js';
import { migrateDatabase } from '../db/migrate.js';
import { pingDatabase } from '../db/ping.js';
import type { DatabaseHandle } from '../db/types.js';

/**
 * A fresh, fully migrated, in-memory PostgreSQL (PGlite: real Postgres compiled to WASM)
 * for one test file. No Docker or external server needed. See docs/TECH_STACK.md.
 */
export async function createTestDatabase(): Promise<DatabaseHandle> {
  const client = new PGlite();
  const db = drizzle(client, { schema, casing: 'snake_case' });
  await migrateDatabase(db);
  return {
    db,
    ping: (timeoutMs) => pingDatabase(db, timeoutMs),
    close: () => client.close(),
  };
}
