import { and, eq, isNull, max, or } from 'drizzle-orm';
import {
  standingRefusals,
  tradeDecision,
  type TradeRelationFacts,
  type TradeStanding,
  type TradingSettings,
} from '@worldforge/game-core';
import { accounts, characters, friendships, guildMembers } from '../db/schema.js';
import type { Executor } from '../db/types.js';
import { isEmailVerified } from '../auth/tokens.js';
import { activeSanctions } from '../social/sanctions.js';
import { isBlockedEitherWay, pairOf } from '../social/relations.js';

/**
 * The facts trade decisions read (ticket T.4, docs/TRADING.md "T.4 as built"): one account's
 * standing and the relation between two accounts. Internal ids in, never shown to players. Inside
 * a value transaction (T.5) pass the transaction, so the facts are the ones the locks protect.
 */

/** Account age, best hero level, verified email and active sanctions at `now`. */
export async function loadTradeStanding(
  executor: Executor,
  accountId: string,
  now: Date,
): Promise<TradeStanding | null> {
  const [account] = await executor
    .select({ createdAt: accounts.createdAt, isTest: accounts.isTest })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  if (!account) return null;
  const [best] = await executor
    .select({ level: max(characters.level) })
    .from(characters)
    .where(and(eq(characters.accountId, accountId), isNull(characters.deletedAt)));
  const [emailVerified, sanctions] = await Promise.all([
    isEmailVerified(executor, accountId),
    activeSanctions(executor, accountId, now),
  ]);
  return {
    createdAt: account.createdAt,
    highestHeroLevel: best?.level ?? 0,
    emailVerified,
    sanctions: sanctions.map((s) => s.kind),
    ...(account.isTest ? { testAccount: true } : {}),
  };
}

/**
 * The relation as trading sees it: a block either way, when the friendship was accepted, and when
 * the two became guildmates (the later of their two joins of the guild they share now).
 */
export async function loadTradeRelation(
  executor: Executor,
  a: string,
  b: string,
): Promise<TradeRelationFacts> {
  if (a === b) return { self: true, blocked: false, friendSince: null, guildmatesSince: null };
  const { low, high } = pairOf(a, b);
  const [blocked, [friendship], members] = await Promise.all([
    isBlockedEitherWay(executor, a, b),
    executor
      .select({
        status: friendships.status,
        acceptedAt: friendships.acceptedAt,
        createdAt: friendships.createdAt,
      })
      .from(friendships)
      .where(and(eq(friendships.accountLow, low), eq(friendships.accountHigh, high))),
    executor
      .select({ guildId: guildMembers.guildId, joinedAt: guildMembers.joinedAt })
      .from(guildMembers)
      .where(or(eq(guildMembers.accountId, a), eq(guildMembers.accountId, b))),
  ]);
  // A friendship without an acceptance time (none should exist) counts from its row.
  const friendSince =
    friendship?.status === 'friends' ? (friendship.acceptedAt ?? friendship.createdAt) : null;
  const shared =
    members.length === 2 && members[0]!.guildId === members[1]!.guildId
      ? new Date(Math.max(members[0]!.joinedAt.getTime(), members[1]!.joinedAt.getTime()))
      : null;
  return { self: false, blocked, friendSince, guildmatesSince: shared };
}

/**
 * Ticket T.7 (exploit review F1): the other account's standing as a trade decision may see it.
 * Read only once the pair qualifies (no block, a friend or guildmate of 7 days or more, judged by
 * game-core with no standing at all), and then handed on as one bit, so no refusal can name, or
 * count, the rules the other account misses. Every decision about another account (send, accept,
 * the receiver's preview, the eligibility endpoint) goes through this.
 */
export async function hiddenCounterpart(
  executor: Executor,
  input: {
    actor: TradeStanding;
    relation: TradeRelationFacts;
    settings: TradingSettings;
    now: Date;
    otherAccountId: string;
  },
): Promise<'hidden-eligible' | 'hidden-ineligible' | null> {
  const probe = tradeDecision({
    action: 'send',
    settings: input.settings,
    now: input.now,
    actor: input.actor,
    counterpart: null,
    relation: input.relation,
  });
  if (probe.refusals.some((r) => r.party === 'pair')) return null;
  const theirs = await loadTradeStanding(executor, input.otherAccountId, input.now);
  return theirs && standingRefusals(theirs, input.now).length === 0
    ? 'hidden-eligible'
    : 'hidden-ineligible';
}
