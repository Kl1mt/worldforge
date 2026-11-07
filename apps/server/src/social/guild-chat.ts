import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, asc, desc, eq, gt, gte, isNull, lt, lte, notInArray, or } from 'drizzle-orm';
import {
  GUILD_CHAT_LIMITS,
  GUILD_CHAT_REFUSALS,
  GUILD_REFUSALS,
  guildChatDecision,
  type GuildChatAction,
  type GuildMessageKind,
  type GuildRefusal,
  type GuildRole,
  type GuildStanding,
  type GuildTarget,
  type GuildTombstone,
  type SocialWriteAction,
} from '@worldforge/game-core';
import { accounts, guildMessages, guilds, type Account, type Guild } from '../db/schema.js';
import type { Executor, Transaction } from '../db/types.js';
import { withTransaction } from '../db/transaction.js';
import { writeAudit } from '../db/audit.js';
import { uuidv7 } from '../db/uuid.js';
import { ApiError } from '../errors.js';
import { latestSeq, messageTargetKey, visibleMessage } from './chat-model.js';
import { guildMembersOf, lockGuild, membershipOf } from './guild-model.js';
import { blockedEitherWay } from './relations.js';
import {
  activeSanctions,
  hiddenTargetKeys,
  sanctionView,
  sanctionViewSchema,
} from './sanctions.js';
import { socialWrite } from './social-write.js';
import { profileFieldKey } from './targets.js';
import { assertPlayerText } from './text.js';

/**
 * Guild chat and the guild notice (ticket 4.5, docs/SOCIAL.md "Guild chat").
 *
 * - **Reads** run in one read-only `repeatable read` snapshot: the membership check and every
 *   line come from the same moment, so a poll racing a kick or a leave either sees the member
 *   and only lines from before the kick, or answers `404 not_in_guild`.
 * - **Writes** run in `socialWrite` (social rate-limit class, mutes) and under the guild's lock,
 *   which every membership change also takes: a kicked player's post either lands before the
 *   kick or is refused. `seq` is `max + 1` under that lock, so lines commit in `seq` order and a
 *   `since` cursor never skips one.
 * - Lines by a player the viewer blocks, or who blocks the viewer, are left out of every page.
 *   Removed and hidden lines are tombstones: their text is never sent.
 */

function refuse(r: GuildRefusal): never {
  throw new ApiError(r.status, r.code, r.message);
}

function decide(standing: GuildStanding, action: GuildChatAction, author?: GuildTarget) {
  const d = guildChatDecision(standing, action, author);
  if (d !== 'allowed') refuse(d);
}

// -----------------------------------------------------------------------------------------------
// Views

export interface ChatLineView {
  id: string;
  seq: number;
  kind: GuildMessageKind;
  /** Null once the author's account is gone. */
  author: {
    handle: string;
    /** Null while a moderator hides the display name. */
    displayName: string | null;
    /** Their rank in the guild now; null when they have left it. */
    role: GuildRole | null;
  } | null;
  mine: boolean;
  /** Null for a tombstone. */
  text: string | null;
  tombstone: GuildTombstone | null;
  sentAt: string;
}

const lineSchema = {
  type: 'object',
  required: ['id', 'seq', 'kind', 'author', 'mine', 'text', 'tombstone', 'sentAt'],
  properties: {
    id: { type: 'string' },
    seq: { type: 'integer' },
    kind: { type: 'string' },
    author: {
      type: ['object', 'null'],
      required: ['handle', 'displayName', 'role'],
      properties: {
        handle: { type: 'string' },
        displayName: { type: ['string', 'null'] },
        role: { type: ['string', 'null'] },
      },
    },
    mine: { type: 'boolean' },
    text: { type: ['string', 'null'] },
    tombstone: { type: ['string', 'null'] },
    sentAt: { type: 'string' },
  },
} as const;

const chatResponse = {
  200: {
    type: 'object',
    required: [
      'guild',
      'role',
      'messages',
      'revised',
      'gone',
      'notice',
      'next',
      'hasOlder',
      'more',
      'mute',
    ],
    properties: {
      guild: { type: 'object', required: ['handle'], properties: { handle: { type: 'string' } } },
      role: { type: 'string' },
      /** Oldest first. */
      messages: { type: 'array', items: lineSchema },
      /** Polls: lines below the cursor that are tombstones now. */
      revised: { type: 'array', items: lineSchema },
      /** Polls: `seq`s below the cursor the viewer may no longer see (a block since). */
      gone: { type: 'array', items: { type: 'integer' } },
      notice: { anyOf: [lineSchema, { type: 'null' }] },
      /** The `since` for the next poll. */
      next: { type: 'integer' },
      /** First page and `before`: older readable lines exist. */
      hasOlder: { type: 'boolean' },
      /** Polls: more new lines than one poll returns; load the newest page again. */
      more: { type: 'boolean' },
      mute: { anyOf: [sanctionViewSchema, { type: 'null' }] },
    },
  },
  304: { type: 'null' },
} as const;

