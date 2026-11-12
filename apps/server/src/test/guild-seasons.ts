import { guildBossWeek } from '@worldforge/game-core';
import {
  characters,
  communityContributions,
  guildBossAttempts,
  guildBossStages,
  leaderboardEntries,
  seasons,
} from '../db/schema.js';
import type { Database } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';

/**
 * Ticket 8.4 test fixtures: the stored facts the guild season roll reads, written directly
 * (a guild boss stage with the attempt that broke it, a hero's PvE Progress row, a town-works gift).
 */

export const DAY = 86_400_000;

/** The start of the UTC day `days` after the wall clock's (dates derive from the clock). */
export function dayFromNow(days: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() + days * DAY);
}

export async function insertSeason(db: Database, number: number, startsAt: Date, endsAt: Date) {
  const [row] = await db.insert(seasons).values({ number, startsAt, endsAt }).returning();
  return row!;
}

let attemptSeq = 0;

/** A stage the guild reached at `at`, by an attempt of `accountId` (who thereby fought for it). */
export async function insertStage(
  db: Database,
  guildId: string,
  accountId: string,
  stage: number,
  at: Date,
) {
  const week = guildBossWeek(at.getTime()).key;
  const id = uuidv7();
  await db.insert(guildBossAttempts).values({
    id,
    accountId,
    week,
    attemptNo: (attemptSeq = (attemptSeq % 30_000) + 1),
    guildId,
    bossId: 'risenGravewarden',
    snapshot: {} as never,
    damage: 1,
    counted: 1,
    end: 'fell',
    durationMs: 1,
    createdAt: at,
  });
  await db.insert(guildBossStages).values({ guildId, week, stage, reachedAt: at, attemptId: id });
}

/** A hero with a PvE Progress row of `value` milestones (of the version's list). */
export async function insertPve(
  db: Database,
  accountId: string,
  value: number,
  formulaVersion = 6,
) {
  const id = uuidv7();
  await db.insert(characters).values({
    id,
    accountId,
    name: `Pve${Math.floor(Math.random() * 1e9)}`,
    classId: 'warrior',
    appearance: { banner: 'ash' },
    level: 40,
    progress: {},
  });
  await db.insert(leaderboardEntries).values({
    characterId: id,
    metric: 'pveProgress',
    accountId,
    classId: 'warrior',
    level: 40,
    formulaVersion,
    value,
    sortKey: [value, 0, 0],
    inputsHash: 'fixture',
    input: {} as never,
    achievedAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

/** A town-works gift on `day` (YYYY-MM-DD). */
export async function insertGift(
  db: Database,
  accountId: string,
  day: string,
  amount: number,
  { projectId = 'deepLanterns', stageId = 'lanternPosts', resource = 'gold' } = {},
) {
  await db
    .insert(communityContributions)
    .values({ projectId, stageId, accountId, day, resource, amount });
}
