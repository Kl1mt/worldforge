import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  FRIEND_LIMITS,
  FRIEND_LIMIT_REFUSALS,
  HANDLE_RE,
  PRESENCE_BUCKETS,
  friendDecision,
  visibleRelation,
  type FriendAction,
  type FriendRefusal,
  type PresenceBucket,
  type Relation,
  type SocialWriteAction,
} from '@worldforge/game-core';
import { accountPresence, accounts, blocks, friendships, type Account } from '../db/schema.js';
import type { Executor, Transaction } from '../db/types.js';
import { writeAudit } from '../db/audit.js';
import { dropGuildOffersBetween } from './guild-model.js';
import { ApiError } from '../errors.js';
import { normalizeDisplayName } from '../auth/validation.js';
import { hiddenTargetKeys } from './sanctions.js';
import { socialWrite } from './social-write.js';
import { profileFieldKey } from './targets.js';
import {
  blockedBy,
  friendIds,
  lockSocialAccounts,
  pairOf,
  pendingFor,
  presenceHidden,
  presenceOf,
  relationBetween,
  relationCounts,
} from './relations.js';

function refuse(r: FriendRefusal): never {
  throw new ApiError(r.status, r.code, r.message);
}

const NOT_FOUND: FriendRefusal = {
  status: 404,
  code: 'not_found',
  message: 'No player by that name.',
};

export async function accountBy(
  executor: Executor,
  by: { handle: string } | { name: string },
  now: Date,
): Promise<Account | null> {
  if ('handle' in by) {
    if (!HANDLE_RE.test(by.handle)) return null;
    const [row] = await executor.select().from(accounts).where(eq(accounts.handle, by.handle));
    return row ?? null;
  }
  const name = normalizeDisplayName(by.name);
  const [row] = await executor
    .select()
    .from(accounts)
    .where(sql`lower(${accounts.displayName}) = lower(${name})`)
    .limit(1);
  // A name hidden by a moderator can't be looked up (as in 4.1's lookup).
  if (!row) return null;
  const hidden = await hiddenTargetKeys(executor, [profileFieldKey(row.id, 'displayName')], now);
  return hidden.size > 0 ? null : row;
}

interface PairContext {
  tx: Transaction;
  me: Account;
  them: Account;
  relation: Relation;
  now: Date;
}

/**
 * One friend action on one pair: resolve the target, lock both accounts, read the relation, ask
 * the matrix, then run `effect`. Answers the viewer's new (visible) relation.
 */
async function pairAction(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  writeAction: SocialWriteAction,
  action: FriendAction,
  target: { handle: string } | { name: string },
  effect: (ctx: PairContext) => Promise<Relation>,
): Promise<{ relation: Relation }> {
  return socialWrite(app, request, reply, writeAction, async (tx, { account, now }) => {
    const them = await accountBy(tx, target, now);
    if (!them) refuse(NOT_FOUND);
    if (them.id === account.id) refuse(friendDecision('self', action) as FriendRefusal);
    await lockSocialAccounts(tx, [account.id, them.id]);
    const relation = await relationBetween(tx, account.id, them.id);
    const decision = friendDecision(relation, action);
    if (decision !== 'allowed') refuse(decision);
    const next = await effect({ tx, me: account, them, relation, now });
    return { relation: visibleRelation(next) ?? 'stranger' };
  });
}

function pairWhere(a: string, b: string) {
  const { low, high } = pairOf(a, b);
  return and(eq(friendships.accountLow, low), eq(friendships.accountHigh, high));
}

async function acceptPair({ tx, me, them, now }: PairContext): Promise<Relation> {
  const [mine, theirs] = await Promise.all([
    relationCounts(tx, me.id),
    relationCounts(tx, them.id),
  ]);
  if (mine.friends >= FRIEND_LIMITS.friends) refuse(FRIEND_LIMIT_REFUSALS.friends);
  if (theirs.friends >= FRIEND_LIMITS.friends) refuse(FRIEND_LIMIT_REFUSALS.theirFriends);
  await tx
    .update(friendships)
    .set({ status: 'friends', acceptedAt: now })
    .where(pairWhere(me.id, them.id));
  await writeAudit(tx, { event: 'friend.accept', accountId: me.id, data: { with: them.id } });
  return 'friend';
}

