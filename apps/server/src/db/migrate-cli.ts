// `pnpm db:migrate` — applies pending migrations to DATABASE_URL, runs the pending one-shot data
// backfills (docs/DEPLOY.md "Data backfills"), then exits.
import { loadConfig, requireDatabaseUrl } from '../config.js';
import { backfillAchievements } from '../achievements/backfill.js';
import { createPostgresDatabase } from './client.js';
import { MIGRATIONS_FOLDER, migrateDatabase } from './migrate.js';

const config = loadConfig();
const database = createPostgresDatabase({ url: requireDatabaseUrl(config), poolMax: 1 });
try {
  await migrateDatabase(database.db);
  console.log(`Migrations applied from ${MIGRATIONS_FOLDER}`);
  const backfill = await backfillAchievements(database.db);
  console.log(
    backfill.ran
      ? `Backfill ${backfill.id}: ${backfill.awarded} achievements for ${backfill.accounts} accounts`
      : `Backfill ${backfill.id}: already done`,
  );
} catch (err) {
  console.error('Migration failed:', err);
  process.exitCode = 1;
} finally {
  await database.close();
}
