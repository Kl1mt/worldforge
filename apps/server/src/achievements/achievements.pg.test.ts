/**
 * Real-PostgreSQL races for achievement awards (ticket 4.2). Runs when `DATABASE_URL` is set,
 * skipped otherwise (CI sets `REQUIRE_PG_TESTS=1`). Whatever runs at once (several heroes of one
 * account earning the same achievement, live awards racing the backfill, two backfills), every
 * achievement is awarded at most once per account with exactly one audit row. Each race runs a
 * few rounds in varied orders and asserts only what holds in every order.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { accountAchievements, auditLog } from '../db/schema.js';
import { withTransaction } from '../db/transaction.js';
import type { DatabaseHandle } from '../db/types.js';
import { createPostgresTestDatabase } from '../test/db.js';
import { insertCharacter, insertItem } from '../test/heroes.js';
import { insertAccount } from '../test/social.js';
import { refreshAchievements } from './award.js';
import { backfillAccount, backfillAchievements } from './backfill.js';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === '1') {
  throw new Error('REQUIRE_PG_TESTS=1 but DATABASE_URL is not set');
}

const N = 6;
const ROUNDS = 3;

describe.skipIf(!url)('real PostgreSQL: achievements are awarded at most once', () => {
  let database: DatabaseHandle;
  const db = () => database.db;
  const now = new Date('2026-11-06T12:00:00Z');

  beforeAll(async () => {
    database = await createPostgresTestDatabase(url!, { poolMax: N * 2 + 2 });
  });

  afterAll(async () => {
    await database?.close();
  });

  async function counts(accountId: string) {
    const rows = await db()
      .select()
      .from(accountAchievements)
      .where(eq(accountAchievements.accountId, accountId));
    const audits = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.accountId, accountId), eq(auditLog.event, 'achievement.award')));
    const perId = new Map<string, number>();
    for (const a of audits) {
      const id = String(a.data.achievementId);
      perId.set(id, (perId.get(id) ?? 0) + 1);
    }
    return { ids: rows.map((r) => r.achievementId).sort(), perId };
  }

  /** A hero with a Legendary and level 20: earns firstEpic, firstLegendary, level10, level20. */
  async function legendaryHero(accountId: string) {
    const hero = await insertCharacter(db(), accountId, { level: 20 });
    await insertItem(db(), hero.id, { rarityId: 'legendary' });
    return hero;
  }
  const EXPECTED = ['firstEpic', 'firstLegendary', 'level10', 'level20'];

  it('several heroes of one account earning at once: one award each', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const acc = await insertAccount(db());
      const heroes = await Promise.all(Array.from({ length: N }, () => legendaryHero(acc.id)));
      const results = await Promise.all(
        heroes.map((h, i) =>
          withTransaction(db(), (tx) =>
            refreshAchievements(
              tx,
              h,
              i % 2 === round % 2
                ? ['maxRarity', 'maxCharacterLevel']
                : ['maxCharacterLevel', 'maxRarity'],
              now,
            ),
          ),
        ),
      );
      const { ids, perId } = await counts(acc.id);
      expect(ids).toEqual(EXPECTED);
      // Every award was returned by exactly one transaction and audited exactly once.
      expect(results.flat().sort()).toEqual(EXPECTED);
      for (const id of EXPECTED) expect(perId.get(id)).toBe(1);
    }
  });

  it('live awards racing the backfill: one award each', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const acc = await insertAccount(db());
      const heroes = await Promise.all(Array.from({ length: N }, () => legendaryHero(acc.id)));
      const live = heroes.map(
        (h) => () =>
          withTransaction(db(), (tx) =>
            refreshAchievements(tx, h, ['maxRarity', 'maxCharacterLevel'], now),
          ),
      );
      const backfills = Array.from(
        { length: 2 },
        () => () => withTransaction(db(), (tx) => backfillAccount(tx, acc.id, now)),
      );
      const jobs = round === 1 ? [...backfills, ...live] : [...live, ...backfills];
      await Promise.all(jobs.map((j) => j()));
      const { ids, perId } = await counts(acc.id);
      expect(ids).toEqual(EXPECTED);
      for (const id of EXPECTED) expect(perId.get(id)).toBe(1);
    }
  });

  it('two whole backfills at once: no double award, no deadlock', async () => {
    const accs = await Promise.all(Array.from({ length: N }, () => insertAccount(db())));
    for (const acc of accs) await legendaryHero(acc.id);
    await Promise.all([
      backfillAchievements(db(), { now: () => now, force: true, batch: 2 }),
      backfillAchievements(db(), { now: () => now, force: true, batch: 3 }),
    ]);
    const rows = await db()
      .select()
      .from(accountAchievements)
      .where(
        inArray(
          accountAchievements.accountId,
          accs.map((a) => a.id),
        ),
      );
    expect(rows).toHaveLength(N * EXPECTED.length);
    for (const acc of accs) {
      const { perId } = await counts(acc.id);
      for (const id of EXPECTED) expect(perId.get(id)).toBe(1);
    }
  });
});
