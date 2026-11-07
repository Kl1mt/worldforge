// `pnpm admin:project <status|complete> [projectId]` (ticket 4.6, docs/COMMUNITY.md "Owner CLI").
// The owner's playtest tool: `status` prints every project's progress; `complete <projectId>`
// finishes an open project's remaining stages through the normal completion path (world flag,
// contributor achievements, audit rows marked `by: admin`, telemetry), in one transaction under
// the project lock. There is no API path for it and no way to undo a completion. Uses DATABASE_URL, else (outside production) the playtest database (ticket 4.11).
import { findCommunityProject, isProjectOpen } from '@worldforge/game-core';
import { loadConfig } from '../config.js';
import { openCliDatabase } from '../db/cli-database.js';
import { writeAudit } from '../db/audit.js';
import { withTransaction } from '../db/transaction.js';
import type { Database } from '../db/types.js';
import {
  advanceProject,
  completedProjectIds,
  lockProject,
  projectProgressSummary,
} from './model.js';

const USAGE = `Usage:
  pnpm admin:project status
  pnpm admin:project complete <projectId>     (finishes the project for everyone; cannot be undone)`;

export async function printStatus(db: Database): Promise<void> {
  for (const p of await projectProgressSummary(db)) {
    const head = `${p.id} — ${p.name}: ${p.status}`;
    if (p.status === 'complete')
      console.log(`${head} (on ${p.completedOn}), ${p.contributors} contributors`);
    else if (p.status === 'locked') console.log(`${head}`);
    else {
      const needs = p.current.map((n) => `${n.resource} ${n.delivered}/${n.required}`).join(', ');
      console.log(
        `${head}, stage ${p.stage}/${p.stages} (${needs}), ${p.contributors} contributors`,
      );
    }
  }
}

/** Completes an open project; returns a message. Exported for tests. */
export async function completeProject(db: Database, projectId: string, now: Date): Promise<string> {
  const def = findCommunityProject(projectId);
  if (!def) return `No project "${projectId}".`;
  return withTransaction(db, async (tx) => {
    const row = await lockProject(tx, def.id, now);
    if (row.completedAt) return `${def.name} is already complete.`;
    if (!isProjectOpen(def, await completedProjectIds(tx))) {
      return `${def.name} has not opened yet (complete ${def.requires} first).`;
    }
    const out = await advanceProject(tx, def, row, now, { force: true, by: 'admin' });
    await writeAudit(tx, {
      event: 'community.admin_complete',
      data: { projectId: def.id, stages: out.stagesCompleted },
    });
    return `${def.name}: completed (${out.stagesCompleted.join(', ')}); flag ${def.grantsFlag} set; ${out.awarded} achievements awarded. Running servers see it within a minute.`;
  });
}

const isMain =
  process.argv[1]?.endsWith('project-cli.ts') || process.argv[1]?.endsWith('project-cli.js');
if (isMain) {
  const [command, projectId] = process.argv.slice(2);
  if (command !== 'status' && !(command === 'complete' && projectId)) {
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
    if (command === 'status') await printStatus(database.db);
    else console.log(await completeProject(database.db, projectId!, new Date()));
  } catch (err) {
    console.error('Project command failed:', err);
    process.exitCode = 1;
  } finally {
    await cli.close();
  }
}