async function deletePair(tx: Transaction, a: string, b: string) {
  return tx.delete(friendships).where(pairWhere(a, b)).returning({ status: friendships.status });
}

const handleParams = {
  type: 'object',
  required: ['handle'],
  properties: { handle: { type: 'string', minLength: 1, maxLength: 64 } },
} as const;

const relationResponse = {
  200: {
    type: 'object',
    required: ['relation'],
    properties: { relation: { type: 'string' } },
  },
} as const;

const targetBody = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['handle'],
      properties: { handle: { type: 'string', minLength: 1, maxLength: 64 } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: { name: { type: 'string', minLength: 1, maxLength: 64 } },
    },
  ],
} as const;

const playerSchema = {
  type: 'object',
  required: ['handle', 'displayName'],
  properties: {
    handle: { type: 'string' },
    // `null` while a moderator hides the name.
    displayName: { type: ['string', 'null'] },
    presence: { type: ['string', 'null'], enum: [...PRESENCE_BUCKETS, null] },
  },
} as const;

const friendsResponse = {
  304: { type: 'null' },
  200: {
    type: 'object',
    required: ['friends', 'incoming', 'outgoing', 'blocked', 'presenceHidden', 'limits'],
    properties: {
      friends: { type: 'array', items: playerSchema },
      incoming: { type: 'array', items: playerSchema },
      outgoing: { type: 'array', items: playerSchema },
      blocked: { type: 'array', items: playerSchema },
      presenceHidden: { type: 'boolean' },
      limits: {
        type: 'object',
        required: ['friends', 'outgoingRequests', 'incomingRequests', 'blocks'],
        properties: {
          friends: { type: 'integer' },
          outgoingRequests: { type: 'integer' },
          incomingRequests: { type: 'integer' },
          blocks: { type: 'integer' },
        },
      },
    },
  },
} as const;

interface PlayerEntry {
  handle: string;
  displayName: string | null;
  presence?: PresenceBucket | null;
}

const BUCKET_ORDER: Record<string, number> = { online: 0, today: 1, week: 2, longer: 3 };

