import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import {
  DEFAULT_GUILD_EMBLEM,
  GUILD_CREATE_COST,
  GUILD_EMBLEM_IDS,
  GUILD_LIMITS,
  GUILD_LIMIT_REFUSALS,
  GUILD_REFUSALS,
  PRESENCE_BUCKETS,
  guildDecision,
  type GuildAction,
  type GuildRefusal,
  type GuildRole,
  type GuildStanding,
  type GuildTarget,
  type SocialWriteAction,
} from '@worldforge/game-core';
import {
  accounts,
  auditLog,
  guildApplications,
  guildInvites,
  guildMembers,
  guilds,
  type Account,
  type Guild,
} from '../db/schema.js';
import type { Executor, Transaction } from '../db/types.js';
import { writeAudit } from '../db/audit.js';
import { queryRows } from '../db/query.js';
import { uuidv7 } from '../db/uuid.js';
import { checkNewName } from '../names/checks.js';
import { ApiError } from '../errors.js';
import type { ActivityOptions } from '../activity/settle.js';
import { characterSchema, characterView } from '../characters/routes.js';
import { changeGold, insufficientGold } from '../economy/shared.js';
import { idempotentTransaction } from '../idempotency/index.js';
import { lockOwnedCharacter } from '../inventory/routes.js';
import { recordTelemetry } from '../telemetry/record.js';
import { goldOut } from '../telemetry/counts.js';
import { accountBy } from './friends.js';
import {
  claimGuildName,
  disbandGuildTx,
  guildByHandle,
  guildLeaderId,
  guildMembersOf,
  lockGuild,
  memberCount,
  membershipOf,
  nameKey,
} from './guild-model.js';
import {
  blockedEitherWay,
  isBlockedEitherWay,
  lockSocialAccounts,
  presenceOf,
  relationBetween,
  relationsFor,
} from './relations.js';
import { hiddenTargetKeys } from './sanctions.js';
import { latestSeq } from './chat-model.js';
import { assertSocialWriteAllowed, socialWrite } from './social-write.js';
import { profileFieldKey } from './targets.js';
import { assertPlayerText } from './text.js';
import { NO_PRESTIGE_SHOWN, prestigeFor, prestigeShownSchema } from '../seasons/model.js';

/**
 * Guild routes (ticket 4.4, docs/SOCIAL.md "Guilds"). Every write runs in `socialWrite` (the
 * social rate-limit class and the sanction check), asks game-core `guildDecision`, and holds the
 * locks described in `guild-model.ts`. Founding a guild is a value operation: `Idempotency-Key`,
 * gold from the chosen hero under its lock, `guild.create` audited and `gold.out guild_create`
 * recorded in the same transaction.
 */

function refuse(r: GuildRefusal): never {
  throw new ApiError(r.status, r.code, r.message);
}

const NO_GUILD: GuildRefusal = { status: 404, code: 'not_found', message: 'No such guild.' };
const NO_PLAYER: GuildRefusal = {
  status: 404,
  code: 'not_found',
  message: 'No player by that name.',
};
const NO_INVITE: GuildRefusal = {
  status: 404,
  code: 'no_invite',
  message: 'That invite is gone; it may have been withdrawn.',
};
const NO_APPLICATION: GuildRefusal = {
  status: 404,
  code: 'no_application',
  message: 'That application is gone; it may have been withdrawn.',
};

const day = (d: Date) => d.toISOString().slice(0, 10);

/** A guild that exists and that the viewer may see: hidden from players who block, or are blocked
 * by, its leader (a block hides each from the other everywhere; the guild is the leader's). */
export async function visibleGuild(executor: Executor, viewerId: string, handle: string) {
  const guild = await guildByHandle(executor, handle);
  if (!guild) return null;
  const leaderId = await guildLeaderId(executor, guild.id);
  if (leaderId && (await isBlockedEitherWay(executor, viewerId, leaderId))) return null;
  return guild;
}

// -----------------------------------------------------------------------------------------------
// Views

interface GuildSummary {
  handle: string;
  name: string;
  tag: string;
  emblem: string;
  memberCount: number;
  foundedOn: string;
}

async function summaries(executor: Executor, list: Guild[]): Promise<Map<string, GuildSummary>> {
  const ids = list.map((g) => g.id);
  const counts = ids.length
    ? await executor
        .select({ guildId: guildMembers.guildId, n: sql<number>`count(*)::int` })
        .from(guildMembers)
        .where(inArray(guildMembers.guildId, ids))
        .groupBy(guildMembers.guildId)
    : [];
  return new Map(
    list.map((g) => [
      g.id,
      {
        handle: g.handle,
        name: g.name,
        tag: g.tag,
        emblem: g.emblem,
        memberCount: counts.find((c) => c.guildId === g.id)?.n ?? 0,
        foundedOn: day(g.createdAt),
      },
    ]),
  );
}

/** Handles and display names (null while a moderator hides the name) of accounts. */
export async function people(executor: Executor, ids: string[], now: Date) {
  if (ids.length === 0) return new Map<string, { handle: string; displayName: string | null }>();
  const [rows, hidden] = await Promise.all([
    executor
      .select({ id: accounts.id, handle: accounts.handle, displayName: accounts.displayName })
      .from(accounts)
      .where(inArray(accounts.id, ids)),
    hiddenTargetKeys(
      executor,
      ids.map((id) => profileFieldKey(id, 'displayName')),
      now,
    ),
  ]);
  return new Map(
    rows.map((r) => [
      r.id,
      {
        handle: r.handle,
        displayName: hidden.has(profileFieldKey(r.id, 'displayName')) ? null : r.displayName,
      },
    ]),
  );
}

const ROLE_ORDER: Record<GuildRole, number> = { leader: 0, officer: 1, member: 2 };
const BUCKET_ORDER: Record<string, number> = { online: 0, today: 1, week: 2, longer: 3 };

const summarySchema = {
  type: 'object',
  required: ['handle', 'name', 'tag', 'emblem', 'memberCount', 'foundedOn'],
  properties: {
    handle: { type: 'string' },
    name: { type: 'string' },
    tag: { type: 'string' },
    emblem: { type: 'string' },
    memberCount: { type: 'integer' },
    foundedOn: { type: 'string' },
  },
} as const;

