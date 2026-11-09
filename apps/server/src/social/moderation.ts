import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, asc, count, eq, inArray, isNotNull, ne, or, sql, lte } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  SANCTION_FOR_ACTION,
  actionableRoles,
  moderationDecision,
  validSanctionDuration,
  type AccountRole,
  type ModerationAction,
  type SanctionAction,
} from '@worldforge/game-core';
import { accounts, guilds, reports, sanctions, type Account, type Sanction } from '../db/schema.js';
import { withTransaction } from '../db/transaction.js';
import type { Executor, Transaction } from '../db/types.js';
import { writeAudit } from '../db/audit.js';
import { uuidv7 } from '../db/uuid.js';
import { ApiError, notFoundBody } from '../errors.js';
import {
  type SanctionEvents,
  activeSanctions,
  hiddenTargetKeys,
  sanctionView,
  sanctionViewSchema,
} from './sanctions.js';
import { currentTargetValues, isHideable, reportTargetViewSchema } from './targets.js';
import { disbandGuildTx, forceRenameGuildTx, guildLeaderId, lockGuild } from './guild-model.js';
import { assertPlayerText } from './text.js';

/**
 * Moderator routes (ticket 4.1, docs/SOCIAL.md "Moderation"), all under `/api/mod`, all behind
 * `app.requireStaff` as an `onRequest` hook, so it runs before body validation: non-staff and
 * anonymous visitors get the same `404` as an unknown route, whatever they send.
 * Every action re-reads the actor's role under a share lock, so a role revoked by the CLI takes
 * effect for the next action even if the request already passed the preHandler.
 *
 * Lock order (no deadlocks): actor account (share) → report (update) → subject account (update)
 * → the subject's sanctions.
 */

const HOUR_MS = 3_600_000;

async function lockActor(tx: Executor, actorId: string): Promise<Account> {
  const [actor] = await tx.select().from(accounts).where(eq(accounts.id, actorId)).for('share');
  if (!actor || moderationDecision(actor.role, 'viewQueue') !== 'allowed') {
    throw new ApiError(404, 'not_found', 'Not found.');
  }
  return actor;
}

async function lockSubject(tx: Executor, subjectId: string): Promise<Account> {
  const [subject] = await tx
    .select()
    .from(accounts)
    .where(eq(accounts.id, subjectId))
    .for('update');
  if (!subject) throw new ApiError(404, 'not_found', 'That account no longer exists.');
  return subject;
}

function assertAllowed(actor: Account, action: ModerationAction, subject: Account) {
  const decision = moderationDecision(actor.role, action, {
    self: actor.id === subject.id,
    role: subject.role,
  });
  if (decision === 'not_found') throw new ApiError(404, 'not_found', 'Not found.');
  if (decision === 'forbidden') {
    throw new ApiError(
      403,
      'forbidden',
      actor.id === subject.id
        ? 'You cannot act on your own account.'
        : 'Only a higher role can act on this account.',
    );
  }
}

/** An unused placeholder display name for a forced rename ("Wanderer 482913"). */
async function placeholderName(tx: Executor): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const name = `Wanderer ${randomInt(100_000, 1_000_000)}`;
    const [taken] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(sql`lower(${accounts.displayName}) = lower(${name})`)
      .limit(1);
    if (!taken) return name;
  }
  throw new Error('no free placeholder name');
}

interface IssueInput {
  actor: Account;
  subject: Account;
  action: SanctionAction;
  reason: string;
  durationHours: number;
  /** For `hide`: the content's key and public target. */
  targetKey: string | null;
  target: Sanction['target'];
  now: Date;
  /** Ticket T.4: listeners run in this transaction after the rows are written. */
  events: SanctionEvents;
}

/** Issues a sanction under the subject's row lock. `409 already_sanctioned` if one of the same
 * kind (and, for `hide`, the same content) is active. */
