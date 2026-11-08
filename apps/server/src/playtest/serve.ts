/**
 * Local playtest server (ticket P.1): the real `buildApp()` on a PGlite database persisted to a
 * local directory, so the game can be played on one machine without Docker or PostgreSQL and
 * progress survives restarts. Never used in production: it is excluded from the production build
 * (`tsconfig.build.json`) and refuses to start with `NODE_ENV=production`.
 *
 * Differences from `src/index.ts`, all server-side:
 * - database: PGlite in `PLAYTEST_DATA_DIR` (default `<repo>/.playtest-data/`, git-ignored);
 *   `pnpm playtest:reset` deletes it;
 * - `SESSION_COOKIE_SECURE` defaults to off, because it only listens on plain http on this machine
 *   (Safari rejects `Secure` cookies on http://localhost); set it to 1 to keep the flag;
 * - optional fast time: `PLAYTEST_TIME_SCALE` (default 1 = real time) speeds up the farming clock,
 *   so offline progress and the 3 h cap show up in minutes; the clock never runs backwards across
 *   restarts (`clock.ts`). Sessions, cookies and rate limits keep the real clock;
 * - scheduled settlement every `PLAYTEST_SETTLE_INTERVAL_SECONDS` real seconds (default 30).
 * Auth, validation, rate limits and game rules are unchanged; the client still sends only intents.
 *
 *   pnpm playtest            (root: this server + the web client, see docs/PLAYTEST.md)
 *   pnpm --filter @worldforge/server playtest:serve
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createPgliteDatabase } from '../test/db.js';
import { playtestClock, startOffsetMs } from './clock.js';
import { latestStoredTimeMs } from './stored-time.js';
import { createLogMailer } from '../mail/mailer.js';

if (process.env.NODE_ENV === 'production') {
  console.error(
    'src/playtest/serve.ts is a local playtest server and does not run with NODE_ENV=production.',
  );
  process.exit(1);
}

// Keep in sync with tools/playtest/lib.mjs (`dataDir`, `LOCK_FILE`).
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const dataDir = resolve(REPO_ROOT, process.env.PLAYTEST_DATA_DIR || '.playtest-data');
const lockFile = join(dataDir, 'server.lock');
const clockFile = join(dataDir, 'clock.json');

function numberEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < min) throw new Error(`Invalid ${name}: ${raw}`);
  return value;
}

const config = loadConfig({
  SESSION_COOKIE_SECURE: '0',
  ...process.env,
});
const timeScale = numberEnv('PLAYTEST_TIME_SCALE', 1, 1);
const settleIntervalSeconds = numberEnv('PLAYTEST_SETTLE_INTERVAL_SECONDS', 30, 0);

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// One server per data directory: two PGlite instances on the same files would corrupt them.
mkdirSync(dataDir, { recursive: true });
try {
  const { pid } = JSON.parse(readFileSync(lockFile, 'utf8')) as { pid: number };
  if (pid !== process.pid && isRunning(pid)) {
    console.error(
      `Another playtest server (pid ${pid}) is already using ${dataDir}. Stop it first (Ctrl+C in its terminal).`,
    );
    process.exit(1);
  }
} catch {
  // No lock, or an unreadable one left by a crash: take it over.
}
writeFileSync(lockFile, JSON.stringify({ pid: process.pid }));

let savedOffsetMs: number | undefined;
try {
  savedOffsetMs = (JSON.parse(readFileSync(clockFile, 'utf8')) as { offsetMs?: number }).offsetMs;
} catch {
  savedOffsetMs = undefined;
}

const database = await createPgliteDatabase(join(dataDir, 'db'));
const latestStoredMs = await latestStoredTimeMs(database.db);
const clock = playtestClock({
  scale: timeScale,
  offsetMs: startOffsetMs(savedOffsetMs, latestStoredMs, Date.now()),
});
const saveClock = () => writeFileSync(clockFile, JSON.stringify({ offsetMs: clock.offsetMs() }));
saveClock();
const clockTimer = setInterval(saveClock, 5000);
clockTimer.unref();

const app = buildApp({
  logger: { level: config.logLevel },
  database,
  auth: {
    sessionTtlMs: config.sessionTtlHours * 60 * 60 * 1000,
    cookieSecure: config.sessionCookieSecure,
    // Ticket 5.7: no mail leaves a playtest; letters (with their links) are printed to the log.
    mailer: createLogMailer((m) =>
      console.log(`\n[mail] ${m.kind} to ${m.to}: ${m.subject}\n${m.text}\n`),
    ),
    publicBaseUrl: config.mail.publicBaseUrl ?? 'http://localhost:5173',
  },
  activity: {
    offlineCapMs: config.offlineCapSeconds * 1000,
    // The scheduler fires on real time; "due" is measured on the (possibly fast) playtest clock.
    settleIntervalMs: settleIntervalSeconds * 1000,
    now: clock.now,
  },
});

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(clockTimer);
  try {
    await app.close();
    saveClock();
    await database.close();
  } finally {
    rmSync(lockFile, { force: true });
    process.exit(0);
  }
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

try {
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  app.log.error(err);
  await database.close().catch(() => undefined);
  rmSync(lockFile, { force: true });
  process.exit(1);
}
app.log.warn(
  { dataDir, timeScale, offlineCapSeconds: config.offlineCapSeconds, settleIntervalSeconds },
  timeScale > 1
    ? `PLAYTEST SERVER: local data, FAST TIME x${timeScale}`
    : 'PLAYTEST SERVER: local data, real time',
);
