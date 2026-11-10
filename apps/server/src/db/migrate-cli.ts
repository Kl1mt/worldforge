// `pnpm db:migrate` — applies pending migrations to DATABASE_URL, runs the pending one-shot data
// backfills (docs/DEPLOY.md "Data backfills"), then exits.
import { loadConfig, requireDatabaseUrl } from '../config.js';
import { backfillAchievements } from '../achievements/backfill.js';
import { backfillCosmetics } from '../cosmetics/backfill.js';
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
  // Ticket 6.8: cosmetics earned before the collection book (after the achievements).
  const cosmetics = await backfillCosmetics(database.db);
  console.log(
    cosmetics.ran
      ? `Backfill ${cosmetics.id}: ${cosmetics.granted} cosmetics for ${cosmetics.accounts} accounts`
      : `Backfill ${cosmetics.id}: already done`,
  );
} catch (err) {
  console.error('Migration failed:', err);
  process.exitCode = 1;
} finally {
  await database.close();
}
