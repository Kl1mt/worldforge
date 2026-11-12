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
 * - with `E2E_SEED_TEST_ACCOUNT=<email>` (ticket D.4) a test account ("Probe Ansel").
 * - with `E2E_SEED_ADMIN=<email>` (ticket D.3) likewise an admin ("Castellan Ysolde"), for the admin
 *   panel screenshots; `WORLDFORGE_GIT_SHA` / `WORLDFORGE_BUILD_TIME` fill its server status.
 * - ticket 5.7: mail goes to an in-memory outbox and never leaves the process; with
 *   `E2E_MAIL_DIR=<dir>` every mail is also written there as `<n>-<kind>.json` (`to`, `subject`,
 *   `text`, `html`), so browser runs and screenshot scripts can open the links.
 * - with `E2E_SEED_PHASE5=1` (ticket 5.8, `tools/e2e/phase5-exit.mjs`) the Phase 5 run's world is
 *   set up at start (`seed-phase5.ts`): trading opened (master switch, Trade and Shelf on; trading
 *   stays closed without this variable), the Warehouse restored, Season 1 scheduled from now, and
 *   three seeded players: two trade-ready friends (Ilse Varrow `p5-ilse@graumark.test`, a level-15
 *   warrior with gold and a tradeable Epic; Bertram Holt `p5-bertram@graumark.test`, a level-16
 *   hunter with a saved defence) and a duel-ready stranger (Corvin Ashe `p5-corvin@graumark.test`,
 *   a level-15 warrior in Ilse's kit with a saved defence), password `ashes-and-iron-42`. Done
 *   directly in the database and through the server's own model functions, like the role seeds.
 * - with `E2E_SEED_PHASE6=1` (ticket 6.10, `tools/e2e/phase6-exit.mjs`) the Phase 6 run's world
 *   (`seed-phase6.ts`): the town's works done (the Forgeward Age), a Harvest of Bones under way,
 *   a level-38 warrior in Legendary +10 kit with the price of an awakening, a Prismatic and a Void
 *   piece and two keepsakes (Hralda Vey `p6-hralda@graumark.test`), a level-34 hunter the
 *   Tyrant's door still bars (Tamsin Coldlamp `p6-tamsin@graumark.test`) and an admin (Ysolde
 *   Marr `p6-ysolde@graumark.test`), password `ashes-and-iron-42`.
 * - with `E2E_SEED_PHASE8=1` (ticket 8.7, `tools/e2e/phase8-exit.mjs`) the Phase 8 run's world
 *   (`seed-phase8.ts`): the town's works done (the Lantern Vigil, the Hollow Deep and the Throne
 *   open), Season 1 under way, the guild "The Lantern Wardens" on the Guild Roll, a level-50
 *   warrior in Marches Legendary +10 kit who leads it (Odric Lanternhand `p8-odric@graumark.test`),
 *   a level-46 hunter the Throne's door still bars (Brynja Coldwick `p8-brynja@`), a level-22 mage
 *   with a mixed pack and three ready Tavern notices (Cass Wenhallow `p8-cass@`) and an admin
 *   (Mira Castellane `p8-mira@`), password `ashes-and-iron-42`. The calendar stays paused.
 * Auth, validation and rate limits are unchanged.
 *
 *   pnpm --filter @worldforge/server e2e:serve
 */
import { setTestAccount } from '../admin/test-accounts.js';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { join } from 'node:path';
import { createPgliteDatabase, createTestDatabase } from '../test/db.js';
import { scaledClock } from './clock.js';
import { setAccountRole } from '../social/roles.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createMemoryMailer } from '../mail/mailer.js';
import { seedPhase5 } from './seed-phase5.js';
import { seedPhase6 } from './seed-phase6.js';
import { seedPhase8 } from './seed-phase8.js';

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
  // Ticket 8.6: the Readiness tab reads LEGAL_DIR and BACKUP_STATUS_FILE like production.
  legal: { dir: config.legalDir },
  admin: { build: config.build, backupStatusFile: config.backupStatusFile },
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

// Ticket D.4: a test account (the CLI's flag), for the admin tools screenshots.
const seedTest = process.env.E2E_SEED_TEST_ACCOUNT;
if (seedTest) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: seedTest, displayName: 'Probe Ansel', password: 'ashes-and-iron-42' },
  });
  if (res.statusCode !== 201) throw new Error(`seeding the test account failed: ${res.body}`);
  await setTestAccount(
    database.db,
    res.json<{ account: { handle: string } }>().account.handle,
    true,
  );
}

if (process.env.E2E_SEED_PHASE5 === '1') await seedPhase5(app, database.db, now);
if (process.env.E2E_SEED_PHASE6 === '1') await seedPhase6(app, database.db, now);
if (process.env.E2E_SEED_PHASE8 === '1') await seedPhase8(app, database.db, now);

await app.listen({ host: config.host, port: config.port });
app.log.warn(
  { timeScale, settleIntervalSeconds, dataDir },
  `E2E TEST SERVER: ${dataDir ? 'local' : 'in-memory'} database, scaled farming clock`,
);
