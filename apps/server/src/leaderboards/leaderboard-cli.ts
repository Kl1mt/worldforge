// `pnpm admin:leaderboards <check|refresh>` (ticket 5.2, docs/LEADERBOARDS.md "Recompute check").
// `check` recomputes every stored leaderboard row with game-core's formulas and compares it with
// the stored value and with the hero's current server state; it exits 1 when a row is wrong
// (a value that does not match its formula) and prints stale, outdated and missing rows, which the
// running server's sweep fixes by itself. `refresh` rewrites every hero's rows from current state
// now (after a formula bump, or to backfill without waiting for the sweep); it is safe while the
// server runs (each hero under its own advisory lock). Uses DATABASE_URL, else (outside
// production) the playtest database.
import { loadConfig } from '../config.js';
import { openCliDatabase } from '../db/cli-database.js';
import type { Database } from '../db/types.js';
import { loadWorldState } from '../community/world-state.js';
import { checkLeaderboards, type CheckReport } from './check.js';
import { FormulaVersionSource } from './formulas.js';
import { refreshAll, type SnapshotDeps } from './snapshot.js';

const USAGE = `Usage:
  pnpm admin:leaderboards check      (recompute every stored row; exit 1 if one is wrong)
  pnpm admin:leaderboards refresh    (rewrite every hero's rows from current state)`;

export function cliDeps(db: Database): SnapshotDeps {
  const formulas = new FormulaVersionSource(db, 0);
  return {
    db,
    worldFlags: async () => (await loadWorldState(db)).flags,
    formulaVersions: (now) => formulas.at(now),
  };
}

/** Plain-text summary of a check; exported for tests. */
export function formatCheck(report: CheckReport): string {
  const by = (kind: string) => report.problems.filter((p) => p.kind === kind);
  const lines = [
    `${report.heroes} heroes, ${report.rows} rows: ${report.matching} match their formula and the current state.`,
  ];
  for (const kind of ['wrong', 'outdated', 'stale', 'missing'] as const) {
    const list = by(kind);
    if (list.length === 0) continue;
    lines.push(`${kind}: ${list.length}`);
    for (const p of list.slice(0, 20)) lines.push(`  ${p.characterId} ${p.metric}: ${p.detail}`);
    if (list.length > 20) lines.push(`  … and ${list.length - 20} more`);
  }
  return lines.join('\n');
}

const isMain =
  process.argv[1]?.endsWith('leaderboard-cli.ts') ||
  process.argv[1]?.endsWith('leaderboard-cli.js');
if (isMain) {
  const [command] = process.argv.slice(2);
  if (command !== 'check' && command !== 'refresh') {
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
  const deps = cliDeps(cli.database.db);
  try {
    if (command === 'check') {
      const report = await checkLeaderboards(deps);
      console.log(formatCheck(report));
      if (report.problems.some((p) => p.kind === 'wrong')) process.exitCode = 1;
    } else {
      const updated = await refreshAll(deps, new Date());
      console.log(`Refreshed: ${updated} heroes changed.`);
      console.log(formatCheck(await checkLeaderboards(deps)));
    }
  } catch (err) {
    console.error('Leaderboard command failed:', err);
    process.exitCode = 1;
  } finally {
    await cli.close();
  }
}
