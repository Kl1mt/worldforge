// Shared helpers for the local playtest scripts (ticket P.1; docs/PLAYTEST.md): `pnpm playtest`,
// `pnpm playtest:reset` and `pnpm run doctor`. Plain Node (no dependencies), so they run on Windows,
// macOS and Linux, and `node tools/doctor.mjs` works even before `pnpm install`.
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Keep in sync with apps/server/src/playtest/serve.ts. */
export const dataDir = () => resolve(REPO_ROOT, process.env.PLAYTEST_DATA_DIR || '.playtest-data');
export const LOCK_FILE = 'server.lock';

export const DEFAULT_SERVER_PORT = 3000;
export const DEFAULT_WEB_PORT = 5173;

const rootPackage = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'));
/** e.g. "pnpm@10.28.0" → "10.28.0". */
export const PNPM_VERSION = String(rootPackage.packageManager ?? '').replace(/^pnpm@/, '');

/** `engines.node` is ">=22.12.0 <23": Node 22, at least 22.12. */
export function checkNodeVersion(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  const ok = major === 22 && minor >= 12;
  return { ok, version, wanted: '22 (22.12 or newer)' };
}

export const depsInstalled = () => existsSync(resolve(REPO_ROOT, 'node_modules/.modules.yaml'));

/** True when something accepts connections on `port` (IPv4 or IPv6 localhost). */
export async function portInUse(port) {
  const tryHost = (host) =>
    new Promise((done) => {
      const socket = connect({ host, port });
      const finish = (inUse) => {
        socket.destroy();
        done(inUse);
      };
      socket.setTimeout(500, () => finish(false));
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
    });
  const results = await Promise.all([tryHost('127.0.0.1'), tryHost('::1')]);
  return results.some(Boolean);
}

export function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** The pid of a running playtest server on the data directory, or null. */
export function runningPlaytestPid() {
  try {
    const { pid } = JSON.parse(readFileSync(resolve(dataDir(), LOCK_FILE), 'utf8'));
    return Number.isInteger(pid) && isRunning(pid) ? pid : null;
  } catch {
    return null;
  }
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
export const bold = paint('1');
export const green = paint('32');
export const red = paint('31');
export const yellow = paint('33');
export const dim = paint('2');
