// `pnpm report:telemetry` (ticket 3.8, docs/TELEMETRY.md): prints the telemetry summary.
//
//   pnpm report:telemetry [-- --from 2026-11-01] [--to 2026-11-06] [--json] [--out file.json]
//                         [--reconcile] [--db playtest|postgres]
//
// Reads Postgres (`DATABASE_URL`) when it is set, else the playtest PGlite database
// (`PLAYTEST_DATA_DIR`, default `<repo>/.playtest-data/`). Read-only apart from migrating an old
// playtest database, as the playtest server would.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { createPostgresDatabase } from '../db/client.js';
import { queryRows } from '../db/query.js';
import type { DatabaseHandle } from '../db/types.js';
import { createPgliteDatabase } from '../test/db.js';
import { sql } from 'drizzle-orm';
import { buildTelemetryReport, parseDay, renderTelemetryReport } from './report.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

// `… | head` closes the pipe early; that is not an error.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

let args;
try {
  args = parseArgs({
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      json: { type: 'boolean', default: false },
      out: { type: 'string' },
      reconcile: { type: 'boolean', default: false },
      db: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    // `pnpm report:telemetry -- --json` passes a literal `--` through.
    args: process.argv.slice(2).filter((a) => a !== '--'),
  }).values;
} catch (err) {
  fail(`${(err as Error).message}\nRun with --help for the options.`);
}

if (args.help) {
  console.log(`Usage: pnpm report:telemetry [-- options]
  --from YYYY-MM-DD   first game day to include (default: first recorded day)
  --to YYYY-MM-DD     last game day to include (default: last recorded day)
  --json              print the report as JSON (for balance tooling, ticket B.2)
  --out FILE          also write the JSON report to FILE
  --reconcile         compare the rollups with the audit log (all time)
  --db playtest|postgres
                      data source (default: postgres when DATABASE_URL is set, else playtest)`);
  process.exit(0);
}

let from: string | null = null;
let to: string | null = null;
try {
  from = args.from ? parseDay(args.from, '--from') : null;
  to = args.to ? parseDay(args.to, '--to') : null;
} catch (err) {
  fail((err as Error).message);
}
if (from && to && from > to) fail(`--from (${from}) is after --to (${to}).`);

// Like `--env-file-if-exists=.env`, without its notice on stderr when there is no `.env`.
if (existsSync('.env')) process.loadEnvFile('.env');
const config = loadConfig();
const source = args.db ?? (config.databaseUrl ? 'postgres' : 'playtest');
if (source !== 'playtest' && source !== 'postgres') fail(`--db must be playtest or postgres.`);

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

let database: DatabaseHandle;
let releaseLock = () => {};
let label: string;
if (source === 'postgres') {
  if (!config.databaseUrl) fail('DATABASE_URL is not set (needed for --db postgres).');
  database = createPostgresDatabase({ url: config.databaseUrl, poolMax: 1 });
  label = 'PostgreSQL (DATABASE_URL)';
  const [table] = await queryRows<{ t: string | null }>(
    database.db,
    sql`select to_regclass('public.telemetry_daily')::text as t`,
  ).catch((err: unknown) => fail(`Cannot reach the database: ${(err as Error).message}`));
  if (!table?.t) {
    await database.close();
    fail('This database has no telemetry table yet. Run `pnpm db:migrate` first.');
  }
} else {
  // Keep in sync with src/playtest/serve.ts and tools/playtest/lib.mjs.
  const dataDir = resolve(REPO_ROOT, process.env.PLAYTEST_DATA_DIR || '.playtest-data');
  const dbDir = join(dataDir, 'db');
  if (!existsSync(dbDir)) {
    console.log(`No playtest database at ${dataDir} yet — nothing to report.`);
    console.log('Start one with `pnpm playtest`, or point DATABASE_URL at a server database.');
    process.exit(0);
  }
  // PGlite allows one process per data directory: never open it under a running server.
  const lockFile = join(dataDir, 'server.lock');
  try {
    const { pid } = JSON.parse(readFileSync(lockFile, 'utf8')) as { pid: number };
    if (pid !== process.pid && isRunning(pid)) {
      fail(
        `The playtest server (pid ${pid}) has the database open. Stop it (Ctrl+C), then run the report again.`,
      );
    }
  } catch {
    // No lock (or a stale one).
  }
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid }));
  releaseLock = () => rmSync(lockFile, { force: true });
  database = await createPgliteDatabase(dbDir);
  label = `playtest PGlite (${dataDir})`;
}

try {
  const report = await buildTelemetryReport(
    database.db,
    { from, to },
    { reconcile: args.reconcile },
  );
  const json = JSON.stringify({ source: source, ...report }, null, 2);
  // pnpm runs the script in apps/server; resolve --out against the caller's directory.
  const outFile = args.out ? resolve(process.env.INIT_CWD ?? process.cwd(), args.out) : null;
  if (outFile) writeFileSync(outFile, `${json}\n`);
  if (args.json) {
    console.log(json);
  } else {
    console.log(`Source: ${label}`);
    console.log(renderTelemetryReport(report));
    if (outFile) console.log(`\nJSON written to ${outFile}`);
  }
  if (report.reconcile?.some((c) => !c.ok)) process.exitCode = 2;
} finally {
  await database.close();
  releaseLock();
}
