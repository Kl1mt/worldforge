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
 * - with `E2E_SEED_MODERATOR=<email>` (ticket 4.1) a moderator account with that email (password
 *   `ashes-and-iron-42`, display name "Warden Brann") is created at start, the way the owner would
 *   with `pnpm admin:role`, for the moderator-queue screenshots and browser runs.
 * - with `E2E_SEED_ADMIN=<email>` (ticket D.3) likewise an admin ("Castellan Ysolde"), for the admin
 *   panel screenshots; `WORLDFORGE_GIT_SHA` / `WORLDFORGE_BUILD_TIME` fill its server status.
 * - ticket 5.7: mail goes to an in-memory outbox and never leaves the process; with
 *   `E2E_MAIL_DIR=<dir>` every mail is also written there as `<n>-<kind>.json` (`to`, `subject`,
 *   `text`, `html`), so browser runs and screenshot scripts can open the links.
 * Auth, validation and rate limits are unchanged.
 *
 *   pnpm --filter @worldforge/server e2e:serve
 */
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { join } from 'node:path';
import { createPgliteDatabase, createTestDatabase } from '../test/db.js';
import { scaledClock } from './clock.js';
import { setAccountRole } from '../social/roles.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createMemoryMailer } from '../mail/mailer.js';

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
const mailDir = process.env.E2E_MAIL_DIR;
if (mailDir) mkdirSync(mailDir, { recursive: true });
let mailSeq = 0;
const mailer = createMemoryMailer((m) => {
  if (!mailDir) return;
  mailSeq += 1;
  writeFileSync(
    join(mailDir, `${String(mailSeq).padStart(4, '0')}-${m.kind}.json`),
    JSON.stringify(m, null, 2),
  );
});
const app = buildApp({
  logger: { level: config.logLevel },
  database,
  auth: {
    sessionTtlMs: config.sessionTtlHours * 60 * 60 * 1000,
    cookieSecure: config.sessionCookieSecure,
    mailer,
    publicBaseUrl: process.env.E2E_PUBLIC_BASE_URL ?? 'http://localhost:5173',
  },
  admin: { build: config.build },
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

const seedModerator = process.env.E2E_SEED_MODERATOR;
if (seedModerator) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: seedModerator, displayName: 'Warden Brann', password: 'ashes-and-iron-42' },
  });
  if (res.statusCode !== 201) throw new Error(`seeding the moderator failed: ${res.body}`);
  await setAccountRole(database.db, seedModerator, 'moderator');
}

const seedAdmin = process.env.E2E_SEED_ADMIN;
if (seedAdmin) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: seedAdmin, displayName: 'Castellan Ysolde', password: 'ashes-and-iron-42' },
  });
  if (res.statusCode !== 201) throw new Error(`seeding the admin failed: ${res.body}`);
  await setAccountRole(database.db, seedAdmin, 'admin');
}

await app.listen({ host: config.host, port: config.port });
app.log.warn(
  { timeScale, settleIntervalSeconds, dataDir },
  `E2E TEST SERVER: ${dataDir ? 'local' : 'in-memory'} database, scaled farming clock`,
);