type Row = typeof guildMessages.$inferSelect & {
  authorHandle: string | null;
  authorName: string | null;
};

interface ReadContext {
  me: Account;
  guild: Guild;
  roles: Map<string, GuildRole>;
  hidden: Set<string>;
}

function tombstoneOf(row: Row, hidden: Set<string>): GuildTombstone | null {
  if (row.removedAs === 'withdrawn') return 'withdrawn';
  if (row.removedAs === 'removed') return 'removed';
  if (hidden.has(messageTargetKey(row.id))) return 'hidden';
  return null;
}

function lineView(row: Row, ctx: ReadContext): ChatLineView {
  const tombstone = tombstoneOf(row, ctx.hidden);
  return {
    id: row.id,
    seq: row.seq,
    kind: row.kind as GuildMessageKind,
    author:
      row.authorId && row.authorHandle
        ? {
            handle: row.authorHandle,
            displayName: ctx.hidden.has(profileFieldKey(row.authorId, 'displayName'))
              ? null
              : row.authorName,
            role: ctx.roles.get(row.authorId) ?? null,
          }
        : null,
    mine: row.authorId === ctx.me.id,
    text: tombstone ? null : row.body,
    tombstone,
    sentAt: row.createdAt.toISOString(),
  };
}

const lineColumns = {
  id: guildMessages.id,
  guildId: guildMessages.guildId,
  seq: guildMessages.seq,
  authorId: guildMessages.authorId,
  kind: guildMessages.kind,
  body: guildMessages.body,
  createdAt: guildMessages.createdAt,
  removedAt: guildMessages.removedAt,
  removedBy: guildMessages.removedBy,
  removedAs: guildMessages.removedAs,
  authorHandle: accounts.handle,
  authorName: accounts.displayName,
};

interface ChatQuery {
  since?: number;
  before?: number;
  from?: number;
}

/**
 * One read of the chat, inside the snapshot. The first page (no cursor), an older page
 * (`before`), or a poll (`since`, with `from`: the oldest line the client holds, whose removals
 * it wants to hear about, at most `revisionWindow` lines below the cursor).
 */
