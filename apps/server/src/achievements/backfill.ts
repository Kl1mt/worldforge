import { createHash } from 'node:crypto';
import { asc, eq, gt, sql } from 'drizzle-orm';
import { ACHIEVEMENT_IDS, type AchievementFacts } from '@worldforge/game-core';
import { accounts, characters, dataBackfills } from '../db/schema.js';
import { queryRows } from '../db/query.js';
import { withTransaction } from '../db/transaction.js';
import type { Database, Executor } from '../db/types.js';
import { ALL_FACTS, awardAchievements, characterFacts, rarest } from './award.js';

/**
 * The achievement backfill (ticket 4.2, docs/DEPLOY.md "Data backfills"): awards every account
 * what its existing progress already earned. Run by `migrate-cli` after the migrations (so on
 * every deploy before the server starts), and again only when the achievement id list changes
 * (the id below hashes it). Idempotent: awards are at-most-once by the primary key, so a re-run,
 * a crash half-way or a live award racing it never awards twice.
 *
 * Sources: each character's current state (items, level, progress, quests), plus the audit log
 * for history the state lost: the rarity of every item that was sold, salvaged or discarded (all
 * three are audited with the rarity), notable drops, crafted, bought and quest-reward items, and
 * every forge upgrade's resulting level.
 */
export const ACHIEVEMENT_BACKFILL_ID = `achievements:${createHash('sha256')
  .update([...ACHIEVEMENT_IDS].sort().join(','))
  .digest('hex')
  .slice(0, 16)}`;

const RARITY_EVENTS = [
  'activity.reward',
  'quest.turn_in',
  'forge.craft',
  'merchant.buy',
  'merchant.sell',
  'forge.salvage',
  'item.discard',
] as const;

/** Facts from the account's audit history (items it no longer has, past upgrades). */
export async function historyFacts(
  executor: Executor,
  accountId: string,
): Promise<AchievementFacts> {
  const rarities = await queryRows<{ rarity: string }>(
    executor,
    sql`select distinct r #>> '{}' as rarity
        from audit_log a,
        lateral jsonb_path_query(
          a.data,
          (case
            when a.event in ('merchant.sell', 'forge.salvage') then '$.items[*].rarityId'
            when a.event = 'activity.reward' then '$.notableItems[*].rarityId'
            when a.event = 'quest.turn_in' then '$.item.rarityId'
            else '$.rarityId'
          end)::jsonpath
        ) r
        where a.account_id = ${accountId}
          and a.event in (${sql.join(
            RARITY_EVENTS.map((e) => sql`${e}`),
            sql`, `,
          )})`,
  );
  const [upgrade] = await queryRows<{ level: number | null }>(
    executor,
    sql`select max((data ->> 'toLevel')::int) as level
        from audit_log
        where account_id = ${accountId} and event = 'forge.upgrade'
          and jsonb_typeof(data -> 'toLevel') = 'number'`,
  );
  return {
    maxRarity: rarest(rarities.map((r) => r.rarity)),
    maxUpgradeLevel: Number(upgrade?.level ?? 0),
  };
}

/** Backfills one account; returns the ids awarded. */
export async function backfillAccount(
  executor: Executor,
  accountId: string,
  now: Date,
): Promise<string[]> {
  const awarded: string[] = [];
  const heroes = await executor
    .select()
    .from(characters)
    .where(eq(characters.accountId, accountId))
    .orderBy(asc(characters.createdAt), asc(characters.id));
  for (const hero of heroes) {
    const facts = await characterFacts(executor, hero, ALL_FACTS);
    awarded.push(
      ...(await awardAchievements(
        executor,
        { accountId, characterId: hero.id, now, source: 'backfill' },
        facts,
      )),
    );
  }
  awarded.push(
    ...(await awardAchievements(
      executor,
      { accountId, characterId: null, now, source: 'backfill' },
      await historyFacts(executor, accountId),
    )),
  );
  return awarded;
}

export interface BackfillResult {
  id: string;
  /** False when this backfill had already run on this database. */
  ran: boolean;
  accounts: number;
  awarded: number;
}

/** Runs the achievement backfill once per database (see the module comment). */
export async function backfillAchievements(
  db: Database,
  { now = () => new Date(), force = false, batch = 200 } = {},
): Promise<BackfillResult> {
  const id = ACHIEVEMENT_BACKFILL_ID;
  if (!force) {
    const [done] = await db.select().from(dataBackfills).where(eq(dataBackfills.id, id));
    if (done) return { id, ran: false, accounts: 0, awarded: 0 };
  }
  let after: string | null = null;
  let accountCount = 0;
  let awarded = 0;
  for (;;) {
    const page: { id: string }[] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(after ? gt(accounts.id, after) : undefined)
      .orderBy(asc(accounts.id))
      .limit(batch);
    if (page.length === 0) break;
    for (const account of page) {
      // One short transaction per account: a crash leaves finished accounts done.
      const ids = await withTransaction(db, (tx) => backfillAccount(tx, account.id, now()));
      awarded += ids.length;
      accountCount += 1;
    }
    after = page[page.length - 1]!.id;
  }
  await db
    .insert(dataBackfills)
    .values({ id, completedAt: now(), data: { accounts: accountCount, awarded } })
    .onConflictDoUpdate({
      target: dataBackfills.id,
      set: { completedAt: now(), data: { accounts: accountCount, awarded } },
    });
  return { id, ran: true, accounts: accountCount, awarded };
}
