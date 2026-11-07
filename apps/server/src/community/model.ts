import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  COMMUNITY_PROJECTS,
  contributionWindow,
  findCommunityProject,
  isProjectOpen,
  isStageComplete,
  stageAgeDays,
  stageCap,
  type CommunityProjectDefinition,
  type ProjectResource,
  type ResourceAmounts,
} from '@worldforge/game-core';
import {
  communityContributions,
  communityProjectProgress,
  communityProjects,
  worldFlags,
} from '../db/schema.js';
import type { Database, Executor, Transaction } from '../db/types.js';
import { withTransaction } from '../db/transaction.js';
import { writeAudit } from '../db/audit.js';
import { ApiError } from '../errors.js';
import { awardAchievements } from '../achievements/award.js';
import { recordTelemetry } from '../telemetry/record.js';

/**
 * Community project state (ticket 4.6, docs/COMMUNITY.md). Definitions are game-core data; the
 * database holds one row per touched project (`community_projects`, the lock), the delivered
 * totals (`community_project_progress`) and what each account gave per window
 * (`community_contributions`). Everything that changes them runs under `lockProject`.
 */

export function projectOrThrow(projectId: string): CommunityProjectDefinition {
  const def = findCommunityProject(projectId);
  if (!def) throw new ApiError(404, 'not_found', 'No such project.');
  return def;
}

export interface ProjectRow {
  projectId: string;
  stageIndex: number;
  completedAt: Date | null;
}

/**
 * Creates the project's row if needed and locks it (`for update`). Every contribution and stage
 * change of the project serialises here, so totals, caps and completion are exact. Lock order:
 * the hero first (its activity settles), then the project, then the counter rows.
 */
export async function lockProject(
  tx: Transaction,
  projectId: string,
  now: Date,
): Promise<ProjectRow> {
  await tx
    .insert(communityProjects)
    .values({ projectId, stageIndex: 0, updatedAt: now })
    .onConflictDoNothing();
  const [row] = await tx
    .select({
      projectId: communityProjects.projectId,
      stageIndex: communityProjects.stageIndex,
      completedAt: communityProjects.completedAt,
    })
    .from(communityProjects)
    .where(eq(communityProjects.projectId, projectId))
    .for('update');
  return row!;
}

export async function completedProjectIds(db: Executor): Promise<Set<string>> {
  const rows = await db
    .select({ id: communityProjects.projectId })
    .from(communityProjects)
    .where(isNotNull(communityProjects.completedAt));
  return new Set(rows.map((r) => r.id));
}

export async function stageTotals(
  db: Executor,
  projectId: string,
  stageId: string,
): Promise<ResourceAmounts> {
  const rows = await db
    .select({
      resource: communityProjectProgress.resource,
      amount: communityProjectProgress.amount,
    })
    .from(communityProjectProgress)
    .where(
      and(
        eq(communityProjectProgress.projectId, projectId),
        eq(communityProjectProgress.stageId, stageId),
      ),
    );
  return Object.fromEntries(rows.map((r) => [r.resource, r.amount])) as ResourceAmounts;
}

export async function givenInWindow(
  db: Executor,
  projectId: string,
  stageId: string,
  accountId: string,
  day: string,
): Promise<ResourceAmounts> {
  const rows = await db
    .select({ resource: communityContributions.resource, amount: communityContributions.amount })
    .from(communityContributions)
    .where(
      and(
        eq(communityContributions.projectId, projectId),
        eq(communityContributions.stageId, stageId),
        eq(communityContributions.accountId, accountId),
        eq(communityContributions.day, day),
      ),
    );
  return Object.fromEntries(rows.map((r) => [r.resource, r.amount])) as ResourceAmounts;
}

/**
 * The day of the stage's first gift (null if none yet): the cap grows with the days since
 * (ticket B.3, game-core `stageAgeDays`). Read under the project lock, like the totals.
 */
export async function stageFirstDay(
  db: Executor,
  projectId: string,
  stageId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ first: sql<string | null>`min(${communityContributions.day})::text` })
    .from(communityContributions)
    .where(
      and(
        eq(communityContributions.projectId, projectId),
        eq(communityContributions.stageId, stageId),
      ),
    );
  return row?.first ?? null;
}

/** Adds what was accepted to the stage totals and to the account's row for this window. */
export async function addContribution(
  tx: Transaction,
  projectId: string,
  stageId: string,
  accountId: string,
  day: string,
  accepted: ResourceAmounts,
): Promise<void> {
  const entries = (Object.entries(accepted) as [ProjectResource, number][]).filter(
    ([, n]) => n > 0,
  );
  if (entries.length === 0) return;
  await tx
    .insert(communityProjectProgress)
    .values(entries.map(([resource, amount]) => ({ projectId, stageId, resource, amount })))
    .onConflictDoUpdate({
      target: [
        communityProjectProgress.projectId,
        communityProjectProgress.stageId,
        communityProjectProgress.resource,
      ],
      set: { amount: sql`${communityProjectProgress.amount} + excluded.amount` },
    });
  await tx
    .insert(communityContributions)
    .values(
      entries.map(([resource, amount]) => ({
        projectId,
        stageId,
        accountId,
        day,
        resource,
        amount,
      })),
    )
    .onConflictDoUpdate({
      target: [
        communityContributions.projectId,
        communityContributions.stageId,
        communityContributions.accountId,
        communityContributions.day,
        communityContributions.resource,
      ],
      set: { amount: sql`${communityContributions.amount} + excluded.amount` },
    });
}

