import { and, asc, count, eq, inArray } from 'drizzle-orm';
import {
  SLOT_RULES,
  accountGrowthEarned,
  findAccountGrowthRule,
  offlineCapEndMs,
  type AccountGrowthRule,
  type GrowthHero,
} from '@worldforge/game-core';
import { accountGrowthGrants, type AccountGrowthGrant } from '../db/schema.js';
import { writeAudit } from '../db/audit.js';
import type { Executor } from '../db/types.js';

/**
 * Account growth grants (ticket 9.4, docs/ACCOUNTS.md). Every grant inserts into
 * `account_growth_grants` with `on conflict do nothing` on its `(account, grant id)` primary key,
 * so a rule is granted **at most once** per account whatever runs at the same time (two heroes, a
 * live grant and the backfill, two backfills), and only the insert that created the row writes the
 * `account.grow` audit row. Grants are never removed (no route or tool deletes one). Callers:
 * `refreshAchievements` (settlements that change the level, dungeon claims, the D.4b admin
 * progress tools, so test accounts follow the same rules) and the backfill.
 */
export async function grantAccountGrowthTx(
  executor: Executor,
  hero: GrowthHero & { id: string; accountId: string },
  now: Date,
  { backfill = false } = {},
): Promise<string[]> {
  const earned = accountGrowthEarned(hero);
  if (earned.length === 0) return [];
  const have = await executor
    .select({ id: accountGrowthGrants.grantId })
    .from(accountGrowthGrants)
    .where(
      and(
        eq(accountGrowthGrants.accountId, hero.accountId),
        inArray(accountGrowthGrants.grantId, earned),
      ),
    );
  const owned = new Set(have.map((h) => h.id));
  const missing = earned.filter((id) => !owned.has(id));
  if (missing.length === 0) return [];
  const inserted = await executor
    .insert(accountGrowthGrants)
    .values(
      missing.map((grantId) => ({
        accountId: hero.accountId,
        grantId,
        kind: findAccountGrowthRule(grantId)!.kind,
        source: grantId,
        characterId: hero.id,
        backfill,
        grantedAt: now,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: accountGrowthGrants.grantId });
  const granted = missing.filter((id) => inserted.some((r) => r.id === id));
  for (const grantId of granted) {
    await writeAudit(executor, {
      event: 'account.grow',
      accountId: hero.accountId,
      characterId: hero.id,
      data: { grantId, kind: findAccountGrowthRule(grantId)!.kind, source: grantId, backfill },
    });
  }
  return granted;
}

/** Slot grants of the account (any source, the later shop included). */
export async function slotGrantCount(executor: Executor, accountId: string): Promise<number> {
  const [row] = await executor
    .select({ n: count() })
    .from(accountGrowthGrants)
    .where(and(eq(accountGrowthGrants.accountId, accountId), eq(accountGrowthGrants.kind, 'slot')));
  return row?.n ?? 0;
}

/**
 * The account's slot total: its base (`accounts.character_slots`, 2 unless an admin changed it)
 * plus its slot grants. Callers that enforce it hold the account row lock (`for no key update`):
 * hero creation, the admin restore. A grant committing concurrently is not seen, so a race only
 * ever refuses a creation it could have allowed, never allows one too many.
 */
export async function characterSlotTotal(
  executor: Executor,
  account: { id: string; characterSlots: number },
): Promise<number> {
  return account.characterSlots + (await slotGrantCount(executor, account.id));
}

export interface LockedSlotView {
  /** The rule id (the source the grant will record). */
  source: string;
  description: string;
  /** False for a slot no hero can earn yet (the community seam). */
  available: boolean;
}

/** The account's grants, oldest first. */
export async function loadGrowthGrants(
  executor: Executor,
  accountId: string,
): Promise<AccountGrowthGrant[]> {
  return executor
    .select()
    .from(accountGrowthGrants)
    .where(eq(accountGrowthGrants.accountId, accountId))
    .orderBy(asc(accountGrowthGrants.grantedAt), asc(accountGrowthGrants.grantId));
}

/** The next slot rule the account has not earned (for the hero list's locked slot). */
export async function nextLockedSlot(
  executor: Executor,
  accountId: string,
): Promise<LockedSlotView | null> {
  const owned = new Set((await loadGrowthGrants(executor, accountId)).map((g) => g.grantId));
  const rule = SLOT_RULES.find((r) => !owned.has(r.id));
  return rule ? lockedView(rule) : null;
}

export function lockedView(rule: AccountGrowthRule): LockedSlotView {
  return {
    source: rule.id,
    description: rule.description,
    available: rule.unlock.kind !== 'futureCommunityProject',
  };
}

/** When each offline step of the account was granted (oldest first). */
export async function offlineGrantTimes(executor: Executor, accountId: string): Promise<number[]> {
  const rows = await executor
    .select({ at: accountGrowthGrants.grantedAt })
    .from(accountGrowthGrants)
    .where(
      and(eq(accountGrowthGrants.accountId, accountId), eq(accountGrowthGrants.kind, 'offline')),
    )
    .orderBy(asc(accountGrowthGrants.grantedAt));
  return rows.map((r) => r.at.getTime());
}

/** Where the hero's offline credit ends (game-core `offlineCapEndMs` over the account's grants). */
export async function offlineCapEndTx(
  executor: Executor,
  accountId: string,
  lastSeenAt: Date,
  baseMs: number,
): Promise<number> {
  return offlineCapEndMs(
    lastSeenAt.getTime(),
    baseMs,
    await offlineGrantTimes(executor, accountId),
  );
}
