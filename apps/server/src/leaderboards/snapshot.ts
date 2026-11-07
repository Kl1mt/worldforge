import { createHash } from 'node:crypto';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import {
  FORMULA_VERSIONS,
  SCORE_METRICS,
  computeScore,
  metricInput,
  type ScoreMetric,
  type ScoringInput,
  type WorldFlags,
} from '@worldforge/game-core';
import { characters, leaderboardEntries, type Character } from '../db/schema.js';
import { withTransaction } from '../db/transaction.js';
import type { Database, Executor } from '../db/types.js';
import { canonicalJson } from '../idempotency/index.js';
import { scoringInput } from '../scores/routes.js';

/**
 * Leaderboard snapshots (ticket 5.2, docs/LEADERBOARDS.md "Boards"). A hero's four rows are
 * recomputed from server state after each event that can move a score, never from anything a
 * client sends. Each metric's slice of the input is hashed; a refresh whose slices are unchanged
 * writes nothing (the debounce: a settlement that only adds XP recomputes Character Level, not
 * Power).
 */

/** Where world flags come from: the app's cache, or the database for the CLI. */
export interface SnapshotDeps {
  db: Database;
  worldFlags: () => Promise<WorldFlags>;
}

export type EntryRow = typeof leaderboardEntries.$inferSelect;

/** The input as stored: equipment in slot order, so equal state always hashes the same. */
export async function snapshotInput(
  db: Executor,
  hero: Character,
  worldFlags: () => Promise<WorldFlags>,
): Promise<ScoringInput> {
  const input = await scoringInput({ worldState: { flags: worldFlags } }, db, hero);
  return {
    ...input,
    equipment: [...input.equipment].sort((a, b) =>
      a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0,
    ),
  };
}

/** SHA-256 of the canonical JSON of `metric`'s slice of the input (`inputs_hash`). */
export function inputsHash(metric: ScoreMetric, input: ScoringInput): string {
  return createHash('sha256')
    .update(`${metric}:v${FORMULA_VERSIONS[metric]}\n${canonicalJson(metricInput(metric, input))}`)
    .digest('hex');
}

/** Whether a stored row is current for `input`: same formula version and slice hash. */
function isCurrent(
  row: Pick<EntryRow, 'formulaVersion' | 'inputsHash' | 'metric'>,
  input: ScoringInput,
) {
  return (
    row.formulaVersion === FORMULA_VERSIONS[row.metric] &&
    row.inputsHash === inputsHash(row.metric, input)
  );
}

const sameKey = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

export type RefreshOutcome = 'unchanged' | 'updated' | 'missing';

/**
 * Brings one hero's four rows up to date with its current state. `now` is the game-clock moment of
 * the event that moved the score (the request's clock, read before its transaction: the window
 * rule), and becomes `achieved_at` of every row whose `sort_key` changed.
 *
 * Two refreshes of one hero serialise on a transaction-scoped advisory lock and each re-reads the
 * state under it, so the last one to run writes the newest committed state; the hero's own rows
 * (the character row, items) are only read, never locked, so a refresh never waits on gameplay.
 */