export interface AdvanceOutcome {
  /** Stage ids completed by this call, in order. */
  stagesCompleted: string[];
  projectCompleted: boolean;
  /** Accounts newly awarded the project's achievement. */
  awarded: number;
}

/**
 * Under the project lock: while the current stage is complete, moves on (audit
 * `community.stage_complete`, telemetry `community.stage`); after the last stage completes the
 * project, sets its world flag and awards the contributors' achievement (`community.project_complete`).
 * `force` completes the current stages regardless of totals (the owner's CLI only).
 */
export async function advanceProject(
  tx: Transaction,
  def: CommunityProjectDefinition,
  row: ProjectRow,
  now: Date,
  { force = false, by }: { force?: boolean; by?: 'admin' } = {},
): Promise<AdvanceOutcome> {
  const out: AdvanceOutcome = { stagesCompleted: [], projectCompleted: false, awarded: 0 };
  if (row.completedAt !== null) return out;
  let index = row.stageIndex;
  while (index < def.stages.length) {
    const stage = def.stages[index]!;
    if (!force && !isStageComplete(stage, await stageTotals(tx, def.id, stage.id))) break;
    index += 1;
    out.stagesCompleted.push(stage.id);
    await writeAudit(tx, {
      event: 'community.stage_complete',
      data: { projectId: def.id, stageId: stage.id, stageIndex: index - 1, ...(by ? { by } : {}) },
    });
    recordTelemetry(tx, now, [{ metric: 'community.stage', dims: [def.id, stage.id] }]);
  }
  if (out.stagesCompleted.length === 0) return out;
  const done = index >= def.stages.length;
  await tx
    .update(communityProjects)
    .set({ stageIndex: index, updatedAt: now, ...(done ? { completedAt: now } : {}) })
    .where(eq(communityProjects.projectId, def.id));
  if (!done) return out;
  out.projectCompleted = true;
  await tx
    .insert(worldFlags)
    .values({ flagId: def.grantsFlag, projectId: def.id, setAt: now })
    .onConflictDoNothing();
  const contributors = await tx
    .selectDistinct({ accountId: communityContributions.accountId })
    .from(communityContributions)
    .where(eq(communityContributions.projectId, def.id));
  for (const { accountId } of contributors) {
    const got = await awardAchievements(
      tx,
      { accountId, characterId: null, now, source: 'live' },
      { communityProjects: [def.id] },
    );
    out.awarded += got.length;
  }
  await writeAudit(tx, {
    event: 'community.project_complete',
    data: {
      projectId: def.id,
      flag: def.grantsFlag,
      contributors: contributors.length,
      ...(by ? { by } : {}),
    },
  });
  return out;
}

/**
 * Ticket B.3: finishes the stages of an open project whose needs are already met by what they
 * hold. That only happens when a balance change lowered a need below a live stage's totals; then
 * no contribution could ever finish it (nothing more is taken). Reads without a lock first, so a
 * normal contribution pays one indexed read; the advance itself runs under the project lock, in
 * its own transaction (it must stand even if the contribution after it is refused). Returns
 * whether the project completed.
 */
export async function catchUpProject(
  db: Database,
  def: CommunityProjectDefinition,
  now: Date,
): Promise<boolean> {
  const [peek] = await db
    .select({
      stageIndex: communityProjects.stageIndex,
      completedAt: communityProjects.completedAt,
    })
    .from(communityProjects)
    .where(eq(communityProjects.projectId, def.id));
  if (!peek || peek.completedAt !== null) return false;
  const stage = def.stages[peek.stageIndex];
  if (!stage || !isStageComplete(stage, await stageTotals(db, def.id, stage.id))) return false;
  return withTransaction(db, async (tx) => {
    const row = await lockProject(tx, def.id, now);
    if (row.completedAt !== null || !isProjectOpen(def, await completedProjectIds(tx)))
      return false;
    return (await advanceProject(tx, def, row, now)).projectCompleted;
  });
}

// --- Views.

export interface NeedView {
  resource: ProjectResource;
  required: number;
  delivered: number;
  /** The account's cap per window on this need. */
  cap: number;
  /** What the account gave to this need in the current window. */
  givenToday: number;
}

export interface StageView {
  id: string;
  name: string;
  description: string;
  status: 'done' | 'current' | 'upcoming';
  needs: NeedView[];
}

export interface ProjectView {
  id: string;
  name: string;
  description: string;
  status: 'locked' | 'open' | 'complete';
  requires: string | null;
  grantsFlag: string;
  completedOn: string | null;
  stageIndex: number;
  stages: StageView[];
  /** Distinct accounts that gave anything (a count; no names). */
  contributors: number;
  /** The viewing account's own totals over the whole project. */
  yours: { resource: ProjectResource; amount: number }[];
  reward: { achievementId: string; earned: boolean };
}

