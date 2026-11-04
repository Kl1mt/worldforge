// `pnpm playtest:reset` (ticket P.1): deletes the local playtest database (accounts, characters,
// items, farming progress) so the next `pnpm playtest` starts from an empty world.
// Only touches the playtest data directory; Docker/PostgreSQL data (`pnpm dev`) is not affected.
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { bold, dataDir, green, LOCK_FILE, red, runningPlaytestPid } from './lib.mjs';

const dir = dataDir();

if (!existsSync(dir)) {
  console.log(green(`Nothing to reset: ${dir} does not exist.`));
  process.exit(0);
}

const pid = runningPlaytestPid();
if (pid !== null) {
  console.error(red(`The playtest server is still running (pid ${pid}).`));
  console.error(
    'Stop it first: press Ctrl+C in the terminal running `pnpm playtest`, then run this again.',
  );
  process.exit(1);
}

// Safety net for a custom PLAYTEST_DATA_DIR: only delete a directory that looks like playtest data.
const known = new Set(['db', 'clock.json', LOCK_FILE]);
const entries = readdirSync(dir);
if (entries.some((name) => !known.has(name))) {
  console.error(red(`${dir} contains files the playtest server did not create; not deleting it.`));
  console.error('Check PLAYTEST_DATA_DIR, or delete the folder by hand.');
  process.exit(1);
}

rmSync(resolve(dir), { recursive: true, force: true });
console.log(green(bold('Playtest data deleted.')) + ` (${dir})`);
console.log('Run `pnpm playtest` to start again with an empty world.');