async function readChat(tx: Executor, me: Account, q: ChatQuery, now: Date) {
  const mine = await membershipOf(tx, me.id);
  if (!mine) refuse(GUILD_REFUSALS.notInGuild);
  const guild = mine.guild;
  // One connection: the reads run one after another.
  const members = await guildMembersOf(tx, guild.id);
  const blocked = await blockedEitherWay(tx, me.id);
  const latest = await latestSeq(tx, guild.id);
  const mutes = await activeSanctions(tx, me.id, now, ['mute']);
  const roles = new Map(members.map((m) => [m.accountId, m.role]));
  const floor = Math.max(0, latest - GUILD_CHAT_LIMITS.historyMessages);
  const dateFloor = new Date(now.getTime() - GUILD_CHAT_LIMITS.historyDays * 86_400_000);
  const blockedIds = [...blocked];
  const readable = and(
    eq(guildMessages.guildId, guild.id),
    gt(guildMessages.seq, floor),
    gt(guildMessages.createdAt, dateFloor),
    blockedIds.length
      ? or(isNull(guildMessages.authorId), notInArray(guildMessages.authorId, blockedIds))
      : undefined,
  );
  const select = () =>
    tx
      .select(lineColumns)
      .from(guildMessages)
      .leftJoin(accounts, eq(accounts.id, guildMessages.authorId));

  let rows: Row[];
  let revisionRows: Row[] = [];
  let gone: number[] = [];
  let hasOlder = false;
  let more = false;
  let next = latest;
  const { page, pollMax, revisionWindow } = GUILD_CHAT_LIMITS;
  if (q.since !== undefined) {
    rows = await select()
      .where(and(readable, gt(guildMessages.seq, q.since)))
      .orderBy(asc(guildMessages.seq))
      .limit(pollMax + 1);
    more = rows.length > pollMax;
    rows = rows.slice(0, pollMax);
    if (more) next = rows[rows.length - 1]!.seq;
    const top = Math.min(q.since, latest);
    const low = Math.max(q.from ?? top, top - revisionWindow, floor + 1);
    if (low <= top) {
      // Every line in the window (blocked authors too), to report what changed below the cursor.
      const window = await select()
        .where(
          and(
            eq(guildMessages.guildId, guild.id),
            gte(guildMessages.seq, low),
            lte(guildMessages.seq, top),
          ),
        )
        .orderBy(asc(guildMessages.seq));
      gone = window.filter((r) => r.authorId && blocked.has(r.authorId)).map((r) => r.seq);
      revisionRows = window.filter((r) => !(r.authorId && blocked.has(r.authorId)));
    }
  } else {
    rows = await select()
      .where(and(readable, q.before !== undefined ? lt(guildMessages.seq, q.before) : undefined))
      .orderBy(desc(guildMessages.seq))
      .limit(page + 1);
    hasOlder = rows.length > page;
    rows = rows.slice(0, page).reverse();
  }

  let noticeRow: Row | null = null;
  if (guild.noticeMessageId) {
    const [n] = await select().where(
      and(eq(guildMessages.id, guild.noticeMessageId), eq(guildMessages.guildId, guild.id)),
    );
    if (n && !(n.authorId && blocked.has(n.authorId))) noticeRow = n;
  }

  const all = [...rows, ...revisionRows, ...(noticeRow ? [noticeRow] : [])];
  const hidden = await hiddenTargetKeys(
    tx,
    [
      ...new Set([
        ...all.map((r) => messageTargetKey(r.id)),
        ...all.flatMap((r) => (r.authorId ? [profileFieldKey(r.authorId, 'displayName')] : [])),
      ]),
    ],
    now,
  );
  const ctx: ReadContext = { me, guild, roles, hidden };
  const mute = mutes[0];
  return {
    guild: { handle: guild.handle },
    role: mine.member.role,
    messages: rows.map((r) => lineView(r, ctx)),
    revised: revisionRows.filter((r) => tombstoneOf(r, hidden)).map((r) => lineView(r, ctx)),
    gone,
    notice: noticeRow ? lineView(noticeRow, ctx) : null,
    next,
    hasOlder,
    more,
    mute: mute ? sanctionView(mute) : null,
  };
}

// -----------------------------------------------------------------------------------------------
// Writes

/**
 * Inside `socialWrite`: the actor's guild locked, and their standing read under the lock. A
 * membership changes only under the guild's lock, so it holds until commit.
 */
async function lockMyGuild(tx: Transaction, me: Account) {
  const first = await membershipOf(tx, me.id);
  if (!first) refuse(GUILD_REFUSALS.notInGuild);
  await lockGuild(tx, first.guild.id);
  const mine = await membershipOf(tx, me.id);
  if (!mine || mine.guild.id !== first.guild.id) {
    refuse(GUILD_REFUSALS.notInGuild);
  }
  return { guild: mine.guild, standing: mine.member.role as GuildStanding };
}

async function insertLine(
  tx: Transaction,
  guild: Guild,
  me: Account,
  kind: GuildMessageKind,
  body: string,
  now: Date,
) {
  const seq = (await latestSeq(tx, guild.id)) + 1;
  const [row] = await tx
    .insert(guildMessages)
    .values({ id: uuidv7(), guildId: guild.id, seq, authorId: me.id, kind, body, createdAt: now })
    .returning();
  return row!;
}

function ownLine(
  row: typeof guildMessages.$inferSelect,
  me: Account,
  role: GuildRole,
): ChatLineView {
  return {
    id: row.id,
    seq: row.seq,
    kind: row.kind as GuildMessageKind,
    author: { handle: me.handle, displayName: me.displayName, role },
    mine: true,
    text: row.body,
    tombstone: null,
    sentAt: row.createdAt.toISOString(),
  };
}

const intQuery = { type: 'integer', minimum: 0, maximum: 2_147_483_647 } as const;