async function issueSanction(tx: Transaction, input: IssueInput): Promise<Sanction> {
  const { actor, subject, action, now } = input;
  const kind = SANCTION_FOR_ACTION[action];
  const active = await activeSanctions(tx, subject.id, now, [kind]);
  const same = active.find((s) => kind !== 'hide' || s.targetKey === input.targetKey);
  if (same) {
    throw new ApiError(
      409,
      'already_sanctioned',
      'An active sanction of this kind exists; lift it first.',
      {
        sanction: sanctionView(same),
      },
    );
  }
  const data: Record<string, unknown> = {};
  if (kind === 'rename') {
    const placeholder = await placeholderName(tx);
    data.previousName = subject.displayName;
    data.placeholder = placeholder;
    await tx
      .update(accounts)
      .set({ displayName: placeholder, updatedAt: now })
      .where(eq(accounts.id, subject.id));
  }
  const [row] = await tx
    .insert(sanctions)
    .values({
      id: uuidv7(),
      subjectId: subject.id,
      kind,
      targetKey: kind === 'hide' ? input.targetKey : null,
      target: kind === 'hide' ? input.target : null,
      reason: input.reason,
      issuedBy: actor.id,
      data,
      createdAt: now,
      expiresAt: new Date(now.getTime() + input.durationHours * HOUR_MS),
    })
    .returning();
  // On the subject's history (account id), with the issuer in the data.
  await writeAudit(tx, {
    event: 'sanction.issue',
    accountId: subject.id,
    data: {
      sanctionId: row!.id,
      kind,
      issuedBy: actor.id,
      reason: input.reason,
      expiresAt: row!.expiresAt.toISOString(),
      ...(kind === 'hide' ? { targetKey: input.targetKey } : {}),
      ...data,
    },
  });
  await input.events.emit(
    { sanction: row!, kind, subjectId: subject.id, actorAccountId: actor.id, at: now },
    tx,
  );
  return row!;
}

const resolveBodySchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: { action: { const: 'dismiss' }, note: { type: 'string', maxLength: 2000 } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'reason', 'durationHours'],
      properties: {
        action: {
          type: 'string',
          enum: ['mute', 'suspend', 'forceRename', 'hideContent', 'restrictTrade'],
        },
        reason: { type: 'string', maxLength: 2000 },
        durationHours: { type: 'integer', minimum: 1, maximum: 24 * 366 },
      },
    },
    // Ticket 4.4: on a reported guild.
    {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'reason'],
      properties: {
        action: { type: 'string', enum: ['renameGuild', 'disbandGuild'] },
        reason: { type: 'string', maxLength: 2000 },
      },
    },
  ],
} as const;

type GuildModerationAction = 'renameGuild' | 'disbandGuild';

type ResolveBody =
  | { action: 'dismiss'; note?: string }
  | { action: SanctionAction; reason: string; durationHours: number }
  | { action: GuildModerationAction; reason: string };

const isGuildAction = (a: ResolveBody['action']): a is GuildModerationAction =>
  a === 'renameGuild' || a === 'disbandGuild';

const caseSchema = {
  type: 'object',
  required: ['reportId', 'target', 'subject', 'current', 'reports', 'openedAt'],
  properties: {
    reportId: { type: 'string' },
    target: reportTargetViewSchema,
    subject: {
      type: 'object',
      required: ['handle', 'displayName', 'role', 'sanctions', 'pastSanctions'],
      properties: {
        handle: { type: 'string' },
        displayName: { type: 'string' },
        role: { type: 'string' },
        sanctions: { type: 'array', items: sanctionViewSchema },
        pastSanctions: { type: 'integer' },
      },
    },
    current: {
      type: 'object',
      required: ['value', 'hidden'],
      properties: { value: { type: 'string' }, hidden: { type: 'boolean' } },
    },
    reports: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'reason', 'note', 'createdAt', 'context', 'reporter'],
        properties: {
          id: { type: 'string' },
          reason: { type: 'string' },
          note: { type: ['string', 'null'] },
          createdAt: { type: 'string' },
          context: { type: 'object', additionalProperties: true },
          reporter: {
            type: 'object',
            required: ['handle', 'displayName'],
            properties: { handle: { type: 'string' }, displayName: { type: 'string' } },
          },
        },
      },
    },
    openedAt: { type: 'string' },
  },
} as const;

