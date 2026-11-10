import { eq } from 'drizzle-orm';
import { isHandle } from '@worldforge/game-core';
import { accounts } from '../db/schema.js';
import { writeAudit } from '../db/audit.js';
import { withTransaction } from '../db/transaction.js';
import type { Database } from '../db/types.js';

/**
 * Ticket D.4: marks an account as a test account, or back. **CLI only**
 * (`pnpm admin:tools test-account <handle> on|off`, `deploy/admin.sh test-account …`): no API
 * route writes `is_test`, like roles. By handle only (never an email, so nothing personal lands in
 * shell history). Audited as `admin.test_account` (`via: 'cli'`).
 *
 * The flag takes effect at once everywhere it is read: boards, the season archive and awards and
 * the arena ladder leave the account out at read time; matchmaking pairs test accounts only with
 * each other; trading refuses (`test_account`); new telemetry goes to `telemetry_daily_test`.
 * Turning it off brings the account back on the boards as its heroes stand.
 */
export async function setTestAccount(
  db: Database,
  handle: string,
  on: boolean,
): Promise<{ handle: string; displayName: string; changed: boolean; to: boolean } | null> {
  const h = handle.trim().toLowerCase();
  if (!isHandle(h)) return null;
  return withTransaction(db, async (tx) => {
    const [row] = await tx.select().from(accounts).where(eq(accounts.handle, h)).for('update');
    if (!row) return null;
    if (row.isTest === on) {
      return { handle: row.handle, displayName: row.displayName, changed: false, to: on };
    }
    await tx.update(accounts).set({ isTest: on }).where(eq(accounts.id, row.id));
    await writeAudit(tx, {
      event: 'admin.test_account',
      accountId: row.id,
      data: { before: { testAccount: row.isTest }, after: { testAccount: on }, via: 'cli' },
    });
    return { handle: row.handle, displayName: row.displayName, changed: true, to: on };
  });
}
