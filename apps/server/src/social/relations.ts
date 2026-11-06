import { and, eq, inArray, ne, or, sql } from 'drizzle-orm';
import {
  presenceBucket,
  relationFromFacts,
  type PresenceBucket,
  type Relation,
} from '@worldforge/game-core';
import { accountPresence, blocks, friendships } from '../db/schema.js';
import type { Executor } from '../db/types.js';

/**
 * The relationship model (ticket 4.3, docs/SOCIAL.md "Relations"): the reusable API other
 * features ask (profiles 4.2, guild invites 4.4, chat 4.5). All take internal account ids; none
 * of them may be shown to players (use handles).
 */

/** The pair as stored: `account_low < account_high` (uuid order equals lowercase-hex order). */
export function pairOf(a: string, b: string): { low: string; high: string } {
  return a < b ? { low: a, high: b } : { low: b, high: a };
}

/**
 * Inside a transaction: takes each account's social lock (a transaction-scoped advisory lock),
 * in a fixed order, so every change to a pair — and every count behind a cap — serialises with
 * every other change touching either account. Taken after `socialWrite`'s share lock on the
 * actor's row; nothing else takes these, so there is no lock cycle.
 */
export async function lockSocialAccounts(tx: Executor, ids: string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`social:${id}`}, 0))`);
  }
}

/** The viewer's relation to each of `targetIds` (one query per table, for lists). */
export async function relationsFor(
  executor: Executor,
  viewerId: string,
  targetIds: readonly string[],
): Promise<Map<string, Relation>> {
  const ids = [...new Set(targetIds)].filter((id) => id !== viewerId);
  const out = new Map<string, Relation>();
  if (targetIds.includes(viewerId)) out.set(viewerId, 'self');
  if (ids.length === 0) return out;
  const [pairs, blockRows] = await Promise.all([
    executor
      .select()
      .from(friendships)
      .where(
        or(
          and(eq(friendships.accountLow, viewerId), inArray(friendships.accountHigh, ids)),
          and(eq(friendships.accountHigh, viewerId), inArray(friendships.accountLow, ids)),
        ),
      ),
    executor
      .select()
      .from(blocks)
      .where(
        or(
          and(eq(blocks.blockerId, viewerId), inArray(blocks.blockedId, ids)),
          and(eq(blocks.blockedId, viewerId), inArray(blocks.blockerId, ids)),
        ),
      ),
  ]);
  for (const id of ids) {
    const pair = pairs.find((p) => p.accountLow === id || p.accountHigh === id);
    out.set(
      id,
      relationFromFacts({
        blockedByMe: blockRows.some((b) => b.blockerId === viewerId && b.blockedId === id),
        blockedByThem: blockRows.some((b) => b.blockerId === id && b.blockedId === viewerId),
        friendship: pair
          ? { status: pair.status, requestedByMe: pair.requestedBy === viewerId }
          : null,
      }),
    );
  }
  return out;
}

/** The viewer's relation to one other account. */
export async function relationBetween(
  executor: Executor,
  viewerId: string,
  targetId: string,
): Promise<Relation> {
  return (await relationsFor(executor, viewerId, [targetId])).get(targetId)!;
}

/** Of `ids` (or of everyone, when omitted), the accounts that block the viewer or that the viewer blocks. */
export async function blockedEitherWay(
  executor: Executor,
  viewerId: string,
  ids?: readonly string[],
): Promise<Set<string>> {
  if (ids && ids.length === 0) return new Set();
  const rows = await executor
    .select({ blockerId: blocks.blockerId, blockedId: blocks.blockedId })
    .from(blocks)
    .where(
      or(
        and(eq(blocks.blockerId, viewerId), ids ? inArray(blocks.blockedId, [...ids]) : undefined),
        and(eq(blocks.blockedId, viewerId), ids ? inArray(blocks.blockerId, [...ids]) : undefined),
      ),
    );
  return new Set(rows.map((r) => (r.blockerId === viewerId ? r.blockedId : r.blockerId)));
}

/** Whether either account blocks the other. */
export async function isBlockedEitherWay(
  executor: Executor,
  a: string,
  b: string,
): Promise<boolean> {
  if (a === b) return false;
  return (await blockedEitherWay(executor, a, [b])).size > 0;
}

/** The account's friends (accepted only). */
export async function friendIds(executor: Executor, accountId: string): Promise<string[]> {
  const rows = await executor
    .select({ low: friendships.accountLow, high: friendships.accountHigh })
    .from(friendships)
    .where(
      and(
        eq(friendships.status, 'friends'),
        or(eq(friendships.accountLow, accountId), eq(friendships.accountHigh, accountId)),
      ),
    );
  return rows.map((r) => (r.low === accountId ? r.high : r.low));
}

/** Counts behind the caps (`FRIEND_LIMITS`); exact only under `lockSocialAccounts`. */
export async function relationCounts(executor: Executor, accountId: string) {
  const mine = or(eq(friendships.accountLow, accountId), eq(friendships.accountHigh, accountId));
  const [row] = await executor
    .select({
      friends: sql<number>`count(*) filter (where ${friendships.status} = 'friends')::int`,
      outgoing: sql<number>`count(*) filter (where ${friendships.status} = 'pending' and ${friendships.requestedBy} = ${accountId})::int`,
      incoming: sql<number>`count(*) filter (where ${friendships.status} = 'pending' and ${friendships.requestedBy} <> ${accountId})::int`,
    })
    .from(friendships)
    .where(mine);
  const [b] = await executor
    .select({ n: sql<number>`count(*)::int` })
    .from(blocks)
    .where(eq(blocks.blockerId, accountId));
  return {
    friends: row?.friends ?? 0,
    outgoing: row?.outgoing ?? 0,
    incoming: row?.incoming ?? 0,
    blocks: b?.n ?? 0,
  };
}

/**
 * Presence buckets for `ids` as of `now`: `null` where the player hides it. Never a time. The
 * caller decides who may see it (`friendDecision(relation, 'viewPresence')`; guildmates in 4.4).
 */
export async function presenceOf(
  executor: Executor,
  ids: readonly string[],
  now: Date,
): Promise<Map<string, PresenceBucket | null>> {
  const out = new Map<string, PresenceBucket | null>();
  if (ids.length === 0) return out;
  const rows = await executor
    .select()
    .from(accountPresence)
    .where(inArray(accountPresence.accountId, [...ids]));
  for (const id of ids) {
    const row = rows.find((r) => r.accountId === id);
    out.set(id, row?.hidden ? null : presenceBucket(row?.lastSeenAt ?? null, now));
  }
  return out;
}

/** The account's own presence setting. */
export async function presenceHidden(executor: Executor, accountId: string): Promise<boolean> {
  const [row] = await executor
    .select({ hidden: accountPresence.hidden })
    .from(accountPresence)
    .where(eq(accountPresence.accountId, accountId));
  return row?.hidden ?? false;
}

/** Pending rows the account takes part in, with which side asked. */
export async function pendingFor(executor: Executor, accountId: string) {
  const rows = await executor
    .select()
    .from(friendships)
    .where(
      and(
        eq(friendships.status, 'pending'),
        or(eq(friendships.accountLow, accountId), eq(friendships.accountHigh, accountId)),
      ),
    );
  return rows.map((r) => ({
    otherId: r.accountLow === accountId ? r.accountHigh : r.accountLow,
    incoming: r.requestedBy !== accountId,
    createdAt: r.createdAt,
  }));
}

/** Accounts the account blocks. */
export async function blockedBy(executor: Executor, accountId: string) {
  return executor
    .select({ blockedId: blocks.blockedId, createdAt: blocks.createdAt })
    .from(blocks)
    .where(and(eq(blocks.blockerId, accountId), ne(blocks.blockedId, accountId)));
}