export async function refreshHeroScores(
  deps: SnapshotDeps,
  characterId: string,
  now: Date,
): Promise<RefreshOutcome> {
  // Fast path without the lock: nothing moved since the last refresh.
  const [hero] = await deps.db.select().from(characters).where(eq(characters.id, characterId));
  if (!hero) return 'missing';
  // Read once, outside the transaction: the cache may query the pool (PGlite has one connection).
  const flags = await deps.worldFlags();
  const fixedFlags = async () => flags;
  const input = await snapshotInput(deps.db, hero, fixedFlags);
  const stored = await deps.db
    .select({
      metric: leaderboardEntries.metric,
      formulaVersion: leaderboardEntries.formulaVersion,
      inputsHash: leaderboardEntries.inputsHash,
      level: leaderboardEntries.level,
    })
    .from(leaderboardEntries)
    .where(eq(leaderboardEntries.characterId, characterId));
  if (
    stored.length === SCORE_METRICS.length &&
    stored.every((r) => isCurrent(r, input) && r.level === hero.level)
  )
    return 'unchanged';

  return withTransaction(deps.db, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`leaderboard:${characterId}`}, 0))`,
    );
    const [fresh] = await tx.select().from(characters).where(eq(characters.id, characterId));
    if (!fresh) return 'missing';
    const current = await snapshotInput(tx, fresh, fixedFlags);
    const rows = await tx
      .select()
      .from(leaderboardEntries)
      .where(eq(leaderboardEntries.characterId, characterId));
    let wrote = false;
    for (const metric of SCORE_METRICS) {
      const row = rows.find((r) => r.metric === metric);
      if (row && isCurrent(row, current)) {
        // The score did not move, but the bracket filter needs the hero's level on every row.
        if (row.level !== fresh.level) {
          await tx
            .update(leaderboardEntries)
            .set({ level: fresh.level, updatedAt: now })
            .where(
              and(
                eq(leaderboardEntries.characterId, characterId),
                eq(leaderboardEntries.metric, metric),
              ),
            );
          wrote = true;
        }
        continue;
      }
      const score = computeScore(metric, current);
      // `achieved_at` moves only when the standing does. A formula bump that changes the key
      // keeps it (the hero reached this standing then, measured anew), unless the slice moved too.
      const keyMoved = !row || !sameKey(row.sortKey, score.sortKey);
      const versionOnly =
        row !== undefined &&
        row.formulaVersion !== score.formulaVersion &&
        canonicalJson(metricInput(metric, row.input)) ===
          canonicalJson(metricInput(metric, current));
      const achievedAt = row && (!keyMoved || versionOnly) ? row.achievedAt : now;
      const values = {
        characterId,
        metric,
        accountId: fresh.accountId,
        classId: fresh.classId,
        level: fresh.level,
        formulaVersion: score.formulaVersion,
        value: score.value,
        sortKey: score.sortKey,
        inputsHash: inputsHash(metric, current),
        input: current,
        achievedAt,
        updatedAt: now,
      };
      await tx
        .insert(leaderboardEntries)
        .values(values)
        .onConflictDoUpdate({
          target: [leaderboardEntries.characterId, leaderboardEntries.metric],
          set: {
            accountId: values.accountId,
            classId: values.classId,
            level: values.level,
            formulaVersion: values.formulaVersion,
            value: values.value,
            sortKey: values.sortKey,
            inputsHash: values.inputsHash,
            input: values.input,
            achievedAt: values.achievedAt,
            updatedAt: values.updatedAt,
          },
        });
      wrote = true;
    }
    return wrote ? 'updated' : 'unchanged';
  });
}

/** Refreshes `characterId` if it is one of the account's heroes, else every hero of the account. */
export async function refreshAccountHeroes(
  deps: SnapshotDeps,
  accountId: string,
  now: Date,
  characterId?: string,
): Promise<number> {
  const heroes = await deps.db
    .select({ id: characters.id })
    .from(characters)
    .where(
      and(
        eq(characters.accountId, accountId),
        characterId ? eq(characters.id, characterId) : undefined,
      ),
    )
    .orderBy(asc(characters.id));
  let updated = 0;
  for (const h of heroes) {
    if ((await refreshHeroScores(deps, h.id, now)) === 'updated') updated += 1;
  }
  return updated;
}

/** Heroes without a current row for every metric (new heroes, existing ones before 5.2, bumps). */
export async function heroesNeedingRows(db: Executor, limit: number): Promise<string[]> {
  const versions = SCORE_METRICS.map(
    (m) =>
      sql`(${leaderboardEntries.metric} = ${m} and ${leaderboardEntries.formulaVersion} = ${FORMULA_VERSIONS[m]})`,
  );
  const rows = await db
    .select({ id: characters.id })
    .from(characters)
    .where(
      sql`(select count(*) from ${leaderboardEntries}
        where ${leaderboardEntries.characterId} = ${characters.id}
          and (${sql.join(versions, sql` or `)})) < ${SCORE_METRICS.length}`,
    )
    .orderBy(asc(characters.id))
    .limit(limit);
  return rows.map((r) => r.id);
}

/**
 * The background sweep (ticket 5.2): each run refreshes heroes that have no current rows first
 * (the lazy backfill after deploy and after a formula bump), then continues a rotation over every
 * hero from `cursor`, which catches what no request of the hero's own saw: scheduled settlements
 * while the player is away, a world flag set by the community, a guild boss stage broken by a
 * guildmate. Unchanged heroes cost three small reads. Returns the next cursor.
 */
export async function sweepLeaderboards(
  deps: SnapshotDeps,
  now: Date,
  options: { batch: number; cursor: string | null },
): Promise<{ cursor: string | null; refreshed: number; updated: number }> {
  const missing = await heroesNeedingRows(deps.db, options.batch);
  const room = Math.max(0, options.batch - missing.length);
  const rotation = room
    ? await deps.db
        .select({ id: characters.id })
        .from(characters)
        .where(options.cursor ? gt(characters.id, options.cursor) : undefined)
        .orderBy(asc(characters.id))
        .limit(room)
    : [];
  const ids = [...new Set([...missing, ...rotation.map((r) => r.id)])];
  let updated = 0;
  for (const id of ids) {
    if ((await refreshHeroScores(deps, id, now)) === 'updated') updated += 1;
  }
  const cursor = rotation.length < room ? null : (rotation.at(-1)?.id ?? options.cursor);
  return { cursor, refreshed: ids.length, updated };
}

/** Every hero's rows (the CLI's `refresh`); returns how many heroes changed. */
export async function refreshAll(deps: SnapshotDeps, now: Date, batch = 200): Promise<number> {
  let cursor: string | null = null;
  let updated = 0;
  for (;;) {
    const rows = await deps.db
      .select({ id: characters.id })
      .from(characters)
      .where(cursor ? gt(characters.id, cursor) : undefined)
      .orderBy(asc(characters.id))
      .limit(batch);
    for (const r of rows) {
      if ((await refreshHeroScores(deps, r.id, now)) === 'updated') updated += 1;
    }
    if (rows.length < batch) return updated;
    cursor = rows.at(-1)!.id;
  }
}
