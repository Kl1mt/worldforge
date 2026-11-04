// `pnpm playtest` (ticket P.1; docs/PLAYTEST.md): starts the local playtest server (PGlite saved in
// .playtest-data/, no Docker) and the web client, then prints the address to open.
//
//   pnpm playtest                    real time
//   pnpm playtest:fast               farming clock ×60 (3 h of offline progress in 3 minutes)
//   pnpm playtest -- --fast=120      any speed-up factor
//   pnpm playtest -- --server-port=3001 --web-port=5174
//
// Ctrl+C stops both. Runs node directly (no shell), so it behaves the same on Windows, macOS and Linux.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import {
  bold,
  checkNodeVersion,
  dataDir,
  DEFAULT_SERVER_PORT,
  DEFAULT_WEB_PORT,
  depsInstalled,
  dim,
  green,
  portInUse,
  red,
  REPO_ROOT,
  runningPlaytestPid,
  yellow,
} from './lib.mjs';

const fail = (lines) => {
  for (const line of lines) console.error(line);
  process.exit(1);
};

// --- arguments -----------------------------------------------------------------------------------
let timeScale = Number(process.env.PLAYTEST_TIME_SCALE || 1);
let serverPort = Number(process.env.PORT || DEFAULT_SERVER_PORT);
let webPort = DEFAULT_WEB_PORT;
for (const arg of process.argv.slice(2)) {
  const [name, value] = arg.split('=');
  if (arg === '--') continue;
  else if (name === '--fast') timeScale = value === undefined ? 60 : Number(value);
  else if (name === '--server-port') serverPort = Number(value);
  else if (name === '--web-port') webPort = Number(value);
  else fail([red(`Unknown option: ${arg}`), 'Options: --fast[=N], --server-port=N, --web-port=N']);
}
if (!Number.isFinite(timeScale) || timeScale < 1)
  fail([red('--fast needs a number ≥ 1, e.g. --fast=60')]);
for (const port of [serverPort, webPort]) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail([red(`Invalid port: ${port}`)]);
}

// --- preflight -----------------------------------------------------------------------------------
const node = checkNodeVersion();
if (!node.ok) {
  fail([
    red(`Node ${node.version} is running, but Worldforge needs Node ${node.wanted}.`),
    'Switch with `fnm use` or `nvm use` in this folder (see docs/PLAYTEST.md), then run `pnpm run doctor`.',
  ]);
}
if (!depsInstalled()) fail([red('Dependencies are not installed.'), 'Run `pnpm install` first.']);
const pid = runningPlaytestPid();
if (pid !== null) {
  fail([
    red(`A playtest server is already running (pid ${pid}).`),
    'Use that one, or stop it with Ctrl+C in its terminal.',
  ]);
}
for (const [label, port, flag] of [
  ['server', serverPort, '--server-port'],
  ['web', webPort, '--web-port'],
]) {
  if (await portInUse(port)) {
    fail([
      red(`Port ${port} (${label}) is already in use.`),
      `Stop the program using it (maybe another \`pnpm dev\` or \`pnpm playtest\`), or pick another port:`,
      `  pnpm playtest -- ${flag}=${port + 1}`,
      'Run `pnpm run doctor` for details.',
    ]);
  }
}

// --- start ---------------------------------------------------------------------------------------
const serverDir = resolve(REPO_ROOT, 'apps/server');
const webDir = resolve(REPO_ROOT, 'apps/web');
// pnpm links each package's dependencies into its own node_modules folder.
const viteBin = resolve(webDir, 'node_modules/vite/bin/vite.js');

const children = [];
let stopping = false;

/** Server logs are JSON lines (pino); show them as short readable lines. */
function formatServerLine(line) {
  try {
    const entry = JSON.parse(line);
    const level = { 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' }[entry.level] ?? 'log';
    const extra = entry.err?.message ? ` — ${entry.err.message}` : '';
    const text = `${level.padEnd(5)} ${entry.msg ?? ''}${extra}`;
    return entry.level >= 50 ? red(text) : entry.level >= 40 ? yellow(text) : text;
  } catch {
    return line;
  }
}

function start(name, args, cwd, env, format = (line) => line) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', (line) => {
      if (line.trim()) console.log(`${dim(`[${name}]`)} ${format(line)}`);
    });
  }
  child.on('exit', (code, signal) => {
    if (!stopping) {
      console.error(red(`\nThe ${name} stopped unexpectedly (${signal ?? `exit code ${code}`}).`));
      console.error(
        'Scroll up for its error message, or see "Troubleshooting" in docs/PLAYTEST.md.',
      );
      stop(1);
    }
  });
  children.push(child);
  return child;
}

/**
 * `fromConsole`: Ctrl+C. The terminal already sends it to the child processes too; on Windows,
 * `child.kill()` would end them abruptly instead, before the database is closed, so there we
 * only wait for them.
 */
function stop(code = 0, { fromConsole = false } = {}) {
  if (stopping) return;
  stopping = true;
  console.log(dim('\nStopping… (your progress is saved)'));
  let left = children.filter((c) => c.exitCode === null && c.signalCode === null).length;
  if (left === 0) process.exit(code);
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    child.once('exit', () => {
      left -= 1;
      if (left === 0) process.exit(code);
    });
    if (!(fromConsole && process.platform === 'win32')) child.kill('SIGINT');
  }
  // Last resort if a process ignores the signal.
  setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
    process.exit(code);
  }, 10_000).unref();
}
process.on('SIGINT', () => stop(0, { fromConsole: true }));
process.on('SIGTERM', () => stop(0));

console.log(bold('Starting the Worldforge playtest…'));
console.log(dim(`Data folder: ${dataDir()}`));
if (timeScale > 1) {
  console.log(
    yellow(
      `FAST TIME is on: the farming clock runs ×${timeScale} (3 h offline cap ≈ ${Math.round((180 / timeScale) * 10) / 10} min).`,
    ),
  );
}

start(
  'server',
  ['--conditions=source', '--import', 'tsx', 'src/playtest/serve.ts'],
  serverDir,
  {
    PORT: String(serverPort),
    HOST: '127.0.0.1',
    LOG_LEVEL: process.env.LOG_LEVEL || 'warn',
    PLAYTEST_TIME_SCALE: String(timeScale),
  },
  formatServerLine,
);
start('web', [viteBin, '--port', String(webPort), '--clearScreen', 'false'], webDir, {
  WORLDFORGE_SERVER_URL: `http://127.0.0.1:${serverPort}`,
});

// --- wait until both answer, then say where to go -----------------------------------------------
const webUrl = `http://localhost:${webPort}`;
async function ready(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}
const deadline = Date.now() + 120_000;
while (!stopping) {
  // The server first (directly, so the web proxy logs no errors meanwhile), then the web client.
  if (
    (await ready(`http://127.0.0.1:${serverPort}/api/health`)) &&
    (await ready(webUrl)) &&
    (await ready(`${webUrl}/api/health`))
  ) {
    const line = '─'.repeat(52);
    console.log(`\n${green(line)}`);
    console.log(green(bold('  Worldforge is running.')));
    console.log(`  Open ${bold(webUrl)} in your browser.`);
    console.log(`  Stop with ${bold('Ctrl+C')}. Progress is kept between runs.`);
    console.log(`${green(line)}\n`);
    break;
  }
  if (Date.now() > deadline) {
    console.error(
      yellow(
        'Still not ready after 2 minutes. Check the messages above, or run `pnpm run doctor`.',
      ),
    );
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