const personSchema = {
  type: 'object',
  required: ['handle', 'displayName'],
  properties: { handle: { type: 'string' }, displayName: { type: ['string', 'null'] } },
} as const;

const limitsSchema = {
  type: 'object',
  required: [
    'members',
    'invitesPerGuild',
    'invitesPerAccount',
    'applicationsPerGuild',
    'applicationsPerAccount',
  ],
  properties: {
    members: { type: 'integer' },
    invitesPerGuild: { type: 'integer' },
    invitesPerAccount: { type: 'integer' },
    applicationsPerGuild: { type: 'integer' },
    applicationsPerAccount: { type: 'integer' },
  },
} as const;

const myGuildResponse = {
  304: { type: 'null' },
  200: {
    type: 'object',
    required: ['guild', 'invites', 'applications', 'notice', 'createCost', 'limits'],
    properties: {
      guild: {
        anyOf: [
          { type: 'null' },
          {
            type: 'object',
            required: [
              ...summarySchema.required,
              'role',
              'renameRequired',
              'renameReason',
              'members',
              'invites',
              'applications',
            ],
            properties: {
              ...summarySchema.properties,
              role: { type: 'string' },
              renameRequired: { type: 'boolean' },
              renameReason: { type: ['string', 'null'] },
              members: {
                type: 'array',
                items: {
                  type: 'object',
                  required: [
                    'handle',
                    'displayName',
                    'role',
                    'presence',
                    'joinedOn',
                    'blocked',
                    'prestige',
                  ],
                  properties: {
                    handle: { type: 'string' },
                    displayName: { type: ['string', 'null'] },
                    role: { type: 'string' },
                    prestige: prestigeShownSchema,
                    presence: { type: ['string', 'null'], enum: [...PRESENCE_BUCKETS, null] },
                    joinedOn: { type: 'string' },
                    blocked: { type: 'boolean' },
                  },
                },
              },
              invites: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['player', 'invitedOn'],
                  properties: { player: personSchema, invitedOn: { type: 'string' } },
                },
              },
              applications: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['player', 'appliedOn'],
                  properties: { player: personSchema, appliedOn: { type: 'string' } },
                },
              },
            },
          },
        ],
      },
      invites: {
        type: 'array',
        items: {
          type: 'object',
          required: ['guild', 'invitedBy', 'invitedOn'],
          properties: {
            guild: summarySchema,
            invitedBy: { anyOf: [personSchema, { type: 'null' }] },
            invitedOn: { type: 'string' },
          },
        },
      },
      applications: {
        type: 'array',
        items: {
          type: 'object',
          required: ['guild', 'appliedOn'],
          properties: { guild: summarySchema, appliedOn: { type: 'string' } },
        },
      },
      notice: {
        anyOf: [
          { type: 'null' },
          {
            type: 'object',
            required: ['kind', 'guildName', 'on', 'reason'],
            properties: {
              kind: { type: 'string', enum: ['kicked', 'disbanded', 'disbandedByModerator'] },
              guildName: { type: 'string' },
              on: { type: 'string' },
              reason: { type: ['string', 'null'] },
            },
          },
        ],
      },
      createCost: { type: 'integer' },
      limits: limitsSchema,
    },
  },
} as const;

const NOTICE_DAYS = 7;

/**
 * Why a guildless player last left a guild against their will (a kick, or a disband by the leader
 * or a moderator, in the last week and after their last join), from the audit log.
 */
