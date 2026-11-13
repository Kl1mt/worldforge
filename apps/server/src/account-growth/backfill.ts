import { createHash } from 'node:crypto';
import { asc, eq, gt } from 'drizzle-orm';
import { ACCOUNT_GROWTH_RULES } from '@worldforge/game-core';
import { accounts, characters, dataBackfills } from '../db/schema.js';
import { withTransaction } from '../db/transaction.js';
import type { Database, Executor } from '../db/types.js';
import { grantAccountGrowthTx } from './grant.js';

/**
 * The account growth backfill (ticket 9.4, docs/ACCOUNTS.md "Backfill", docs/DEPLOY.md "Data
 * backfills"): grants every account the slots and offline steps its heroes already earned (their
 * level and world progress; a soft-deleted hero's deeds count too, as they did when earned).
 * Run by `migrate-cli` after the cosmetics backfill, once per database and rule set (the id hashes
 * every rule's id, kind and unlock, so a new rule, e.g. the community slot's project, runs it
 * again). Idempotent: a grant is at most once by `account_growth_grants`' primary key, so a re-run,
 * a crash half-way or a live grant racing it never grants twice. One short transaction per account.
 *
 * A backfilled grant counts from the moment the backfill writes it (`granted_at = now`): an offline
 * step never pays back time a hero already lost before the deploy.
 */
export const ACCOUNT_GROWTH_BACKFILL_ID = `account-growth:${createHash('sha256')
  .update(
    ACCOUNT_GROWTH_RULES.map((r) => `${r.id}=${r.kind}:${JSON.stringify(r.unlock)}`)
      .sort()
      .join(','),
  )
  .digest('hex')
  .slice(0, 16)}`;

/** Backfills one account; returns the grant ids written. */
export async function backfillAccountGrowth(
  executor: Executor,
  accountId: string,
  now: Date,
): Promise<string[]> {
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
  const granted: string[] = [];
  for (const hero of heroes) {
    granted.push(...(await grantAccountGrowthTx(executor, hero, now, { backfill: true })));
  }
  return granted;
}

export interface AccountGrowthBackfillResult {
  id: string;
  /** False when this backfill had already run on this database. */
  ran: boolean;
  accounts: number;
  granted: number;
}

/** Runs the account growth backfill once per database and rule set (see the module comment). */
export async function backfillAccountGrowthAll(
  db: Database,
  {
    now = () => new Date(),
    force = false,
    batch = 200,
    failAfterAccounts = undefined as number | undefined,
  } = {},
): Promise<AccountGrowthBackfillResult> {
  const id = ACCOUNT_GROWTH_BACKFILL_ID;
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
        throw new Error(`account growth backfill stopped after ${accountCount} accounts (test)`);
      }
      const ids = await withTransaction(db, (tx) => backfillAccountGrowth(tx, account.id, now()));
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
