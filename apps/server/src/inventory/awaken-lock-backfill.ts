import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { characters, dataBackfills, itemInstances } from '../db/schema.js';
import { writeAudit } from '../db/audit.js';
import { withTransaction } from '../db/transaction.js';
import type { Database } from '../db/types.js';

/**
 * Ticket 6.5c (docs/AWAKENING.md "6.5c: awakening locks the item", docs/DEPLOY.md "Data
 * backfills"): since 6.5c an awakening locks its item. Items awakened under 6.5b (0.6.9), before
 * that rule, get the same lock once here, each with an `item.lock` audit row (`via: 'backfill'`).
 *
 * One transaction (awakened items are few: at most one per Tyrant hoard of three days). It only
 * writes rows that are awakened and unlocked (`for update skip locked`: a row a request holds is
 * left for the next start-up). Idempotent: the `data_backfills` row records the finished pass,
 * after which start-ups skip it, and a forced re-run finds nothing left to lock. A player who
 * unlocked an awakened item before this pass ran finds it locked once more (they can unlock it
 * again); after the pass, unlocking is never undone.
 */
export const AWAKEN_LOCK_BACKFILL_ID = 'awaken-lock:6.5c';

export interface AwakenLockBackfillResult {
  id: string;
  /** False when this backfill had already finished on this database. */
  ran: boolean;
  /** Items locked by this pass. */
  locked: number;
  /** Awakened, unlocked rows a request held during the pass (the next start-up retries them). */
  skipped: number;
}

export async function backfillAwakenLock(
  db: Database,
  { now = () => new Date(), force = false } = {},
): Promise<AwakenLockBackfillResult> {
  const id = AWAKEN_LOCK_BACKFILL_ID;
  if (!force) {
    const [done] = await db.select().from(dataBackfills).where(eq(dataBackfills.id, id));
    if (done) return { id, ran: false, locked: 0, skipped: 0 };
  }
  const unlocked = and(isNotNull(itemInstances.awakening), eq(itemInstances.locked, false));
  const locked = await withTransaction(db, async (tx) => {
    const rows = await tx
      .select({
        id: itemInstances.id,
        characterId: itemInstances.characterId,
        accountId: characters.accountId,
      })
      .from(itemInstances)
      .innerJoin(characters, eq(characters.id, itemInstances.characterId))
      .where(unlocked)
      .for('update', { of: itemInstances, skipLocked: true });
    for (const r of rows) {
      await tx
        .update(itemInstances)
        .set({ locked: true })
        .where(and(eq(itemInstances.id, r.id), unlocked));
      await writeAudit(tx, {
        event: 'item.lock',
        accountId: r.accountId,
        characterId: r.characterId,
        data: { itemId: r.id, locked: true, via: 'backfill', backfill: id },
      });
    }
    return rows.length;
  });
  const [left] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(itemInstances)
    .where(unlocked);
  const skipped = left?.n ?? 0;
  if (skipped === 0) {
    await db
      .insert(dataBackfills)
      .values({ id, completedAt: now(), data: { locked } })
      .onConflictDoUpdate({
        target: dataBackfills.id,
        set: { completedAt: now(), data: { locked } },
      });
  }
  return { id, ran: true, locked, skipped };
}
