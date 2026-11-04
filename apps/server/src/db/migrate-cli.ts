// `pnpm db:migrate` — applies pending migrations to DATABASE_URL, then exits.
import { loadConfig, requireDatabaseUrl } from '../config.js';
import { createPostgresDatabase } from './client.js';
import { MIGRATIONS_FOLDER, migrateDatabase } from './migrate.js';

const config = loadConfig();
const database = createPostgresDatabase({ url: requireDatabaseUrl(config), poolMax: 1 });
try {
  await migrateDatabase(database.db);
  console.log(`Migrations applied from ${MIGRATIONS_FOLDER}`);
} catch (err) {
  console.error('Migration failed:', err);
  process.exitCode = 1;
} finally {
  await database.close();
}
