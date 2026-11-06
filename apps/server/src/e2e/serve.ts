/**
 * End-to-end test server (ticket 1.8): the real `buildApp()` against an in-process PGlite database,
 * for Playwright runs in sandboxes without Docker. Never used in production: it is excluded from
 * the production build (`tsconfig.build.json`) and refuses to start with `NODE_ENV=production`.
 *
 * Differences from `src/index.ts`, all server-side:
 * - in-memory database (fresh and migrated on every start; nothing persists);
 * - the farming clock runs `E2E_TIME_SCALE` times faster than real time (default 120), so loot
 *   appears within seconds; sessions, rate limits and cookies use the real clock;
 * - scheduled settlement every `E2E_SETTLE_INTERVAL_SECONDS` real seconds (default 5);
 * - with `E2E_DATA_DIR` (ticket 3.9) the PGlite database is kept in `<dir>/db` instead of memory,
 *   so after the run (server stopped) `PLAYTEST_DATA_DIR=<dir> pnpm report:telemetry -- --db
 *   playtest --reconcile` can check it.
 * Auth, validation and rate limits are unchanged.
 *
 *   pnpm --filter @worldforge/server e2e:serve
 */
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { join } from 'node:path';
import { createPgliteDatabase, createTestDatabase } from '../test/db.js';
import { scaledClock } from './clock.js';

if (process.env.NODE_ENV === 'production') {
  console.error('src/e2e/serve.ts is a test server and does not run with NODE_ENV=production.');
  process.exit(1);
}

const config = loadConfig();
const timeScale = Number(process.env.E2E_TIME_SCALE ?? 120);
const settleIntervalSeconds = Number(process.env.E2E_SETTLE_INTERVAL_SECONDS ?? 5);
if (!Number.isFinite(settleIntervalSeconds) || settleIntervalSeconds < 0) {
  throw new Error(`Invalid E2E_SETTLE_INTERVAL_SECONDS: ${settleIntervalSeconds}`);
}
const now = scaledClock(timeScale);

const dataDir = process.env.E2E_DATA_DIR;
const database = dataDir
  ? await createPgliteDatabase(join(dataDir, 'db'))
  : await createTestDatabase();
const app = buildApp({
  logger: { level: config.logLevel },
  database,
  auth: {
    sessionTtlMs: config.sessionTtlHours * 60 * 60 * 1000,
    cookieSecure: config.sessionCookieSecure,
  },
  activity: {
    offlineCapMs: config.offlineCapSeconds * 1000,
    // The scheduler fires on real time; "due" is measured on the scaled clock.
    settleIntervalMs: settleIntervalSeconds * 1000,
    now,
  },
});

const shutdown = async () => {
  await app.close();
  await database.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await app.listen({ host: config.host, port: config.port });
app.log.warn(
  { timeScale, settleIntervalSeconds, dataDir },
  `E2E TEST SERVER: ${dataDir ? 'local' : 'in-memory'} database, scaled farming clock`,
);