export async function registerModeration(app: FastifyInstance): Promise<void> {
  // Ticket 4.11: every other path under /api/mod answers like a missing route, after the same
  // onRequest 404 as the real ones (so a malformed body cannot tell them apart).
  app.all('/mod/*', { onRequest: app.requireStaff }, async (request, reply) =>
    reply.code(404).send(notFoundBody(request)),
  );

  const reporter = alias(accounts, 'reporter');

  // The queue: one case per reported target with open reports, oldest first, for subjects the
  // viewer may act on (below their role, never themselves).
  app.get(
    '/mod/queue',
    {
      onRequest: app.requireStaff,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            cursor: { type: 'string', pattern: '^[0-9a-f-]{36}$' },
            limit: { type: 'integer', minimum: 1, maximum: 50 },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['cases', 'openCases', 'nextCursor'],
            properties: {
              cases: { type: 'array', items: caseSchema },
              openCases: { type: 'integer' },
              nextCursor: { type: ['string', 'null'] },
            },
          },
        },
      },
    },
    async (request) => {
      const { cursor, limit = 20 } = request.query as { cursor?: string; limit?: number };
      const actor = request.auth!.account;
      const now = app.authNow();
      const roles = actionableRoles(actor.role) as AccountRole[];
      const visible = and(
        eq(reports.status, 'open'),
        ne(reports.subjectId, actor.id),
        inArray(accounts.role, roles),
      );
      // Ticket 4.11: a case is one target *and* one subject. A guild's reports name its leader at
      // the time, so after a handover one guild can hold reports about different players; each
      // is its own case, and a viewer never sees (or closes) reports about themselves or a rank
      // they cannot act on.
      const firstId = sql<string>`min(${reports.id}::text)`;
      const caseRows = await app.db
        .select({ targetKey: reports.targetKey, subjectId: reports.subjectId, firstId })
        .from(reports)
        .innerJoin(accounts, eq(accounts.id, reports.subjectId))
        .where(visible)
        .groupBy(reports.targetKey, reports.subjectId)
        .having(cursor ? sql`min(${reports.id}::text) > ${cursor}` : undefined)
        .orderBy(asc(firstId))
        .limit(limit + 1);
      const [total] = await app.db
        .select({
          n: sql<number>`count(distinct (${reports.targetKey}, ${reports.subjectId}))::int`,
        })
        .from(reports)
        .innerJoin(accounts, eq(accounts.id, reports.subjectId))
        .where(visible);
      const page = caseRows.slice(0, limit);
      const keys = page.map((c) => c.targetKey);
      const rows = keys.length
        ? await app.db
            .select({ report: reports, subject: accounts, reporter })
            .from(reports)
            .innerJoin(accounts, eq(accounts.id, reports.subjectId))
            .innerJoin(reporter, eq(reporter.id, reports.reporterId))
            .where(and(inArray(reports.targetKey, keys), visible))
            .orderBy(asc(reports.id))
        : [];
      const subjectIds = [...new Set(rows.map((r) => r.subject.id))];
      const [hidden, active, past, values] = await Promise.all([
        hiddenTargetKeys(app.db, keys, now),
        subjectIds.length
          ? app.db
              .select()
              .from(sanctions)
              .where(
                and(
                  inArray(sanctions.subjectId, subjectIds),
                  sql`${sanctions.liftedAt} is null and ${sanctions.expiresAt} > ${now}`,
                ),
              )
          : Promise.resolve([]),
        subjectIds.length
          ? app.db
              .select({ subjectId: sanctions.subjectId, n: count() })
              .from(sanctions)
              .where(
                and(
                  inArray(sanctions.subjectId, subjectIds),
                  or(isNotNull(sanctions.liftedAt), lte(sanctions.expiresAt, now)),
                ),
              )
              .groupBy(sanctions.subjectId)
          : Promise.resolve([]),
        currentTargetValues(
          app.db,
          page.map((c) => ({
            key: c.targetKey,
            subject: rows.find(
              (r) => r.report.targetKey === c.targetKey && r.subject.id === c.subjectId,
            )?.subject ?? {
              displayName: '',
            },
          })),
        ),
      ]);
      const cases = page.map((c) => {
        const own = rows.filter(
          (r) => r.report.targetKey === c.targetKey && r.subject.id === c.subjectId,
        );
        const first = own[0]!;
        const subject = first.subject;
        return {
          reportId: c.firstId,
          target: first.report.target,
          subject: {
            handle: subject.handle,
            displayName: subject.displayName,
            role: subject.role,
            sanctions: active.filter((s) => s.subjectId === subject.id).map(sanctionView),
            pastSanctions: past.find((p) => p.subjectId === subject.id)?.n ?? 0,
          },
          current: {
            value: values.get(c.targetKey) ?? subject.displayName,
            hidden: hidden.has(c.targetKey),
          },
          reports: own.map((r) => ({
            id: r.report.id,
            reason: r.report.reason,
            note: r.report.note,
            createdAt: r.report.createdAt.toISOString(),
            context: r.report.context,
            reporter: { handle: r.reporter.handle, displayName: r.reporter.displayName },
          })),
          openedAt: first.report.createdAt.toISOString(),
        };
      });
      return {
        cases,
        openCases: total?.n ?? 0,
        nextCursor: caseRows.length > limit ? page[page.length - 1]!.firstId : null,
      };
    },
  );

  // Act on a report: dismiss it, or issue a sanction. Either way every open report on the same
  // target is closed with it (the case). A second moderator acting on the same report gets
  // `409 report_closed`.
  app.post(
    '/mod/reports/:reportId/resolve',
    {
      onRequest: app.requireStaff,
      schema: {
        params: {
          type: 'object',
          required: ['reportId'],
          properties: { reportId: { type: 'string', format: 'uuid' } },
        },
        body: resolveBodySchema,
        response: {
          200: {
            type: 'object',
            required: ['closedReports', 'sanction'],
            properties: {
              closedReports: { type: 'integer' },
              sanction: { anyOf: [sanctionViewSchema, { type: 'null' }] },
            },
          },
        },
      },
    },
    async (request) => {
      const { reportId } = request.params as { reportId: string };
      const body = request.body as ResolveBody;
      const reasonText =
        body.action === 'dismiss'
          ? assertPlayerText('reportNote', body.note ?? '', 'note')
          : assertPlayerText('sanctionReason', body.reason, 'reason');
      const now = app.authNow();
      return withTransaction(app.db, async (tx) => {
        const actor = await lockActor(tx, request.auth!.account.id);
        const [unlocked] = await tx.select().from(reports).where(eq(reports.id, reportId));
        if (!unlocked) throw new ApiError(404, 'not_found', 'No such report.');
        // Ticket 4.11: lock the whole case (its open reports and this one) in id order before the
        // subject, so two moderators answering different reports of one case queue up instead of
        // deadlocking (each held its own report and waited for the other's). Target and subject
        // never change, so the unlocked read finds the right case.
        const locked = await tx
          .select()
          .from(reports)
          .where(
            and(
              eq(reports.targetKey, unlocked.targetKey),
              eq(reports.subjectId, unlocked.subjectId),
              or(eq(reports.status, 'open'), eq(reports.id, reportId)),
            ),
          )
          .orderBy(asc(reports.id))
          .for('update');
        const report = locked.find((r) => r.id === reportId)!;
        if (report.status !== 'open') {
          throw new ApiError(
            409,
            'report_closed',
            'Another moderator already handled this report.',
            {
              status: report.status,
            },
          );
        }
        const subject = await lockSubject(tx, report.subjectId);
        const action: ModerationAction = body.action === 'dismiss' ? 'dismissReport' : body.action;
        assertAllowed(actor, action, subject);

        let sanction: Sanction | null = null;
        let guildActed = false;
        if (isGuildAction(body.action)) {
          // Ticket 4.4: rename or disband the reported guild (the subject is its leader).
          if (report.targetKind !== 'guild') {
            throw new ApiError(
              422,
              'not_a_guild',
              'Only a reported guild can be renamed or disbanded.',
            );
          }
          const guildId = report.targetKey.slice('guild:'.length);
          await lockGuild(tx, guildId);
          const [guild] = await tx.select().from(guilds).where(eq(guilds.id, guildId));
          if (!guild || guild.disbandedAt) {
            throw new ApiError(409, 'guild_gone', 'This guild was disbanded already.');
          }
          const leaderId = (await guildLeaderId(tx, guild.id)) ?? subject.id;
          // Ticket 4.11: the rank rule applies to the leader *now* (the report named the leader
          // at the time; leadership may have passed to staff since). Under the guild lock the
          // leadership cannot change; the role is read without a lock (it changes only by CLI).
          if (leaderId !== subject.id) {
            const [leader] = await tx.select().from(accounts).where(eq(accounts.id, leaderId));
            if (leader) assertAllowed(actor, action, leader);
          }
          if (body.action === 'renameGuild') {
            await forceRenameGuildTx(tx, guild, {
              moderatorId: actor.id,
              leaderId,
              reason: reasonText,
              reportId,
            });
          } else {
            await disbandGuildTx(
              tx,
              guild,
              { accountId: actor.id, moderator: true, reason: reasonText, reportId },
              now,
            );
          }
          guildActed = true;
        } else if (body.action !== 'dismiss') {
          const b = body as { action: SanctionAction; reason: string; durationHours: number };
          if (report.targetKind === 'guild' && b.action === 'forceRename') {
            throw new ApiError(
              422,
              'use_rename_guild',
              'To rename a reported guild, use “rename the guild”.',
            );
          }
          const kind = SANCTION_FOR_ACTION[b.action];
          if (!validSanctionDuration(kind, b.durationHours)) {
            throw new ApiError(
              400,
              'validation_failed',
              'That duration is not allowed for this sanction.',
              {
                fields: { durationHours: 'That duration is not allowed for this sanction.' },
              },
            );
          }
          if (kind === 'hide' && !isHideable(report.targetKind)) {
            throw new ApiError(422, 'not_hideable', 'Only content (not a player) can be hidden.');
          }
          sanction = await issueSanction(tx, {
            actor,
            subject,
            action: b.action,
            reason: reasonText,
            durationHours: b.durationHours,
            targetKey: report.targetKey,
            target: report.target,
            now,
            events: app.sanctionEvents,
          });
        }
        const closed = await tx
          .update(reports)
          .set({
            status: sanction || guildActed ? 'actioned' : 'dismissed',
            resolvedAt: now,
            resolvedBy: actor.id,
            sanctionId: sanction?.id ?? null,
          })
          // The case: open reports on this target about this subject (ticket 4.11).
          .where(
            and(
              eq(reports.targetKey, report.targetKey),
              eq(reports.subjectId, report.subjectId),
              eq(reports.status, 'open'),
            ),
          )
          .returning({ id: reports.id });
        await writeAudit(tx, {
          event: 'report.resolve',
          accountId: actor.id,
          data: {
            reportId,
            action: body.action,
            subjectId: subject.id,
            closedReportIds: closed.map((c) => c.id),
            sanctionId: sanction?.id ?? null,
            ...(body.action === 'dismiss' && reasonText ? { note: reasonText } : {}),
          },
        });
        return { closedReports: closed.length, sanction: sanction ? sanctionView(sanction) : null };
      });
    },
  );

  // Lift an active sanction early. Same permission as issuing it. Lifting a forced rename gives
  // the old name back if the player has not renamed yet and nobody took it meanwhile.
  app.post(
    '/mod/sanctions/:sanctionId/lift',
    {
      onRequest: app.requireStaff,
      schema: {
        params: {
          type: 'object',
          required: ['sanctionId'],
          properties: { sanctionId: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['reason'],
          properties: { reason: { type: 'string', maxLength: 2000 } },
        },
        response: {
          200: {
            type: 'object',
            required: ['sanction'],
            properties: { sanction: sanctionViewSchema },
          },
        },
      },
    },
    async (request) => {
      const { sanctionId } = request.params as { sanctionId: string };
      const reason = assertPlayerText(
        'sanctionReason',
        (request.body as { reason: string }).reason,
        'reason',
      );
      const now = app.authNow();
      return withTransaction(app.db, async (tx) => {
        const actor = await lockActor(tx, request.auth!.account.id);
        const [peek] = await tx
          .select({ subjectId: sanctions.subjectId })
          .from(sanctions)
          .where(eq(sanctions.id, sanctionId));
        if (!peek) throw new ApiError(404, 'not_found', 'No such sanction.');
        const subject = await lockSubject(tx, peek.subjectId);
        const [s] = await tx
          .select()
          .from(sanctions)
          .where(eq(sanctions.id, sanctionId))
          .for('update');
        assertAllowed(actor, 'liftSanction', subject);
        if (s!.liftedAt || s!.expiresAt <= now) {
          throw new ApiError(409, 'sanction_inactive', 'This sanction is no longer active.');
        }
        const [lifted] = await tx
          .update(sanctions)
          .set({ liftedAt: now, liftedBy: actor.id, liftReason: reason })
          .where(eq(sanctions.id, sanctionId))
          .returning();
        let restoredName: string | null = null;
        if (s!.kind === 'rename') {
          const previous = String(s!.data.previousName ?? '');
          const [taken] = await tx
            .select({ id: accounts.id })
            .from(accounts)
            .where(
              sql`lower(${accounts.displayName}) = lower(${previous}) and ${accounts.id} <> ${subject.id}`,
            )
            .limit(1);
          if (previous && !taken && subject.displayName === s!.data.placeholder) {
            await tx
              .update(accounts)
              .set({ displayName: previous, updatedAt: now })
              .where(eq(accounts.id, subject.id));
            restoredName = previous;
          }
        }
        await writeAudit(tx, {
          event: 'sanction.lift',
          accountId: subject.id,
          data: { sanctionId, kind: s!.kind, liftedBy: actor.id, reason, restoredName },
        });
        return { sanction: sanctionView(lifted!) };
      });
    },
  );
}
