import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { accountNotifications, accounts } from '../db/schema.js';
import type { Executor } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { queryRows } from '../db/query.js';
import { isBlockedEitherWay } from '../social/relations.js';

/**
 * The notification inbox's writer (ticket 8.5, docs/NOTIFICATIONS.md). Every entry is written by
 * the server in the transaction of the event it reports, next to that event's audit row, from
 * the server's own facts (never a client body). The entry holds only what its reader may see:
 * ids of their own things (an offer, a duel, a hero of theirs) and content ids, never another
 * player's account id, hero id or name.
 */

export const INBOX_KINDS = [
  /** Drops worth seeing (Legendary and better, set pieces, Void, Prismatic). */
  'drop',
  /** A trade offer arrived for the account. */
  'trade.received',
  /** The account's offer was accepted. */
  'trade.accepted',
  /** An offer to or from the account was voided (a switch, a sanction, a moderator). */
  'trade.voided',
  /** What the account received in a trade is free of its hold. */
  'trade.released',
  /** Someone fought the account's arena defence. */
  'duel.defence',
  /** An event tier (milestone) was reached and its keepsake given. */
  'event.reward',
  /** A season's honours. */
  'season.honours',
  /** A guild season's honours. */
  'guild.honours',
  /** A town-works stage was finished (to every account). */
  'world.stage',
  /** The town entered a new era (to every account). */
  'world.era',
  /** A new game version (F.3's patch notes). */
  'release',
] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

/** Entries kept per account (newest first) … */
export const INBOX_KEEP = 200;
/** … and for at most this many days. */
export const INBOX_KEEP_DAYS = 60;
const DAY_MS = 86_400_000;

export interface NotifyInput {
  accountId: string;
  kind: InboxKind;
  data: Record<string, unknown>;
  now: Date;
  /** Writes the entry at most once per account (resumable jobs). */
  dedupeKey?: string;
  /**
   * The account whose action caused it, when that is another player. Nothing is written when the
   * actor is a test account (D.4: a test account's play reaches only its own inbox) or when
   * either account blocks the other (4.3).
   */
  from?: string | null;
}

/** Writes one entry (see `NotifyInput`); returns whether it was written. */
export async function notifyTx(executor: Executor, input: NotifyInput): Promise<boolean> {
  const { accountId, from } = input;
  if (from && from !== accountId) {
    const [actor] = await executor
      .select({ isTest: accounts.isTest })
      .from(accounts)
      .where(eq(accounts.id, from));
    if (!actor || actor.isTest) return false;
    if (await isBlockedEitherWay(executor, accountId, from)) return false;
  }
  const inserted = await executor
    .insert(accountNotifications)
    .values({
      id: uuidv7(input.now.getTime()),
      accountId,
      kind: input.kind,
      data: input.data,
      dedupeKey: input.dedupeKey ?? null,
      createdAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ id: accountNotifications.id });
  if (inserted.length === 0) return false;
  await pruneAccountInbox(executor, accountId, input.now);
  return true;
}

/**
 * Writes one entry to every account (a town-wide event: a works stage, an era), in one statement.
 * The dedupe key keeps it once per account if the event's job is resumed.
 */
export async function broadcastTx(
  executor: Executor,
  input: Omit<NotifyInput, 'accountId' | 'from'> & { dedupeKey: string },
): Promise<number> {
  const rows = await queryRows<{ id: string }>(
    executor,
    sql`
    insert into account_notifications (id, account_id, kind, data, dedupe_key, created_at)
    select gen_random_uuid(), a.id, ${input.kind}, ${JSON.stringify(input.data)}::jsonb,
      ${input.dedupeKey}, ${input.now}
    from accounts a
    on conflict do nothing
    returning id`,
  );
  return rows.length;
}

/** Keeps the account's newest `INBOX_KEEP` entries of the last `INBOX_KEEP_DAYS` days. */
export async function pruneAccountInbox(
  executor: Executor,
  accountId: string,
  now: Date,
): Promise<void> {
  const cutoff = new Date(now.getTime() - INBOX_KEEP_DAYS * DAY_MS);
  await executor
    .delete(accountNotifications)
    .where(
      and(
        eq(accountNotifications.accountId, accountId),
        lt(accountNotifications.createdAt, cutoff),
      ),
    );
  await executor.execute(sql`
    delete from account_notifications where id in (
      select id from account_notifications where account_id = ${accountId}
      order by created_at desc, id desc offset ${INBOX_KEEP})`);
}

/** The whole store's pruning (the scheduler's hourly pruning step); returns rows removed. */
export async function pruneInboxes(executor: Executor, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - INBOX_KEEP_DAYS * DAY_MS);
  const old = await executor
    .delete(accountNotifications)
    .where(lt(accountNotifications.createdAt, cutoff))
    .returning({ id: accountNotifications.id });
  const over = await queryRows<{ id: string }>(
    executor,
    sql`
    delete from account_notifications where id in (
      select id from (
        select id, row_number() over (
          partition by account_id order by created_at desc, id desc) as n
        from account_notifications) ranked
      where ranked.n > ${INBOX_KEEP})
    returning id`,
  );
  return old.length + over.length;
}

/** Marks entries read (only the account's own; already-read ones keep their time). */
export async function markReadTx(
  executor: Executor,
  accountId: string,
  ids: readonly string[] | 'all',
  now: Date,
): Promise<number> {
  const rows = await executor
    .update(accountNotifications)
    .set({ readAt: now })
    .where(
      and(
        eq(accountNotifications.accountId, accountId),
        sql`${accountNotifications.readAt} is null`,
        ids === 'all' ? undefined : inArray(accountNotifications.id, [...ids]),
      ),
    )
    .returning({ id: accountNotifications.id });
  return rows.length;
}

/** Item fields a drop entry shows (content ids only). */
export interface DropLike {
  baseId: string;
  rarityId: string;
  setId?: string | null;
  mythicId?: string | null;
  variant?: string | null;
}

/** Drops worth an entry: Legendary and Mythic (set pieces, Void and Prismatic are among them). */
export function isDropWorthSeeing(item: DropLike): boolean {
  return (
    item.rarityId === 'legendary' ||
    item.rarityId === 'mythic' ||
    Boolean(item.setId) ||
    Boolean(item.variant)
  );
}

/** Entries name at most this many items; `count` holds the rest. */
export const DROP_ENTRY_ITEMS = 5;

/**
 * One `drop` entry for a settlement or a crypt claim that kept drops worth seeing (only what went
 * to the hero: the loot filter's handled drops are not listed). Nothing when there are none.
 */
export async function notifyDropsTx(
  executor: Executor,
  input: {
    accountId: string;
    characterId: string;
    source: 'farming' | 'crypt';
    placeId: string;
    items: readonly DropLike[];
    now: Date;
  },
): Promise<boolean> {
  const worth = input.items.filter(isDropWorthSeeing);
  if (worth.length === 0) return false;
  return notifyTx(executor, {
    accountId: input.accountId,
    kind: 'drop',
    now: input.now,
    data: {
      characterId: input.characterId,
      source: input.source,
      placeId: input.placeId,
      count: worth.length,
      items: worth.slice(0, DROP_ENTRY_ITEMS).map((i) => ({
        baseId: i.baseId,
        rarityId: i.rarityId,
        ...(i.setId ? { setId: i.setId } : {}),
        ...(i.mythicId ? { mythicId: i.mythicId } : {}),
        ...(i.variant ? { variant: i.variant } : {}),
      })),
    },
  });
}
