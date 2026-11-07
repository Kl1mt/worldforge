// The database an owner CLI (`pnpm admin:role`, `pnpm admin:project`) works on (ticket 4.11):
// PostgreSQL from `DATABASE_URL` when it is set, as on the VPS; otherwise, outside production, the
// local playtest database (`pnpm playtest`'s PGlite folder, `PLAYTEST_DATA_DIR`, default
// `.playtest-data/`), so a playtester can make themselves admin and finish community projects.
// PGlite allows one process per folder: the command refuses while the playtest server runs.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPostgresDatabase } from './client.js';
import type { DatabaseHandle } from './types.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface CliDatabase {
  database: DatabaseHandle;
  label: string;
  close: () => Promise<void>;
}

export async function openCliDatabase(databaseUrl: string | undefined): Promise<CliDatabase> {
  if (databaseUrl) {
    const database = createPostgresDatabase({ url: databaseUrl, poolMax: 1 });
    return { database, label: 'PostgreSQL (DATABASE_URL)', close: () => database.close() };
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL is not set.');
  }
  // Keep in sync with src/playtest/serve.ts and tools/playtest/lib.mjs.
  const dataDir = resolve(REPO_ROOT, process.env.PLAYTEST_DATA_DIR || '.playtest-data');
  const dbDir = join(dataDir, 'db');
  if (!existsSync(dbDir)) {
    throw new Error(
      `DATABASE_URL is not set and there is no playtest database at ${dataDir} yet. Start one with \`pnpm playtest\` (and register) first.`,
    );
  }
  const lockFile = join(dataDir, 'server.lock');
  try {
    const { pid } = JSON.parse(readFileSync(lockFile, 'utf8')) as { pid: number };
    if (pid !== process.pid && isRunning(pid)) {
      throw new Error(
        `The playtest server (pid ${pid}) has the database open. Stop it (Ctrl+C), run the command, then start it again.`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('The playtest server')) throw err;
    // No lock (or a stale one).
  }
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid }));
  // Test-only module (PGlite is a dev dependency): loaded only here, never in production.
  const { createPgliteDatabase } = await import('../test/db.js');
  const database = await createPgliteDatabase(dbDir);
  return {
    database,
    label: `playtest PGlite (${dataDir})`,
    close: async () => {
      await database.close();
      rmSync(lockFile, { force: true });
    },
  };
}
