import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import { SCORE_METRICS, computeScore, type ScoreMetric } from '@worldforge/game-core';
import { characters, leaderboardEntries } from '../db/schema.js';
import { inputsHash, snapshotInput, type SnapshotDeps } from './snapshot.js';

/**
 * The recompute check (ticket 5.2, docs/LEADERBOARDS.md "Recompute check"): every stored row must
 * equal game-core's `computeScore` of its stored input at the current formula version, and that
 * input must still be the hero's current server state. Read-only.
 *
 * - `wrong`: the stored value or sort key is not what the formula gives for the stored input (or
 *   the hash does not match the input). This should never happen; it means a write bypassed
 *   `refreshHeroScores` or a formula changed without a version bump.
 * - `outdated`: computed by an older formula version (the sweep recomputes these).
 * - `stale`: the hero's state moved since the row was written (an event the refresh missed; the
 *   sweep catches it within a rotation).
 * - `missing`: a hero without a row for a metric (before the backfill reached it).
 */
export interface CheckProblem {
  characterId: string;
  metric: ScoreMetric;
  kind: 'wrong' | 'outdated' | 'stale' | 'missing';
  detail: string;
}

export interface CheckReport {
  heroes: number;
  rows: number;
  matching: number;
  problems: CheckProblem[];
}

export async function checkLeaderboards(
  deps: SnapshotDeps,
  batch = 200,
  now: Date = new Date(),
): Promise<CheckReport> {
  const report: CheckReport = { heroes: 0, rows: 0, matching: 0, problems: [] };
  // Ticket 6.1: "current" is the version in force now (an older one until the season ends).
  const versions = await deps.formulaVersions(now);
  const flags = await deps.worldFlags();
  const worldFlags = async () => flags;
  let cursor: string | null = null;
  for (;;) {
    const heroes = await deps.db
      .select()
      .from(characters)
      .where(and(isNull(characters.deletedAt), cursor ? gt(characters.id, cursor) : undefined))
      .orderBy(asc(characters.id))
      .limit(batch);
    for (const hero of heroes) {
      report.heroes += 1;
      const rows = await deps.db
        .select()
        .from(leaderboardEntries)
        .where(eq(leaderboardEntries.characterId, hero.id));
      const current = await snapshotInput(deps.db, hero, worldFlags);
      for (const metric of SCORE_METRICS) {
        const row = rows.find((r) => r.metric === metric);
        const problem = (kind: CheckProblem['kind'], detail: string) =>
          report.problems.push({ characterId: hero.id, metric, kind, detail });
        if (!row) {
          problem('missing', 'no row');
          continue;
        }
        report.rows += 1;
        if (row.formulaVersion !== versions[metric]) {
          problem('outdated', `version ${row.formulaVersion}, current ${versions[metric]}`);
          continue;
        }
        const score = computeScore(metric, row.input, versions[metric]);
        if (
          score.value !== row.value ||
          JSON.stringify(score.sortKey) !== JSON.stringify(row.sortKey) ||
          inputsHash(metric, row.input, versions[metric]) !== row.inputsHash
        ) {
          problem(
            'wrong',
            `stored ${row.value} ${JSON.stringify(row.sortKey)}, formula gives ${score.value} ${JSON.stringify(score.sortKey)}`,
          );
          continue;
        }
        if (
          row.inputsHash !== inputsHash(metric, current, versions[metric]) ||
          row.level !== hero.level
        ) {
          problem(
            'stale',
            `stored ${row.value}, now ${computeScore(metric, current, versions[metric]).value}`,
          );
          continue;
        }
        report.matching += 1;
      }
    }
    if (heroes.length < batch) return report;
    cursor = heroes.at(-1)!.id;
  }
}
