/**
 * Real-PostgreSQL races for events (ticket 6.6, docs/EVENTS.md). Runs when `DATABASE_URL` is set,
 * skipped otherwise (CI sets `REQUIRE_PG_TESTS=1`). Asserts only what holds in every order:
 * - many heroes of the same accounts completing quests at once (some replaying the same events):
 *   each account's tallies equal its heroes' done quests, each tier and cosmetic exactly once;
 * - progress racing the close: it commits before the close or not at all, never after;
 * - reward sweeps racing (some crashing mid-way, then resumed): each missing tier granted once,
 *   the sweep audited once; audit and telemetry reconcile.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { EVENT_CLOSE_GRACE_MS, type QuestEvent } from '@worldforge/game-core';
import {
  auditLog,
  cosmeticUnlocks,
  eventParticipants,
  eventTrackGrants,
  eventTracks,
  worldEvents,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { withTransaction } from '../db/transaction.js';
import { queryRows } from '../db/query.js';
import { createPostgresTestDatabase } from '../test/db.js';
import { insertCharacter } from '../test/heroes.js';
import { insertAccount } from '../test/social.js';
import { reconcileWithAudit } from '../telemetry/report.js';
import { closeEvent, scheduleEvent, sweepEventRewards } from './model.js';
import { joinEventTx, recordEventProgressTx } from './progress.js';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === '1') {
  throw new Error('REQUIRE_PG_TESTS=1 but DATABASE_URL is not set');
}

const DAY = 86_400_000;
const cli = { accountId: null, via: 'cli' as const };
const shuffle = <T>(xs: T[]) =>
  xs
    .map((x) => [Math.random(), x] as const)
    .sort((a, b) => a[0] - b[0])
    .map(([, x]) => x);

const parts: QuestEvent[][] = [
  [{ type: 'enemyKilled', enemyId: 'risenFarmhand', count: 60 }],
  [{ type: 'materialGathered', materialId: 'soulShard', count: 12 }],
  [{ type: 'enemyKilled', enemyId: 'carrionWolf', count: 400 }],
  [{ type: 'bossDefeated', bossId: 'gravewarden' }],
];

describe.skipIf(!url)('real PostgreSQL: the reward track is granted exactly once', () => {
  let database: DatabaseHandle;
  // Derived from the wall clock (CLAUDE.md "Dates").
  const start = Math.floor(Date.now() / DAY) * DAY + 40 * DAY;
  let nowMs = start + 1000;
  const now = () => new Date(nowMs);
  const db = () => database.db;

  beforeAll(async () => {
    database = await createPostgresTestDatabase(url!, { poolMax: 30 });
    await scheduleEvent(
      db(),
      {
        definitionId: 'harvestOfBones',
        startsAt: new Date(start),
        endsAt: new Date(start + 2 * DAY),
      },
      now(),
      cli,
    );
  });
  afterAll(async () => {
    await database?.close();
  });

  it('heroes of one account racing: tallies add up, every tier once; progress racing the close', async () => {
    const [event] = await db().select().from(worldEvents);
    const accounts = await Promise.all(
      Array.from({ length: 8 }, () => insertAccount(db(), { now: now() })),
    );
    const heroes = (
      await Promise.all(
        accounts.map(async (a) => [
          await insertCharacter(db(), a.id),
          await insertCharacter(db(), a.id),
        ]),
      )
    ).flat();
    await Promise.all(
      heroes.map((h) => withTransaction(db(), (tx) => joinEventTx(tx, h, event!, now()))),
    );
    // Every hero sends every part, twice over, in a random order, all at once.
    const work = shuffle(heroes.flatMap((h) => [...parts, ...parts].map((p) => ({ h, p }))));
    await Promise.all(
      work.map(({ h, p }) =>
        withTransaction(db(), (tx) => recordEventProgressTx(tx, h, { questEvents: p }, now())),
      ),
    );
    for (const a of accounts) {
      const [t] = await db().select().from(eventTracks).where(eq(eventTracks.accountId, a.id));
      expect(t?.tallies).toBe(100);
      const grants = await db()
        .select()
        .from(eventTrackGrants)
        .where(eq(eventTrackGrants.accountId, a.id));
      expect(grants.map((g) => g.tier).sort()).toEqual([1, 2, 3]);
      const unlocks = await db()
        .select()
        .from(cosmeticUnlocks)
        .where(eq(cosmeticUnlocks.accountId, a.id));
      expect(unlocks).toHaveLength(3);
    }

    // Progress whose request arrived before the end, racing the close: it lands before the
    // close or is refused, never after. Fresh heroes with one part left.
    const late = await Promise.all(accounts.slice(0, 4).map((a) => insertCharacter(db(), a.id)));
    await Promise.all(
      late.map((h) => withTransaction(db(), (tx) => joinEventTx(tx, h, event!, now()))),
    );
    const endMs = start + 2 * DAY;
    nowMs = endMs + EVENT_CLOSE_GRACE_MS;
    const results = await Promise.all([
      closeEvent(db(), 1, now()),
      ...late.map((h) =>
        withTransaction(db(), (tx) =>
          recordEventProgressTx(tx, h, { questEvents: parts[0]! }, new Date(endMs - 1)),
        ),
      ),
    ]);
    expect(results[0]).toBe('closed');
    const [closed] = await db().select().from(worldEvents);
    for (const h of late) {
      const [p] = await db()
        .select()
        .from(eventParticipants)
        .where(eq(eventParticipants.characterId, h.id));
      // Committed before the close: its updated_at is the request's time; else untouched.
      expect([0, 60]).toContain(p!.progress[0]);
      expect(p!.updatedAt.getTime() <= closed!.closedAt!.getTime()).toBe(true);
    }
    // Nothing after the close.
    for (const h of late) {
      expect(
        await withTransaction(db(), (tx) =>
          recordEventProgressTx(tx, h, { questEvents: parts[2]! }, new Date(endMs - 1)),
        ),
      ).toBeNull();
    }
  });

  it('sweeps racing and crashing mid-way, then resumed: each missing tier once', async () => {
    // Tallies without their grants for 30 accounts (as after a crash between them).
    const extra = await Promise.all(
      Array.from({ length: 30 }, () => insertAccount(db(), { now: now() })),
    );
    await db()
      .insert(eventTracks)
      .values(
        extra.map((a, i) => ({
          event: 1,
          accountId: a.id,
          tallies: [10, 25, 50][i % 3]!,
          updatedAt: now(),
        })),
      );
    const runs = await Promise.allSettled([
      sweepEventRewards(db(), 1, now(), { batch: 4, failAfterBatches: 2 }),
      sweepEventRewards(db(), 1, now(), { batch: 3, failAfterBatches: 5 }),
      sweepEventRewards(db(), 1, now(), { batch: 7 }),
      sweepEventRewards(db(), 1, now(), { batch: 2, failAfterBatches: 1 }),
    ]);
    expect(runs.some((r) => r.status === 'rejected')).toBe(true);
    // Resume: three at once.
    await Promise.all([1, 2, 3].map(() => sweepEventRewards(db(), 1, now(), { batch: 5 })));
    const counts = await queryRows<{ account_id: string; tier: number; n: number }>(
      db(),
      sql`select account_id, tier, count(*)::int as n from event_track_grants group by account_id, tier having count(*) > 1`,
    );
    expect(counts).toEqual([]);
    for (const [i, a] of extra.entries()) {
      const grants = await db()
        .select()
        .from(eventTrackGrants)
        .where(eq(eventTrackGrants.accountId, a.id));
      expect(grants).toHaveLength([1, 2, 3][i % 3]!);
    }
    const [e] = await db().select().from(worldEvents);
    expect(e!.rewardsSweptAt).not.toBeNull();
    expect(
      await db().select().from(auditLog).where(eq(auditLog.event, 'event.sweep')),
    ).toHaveLength(1);
    const rewards = await db().select().from(auditLog).where(eq(auditLog.event, 'event.reward'));
    expect(rewards).toHaveLength((await db().select().from(eventTrackGrants)).length);
    // Audit and telemetry agree (the hand-inserted tallies have no progress audit, by design).
    const bad = (await reconcileWithAudit(db())).filter((c) => !c.ok).map((c) => c.check);
    expect(bad).toEqual(['events: tallies held = tallies audited']);
  });
});
