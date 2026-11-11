import { createHash } from 'node:crypto';
import { asc, eq, gt } from 'drizzle-orm';
import { COSMETICS, type PrestigeTier } from '@worldforge/game-core';
import {
  accountAchievements,
  accounts,
  characters,
  dataBackfills,
  seasonAwards,
} from '../db/schema.js';
import { withTransaction } from '../db/transaction.js';
import type { Database, Executor } from '../db/types.js';
import { grantForAchievementsTx, grantMilestonesTx, grantSeasonTx } from './grant.js';

/**
 * The cosmetics backfill (ticket 6.8, docs/COSMETICS.md "Backfill"): grants every account the
 * cosmetics its existing progress already earned: those of its achievements (`account_achievements`,
 * e.g. Forgeward contributors), its heroes' milestones (level 40, the Ashen Warden or the Tyrant
 * slain, the Heroic crypt cleared) and its season honours (`season_awards`). Event keepsakes were
 * granted by 6.6 with their tier. Run by `migrate-cli` after the achievement backfill, once per
 * database and catalogue (the id hashes every cosmetic's id and source, so a new cosmetic runs it
 * again). Idempotent: grants are exactly once by `cosmetic_unlocks`' primary key, so a re-run, a
 * crash half-way or a live grant racing it never grants twice. One short transaction per account.
 */
export const COSMETIC_BACKFILL_ID = `cosmetics:${createHash('sha256')
  .update(
    COSMETICS.map((c) => `${c.id}=${JSON.stringify(c.source)}`)
      .sort()
      .join(','),
  )
  .digest('hex')
  .slice(0, 16)}`;

/** Backfills one account; returns the cosmetic ids granted. */
export async function backfillAccountCosmetics(
  executor: Executor,
  accountId: string,
  now: Date,
): Promise<string[]> {
  const granted: string[] = [];
  const achieved = await executor
    .select({ id: accountAchievements.achievementId, characterId: accountAchievements.characterId })
    .from(accountAchievements)
    .where(eq(accountAchievements.accountId, accountId))
    .orderBy(asc(accountAchievements.awardedAt), asc(accountAchievements.achievementId));
  for (const a of achieved) {
    granted.push(
      ...(await grantForAchievementsTx(
        executor,
        { accountId, characterId: a.characterId, now, backfill: true },
        [a.id],
      )),
    );
  }
  const heroes = await executor
    .select({
      id: characters.id,
      accountId: characters.accountId,
      level: characters.level,
      progress: characters.progress,
    })
    .from(characters)
    .where(eq(characters.accountId, accountId))
    .orderBy(asc(characters.createdAt), asc(characters.id));
  for (const hero of heroes) {
    granted.push(...(await grantMilestonesTx(executor, hero, now, { backfill: true })));
  }
  const honours = await executor
    .select({ season: seasonAwards.season, tier: seasonAwards.tier })
    .from(seasonAwards)
    .where(eq(seasonAwards.accountId, accountId))
    .orderBy(asc(seasonAwards.season));
  const bySeason = new Map<number, PrestigeTier[]>();
  for (const h of honours) bySeason.set(h.season, [...(bySeason.get(h.season) ?? []), h.tier]);
  for (const [season, tiers] of bySeason) {
    granted.push(
      ...(await grantSeasonTx(executor, accountId, season, tiers, now, { backfill: true })),
    );
  }
  return granted;
}

export interface CosmeticBackfillResult {
  id: string;
  /** False when this backfill had already run on this database. */
  ran: boolean;
  accounts: number;
  granted: number;
}

/** Runs the cosmetics backfill once per database and catalogue (see the module comment). */
export async function backfillCosmetics(
  db: Database,
  {
    now = () => new Date(),
    force = false,
    batch = 200,
    failAfterAccounts = undefined as number | undefined,
  } = {},
): Promise<CosmeticBackfillResult> {
  const id = COSMETIC_BACKFILL_ID;
  if (!force) {
    const [done] = await db.select().from(dataBackfills).where(eq(dataBackfills.id, id));
    if (done) return { id, ran: false, accounts: 0, granted: 0 };
  }
  let after: string | null = null;
  let accountCount = 0;
  let granted = 0;
  for (;;) {
    const page: { id: string }[] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(after ? gt(accounts.id, after) : undefined)
      .orderBy(asc(accounts.id))
      .limit(batch);
    if (page.length === 0) break;
    for (const account of page) {
      if (failAfterAccounts !== undefined && accountCount >= failAfterAccounts) {
        throw new Error(`cosmetics backfill stopped after ${accountCount} accounts (test)`);
      }
      const ids = await withTransaction(db, (tx) =>
        backfillAccountCosmetics(tx, account.id, now()),
      );
      granted += ids.length;
      accountCount += 1;
    }
    after = page[page.length - 1]!.id;
  }
  await db
    .insert(dataBackfills)
    .values({ id, completedAt: now(), data: { accounts: accountCount, granted } })
    .onConflictDoUpdate({
      target: dataBackfills.id,
      set: { completedAt: now(), data: { accounts: accountCount, granted } },
    });
  return { id, ran: true, accounts: accountCount, granted };
}