export async function registerGuildChat(app: FastifyInstance): Promise<void> {
  const write = <T>(
    request: FastifyRequest,
    reply: FastifyReply,
    action: SocialWriteAction,
    fn: Parameters<typeof socialWrite<T>>[4],
  ) => socialWrite<T>(app, request, reply, action, fn);

  // Read the chat: the newest page, an older page (`before`), or a poll (`since`, `from`).
  // Polled every 5 s while the chat is open and visible (30 s when hidden); an unchanged answer
  // is a `304` (ETag).
  app.get(
    '/guild/chat',
    {
      preHandler: app.requireAccount,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { since: intQuery, before: intQuery, from: intQuery },
        },
        response: chatResponse,
      },
    },
    async (request, reply) => {
      const q = request.query as ChatQuery;
      if (q.since !== undefined && q.before !== undefined) {
        throw new ApiError(400, 'validation_failed', 'Use either since or before, not both.');
      }
      const me = request.auth!.account;
      const now = app.authNow();
      const body = await withTransaction(app.db, (tx) => readChat(tx, me, q, now), {
        isolationLevel: 'repeatable read',
      });
      const etag = `"${createHash('sha256').update(JSON.stringify(body)).digest('base64url').slice(0, 22)}"`;
      void reply.header('etag', etag).header('cache-control', 'private, no-cache');
      if (request.headers['if-none-match'] === etag) return reply.code(304).send();
      return body;
    },
  );

  // Post a line.
  app.post(
    '/guild/chat',
    {
      preHandler: app.requireAccount,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['text'],
          properties: { text: { type: 'string', maxLength: 2000 } },
        },
        response: {
          201: { type: 'object', required: ['message'], properties: { message: lineSchema } },
        },
      },
    },
    async (request, reply) => {
      const text = assertPlayerText('chatMessage', (request.body as { text: string }).text, 'text');
      const message = await write(request, reply, 'chat', async (tx, { account, now }) => {
        const { guild, standing } = await lockMyGuild(tx, account);
        decide(standing, 'post');
        const row = await insertLine(tx, guild, account, 'chat', text, now);
        return ownLine(row, account, standing as GuildRole);
      });
      return reply.code(201).send({ message });
    },
  );

  // Remove a line: one's own (withdrawn), or as an officer / the leader (removed).
  app.post(
    '/guild/chat/:id/remove',
    {
      preHandler: app.requireAccount,
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
        },
        response: {
          200: {
            type: 'object',
            required: ['ok', 'tombstone'],
            properties: { ok: { type: 'boolean' }, tombstone: { type: 'string' } },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      return write(request, reply, 'chatDelete', async (tx, { account, now }) => {
        const { guild, standing } = await lockMyGuild(tx, account);
        const found = await visibleMessage(tx, account.id, id);
        if (!found) refuse(GUILD_CHAT_REFUSALS.messageNotFound);
        const { message } = found;
        const own = message.authorId === account.id;
        let author: GuildTarget = 'self';
        if (!own) {
          const theirs = message.authorId ? await membershipOf(tx, message.authorId) : null;
          author = theirs && theirs.guild.id === guild.id ? theirs.member.role : 'none';
        }
        decide(standing, 'delete', author);
        if (message.removedAt) refuse(GUILD_CHAT_REFUSALS.alreadyRemoved);
        const as: GuildTombstone = own ? 'withdrawn' : 'removed';
        await tx
          .update(guildMessages)
          .set({ removedAt: now, removedBy: account.id, removedAs: as })
          .where(eq(guildMessages.id, message.id));
        if (guild.noticeMessageId === message.id) {
          await tx.update(guilds).set({ noticeMessageId: null }).where(eq(guilds.id, guild.id));
        }
        await writeAudit(tx, {
          event: 'guild.chat_remove',
          accountId: account.id,
          data: {
            guildId: guild.id,
            messageId: message.id,
            kind: message.kind,
            authorId: message.authorId,
            as,
          },
        });
        return { ok: true, tombstone: as };
      });
    },
  );

  // Set (or, with empty text, take down) the guild notice: the leader and officers.
  app.post(
    '/guild/notice',
    {
      preHandler: app.requireAccount,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['text'],
          properties: { text: { type: 'string', maxLength: 4000 } },
        },
        response: {
          200: {
            type: 'object',
            required: ['notice'],
            properties: { notice: { anyOf: [lineSchema, { type: 'null' }] } },
          },
        },
      },
    },
    async (request, reply) => {
      const raw = (request.body as { text: string }).text;
      const clear = raw.trim() === '';
      const text = clear ? '' : assertPlayerText('guildNotice', raw, 'text');
      return write(request, reply, 'guildNotice', async (tx, { account, now }) => {
        const { guild, standing } = await lockMyGuild(tx, account);
        decide(standing, 'setNotice');
        const row = clear ? null : await insertLine(tx, guild, account, 'notice', text, now);
        await tx
          .update(guilds)
          .set({ noticeMessageId: row?.id ?? null })
          .where(eq(guilds.id, guild.id));
        await writeAudit(tx, {
          event: 'guild.notice',
          accountId: account.id,
          data: { guildId: guild.id, messageId: row?.id ?? null, previous: guild.noticeMessageId },
        });
        return { notice: row ? ownLine(row, account, standing as GuildRole) : null };
      });
    },
  );
}