export interface ProjectBoard {
  /** The contribution window (game-clock UTC day) and when it resets. */
  window: { day: string; resetsAt: string };
  projects: ProjectView[];
}

export async function projectBoard(
  db: Executor,
  /** The viewer; null for the admin summary (no "yours"). */
  accountId: string | null,
  now: Date,
  earned: ReadonlySet<string>,
): Promise<ProjectBoard> {
  const { day, endsAt } = contributionWindow(now);
  const ids = COMMUNITY_PROJECTS.map((p) => p.id);
  const [rows, totals, mine, contributors, firstDays] = await Promise.all([
    db
      .select({
        projectId: communityProjects.projectId,
        stageIndex: communityProjects.stageIndex,
        completedAt: communityProjects.completedAt,
      })
      .from(communityProjects)
      .where(inArray(communityProjects.projectId, ids)),
    db
      .select()
      .from(communityProjectProgress)
      .where(inArray(communityProjectProgress.projectId, ids)),
    accountId === null
      ? Promise.resolve([])
      : db
          .select({
            projectId: communityContributions.projectId,
            stageId: communityContributions.stageId,
            day: communityContributions.day,
            resource: communityContributions.resource,
            amount: communityContributions.amount,
          })
          .from(communityContributions)
          .where(eq(communityContributions.accountId, accountId)),
    db
      .select({
        projectId: communityContributions.projectId,
        n: sql<number>`count(distinct ${communityContributions.accountId})::int`,
      })
      .from(communityContributions)
      .groupBy(communityContributions.projectId),
    // Ticket B.3: each stage's first day, for the cap that grows with the stage's age.
    db
      .select({
        projectId: communityContributions.projectId,
        stageId: communityContributions.stageId,
        first: sql<string>`min(${communityContributions.day})::text`,
      })
      .from(communityContributions)
      .groupBy(communityContributions.projectId, communityContributions.stageId),
  ]);
  const ageOf = (p: string, s: string) =>
    stageAgeDays(firstDays.find((f) => f.projectId === p && f.stageId === s)?.first ?? null, day);
  const rowOf = new Map(rows.map((r) => [r.projectId, r]));
  const completed = new Set(rows.filter((r) => r.completedAt !== null).map((r) => r.projectId));
  const total = (p: string, s: string, r: string) =>
    totals.find((t) => t.projectId === p && t.stageId === s && t.resource === r)?.amount ?? 0;
  const projects = COMMUNITY_PROJECTS.map((def): ProjectView => {
    const row = rowOf.get(def.id);
    const stageIndex = row?.stageIndex ?? 0;
    const status = row?.completedAt
      ? 'complete'
      : isProjectOpen(def, completed)
        ? 'open'
        : 'locked';
    const yours = new Map<ProjectResource, number>();
    for (const m of mine.filter((m) => m.projectId === def.id)) {
      const r = m.resource as ProjectResource;
      yours.set(r, (yours.get(r) ?? 0) + m.amount);
    }
    return {
      id: def.id,
      name: def.name,
      description: def.description,
      status,
      requires: def.requires,
      grantsFlag: def.grantsFlag,
      completedOn: row?.completedAt ? row.completedAt.toISOString().slice(0, 10) : null,
      stageIndex,
      stages: def.stages.map((stage, i) => ({
        id: stage.id,
        name: stage.name,
        description: stage.description,
        status:
          i < stageIndex ? 'done' : i === stageIndex && status === 'open' ? 'current' : 'upcoming',
        needs: stage.needs.map((n) => ({
          resource: n.resource,
          required: n.amount,
          delivered: Math.min(n.amount, total(def.id, stage.id, n.resource)),
          cap: stageCap(stage, n.resource, ageOf(def.id, stage.id)),
          givenToday:
            mine.find(
              (m) =>
                m.projectId === def.id &&
                m.stageId === stage.id &&
                m.day === day &&
                m.resource === n.resource,
            )?.amount ?? 0,
        })),
      })),
      contributors: contributors.find((c) => c.projectId === def.id)?.n ?? 0,
      yours: [...yours].map(([resource, amount]) => ({ resource, amount })),
      reward: {
        achievementId: def.rewardAchievementId,
        earned: earned.has(def.rewardAchievementId),
      },
    };
  });
  return { window: { day, resetsAt: endsAt.toISOString() }, projects };
}

/** Admin status (D.3): progress of every project as fractions, no accounts. */
export async function projectProgressSummary(db: Executor) {
  const board = await projectBoard(db, null, new Date(), new Set());
  return board.projects.map((p) => ({
    id: p.id,
    name: p.name,
    status: p.status,
    stage: Math.min(p.stageIndex + 1, p.stages.length),
    stages: p.stages.length,
    completedOn: p.completedOn,
    contributors: p.contributors,
    current:
      p.status === 'open'
        ? p.stages[p.stageIndex]!.needs.map((n) => ({
            resource: n.resource,
            delivered: n.delivered,
            required: n.required,
          }))
        : [],
  }));
}
