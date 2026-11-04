// `pnpm run doctor` (ticket P.1; docs/PLAYTEST.md): checks that this machine can run Worldforge and says
// what to do next. Plain Node with no dependencies, so `node tools/doctor.mjs` also works before
// pnpm is installed. Exit code 1 when a required check fails.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  bold,
  checkNodeVersion,
  dataDir,
  DEFAULT_SERVER_PORT,
  DEFAULT_WEB_PORT,
  depsInstalled,
  dim,
  green,
  PNPM_VERSION,
  portInUse,
  red,
  REPO_ROOT,
  runningPlaytestPid,
  yellow,
} from './playtest/lib.mjs';

const results = [];
const ok = (label, detail) => results.push({ level: 'ok', label, detail });
const bad = (label, detail, fix) => results.push({ level: 'fail', label, detail, fix });
const warn = (label, detail, fix) => results.push({ level: 'warn', label, detail, fix });

/** Runs a command and returns its trimmed stdout, or null if it can't run or fails. */
function run(command, args) {
  // Windows needs a shell to find `.cmd` shims such as pnpm.cmd.
  const res = spawnSync(command, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 15_000,
  });
  return res.status === 0 ? res.stdout.trim() : null;
}

// Node
const node = checkNodeVersion();
if (node.ok) ok('Node.js', `v${node.version}`);
else {
  bad(
    'Node.js',
    `v${node.version} is running; Worldforge needs Node ${node.wanted}`,
    'Install Node 22 and switch to it in this folder: `fnm install 22 && fnm use 22` (or `nvm install 22 && nvm use 22`).',
  );
}

// pnpm
const pnpm = run('pnpm', ['--version']);
const wantedMajor = PNPM_VERSION.split('.')[0];
if (pnpm === null) {
  bad('pnpm', 'not found', 'Run `corepack enable` (comes with Node), then open a new terminal.');
} else if (pnpm.split('.')[0] !== wantedMajor) {
  warn(
    'pnpm',
    `${pnpm}; this project pins ${PNPM_VERSION}`,
    'Run `corepack enable` so the pinned version is used.',
  );
} else ok('pnpm', pnpm);

// Git (only needed to get and update the code)
const git = run('git', ['--version']);
if (git === null)
  warn('Git', 'not found', 'Install Git to clone and update the project (see docs/PLAYTEST.md).');
else ok('Git', git.replace(/^git version /, ''));

// Dependencies
if (depsInstalled()) ok('Dependencies', 'installed');
else bad('Dependencies', 'not installed', 'Run `pnpm install` in this folder.');

// Ports
const playtestPid = runningPlaytestPid();
for (const [label, port] of [
  ['Port (server)', DEFAULT_SERVER_PORT],
  ['Port (web)', DEFAULT_WEB_PORT],
]) {
  if (!(await portInUse(port))) ok(label, `${port} is free`);
  else if (playtestPid !== null) {
    warn(
      label,
      `${port} is in use (the playtest is already running, pid ${playtestPid})`,
      'That is fine if you meant to keep it running; open http://localhost:5173.',
    );
  } else {
    bad(
      label,
      `${port} is in use by another program`,
      `Stop that program, or start with another port: \`pnpm playtest -- --${label.includes('web') ? 'web' : 'server'}-port=${port + 1}\`. See "Troubleshooting" in docs/PLAYTEST.md to find what uses it.`,
    );
  }
}

// Docker (optional: only for `pnpm dev` with PostgreSQL)
const docker = run('docker', ['info', '--format', '{{.ServerVersion}}']);
if (docker !== null) ok('Docker (optional)', `running (engine ${docker})`);
else if (run('docker', ['--version']) !== null) {
  warn(
    'Docker (optional)',
    'installed but not running',
    'Only needed for `pnpm dev`. `pnpm playtest` works without it; otherwise start Docker Desktop.',
  );
} else {
  results.push({
    level: 'info',
    label: 'Docker (optional)',
    detail: 'not installed — not needed for `pnpm playtest`',
  });
}

// Playtest data
const dir = dataDir();
if (existsSync(resolve(dir, 'db')))
  results.push({ level: 'info', label: 'Playtest data', detail: `saved in ${dir}` });
else results.push({ level: 'info', label: 'Playtest data', detail: 'none yet (a fresh world)' });

// Report
const icon = { ok: green('✔'), fail: red('✖'), warn: yellow('!'), info: dim('·') };
console.log(bold('\nWorldforge doctor') + dim(`  (${REPO_ROOT})\n`));
for (const r of results) {
  console.log(`${icon[r.level]} ${r.label.padEnd(18)} ${r.detail}`);
  if (r.fix) console.log(`  ${dim('→')} ${r.fix}`);
}
const failed = results.some((r) => r.level === 'fail');
console.log(
  failed
    ? red(bold('\nFix the ✖ items above, then run `pnpm run doctor` again.'))
    : green(
        bold('\nAll set. Start the game with `pnpm playtest`, then open http://localhost:5173.'),
      ),
);
process.exit(failed ? 1 : 0);
