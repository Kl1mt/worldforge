// `pnpm admin:tools test-account <handle> on|off` and `pnpm admin:tools purge [--dry-run]`
// (ticket D.4, docs/DEPLOY.md "Admin tools"). The only way to mark a test account, and the only
// way to purge heroes soft-deleted more than 14 days ago. Uses DATABASE_URL, else (outside
// production) the playtest database.
import { loadConfig } from '../config.js';
import { openCliDatabase } from '../db/cli-database.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { setTestAccount } from './test-accounts.js';
import { purgeDeletedHeroes } from './heroes.js';
import { reservedNameCommand } from './reserved-names-cli.js';

const USAGE = `Usage:
  pnpm admin:tools test-account <handle> on|off   (mark or unmark a test account)
  pnpm admin:tools purge [--dry-run]               (delete heroes soft-deleted over 14 days ago)
  pnpm admin:tools reserved-name list              (built-in and added reserved names)
  pnpm admin:tools reserved-name add <name> [--note <text>]
  pnpm admin:tools reserved-name remove <name>     (only names added by an admin)`;

const [command, ...rest] = process.argv.slice(2);
const valid =
  (command === 'test-account' && rest.length === 2 && (rest[1] === 'on' || rest[1] === 'off')) ||
  (command === 'purge' && (rest.length === 0 || (rest.length === 1 && rest[0] === '--dry-run'))) ||
  // Ticket 6.9: the reserved-names store.
  (command === 'reserved-name' &&
    ((rest[0] === 'list' && rest.length === 1) ||
      (rest[0] === 'add' && (rest.length === 2 || (rest.length === 4 && rest[2] === '--note'))) ||
      (rest[0] === 'remove' && rest.length === 2)));
if (!valid) {
  console.error(USAGE);
  process.exit(2);
}

const config = loadConfig();
let cli: Awaited<ReturnType<typeof openCliDatabase>>;
try {
  cli = await openCliDatabase(config.databaseUrl);
} catch (err) {
  console.error((err as Error).message);
  process.exit(2);
}
const { database } = cli;
try {
  if (command === 'reserved-name') {
    await reservedNameCommand(database.db, rest);
  } else if (command === 'test-account') {
    const change = await setTestAccount(database.db, rest[0]!, rest[1] === 'on');
    if (!change) {
      console.error(`No account with handle "${rest[0]}".`);
      process.exitCode = 1;
    } else if (!change.changed) {
      console.log(
        `${change.displayName} is already ${change.to ? 'a test account' : 'a normal account'}.`,
      );
    } else {
      console.log(
        `${change.displayName} (${change.handle}): ${change.to ? 'now a test account' : 'no longer a test account'}.`,
      );
    }
  } else {
    const dryRun = rest[0] === '--dry-run';
    const out = await purgeDeletedHeroes(database.db, new Date(), DEFAULT_ACTIVITY_OPTIONS, {
      dryRun,
    });
    for (const h of out.purged) console.log(`${dryRun ? 'would purge' : 'purged'}: ${h.name}`);
    for (const h of out.kept) console.log(`kept: ${h.name} (${h.why})`);
    console.log(
      `${out.purged.length} hero(es) ${dryRun ? 'due for purge' : 'purged'}, ${out.kept.length} kept.`,
    );
  }
} catch (err) {
  console.error('Admin command failed:', err);
  process.exitCode = 1;
} finally {
  await cli.close();
}
