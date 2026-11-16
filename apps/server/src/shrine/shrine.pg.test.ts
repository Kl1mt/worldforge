/**
 * Real-PostgreSQL races for the Reward Shrine (ticket 9.5, docs/SHRINE.md). Runs when
 * `DATABASE_URL` is set, skipped otherwise (CI sets `REQUIRE_PG_TESTS=1`). Whatever runs at once
 * (several draws for the last few draws, draws racing a marks purchase and play grants, the same
 * day's accrual twice), the account ends reconciled: no draw spent twice, no grant paid twice.
 * Asserts only what holds in every order; draw outcomes are read back from their stored seeds.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { SHRINE_POOL, drawShrine } from '@worldforge/game-core';
import { accounts, shrineAccounts, shrineDrawGrants, shrineDraws } from '../db/schema.js';
import { withTransaction } from '../db/transaction.js';
import type { DatabaseHandle } from '../db/types.js';
import { createPostgresTestDatabase } from '../test/db.js';
import { insertAccount } from '../test/social.js';
import {
  buyWithMarksTx,
  drawTx,
  grantPlayDrawsTx,
  openShrineTx,
  reconcileShrine,
} from './model.js';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === '1') {
  throw new Error('REQUIRE_PG_TESTS=1 but DATABASE_URL is not set');
}

const N = 6;
const ROUNDS = 3;
const DAY = 86_400_000;

describe.skipIf(!url)('real PostgreSQL: the Shrine pays every draw once', () => {
  let database: DatabaseHandle;
  const db = () => database.db;
  const now = new Date(Math.floor(Date.now() / DAY) * DAY + DAY / 2);

  beforeAll(async () => {
    database = await createPostgresTestDatabase(url!, { poolMax: N * 2 + 2 });
  });

  afterAll(async () => {
    await database?.close();
  });

  async function freshAccount(ageDays: number) {
    const a = await insertAccount(db(), { now });
    await db()
      .update(accounts)
      .set({ createdAt: new Date(now.getTime() - ageDays * DAY) })
      .where(eq(accounts.id, a.id));
    return a;
  }

  it('N draws for fewer held draws: exactly the held ones are spent', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const a = await freshAccount(2); // three free draws held
      const results = await Promise.allSettled(
        Array.from({ length: N }, () => withTransaction(db(), (tx) => drawTx(tx, a.id, now))),
      );
      const ok = results.filter((r) => r.status === 'fulfilled');
      expect(ok).toHaveLength(3);
      for (const r of results) {
        if (r.status === 'rejected') expect((r.reason as { code?: string }).code).toBe('no_draws');
      }
      const rows = await db().select().from(shrineDraws).where(eq(shrineDraws.accountId, a.id));
      expect(rows).toHaveLength(3);
      for (const d of rows) expect(drawShrine(d.seed).cosmeticId).toBe(d.cosmeticId);
      expect((await reconcileShrine(db(), a.id)).ok).toBe(true);
    }
  });

  it('the same day accrued at once by many readers is granted once', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const a = await freshAccount(30);
      await Promise.all(
        Array.from({ length: N }, () => withTransaction(db(), (tx) => openShrineTx(tx, a.id, now))),
      );
      const grants = await db()
        .select()
        .from(shrineDrawGrants)
        .where(eq(shrineDrawGrants.accountId, a.id));
      expect(grants.map((g) => [g.source, g.count])).toEqual([['daily', 7]]);
    }
  });

  it('draws racing a purchase and play grants: marks and draws reconcile', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const a = await freshAccount(0);
      // Enough marks for one rare, earned through the ledger's own path (a pinned duplicate).
      const common = SHRINE_POOL.find((e) => e.rarity === 'common')!.cosmeticId;
      const rare = SHRINE_POOL.find((e) => e.rarity === 'rare')!.cosmeticId;
      let seed = '';
      for (let i = 0; !seed; i++) if (drawShrine(`pg-${i}`).cosmeticId === common) seed = `pg-${i}`;
      await withTransaction(db(), (tx) =>
        grantPlayDrawsTx(tx, { accountId: a.id, key: 'test:pg', count: 14, now }),
      );
      for (let i = 0; i < 14; i++) await withTransaction(db(), (tx) => drawTx(tx, a.id, now, seed));
      const [before] = await db()
        .select()
        .from(shrineAccounts)
        .where(eq(shrineAccounts.accountId, a.id));
      expect(before!.marks).toBe(26);
      const tasks = [
        ...Array.from(
          { length: N },
          () => () => withTransaction(db(), (tx) => buyWithMarksTx(tx, a.id, rare, now)),
        ),
        ...Array.from(
          { length: N },
          (_, i) => () =>
            withTransaction(db(), (tx) =>
              grantPlayDrawsTx(tx, { accountId: a.id, key: `test:pg:${i % 2}`, count: 1, now }),
            ),
        ),
        () => withTransaction(db(), (tx) => drawTx(tx, a.id, now, seed)),
      ];
      const results = await Promise.allSettled(tasks.map((t) => t()));
      const bought = results.slice(0, N).filter((r) => r.status === 'fulfilled');
      expect(bought).toHaveLength(1);
      const r = await reconcileShrine(db(), a.id);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(r.marksSpent).toBe(25);
      expect(r.bySource.play.granted).toBe(14 + 2);
    }
  });
});
