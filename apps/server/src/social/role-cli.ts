// `pnpm admin:role <grant|revoke> <email|handle> [moderator|admin]` (ticket 4.1, docs/SOCIAL.md).
// The only way to change an account role: there is no API path for it. Uses DATABASE_URL.
import { isAccountRole } from '@worldforge/game-core';
import { loadConfig, requireDatabaseUrl } from '../config.js';
import { createPostgresDatabase } from '../db/client.js';
import { setAccountRole } from './roles.js';

const USAGE = `Usage:
  pnpm admin:role grant <email|handle> <moderator|admin>
  pnpm admin:role revoke <email|handle>        (back to player)`;

const [command, identifier, roleArg] = process.argv.slice(2);
const role = command === 'revoke' ? 'player' : roleArg;
if (
  !identifier ||
  (command !== 'grant' && command !== 'revoke') ||
  !isAccountRole(role) ||
  (command === 'grant' && role === 'player')
) {
  console.error(USAGE);
  process.exit(2);
}

const config = loadConfig();
const database = createPostgresDatabase({ url: requireDatabaseUrl(config), poolMax: 1 });
try {
  const change = await setAccountRole(database.db, identifier, role);
  if (!change) {
    console.error(`No account with email or handle "${identifier}".`);
    process.exitCode = 1;
  } else if (!change.changed) {
    console.log(`${change.displayName} is already ${change.to}.`);
  } else {
    console.log(`${change.displayName}: ${change.from} → ${change.to}.`);
  }
} catch (err) {
  console.error('Role change failed:', err);
  process.exitCode = 1;
} finally {
  await database.close();
}
