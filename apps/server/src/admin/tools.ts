import { eq } from 'drizzle-orm';
import { accounts, type Account } from '../db/schema.js';
import { writeAudit } from '../db/audit.js';
import type { Executor, Transaction } from '../db/types.js';
import { ApiError } from '../errors.js';

/**
 * Shared pieces of the admin tools (ticket D.4, docs/DEPLOY.md "Admin tools",
 * docs/API_CONVENTIONS.md "Admin tools").
 *
 * - **Who:** admins only. `app.requireAdmin` answers everyone else the not-found `404` before
 *   body validation; inside every write's transaction `lockAdmin` re-reads the role under a share
 *   lock, so a role the CLI revokes stops the next action. No tool reads or writes a role.
 * - **Cheat tools** (grants, levels, progress, daily resets, fast-forward) work only on a test
 *   account (`accounts.is_test`, set by the CLI) or on the admin's own account (`assertCheat`);
 *   support tools (removals, refunds, deletion, rename, sessions) work on any account.
 * - **Audit:** every tool writes one `admin.<tool>` row **on the target account** (and hero),
 *   `data`: `{ by, reason, before, after, … }` (`by` is the admin's account id). Never an email,
 *   a password hash, a token or an IP.
 */

/** Every tool needs a reason (shown in the audit trail). */
export const REASON_MIN = 3;
export const REASON_MAX = 500;
export const reasonSchema = {
  type: 'string',
  minLength: REASON_MIN,
  maxLength: REASON_MAX,
} as const;

/** Re-reads the actor under a share lock: a role revoked by the CLI stops the next action. */
export async function lockAdmin(tx: Transaction, accountId: string): Promise<void> {
  const [actor] = await tx
    .select({ role: accounts.role })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .for('share');
  if (actor?.role !== 'admin') throw new ApiError(404, 'not_found', 'Not found.');
}

export const noSuchPlayer = () => new ApiError(404, 'not_found', 'No player with that handle.');

/** The target account by handle (no lock), or `404`. */
export async function targetAccount(db: Executor, handle: string): Promise<Account> {
  const [row] = await db.select().from(accounts).where(eq(accounts.handle, handle));
  if (!row) throw noSuchPlayer();
  return row;
}

/**
 * The target account row `for no key update` (deletion and restore): serialises with trade
 * writes, which hold it `for share`, and with shelf moves, which take the same lock. Not
 * `for update`: every write's `Idempotency-Key` insert holds `for key share` on its account row
 * (the foreign key), and waiting on that while holding the shelf lock would deadlock with a shelf
 * move of that account (found by `tools.pg.test.ts`).
 */
export async function lockTargetAccount(tx: Transaction, handle: string): Promise<Account> {
  const [row] = await tx
    .select()
    .from(accounts)
    .where(eq(accounts.handle, handle))
    .for('no key update');
  if (!row) throw noSuchPlayer();
  return row;
}

export interface CheatGate {
  /** The admin's own account, not a test account: what it does shows on public boards. */
  ownPublic: boolean;
}

/**
 * Cheat tools: a test account or the admin's own account only. Anything else is
 * `403 test_account_required` (an admin can see the route exists, so not a 404).
 */
export function assertCheat(target: Pick<Account, 'id' | 'isTest'>, adminId: string): CheatGate {
  if (target.isTest) return { ownPublic: false };
  if (target.id === adminId) return { ownPublic: true };
  throw new ApiError(
    403,
    'test_account_required',
    'This tool works only on test accounts and on your own account. Mark the account as a test account with the CLI first.',
  );
}

/** The typed confirmation of a destructive action: the hero's name, the handle or the flag id. */
export function assertConfirmed(expected: string, given: string | undefined): void {
  if ((given ?? '').trim().toLowerCase() !== expected.trim().toLowerCase()) {
    throw new ApiError(
      422,
      'confirmation_mismatch',
      `Type “${expected}” exactly to confirm this action.`,
      { expected },
    );
  }
}

export interface AdminAuditInput {
  event: `admin.${string}`;
  adminId: string;
  target: Pick<Account, 'id'>;
  characterId?: string | null;
  reason: string;
  before?: unknown;
  after?: unknown;
  data?: Record<string, unknown>;
}

/** One `admin.*` audit row on the target account (who, what, before/after, the reason). */
export async function adminAudit(tx: Executor, input: AdminAuditInput) {
  return writeAudit(tx, {
    event: input.event,
    accountId: input.target.id,
    characterId: input.characterId ?? null,
    data: {
      by: input.adminId,
      reason: input.reason.trim(),
      ...(input.before !== undefined ? { before: input.before } : {}),
      ...(input.after !== undefined ? { after: input.after } : {}),
      ...input.data,
    },
  });
}

/** Keys that must never leave the server in an admin answer (the no-email guard tests it). */
const SECRET_KEY = /email|password|hash|token|secret|seedsecret|forgesecret|^ip$|address/i;

/**
 * Audit `data` as the inspector shows it: keys that could hold personal or secret data dropped,
 * deeply (audit rows never hold them by policy; this is the second line).
 */
export function scrubAuditData(value: unknown, depth = 0): unknown {
  if (depth > 6) return null;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrubAuditData(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(k)) continue;
      out[k] = scrubAuditData(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.includes('@')) return '[redacted]';
  return value;
}
