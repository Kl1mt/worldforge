import { defineConfig } from 'drizzle-kit';

// Used only by `pnpm db:generate` (drizzle-kit generate), which diffs the schema offline.
// Migrations are applied by src/db/migrate.ts, not by drizzle-kit.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  casing: 'snake_case',
});
