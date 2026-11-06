import { eq, sql } from 'drizzle-orm';
import { isHandle, type AccountRole } from '@worldforge/game-core';
import { accounts } from '../db/schema.js';
import { withTransaction } from '../db/transaction.js';
import type { Database } from '../db/types.js';
import { writeAudit } from '../db/audit.js';

export interface RoleChange {
  accountId: string;
  displayName: string;
  from: AccountRole;
  to: AccountRole;
  changed: boolean;
}

/**
 * Sets an account's role (ticket 4.1). The only writer of `accounts.role`; called by the
 * `pnpm admin:role` CLI, never by an API route. The account is found by email (case-insensitive)
 * or handle. Locks the row (moderator actions share-lock their actor, so a revoke and an action
 * serialise) and writes a `role.grant` / `role.revoke` audit row when the role changes.
 */
export async function setAccountRole(
  db: Database,
  identifier: string,
  role: AccountRole,
): Promise<RoleChange | null> {
  const id = identifier.trim();
  return withTransaction(db, async (tx) => {
    const [account] = await tx
      .select()
      .from(accounts)
      .where(isHandle(id) ? eq(accounts.handle, id) : sql`lower(${accounts.email}) = lower(${id})`)
      .for('update');
    if (!account) return null;
    const change: RoleChange = {
      accountId: account.id,
      displayName: account.displayName,
      from: account.role,
      to: role,
      changed: account.role !== role,
    };
    if (!change.changed) return change;
    await tx
      .update(accounts)
      .set({ role, updatedAt: sql`now()` })
      .where(eq(accounts.id, account.id));
    await writeAudit(tx, {
      event: role === 'player' ? 'role.revoke' : 'role.grant',
      accountId: account.id,
      data: { from: account.role, to: role, via: 'cli' },
    });
    return change;
  });
}