/** Friends, requests and blocks (ticket 4.3, docs/SOCIAL.md "Relations"). */
export async function registerFriends(app: FastifyInstance): Promise<void> {
  // The friends screen polls this (every 60 s while open). Small (capped lists), with an ETag so
  // an unchanged list costs a `304`. Presence is a bucket, never a time.
  app.get(
    '/friends',
    { preHandler: app.requireAccount, schema: { response: friendsResponse } },
    async (request, reply) => {
      const me = request.auth!.account;
      const now = app.authNow();
      const [friends, pending, blocked, hidden] = await Promise.all([
        friendIds(app.db, me.id),
        pendingFor(app.db, me.id),
        blockedBy(app.db, me.id),
        presenceHidden(app.db, me.id),
      ]);
      pending.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      blocked.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const ids = [
        ...friends,
        ...pending.map((p) => p.otherId),
        ...blocked.map((b) => b.blockedId),
      ];
      const [people, hiddenNames, presence] = await Promise.all([
        ids.length
          ? app.db
              .select({
                id: accounts.id,
                handle: accounts.handle,
                displayName: accounts.displayName,
              })
              .from(accounts)
              .where(inArray(accounts.id, ids))
          : Promise.resolve([]),
        hiddenTargetKeys(
          app.db,
          ids.map((id) => profileFieldKey(id, 'displayName')),
          now,
        ),
        presenceOf(app.db, friends, now),
      ]);
      const byId = new Map(people.map((p) => [p.id, p]));
      const entry = (id: string): PlayerEntry => {
        const p = byId.get(id)!;
        return {
          handle: p.handle,
          displayName: hiddenNames.has(profileFieldKey(id, 'displayName')) ? null : p.displayName,
        };
      };
      const friendEntries = friends
        .map((id) => ({ ...entry(id), presence: presence.get(id) ?? null }))
        .sort(
          (a, b) =>
            (BUCKET_ORDER[a.presence ?? 'longer'] ?? 3) -
              (BUCKET_ORDER[b.presence ?? 'longer'] ?? 3) ||
            (a.displayName ?? '').localeCompare(b.displayName ?? ''),
        );
      const body = {
        friends: friendEntries,
        incoming: pending.filter((p) => p.incoming).map((p) => entry(p.otherId)),
        outgoing: pending.filter((p) => !p.incoming).map((p) => entry(p.otherId)),
        blocked: blocked.map((b) => entry(b.blockedId)),
        presenceHidden: hidden,
        limits: { ...FRIEND_LIMITS },
      };
      const etag = `"${createHash('sha256').update(JSON.stringify(body)).digest('base64url').slice(0, 22)}"`;
      void reply.header('etag', etag).header('cache-control', 'private, no-cache');
      if (request.headers['if-none-match'] === etag) return reply.code(304).send();
      return body;
    },
  );

  // For other features (4.2's profile page): the viewer's relation to a player. A player who
  // blocks the viewer is answered like an unknown one.
  app.get(
    '/players/:handle/relation',
    {
      preHandler: app.requireAccount,
      schema: { params: handleParams, response: relationResponse },
    },
    async (request) => {
      const me = request.auth!.account;
      const them = await accountBy(
        app.db,
        { handle: (request.params as { handle: string }).handle },
        app.authNow(),
      );
      if (!them) refuse(NOT_FOUND);
      const relation = visibleRelation(await relationBetween(app.db, me.id, them.id));
      if (!relation) refuse(NOT_FOUND);
      return { relation };
    },
  );

  // Send a request (by handle, or by display name from the "add a friend" field). To someone
  // whose request is waiting, it accepts theirs: two players asking at once become friends once.
  app.post(
    '/friends/requests',
    { preHandler: app.requireAccount, schema: { body: targetBody, response: relationResponse } },
    async (request, reply) =>
      pairAction(
        app,
        request,
        reply,
        'friendRequest',
        'sendRequest',
        request.body as { handle: string } | { name: string },
        async (ctx) => {
          if (ctx.relation === 'requested-by-them') return acceptPair(ctx);
          const { tx, me, them, now } = ctx;
          const [mine, theirs] = await Promise.all([
            relationCounts(tx, me.id),
            relationCounts(tx, them.id),
          ]);
          if (mine.friends >= FRIEND_LIMITS.friends) refuse(FRIEND_LIMIT_REFUSALS.friends);
          if (mine.outgoing >= FRIEND_LIMITS.outgoingRequests) {
            refuse(FRIEND_LIMIT_REFUSALS.outgoingRequests);
          }
          if (theirs.friends >= FRIEND_LIMITS.friends) refuse(FRIEND_LIMIT_REFUSALS.theirFriends);
          if (theirs.incoming >= FRIEND_LIMITS.incomingRequests) {
            refuse(FRIEND_LIMIT_REFUSALS.incomingRequests);
          }
          const { low, high } = pairOf(me.id, them.id);
          await tx.insert(friendships).values({
            accountLow: low,
            accountHigh: high,
            status: 'pending',
            requestedBy: me.id,
            createdAt: now,
          });
          await writeAudit(tx, {
            event: 'friend.request',
            accountId: me.id,
            data: { to: them.id },
          });
          return 'requested-by-me';
        },
      ),
  );

  const simple = (
    url: string,
    writeAction: SocialWriteAction,
    action: FriendAction,
    effect: (ctx: PairContext) => Promise<Relation>,
  ) =>
    app.post(
      url,
      {
        preHandler: app.requireAccount,
        schema: { params: handleParams, response: relationResponse },
      },
      async (request, reply) =>
        pairAction(
          app,
          request,
          reply,
          writeAction,
          action,
          { handle: (request.params as { handle: string }).handle },
          effect,
        ),
    );

  simple('/friends/requests/:handle/accept', 'friendAccept', 'accept', acceptPair);

  simple(
    '/friends/requests/:handle/decline',
    'friendDecline',
    'decline',
    async ({ tx, me, them }) => {
      await deletePair(tx, me.id, them.id);
      await writeAudit(tx, { event: 'friend.decline', accountId: me.id, data: { from: them.id } });
      return 'stranger';
    },
  );

  simple('/friends/requests/:handle/cancel', 'friendCancel', 'cancel', async ({ tx, me, them }) => {
    await deletePair(tx, me.id, them.id);
    await writeAudit(tx, { event: 'friend.cancel', accountId: me.id, data: { to: them.id } });
    return 'stranger';
  });

  simple('/friends/:handle/remove', 'friendRemove', 'remove', async ({ tx, me, them, now }) => {
    await deletePair(tx, me.id, them.id);
    await writeAudit(tx, { event: 'friend.remove', accountId: me.id, data: { with: them.id } });
    // Ticket T.5: open trade offers that relied on the friendship are voided with it.
    await app.relationEvents.emit(
      { accountIds: [me.id, them.id], cause: 'friend_remove', at: now },
      tx,
    );
    return 'stranger';
  });

  // Block: removes the pair's friendship or request and hides each from the other. Not stopped
  // by a mute (stepping away is always allowed).
  app.post(
    '/blocks',
    { preHandler: app.requireAccount, schema: { body: targetBody, response: relationResponse } },
    async (request, reply) =>
      pairAction(
        app,
        request,
        reply,
        'block',
        'block',
        request.body as { handle: string } | { name: string },
        async ({ tx, me, them, now }) => {
          const counts = await relationCounts(tx, me.id);
          if (counts.blocks >= FRIEND_LIMITS.blocks) refuse(FRIEND_LIMIT_REFUSALS.blocks);
          const removed = await deletePair(tx, me.id, them.id);
          await tx.insert(blocks).values({ blockerId: me.id, blockedId: them.id, createdAt: now });
          // Ticket 4.11: guild invites and applications the block hides go with it.
          const dropped = await dropGuildOffersBetween(tx, me.id, them.id);
          await writeAudit(tx, {
            event: 'friend.block',
            accountId: me.id,
            data: {
              blocked: them.id,
              removed: removed[0]?.status ?? null,
              ...(dropped.invites || dropped.applications ? { guildOffers: dropped } : {}),
            },
          });
          // Ticket T.5: open trade offers between the two are voided with the block.
          await app.relationEvents.emit(
            { accountIds: [me.id, them.id], cause: 'block', at: now },
            tx,
          );
          return 'blocked-by-me';
        },
      ),
  );

  simple('/blocks/:handle/remove', 'unblock', 'unblock', async ({ tx, me, them }) => {
    await tx.delete(blocks).where(and(eq(blocks.blockerId, me.id), eq(blocks.blockedId, them.id)));
    await writeAudit(tx, {
      event: 'friend.unblock',
      accountId: me.id,
      data: { unblocked: them.id },
    });
    return relationBetween(tx, me.id, them.id);
  });

  // The presence setting. Only the player's own setting; reaches nobody, so not a social write.
  app.post(
    '/account/presence',
    {
      preHandler: app.requireAccount,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['hidden'],
          properties: { hidden: { type: 'boolean' } },
        },
        response: {
          200: {
            type: 'object',
            required: ['hidden'],
            properties: { hidden: { type: 'boolean' } },
          },
        },
      },
    },
    async (request, reply) => {
      const { hidden } = request.body as { hidden: boolean };
      // Ticket 4.11: a social write (its rate limit; mute-exempt), audited only when it changes.
      await socialWrite(app, request, reply, 'presence', async (tx, { account: me }) => {
        const [before] = await tx
          .select({ hidden: accountPresence.hidden })
          .from(accountPresence)
          .where(eq(accountPresence.accountId, me.id))
          .for('update');
        if ((before?.hidden ?? false) === hidden) return;
        await tx
          .insert(accountPresence)
          .values({ accountId: me.id, hidden })
          .onConflictDoUpdate({ target: accountPresence.accountId, set: { hidden } });
        await writeAudit(tx, { event: 'presence.setting', accountId: me.id, data: { hidden } });
      });
      return { hidden };
    },
  );
}
