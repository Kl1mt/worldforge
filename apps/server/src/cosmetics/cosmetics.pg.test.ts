/**
 * Real-PostgreSQL races for cosmetic grants (ticket 6.8, docs/COSMETICS.md). Runs when
 * `DATABASE_URL` is set, skipped otherwise (CI sets `REQUIRE_PG_TESTS=1`). Whatever runs at once
 * (several heroes of one account reaching the same milestone or achievement, live grants racing
 * the backfill, two backfills, two equips), every cosmetic is granted exactly once per account
 * with exactly one audit row. Each race runs a few rounds and asserts only what holds in every
 * order.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLog, cosmeticUnlocks } from '../db/schema.js';
import { withTransaction } from '../db/transaction.js';
import type { DatabaseHandle } from '../db/types.js';
import { createPostgresTestDatabase } from '../test/db.js';
import { insertCharacter, insertItem } from '../test/heroes.js';
import { insertAccount } from '../test/social.js';
import { refreshAchievements } from '../achievements/award.js';
import { backfillAccountCosmetics, backfillCosmetics } from './backfill.js';
import { grantCosmeticsTx, grantMilestonesTx } from './grant.js';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === '1') {
  throw new Error('REQUIRE_PG_TESTS=1 but DATABASE_URL is not set');
}

const N = 6;
const ROUNDS = 3;

describe.skipIf(!url)('real PostgreSQL: cosmetics are granted exactly once', () => {
  let database: DatabaseHandle;
  const db = () => database.db;
  const now = new Date(Date.now() + 86_400_000);

  beforeAll(async () => {
    database = await createPostgresTestDatabase(url!, { poolMax: N * 2 + 2 });
  });

  afterAll(async () => {
    await database?.close();
  });

  async function counts(accountId: string) {
    const rows = await db()
      .select()
      .from(cosmeticUnlocks)
      .where(eq(cosmeticUnlocks.accountId, accountId));
    const audits = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.accountId, accountId), eq(auditLog.event, 'cosmetic.grant')));
    const perId = new Map<string, number>();
    for (const a of audits) {
      const id = String(a.data.cosmeticId);
      perId.set(id, (perId.get(id) ?? 0) + 1);
    }
    return { ids: rows.map((r) => r.cosmeticId).sort(), perId };
  }

  function once(c: Awaited<ReturnType<typeof counts>>, want: string[]) {
    expect(c.ids).toEqual([...want].sort());
    for (const id of want) expect(c.perId.get(id), id).toBe(1);
    expect(c.perId.size).toBe(want.length);
  }

  it('heroes of one account reaching the same milestones at once', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const a = await insertAccount(db());
      const heroes = await Promise.all(
        Array.from({ length: N }, () =>
          insertCharacter(db(), a.id, {
            level: 40,
            progress: { gravewardenDefeated: true, forgeTyrantDefeated: true },
          }),
        ),
      );
      await Promise.all(
        heroes.map((h) =>
          withTransaction(db(), (tx) => refreshAchievements(tx, h, ['maxCharacterLevel'], now)),
        ),
      );
      once(await counts(a.id), ['appearance.ashen', 'appearance.ember']);
    }
  });

  it('live grants racing the backfill and each other', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const a = await insertAccount(db());
      const hero = await insertCharacter(db(), a.id, { level: 40 });
      await insertItem(db(), hero.id, { rarityId: 'legendary' });
      const jobs = [
        ...Array.from(
          { length: N },
          () => () =>
            withTransaction(db(), (tx) => refreshAchievements(tx, hero, ['maxRarity'], now)),
        ),
        ...Array.from(
          { length: N },
          () => () => withTransaction(db(), (tx) => backfillAccountCosmetics(tx, a.id, now)),
        ),
        () => withTransaction(db(), (tx) => grantMilestonesTx(tx, hero, now)),
        () =>
          withTransaction(db(), (tx) =>
            grantCosmeticsTx(tx, { accountId: a.id, now, source: 'test' }, ['appearance.ashen']),
          ),
      ];
      // A different order each round.
      const order = round % 2 === 0 ? jobs : [...jobs].reverse();
      await Promise.all(order.map((j) => j()));
      // The Legendary's achievement and its title colour; level 40's appearance.
      once(await counts(a.id), ['appearance.ashen', 'title-colour.ember']);
    }
  });

  it('two whole backfills at once', async () => {
    const a = await insertAccount(db());
    await insertCharacter(db(), a.id, {
      level: 40,
      progress: { gravewardenDefeated: true, ashenWardenDefeated: true },
    });
    await Promise.all([
      backfillCosmetics(db(), { now: () => now, force: true }),
      backfillCosmetics(db(), { now: () => now, force: true }),
    ]);
    once(await counts(a.id), ['appearance.ashen', 'banner.warden-flame']);
  });
});