async function guildNotice(executor: Executor, accountId: string, now: Date) {
  const since = new Date(now.getTime() - NOTICE_DAYS * 86_400_000);
  const [lastJoin] = await executor
    .select({ at: auditLog.createdAt })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.accountId, accountId),
        inArray(auditLog.event, ['guild.join', 'guild.create']),
        gt(auditLog.createdAt, since),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  const after = lastJoin?.at ?? since;
  const [row] = await executor
    .select({ event: auditLog.event, data: auditLog.data, at: auditLog.createdAt })
    .from(auditLog)
    .where(
      and(
        inArray(auditLog.event, ['guild.kick', 'guild.disband']),
        gt(auditLog.createdAt, after),
        sql`(${auditLog.data}->>'target' = ${accountId} or ${auditLog.data}->'members' @> ${JSON.stringify([accountId])}::jsonb)`,
        // The leader's own disband is not news to the leader.
        sql`${auditLog.accountId} is distinct from ${accountId}`,
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  if (!row) return null;
  const data = row.data as {
    guildName?: string;
    name?: string;
    byModerator?: boolean;
    reason?: string | null;
  };
  if (row.event === 'guild.kick') {
    return {
      kind: 'kicked' as const,
      guildName: String(data.guildName ?? ''),
      on: day(row.at),
      reason: null,
    };
  }
  return {
    kind: data.byModerator ? ('disbandedByModerator' as const) : ('disbanded' as const),
    guildName: String(data.name ?? ''),
    on: day(row.at),
    reason: data.byModerator ? (data.reason ?? null) : null,
  };
}

async function myGuildView(executor: Executor, me: Account, now: Date) {
  const mine = await membershipOf(executor, me.id);
  const [myInvites, myApplications] = await Promise.all([
    executor
      .select({ invite: guildInvites, guild: guilds })
      .from(guildInvites)
      .innerJoin(guilds, eq(guilds.id, guildInvites.guildId))
      .where(and(eq(guildInvites.accountId, me.id), isNull(guilds.disbandedAt)))
      .orderBy(desc(guildInvites.createdAt)),
    executor
      .select({ application: guildApplications, guild: guilds })
      .from(guildApplications)
      .innerJoin(guilds, eq(guilds.id, guildApplications.guildId))
      .where(and(eq(guildApplications.accountId, me.id), isNull(guilds.disbandedAt)))
      .orderBy(desc(guildApplications.createdAt)),
  ]);

  // Invites from a guild whose leader, or whose inviting officer, is blocked either way vanish.
  const offerGuilds = [...myInvites.map((i) => i.guild), ...myApplications.map((a) => a.guild)];
  const leaders = offerGuilds.length
    ? await executor
        .select({ guildId: guildMembers.guildId, accountId: guildMembers.accountId })
        .from(guildMembers)
        .where(
          and(
            inArray(
              guildMembers.guildId,
              offerGuilds.map((g) => g.id),
            ),
            eq(guildMembers.role, 'leader'),
          ),
        )
    : [];
  const inviters = myInvites.map((i) => i.invite.invitedBy).filter((id): id is string => !!id);
  const blocked = await blockedEitherWay(executor, me.id, [
    ...leaders.map((l) => l.accountId),
    ...inviters,
  ]);
  const hiddenGuild = (guildId: string) =>
    leaders.some((l) => l.guildId === guildId && blocked.has(l.accountId));
  const visibleInvites = myInvites.filter(
    (i) => !hiddenGuild(i.guild.id) && !(i.invite.invitedBy && blocked.has(i.invite.invitedBy)),
  );
  const visibleApplications = myApplications.filter((a) => !hiddenGuild(a.guild.id));

  let guildBody = null;
  if (mine) {
    const members = await guildMembersOf(executor, mine.guild.id);
    const officer = mine.member.role !== 'member';
    const [sentInvites, applications] = officer
      ? await Promise.all([
          executor
            .select()
            .from(guildInvites)
            .where(eq(guildInvites.guildId, mine.guild.id))
            .orderBy(desc(guildInvites.createdAt)),
          executor
            .select()
            .from(guildApplications)
            .where(eq(guildApplications.guildId, mine.guild.id))
            .orderBy(asc(guildApplications.createdAt)),
        ])
      : [[], []];
    const ids = [
      ...members.map((m) => m.accountId),
      ...sentInvites.map((i) => i.accountId),
      ...applications.map((a) => a.accountId),
    ];
    const [byId, presence, blockedIds, prestige] = await Promise.all([
      people(executor, ids, now),
      presenceOf(
        executor,
        members.map((m) => m.accountId),
        now,
      ),
      blockedEitherWay(executor, me.id, ids),
      prestigeFor(
        executor,
        members.map((m) => m.accountId),
      ),
    ]);
    const relations = await relationsFor(
      executor,
      me.id,
      members.map((m) => m.accountId),
    );
    const blockedByMe = new Set(
      [...relations].filter(([, r]) => r === 'blocked-by-me').map(([id]) => id),
    );
    const memberEntries = members
      .map((m) => {
        const p = byId.get(m.accountId)!;
        const byMe = blockedByMe.has(m.accountId);
        return {
          handle: p.handle,
          // A member the viewer blocks stays on the roster (officers must still be able to act),
          // without their name; one who blocks the viewer shows no presence.
          displayName: byMe ? null : p.displayName,
          role: m.role,
          presence: blockedIds.has(m.accountId) ? null : (presence.get(m.accountId) ?? null),
          joinedOn: day(m.joinedAt),
          blocked: byMe,
          // Ticket 5.3: the member's season title and frame (cosmetic), not for a blocked member.
          prestige: byMe ? NO_PRESTIGE_SHOWN : (prestige.get(m.accountId) ?? NO_PRESTIGE_SHOWN),
        };
      })
      .sort(
        (a, b) =>
          ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
          (BUCKET_ORDER[a.presence ?? 'longer'] ?? 3) -
            (BUCKET_ORDER[b.presence ?? 'longer'] ?? 3) ||
          (a.displayName ?? '').localeCompare(b.displayName ?? ''),
      );
    const summary = (await summaries(executor, [mine.guild])).get(mine.guild.id)!;
    guildBody = {
      ...summary,
      role: mine.member.role,
      renameRequired: mine.guild.renameRequired,
      renameReason: mine.guild.renameRequired ? mine.guild.renameReason : null,
      members: memberEntries,
      invites: sentInvites
        .filter((i) => !blockedIds.has(i.accountId))
        .map((i) => ({ player: byId.get(i.accountId)!, invitedOn: day(i.createdAt) })),
      // Applications from players blocked either way are invisible to this officer.
      applications: applications
        .filter((a) => !blockedIds.has(a.accountId))
        .map((a) => ({ player: byId.get(a.accountId)!, appliedOn: day(a.createdAt) })),
    };
  }

  const offerSummaries = await summaries(executor, offerGuilds);
  const inviterPeople = await people(executor, inviters, now);
  return {
    guild: guildBody,
    invites: visibleInvites.map((i) => ({
      guild: offerSummaries.get(i.guild.id)!,
      invitedBy: i.invite.invitedBy ? (inviterPeople.get(i.invite.invitedBy) ?? null) : null,
      invitedOn: day(i.invite.createdAt),
    })),
    applications: visibleApplications.map((a) => ({
      guild: offerSummaries.get(a.guild.id)!,
      appliedOn: day(a.application.createdAt),
    })),
    notice: mine ? null : await guildNotice(executor, me.id, now),
    createCost: GUILD_CREATE_COST,
    limits: { ...GUILD_LIMITS },
  };
}

// -----------------------------------------------------------------------------------------------
// Writes

interface MemberContext {
  tx: Transaction;
  me: Account;
  now: Date;
  /** The actor's guild (locked), or null. */
  guild: Guild | null;
  standing: GuildStanding;
}

/**
 * Takes the social locks of the actor and `others` (sorted), then the actor's guild's lock, and
 * reads the actor's standing under it. The actor's membership cannot be created concurrently
 * (that needs the actor's social lock), and cannot change once the guild lock is held.
 */
async function lockActor(
  tx: Transaction,
  me: Account,
  others: string[],
): Promise<{ guild: Guild | null; standing: GuildStanding }> {
  await lockSocialAccounts(tx, [me.id, ...others]);
  const first = await membershipOf(tx, me.id);
  if (!first) return { guild: null, standing: 'none' };
  await lockGuild(tx, first.guild.id);
  const mine = await membershipOf(tx, me.id);
  if (!mine) return { guild: null, standing: 'none' };
  return { guild: mine.guild, standing: mine.member.role };
}

function decide(standing: GuildStanding, action: GuildAction, target?: GuildTarget) {
  const d = guildDecision(standing, action, target);
  if (d !== 'allowed') refuse(d);
}

async function auditGuild(
  tx: Transaction,
  event: string,
  accountId: string,
  data: Record<string, unknown>,
) {
  await writeAudit(tx, { event, accountId, data });
}

/**
 * Ticket 8.7 (docs/PHASE8_EXPLOIT_REVIEW.md F4): a guild whose members are all test accounts may
 * fight the guild boss with minted heroes (6.10's F1), and the stages it breaks stay with the guild
 * (the week's total, the season's guild roll). A real account may not join it, so minted damage
 * never pays or ranks a real player. A test account joining a real guild is fine: it can't fight
 * there. Read under the guild lock that every membership change takes.
 */
async function refuseRealJoiningTestGuild(tx: Transaction, guildId: string, accountId: string) {
  const [row] = await queryRows<{ joiner_test: boolean; real_members: number }>(
    tx,
    sql`select (select is_test from accounts where id = ${accountId}) as joiner_test,
      (select count(*)::int from guild_members m join accounts a on a.id = m.account_id
        where m.guild_id = ${guildId} and not a.is_test) as real_members`,
  );
  if (row && !row.joiner_test && row.real_members === 0) {
    throw new ApiError(
      403,
      'test_guild',
      'This guild is made of test accounts only, so it can’t take in players.',
    );
  }
}

/** Adds `accountId` to the guild (under the guild's and the joiner's locks) and drops the
 * joiner's other invites and applications. Checks the cap. */
async function join(
  tx: Transaction,
  guild: Guild,
  accountId: string,
  via: { kind: 'invite' | 'application'; by: string | null },
  now: Date,
) {
  if ((await memberCount(tx, guild.id)) >= GUILD_LIMITS.members) refuse(GUILD_LIMIT_REFUSALS.full);
  await refuseRealJoiningTestGuild(tx, guild.id, accountId);
  await tx
    .insert(guildMembers)
    .values({ accountId, guildId: guild.id, role: 'member', joinedAt: now });
  await tx.delete(guildInvites).where(eq(guildInvites.accountId, accountId));
  await tx.delete(guildApplications).where(eq(guildApplications.accountId, accountId));
  await auditGuild(tx, 'guild.join', accountId, { guildId: guild.id, via: via.kind, by: via.by });
}

const handleParams = {
  type: 'object',
  required: ['handle'],
  properties: { handle: { type: 'string', minLength: 1, maxLength: 64 } },
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

const okResponse = {
  200: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
} as const;

const nameFields = {
  name: { type: 'string', maxLength: 200 },
  tag: { type: 'string', maxLength: 50 },
} as const;

/** Validates a guild name and tag through the text module (tags are upper-cased first). */
function guildText(body: { name: string; tag: string }) {
  const name = assertPlayerText('guildName', body.name, 'name');
  const tag = assertPlayerText('guildTag', body.tag.toUpperCase(), 'tag');
  return { name, tag };
}

export async function registerGuilds(
  app: FastifyInstance,
  activity: ActivityOptions,
): Promise<void> {
  // The guild page (polled every 60 s while open, with an ETag: an unchanged page is a `304`).
  app.get(
    '/guild',
    { preHandler: app.requireAccount, schema: { response: myGuildResponse } },
    async (request, reply) => {
      const body = await myGuildView(app.db, request.auth!.account, app.authNow());
      const etag = `"${createHash('sha256').update(JSON.stringify(body)).digest('base64url').slice(0, 22)}"`;
      void reply.header('etag', etag).header('cache-control', 'private, no-cache');
      if (request.headers['if-none-match'] === etag) return reply.code(304).send();
      return body;
    },
  );

  // Find guilds: by part of the name or the exact tag, or (no query) a few with room, largest first.
  app.get(
    '/guilds',
    {
      preHandler: app.requireAccount,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { q: { type: 'string', maxLength: 40 } },
        },
        response: {
          200: {
            type: 'object',
            required: ['guilds'],
            properties: { guilds: { type: 'array', items: summarySchema } },
          },
        },
      },
    },
    async (request) => {
      const me = request.auth!.account;
      const q = ((request.query as { q?: string }).q ?? '').normalize('NFKC').trim();
      const like = `%${nameKey(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const counted = app.db
        .select({ guildId: guildMembers.guildId, n: sql<number>`count(*)::int`.as('n') })
        .from(guildMembers)
        .groupBy(guildMembers.guildId)
        .as('counted');
      const rows = await app.db
        .select({ guild: guilds, n: counted.n })
        .from(guilds)
        .innerJoin(counted, eq(counted.guildId, guilds.id))
        .where(
          and(
            isNull(guilds.disbandedAt),
            q
              ? sql`(lower(${guilds.name}) like ${like} or ${guilds.tag} = ${q.toUpperCase()})`
              : sql`${counted.n} < ${GUILD_LIMITS.members}`,
          ),
        )
        .orderBy(desc(counted.n), asc(guilds.name))
        .limit(20);
      const leaders = rows.length
        ? await app.db
            .select({ guildId: guildMembers.guildId, accountId: guildMembers.accountId })
            .from(guildMembers)
            .where(
              and(
                inArray(
                  guildMembers.guildId,
                  rows.map((r) => r.guild.id),
                ),
                eq(guildMembers.role, 'leader'),
              ),
            )
        : [];
      const blocked = await blockedEitherWay(
        app.db,
        me.id,
        leaders.map((l) => l.accountId),
      );
      const visible = rows
        .filter((r) => !leaders.some((l) => l.guildId === r.guild.id && blocked.has(l.accountId)))
        .slice(0, 10);
      const sums = await summaries(
        app.db,
        visible.map((r) => r.guild),
      );
      return { guilds: visible.map((r) => sums.get(r.guild.id)!) };
    },
  );

  // A guild's public profile: name, tag, emblem, founding day, members and their roles (no
  // presence: that is for guildmates, on the guild page). Report action in the client.
  app.get(
    '/guilds/:handle',
    {
      preHandler: app.requireAccount,
      schema: {
        params: handleParams,
        response: {
          200: {
            type: 'object',
            required: ['guild', 'members', 'standing'],
            properties: {
              guild: summarySchema,
              members: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['handle', 'displayName', 'role', 'prestige'],
                  properties: {
                    handle: { type: 'string' },
                    displayName: { type: ['string', 'null'] },
                    role: { type: 'string' },
                    prestige: prestigeShownSchema,
                  },
                },
              },
              standing: {
                type: 'string',
                enum: ['member', 'invited', 'applied', 'otherGuild', 'none'],
              },
            },
          },
        },
      },
    },
    async (request) => {
      const me = request.auth!.account;
      const now = app.authNow();
      const guild = await visibleGuild(
        app.db,
        me.id,
        (request.params as { handle: string }).handle,
      );
      if (!guild) refuse(NO_GUILD);
      const members = await guildMembersOf(app.db, guild.id);
      const ids = members.map((m) => m.accountId);
      const [byId, blocked, mine, invite, application, sums, prestige] = await Promise.all([
        people(app.db, ids, now),
        blockedEitherWay(app.db, me.id, ids),
        membershipOf(app.db, me.id),
        app.db
          .select({ invitedBy: guildInvites.invitedBy })
          .from(guildInvites)
          .where(and(eq(guildInvites.guildId, guild.id), eq(guildInvites.accountId, me.id))),
        app.db
          .select({ id: guildApplications.accountId })
          .from(guildApplications)
          .where(
            and(eq(guildApplications.guildId, guild.id), eq(guildApplications.accountId, me.id)),
          ),
        summaries(app.db, [guild]),
        prestigeFor(app.db, ids),
      ]);
      const standing = mine
        ? mine.guild.id === guild.id
          ? 'member'
          : 'otherGuild'
        : invite.length > 0
          ? 'invited'
          : application.length > 0
            ? 'applied'
            : 'none';
      return {
        guild: sums.get(guild.id)!,
        members: members
          .filter((m) => !blocked.has(m.accountId))
          .sort(
            (a, b) =>
              ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
              a.joinedAt.getTime() - b.joinedAt.getTime(),
          )
          .map((m) => ({
            ...byId.get(m.accountId)!,
            role: m.role,
            prestige: prestige.get(m.accountId) ?? NO_PRESTIGE_SHOWN,
          })),
        standing,
      };
    },
  );

  // Found a guild: gold from the chosen hero (an `Idempotency-Key` value operation), name and tag
  // through the text module and unique case-insensitively, one guild per account.
  app.post(
    '/guilds',
    {
      preHandler: app.requireAccount,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['characterId', 'name', 'tag'],
          properties: {
            characterId: { type: 'string', format: 'uuid' },
            ...nameFields,
            emblem: { type: 'string', enum: [...GUILD_EMBLEM_IDS] },
          },
        },
        response: {
          201: {
            type: 'object',
            required: ['guild', 'character'],
            properties: { guild: summarySchema, character: characterSchema },
          },
        },
      },
    },
    async (request, reply) => {
      const me = request.auth!.account;
      const body = request.body as {
        characterId: string;
        name: string;
        tag: string;
        emblem?: string;
      };
      const { name, tag } = guildText(body);
      await app.socialWriteLimit(me.id, reply);
      return idempotentTransaction(
        app,
        request,
        reply,
        { now: activity.now, status: 201 },
        async (tx) => {
          const now = activity.now();
          await assertSocialWriteAllowed(tx, me.id, 'guildCreate', app.authNow());
          // Lock order: account (share) → hero (settles its activity first) → social → names.
          const hero = await lockOwnedCharacter(tx, me.id, body.characterId, activity);
          await lockSocialAccounts(tx, [me.id]);
          decide((await membershipOf(tx, me.id))?.member.role ?? 'none', 'create');
          await claimGuildName(tx, name, tag);
          // Ticket 6.9: no look-alike of another guild's name or a reserved one.
          const nameSkeleton = await checkNewName(tx, 'guildName', name, { field: 'name' });
          if (hero.gold < GUILD_CREATE_COST) throw insufficientGold(GUILD_CREATE_COST, hero.gold);
          const character = await changeGold(tx, hero, -GUILD_CREATE_COST, now);
          const [guild] = await tx
            .insert(guilds)
            .values({
              id: uuidv7(),
              name,
              nameSkeleton,
              tag,
              emblem: body.emblem ?? DEFAULT_GUILD_EMBLEM,
              createdBy: me.id,
              createdAt: now,
            })
            .returning();
          await tx
            .insert(guildMembers)
            .values({ accountId: me.id, guildId: guild!.id, role: 'leader', joinedAt: now });
          // Founding replaces any waiting offers.
          await tx.delete(guildInvites).where(eq(guildInvites.accountId, me.id));
          await tx.delete(guildApplications).where(eq(guildApplications.accountId, me.id));
          await writeAudit(tx, {
            event: 'guild.create',
            accountId: me.id,
            characterId: hero.id,
            data: {
              guildId: guild!.id,
              name,
              tag,
              emblem: guild!.emblem,
              gold: GUILD_CREATE_COST,
              goldAfter: character.gold,
            },
          });
          recordTelemetry(tx, now, goldOut('guild_create', '', GUILD_CREATE_COST));
          const sums = await summaries(tx, [guild!]);
          return { guild: sums.get(guild!.id)!, character: characterView(character) };
        },
      );
    },
  );

  /** A write by a member on their own guild, optionally aimed at another account. */
  const memberWrite = <T>(
    request: FastifyRequest,
    reply: FastifyReply,
    writeAction: SocialWriteAction,
    others: (tx: Transaction, me: Account, now: Date) => Promise<string[]>,
    fn: (ctx: MemberContext) => Promise<T>,
  ) =>
    socialWrite(app, request, reply, writeAction, async (tx, { account, now }) => {
      const otherIds = await others(tx, account, now);
      const { guild, standing } = await lockActor(tx, account, otherIds);
      return fn({ tx, me: account, now, guild, standing });
    });

  const none = async () => [];

  // Invite a player (by handle or display name). Officers and the leader. A player who applied is
  // taken in at once. Blocks either way refuse (a player who blocks you looks unknown).
  app.post(
    '/guild/invites',
    { preHandler: app.requireAccount, schema: { body: targetBody, response: okResponse } },
    async (request, reply) => {
      const target = request.body as { handle: string } | { name: string };
      let them: Account | null = null;
      return memberWrite(
        request,
        reply,
        'guildInvite',
        async (tx, _me, now) => {
          them = await accountBy(tx, target, now);
          return them ? [them.id] : [];
        },
        async ({ tx, me, now, guild, standing }) => {
          decide(standing, 'invite');
          if (!them) refuse(NO_PLAYER);
          const t: Account = them;
          if (t.id === me.id) refuse(GUILD_REFUSALS.self);
          const relation = await relationBetween(tx, me.id, t.id);
          if (relation === 'blocked-by-me') {
            refuse({
              status: 409,
              code: 'blocked_by_you',
              message: 'You block this player. Unblock them first.',
            });
          }
          // A player who blocks you is answered like an unknown one (a block is never announced).
          if (relation === 'blocked-by-them') refuse(NO_PLAYER);
          const g = guild!;
          // Ticket 4.11: the guild is its leader's; to a player blocked either way with the leader
          // it does not exist, so an officer's invite would only sit hidden in their inbox.
          const leaderId = await guildLeaderId(tx, g.id);
          if (leaderId && leaderId !== me.id && (await isBlockedEitherWay(tx, leaderId, t.id))) {
            refuse(NO_PLAYER);
          }
          if (await membershipOf(tx, t.id)) {
            refuse({
              status: 409,
              code: 'target_in_guild',
              message: 'This player is already in a guild.',
            });
          }
          const [applied] = await tx
            .select()
            .from(guildApplications)
            .where(and(eq(guildApplications.guildId, g.id), eq(guildApplications.accountId, t.id)));
          if (applied) {
            await join(tx, g, t.id, { kind: 'application', by: me.id }, now);
            return { ok: true };
          }
          const [existing] = await tx
            .select()
            .from(guildInvites)
            .where(and(eq(guildInvites.guildId, g.id), eq(guildInvites.accountId, t.id)));
          if (existing) {
            refuse({
              status: 409,
              code: 'invite_pending',
              message: 'This player has your invite already.',
            });
          }
          if ((await memberCount(tx, g.id)) >= GUILD_LIMITS.members)
            refuse(GUILD_LIMIT_REFUSALS.full);
          const [counts] = await tx
            .select({
              guild: sql<number>`count(*) filter (where ${guildInvites.guildId} = ${g.id})::int`,
              them: sql<number>`count(*) filter (where ${guildInvites.accountId} = ${t.id})::int`,
            })
            .from(guildInvites)
            .where(sql`${guildInvites.guildId} = ${g.id} or ${guildInvites.accountId} = ${t.id}`);
          if ((counts?.guild ?? 0) >= GUILD_LIMITS.invitesPerGuild)
            refuse(GUILD_LIMIT_REFUSALS.invitesPerGuild);
          if ((counts?.them ?? 0) >= GUILD_LIMITS.invitesPerAccount)
            refuse(GUILD_LIMIT_REFUSALS.invitesPerAccount);
          await tx
            .insert(guildInvites)
            .values({ guildId: g.id, accountId: t.id, invitedBy: me.id, createdAt: now });
          await auditGuild(tx, 'guild.invite', me.id, { guildId: g.id, target: t.id });
          return { ok: true };
        },
      );
    },
  );

  /** An officer's answer about a waiting invite or application of the account with `handle`. */
  const officerOnRequest = (
    url: string,
    writeAction: SocialWriteAction,
    action: GuildAction,
    effect: (ctx: MemberContext & { guild: Guild; them: Account }) => Promise<void>,
  ) =>
    app.post(
      url,
      { preHandler: app.requireAccount, schema: { params: handleParams, response: okResponse } },
      async (request, reply) => {
        const { handle } = request.params as { handle: string };
        let them: Account | null = null;
        return memberWrite(
          request,
          reply,
          writeAction,
          async (tx, _me, now) => {
            them = await accountBy(tx, { handle }, now);
            return them ? [them.id] : [];
          },
          async (ctx) => {
            decide(ctx.standing, action);
            if (!them) refuse(action === 'cancelInvite' ? NO_INVITE : NO_APPLICATION);
            await effect({ ...ctx, guild: ctx.guild!, them });
            return { ok: true };
          },
        );
      },
    );

  officerOnRequest(
    '/guild/invites/:handle/cancel',
    'guildInviteCancel',
    'cancelInvite',
    async ({ tx, me, guild, them }) => {
      // Ticket 4.11: like answering a petition, an invite to a player blocked either way is
      // invisible to this officer (another officer may still withdraw it).
      if (await isBlockedEitherWay(tx, me.id, them.id)) refuse(NO_INVITE);
      const gone = await tx
        .delete(guildInvites)
        .where(and(eq(guildInvites.guildId, guild.id), eq(guildInvites.accountId, them.id)))
        .returning();
      if (gone.length === 0) refuse(NO_INVITE);
      await auditGuild(tx, 'guild.invite_cancel', me.id, { guildId: guild.id, target: them.id });
    },
  );

  officerOnRequest(
    '/guild/applications/:handle/accept',
    'guildAcceptApplication',
    'acceptApplication',
    async ({ tx, me, now, guild, them }) => {
      // An application from a player blocked either way is invisible to this officer.
      if (await isBlockedEitherWay(tx, me.id, them.id)) refuse(NO_APPLICATION);
      const [row] = await tx
        .select()
        .from(guildApplications)
        .where(
          and(eq(guildApplications.guildId, guild.id), eq(guildApplications.accountId, them.id)),
        );
      if (!row) refuse(NO_APPLICATION);
      // Joining a guild drops the player's other applications, so they cannot be in another.
      if (await membershipOf(tx, them.id)) refuse(NO_APPLICATION);
      await join(tx, guild, them.id, { kind: 'application', by: me.id }, now);
    },
  );

  officerOnRequest(
    '/guild/applications/:handle/decline',
    'guildDeclineApplication',
    'declineApplication',
    async ({ tx, me, guild, them }) => {
      if (await isBlockedEitherWay(tx, me.id, them.id)) refuse(NO_APPLICATION);
      const gone = await tx
        .delete(guildApplications)
        .where(
          and(eq(guildApplications.guildId, guild.id), eq(guildApplications.accountId, them.id)),
        )
        .returning();
      if (gone.length === 0) refuse(NO_APPLICATION);
      await auditGuild(tx, 'guild.application_decline', me.id, {
        guildId: guild.id,
        target: them.id,
      });
    },
  );

  /** A write by anyone about another guild (by its handle): apply, withdraw, answer an invite. */
  const guildOffer = (
    url: string,
    writeAction: SocialWriteAction,
    action: GuildAction,
    effect: (ctx: { tx: Transaction; me: Account; now: Date; guild: Guild }) => Promise<void>,
    { hidden = 'refuse' }: { hidden?: 'refuse' | 'allow' } = {},
  ) =>
    app.post(
      url,
      { preHandler: app.requireAccount, schema: { params: handleParams, response: okResponse } },
      async (request, reply) =>
        socialWrite(app, request, reply, writeAction, async (tx, { account, now }) => {
          const { handle } = request.params as { handle: string };
          await lockSocialAccounts(tx, [account.id]);
          const guild = await guildByHandle(tx, handle);
          if (!guild) refuse(NO_GUILD);
          await lockGuild(tx, guild.id);
          const fresh = await guildByHandle(tx, handle);
          if (!fresh) refuse(NO_GUILD);
          if (hidden === 'refuse') {
            const leaderId = await guildLeaderId(tx, fresh.id);
            if (leaderId && (await isBlockedEitherWay(tx, account.id, leaderId))) refuse(NO_GUILD);
          }
          decide((await membershipOf(tx, account.id))?.member.role ?? 'none', action);
          await effect({ tx, me: account, now, guild: fresh });
          return { ok: true };
        }),
    );

  // Apply to a guild. If the guild invited you already, this accepts the invite.
  guildOffer('/guilds/:handle/apply', 'guildApply', 'apply', async ({ tx, me, now, guild }) => {
    const [invite] = await tx
      .select()
      .from(guildInvites)
      .where(and(eq(guildInvites.guildId, guild.id), eq(guildInvites.accountId, me.id)));
    if (invite && !(invite.invitedBy && (await isBlockedEitherWay(tx, me.id, invite.invitedBy)))) {
      await join(tx, guild, me.id, { kind: 'invite', by: invite.invitedBy }, now);
      return;
    }
    const [existing] = await tx
      .select()
      .from(guildApplications)
      .where(and(eq(guildApplications.guildId, guild.id), eq(guildApplications.accountId, me.id)));
    if (existing)
      refuse({
        status: 409,
        code: 'application_pending',
        message: 'Your application is waiting already.',
      });
    if ((await memberCount(tx, guild.id)) >= GUILD_LIMITS.members)
      refuse(GUILD_LIMIT_REFUSALS.full);
    const [counts] = await tx
      .select({
        guild: sql<number>`count(*) filter (where ${guildApplications.guildId} = ${guild.id})::int`,
        mine: sql<number>`count(*) filter (where ${guildApplications.accountId} = ${me.id})::int`,
      })
      .from(guildApplications)
      .where(
        sql`${guildApplications.guildId} = ${guild.id} or ${guildApplications.accountId} = ${me.id}`,
      );
    if ((counts?.mine ?? 0) >= GUILD_LIMITS.applicationsPerAccount)
      refuse(GUILD_LIMIT_REFUSALS.applicationsPerAccount);
    if ((counts?.guild ?? 0) >= GUILD_LIMITS.applicationsPerGuild)
      refuse(GUILD_LIMIT_REFUSALS.applicationsPerGuild);
    await tx
      .insert(guildApplications)
      .values({ guildId: guild.id, accountId: me.id, createdAt: now });
    await auditGuild(tx, 'guild.apply', me.id, { guildId: guild.id });
  });

  guildOffer(
    '/guilds/:handle/application/cancel',
    'guildCancelApplication',
    'cancelApplication',
    async ({ tx, me, guild }) => {
      const gone = await tx
        .delete(guildApplications)
        .where(and(eq(guildApplications.guildId, guild.id), eq(guildApplications.accountId, me.id)))
        .returning();
      if (gone.length === 0) refuse(NO_APPLICATION);
      await auditGuild(tx, 'guild.application_cancel', me.id, { guildId: guild.id });
    },
    { hidden: 'allow' },
  );

  guildOffer(
    '/guilds/:handle/invite/accept',
    'guildAcceptInvite',
    'acceptInvite',
    async ({ tx, me, now, guild }) => {
      const [invite] = await tx
        .select()
        .from(guildInvites)
        .where(and(eq(guildInvites.guildId, guild.id), eq(guildInvites.accountId, me.id)));
      if (!invite) refuse(NO_INVITE);
      if (invite.invitedBy && (await isBlockedEitherWay(tx, me.id, invite.invitedBy)))
        refuse(NO_INVITE);
      await join(tx, guild, me.id, { kind: 'invite', by: invite.invitedBy }, now);
    },
  );

  guildOffer(
    '/guilds/:handle/invite/decline',
    'guildDeclineInvite',
    'declineInvite',
    async ({ tx, me, guild }) => {
      const gone = await tx
        .delete(guildInvites)
        .where(and(eq(guildInvites.guildId, guild.id), eq(guildInvites.accountId, me.id)))
        .returning();
      if (gone.length === 0) refuse(NO_INVITE);
      await auditGuild(tx, 'guild.invite_decline', me.id, { guildId: guild.id });
    },
    { hidden: 'allow' },
  );

  /** kick / promote / demote / transfer: aimed at a member of the actor's guild, by handle. */
  const onMember = (
    path: string,
    writeAction: SocialWriteAction,
    action: GuildAction,
    effect: (
      ctx: MemberContext & { guild: Guild; them: Account; theirRole: GuildRole },
    ) => Promise<void>,
  ) =>
    app.post(
      `/guild/members/:handle/${path}`,
      { preHandler: app.requireAccount, schema: { params: handleParams, response: okResponse } },
      async (request, reply) => {
        const { handle } = request.params as { handle: string };
        return memberWrite(request, reply, writeAction, none, async (ctx) => {
          const them = await accountBy(ctx.tx, { handle }, ctx.now);
          let target: GuildTarget = 'none';
          let theirRole: GuildRole | null = null;
          if (them && them.id === ctx.me.id) target = 'self';
          else if (them && ctx.guild) {
            const [row] = await ctx.tx
              .select({ role: guildMembers.role })
              .from(guildMembers)
              .where(
                and(eq(guildMembers.guildId, ctx.guild.id), eq(guildMembers.accountId, them.id)),
              );
            if (row) target = theirRole = row.role;
          }
          decide(ctx.standing, action, target);
          await effect({ ...ctx, guild: ctx.guild!, them: them!, theirRole: theirRole! });
          return { ok: true };
        });
      },
    );

  const setRole = (tx: Transaction, guildId: string, accountId: string, role: GuildRole) =>
    tx
      .update(guildMembers)
      .set({ role })
      .where(and(eq(guildMembers.guildId, guildId), eq(guildMembers.accountId, accountId)));

  onMember('kick', 'guildKick', 'kick', async ({ tx, me, guild, them, theirRole }) => {
    await tx
      .delete(guildMembers)
      .where(and(eq(guildMembers.guildId, guild.id), eq(guildMembers.accountId, them.id)));
    await auditGuild(tx, 'guild.kick', me.id, {
      guildId: guild.id,
      guildName: guild.name,
      target: them.id,
      targetRole: theirRole,
      // Ticket 4.5: the last chat line they could have read (the chat is read under this lock).
      chatSeq: await latestSeq(tx, guild.id),
    });
    // Ticket T.5: offers that relied on the guild relation are voided.
    await app.relationEvents.emit(
      { accountIds: [them.id], cause: 'guild_kick', at: app.authNow() },
      tx,
    );
  });

  onMember('promote', 'guildPromote', 'promote', async ({ tx, me, guild, them }) => {
    await setRole(tx, guild.id, them.id, 'officer');
    await auditGuild(tx, 'guild.promote', me.id, { guildId: guild.id, target: them.id });
  });

  onMember('demote', 'guildDemote', 'demote', async ({ tx, me, guild, them }) => {
    await setRole(tx, guild.id, them.id, 'member');
    await auditGuild(tx, 'guild.demote', me.id, { guildId: guild.id, target: them.id });
  });

  // The leader hands over: they become an officer, the target the leader (in that order, for the
  // one-leader index).
  onMember(
    'transfer',
    'guildTransfer',
    'transferLeadership',
    async ({ tx, me, guild, them, theirRole }) => {
      await setRole(tx, guild.id, me.id, 'officer');
      await setRole(tx, guild.id, them.id, 'leader');
      await auditGuild(tx, 'guild.transfer', me.id, {
        guildId: guild.id,
        to: them.id,
        toRole: theirRole,
      });
    },
  );

  // Leave. The leader must hand over or disband first (`409 leader_must_hand_over`).
  app.post(
    '/guild/leave',
    { preHandler: app.requireAccount, schema: { response: okResponse } },
    async (request, reply) =>
      memberWrite(request, reply, 'guildLeave', none, async ({ tx, me, guild, standing }) => {
        decide(standing, 'leave');
        await tx.delete(guildMembers).where(eq(guildMembers.accountId, me.id));
        await auditGuild(tx, 'guild.leave', me.id, {
          guildId: guild!.id,
          role: standing,
          chatSeq: await latestSeq(tx, guild!.id),
        });
        // Ticket T.5: offers that relied on the guild relation are voided.
        await app.relationEvents.emit(
          { accountIds: [me.id], cause: 'guild_leave', at: app.authNow() },
          tx,
        );
        return { ok: true };
      }),
  );

  // Disband (the leader). The guild's name must be typed to confirm.
  app.post(
    '/guild/disband',
    {
      preHandler: app.requireAccount,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: { name: { type: 'string', maxLength: 200 } },
        },
        response: okResponse,
      },
    },
    async (request, reply) =>
      memberWrite(
        request,
        reply,
        'guildDisband',
        none,
        async ({ tx, me, now, guild, standing }) => {
          decide(standing, 'disband');
          const typed = (request.body as { name: string }).name.normalize('NFKC').trim();
          if (nameKey(typed) !== nameKey(guild!.name)) {
            throw new ApiError(
              422,
              'confirm_mismatch',
              'Type the guild’s name exactly to disband it.',
              {
                fields: { name: 'Type the guild’s name exactly to disband it.' },
              },
            );
          }
          await disbandGuildTx(
            tx,
            guild!,
            { accountId: me.id, moderator: false, reason: null },
            now,
            app.relationEvents,
          );
          return { ok: true };
        },
      ),
  );

  app.post(
    '/guild/emblem',
    {
      preHandler: app.requireAccount,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['emblem'],
          properties: { emblem: { type: 'string', enum: [...GUILD_EMBLEM_IDS] } },
        },
        response: okResponse,
      },
    },
    async (request, reply) =>
      memberWrite(request, reply, 'guildEmblem', none, async ({ tx, me, guild, standing }) => {
        decide(standing, 'setEmblem');
        const { emblem } = request.body as { emblem: string };
        await tx.update(guilds).set({ emblem }).where(eq(guilds.id, guild!.id));
        await auditGuild(tx, 'guild.emblem', me.id, { guildId: guild!.id, emblem });
        return { ok: true };
      }),
  );

  // After a moderator's forced rename: the leader chooses a new name and tag (not the old name).
  app.post(
    '/guild/rename',
    {
      preHandler: app.requireAccount,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'tag'],
          properties: nameFields,
        },
        response: okResponse,
      },
    },
    async (request, reply) => {
      const { name, tag } = guildText(request.body as { name: string; tag: string });
      return memberWrite(
        request,
        reply,
        'guildRename',
        none,
        async ({ tx, me, guild, standing }) => {
          decide(standing, 'rename');
          const g = guild!;
          if (!g.renameRequired) {
            refuse({
              status: 409,
              code: 'rename_not_required',
              message: 'Your guild keeps its name; only a moderator’s rename lets you change it.',
            });
          }
          if (g.renamedFrom && nameKey(g.renamedFrom) === nameKey(name)) {
            throw new ApiError(
              422,
              'name_not_allowed',
              'Choose a name other than the one a moderator removed.',
              {
                fields: { name: 'Choose a name other than the one a moderator removed.' },
              },
            );
          }
          await claimGuildName(tx, name, tag, g.id);
          // Ticket 6.9: nor a look-alike of the removed name, another guild's or a reserved one.
          const nameSkeleton = await checkNewName(tx, 'guildName', name, {
            field: 'name',
            selfId: g.id,
            previous: g.renamedFrom,
          });
          await tx
            .update(guilds)
            .set({ name, nameSkeleton, tag, renameRequired: false, renameReason: null })
            .where(eq(guilds.id, g.id));
          await auditGuild(tx, 'guild.rename', me.id, {
            guildId: g.id,
            name,
            tag,
            from: { name: g.name, tag: g.tag },
          });
          return { ok: true };
        },
      );
    },
  );
}
