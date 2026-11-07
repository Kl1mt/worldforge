import type { FastifyInstance } from 'fastify';
import { and, count, eq } from 'drizzle-orm';
import { REPORT_REASON_IDS, type ReportReasonId, type ReportTarget } from '@worldforge/game-core';
import { accounts, reports, sanctions, type Report } from '../db/schema.js';
import { constraintOf, sqlStateOf } from '../db/transaction.js';
import { writeAudit } from '../db/audit.js';
import { uuidv7 } from '../db/uuid.js';
import { ApiError } from '../errors.js';
import { displayNameError, normalizeDisplayName } from '../auth/validation.js';
import { activeSanctions, sanctionView, sanctionViewSchema } from './sanctions.js';
import { lockSocialAccounts } from './relations.js';
import { socialWrite } from './social-write.js';
import { reportTargetSchema, reportTargetViewSchema, resolveReportTarget } from './targets.js';
import { assertPlayerText } from './text.js';

/**
 * Ticket 4.11: reports one player may have waiting for a moderator at once (each field, hero name
 * or message is its own target, so one-per-target alone let a player fill the queue).
 */
export const MAX_OPEN_REPORTS = 20;

/** A report as its reporter sees it. */
export function reportView(r: Report) {
  return {
    id: r.id,
    target: r.target,
    reason: r.reason,
    note: r.note,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
  };
}

const reportViewSchema = {
  type: 'object',
  required: ['id', 'target', 'reason', 'note', 'status', 'createdAt'],
  properties: {
    id: { type: 'string' },
    target: reportTargetViewSchema,
    reason: { type: 'string' },
    note: { type: ['string', 'null'] },
    status: { type: 'string' },
    createdAt: { type: 'string' },
  },
} as const;

/** Player-facing safety routes (ticket 4.1, docs/SOCIAL.md). */
export async function registerSafety(app: FastifyInstance): Promise<void> {
  app.post(
    '/reports',
    {
      preHandler: app.requireAccount,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['target', 'reason'],
          properties: {
            target: reportTargetSchema,
            reason: { type: 'string', enum: REPORT_REASON_IDS },
            note: { type: 'string', maxLength: 4000 },
          },
        },
        response: {
          201: { type: 'object', required: ['report'], properties: { report: reportViewSchema } },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { target: ReportTarget; reason: ReportReasonId; note?: string };
      const note = assertPlayerText('reportNote', body.note ?? '', 'note');
      const report = await socialWrite(
        app,
        request,
        reply,
        'report',
        async (tx, { account, now }) => {
          const resolved = await resolveReportTarget(tx, body.target, account.id);
          if (!resolved) throw new ApiError(404, 'not_found', 'Nothing to report there.');
          if (resolved.subject.id === account.id) {
            throw new ApiError(422, 'cannot_report_self', 'You cannot report yourself.');
          }
          // Ticket 4.11: at most MAX_OPEN_REPORTS waiting per reporter (under their social lock,
          // so the cap is exact); a moderator's answer frees a slot.
          await lockSocialAccounts(tx, [account.id]);
          const [waiting] = await tx
            .select({ n: count() })
            .from(reports)
            .where(and(eq(reports.reporterId, account.id), eq(reports.status, 'open')));
          if ((waiting?.n ?? 0) >= MAX_OPEN_REPORTS) {
            throw new ApiError(
              409,
              'report_limit',
              `You have ${MAX_OPEN_REPORTS} reports waiting for a moderator. Wait for an answer first.`,
              { limit: MAX_OPEN_REPORTS },
            );
          }
          const [row] = await tx
            .insert(reports)
            .values({
              id: uuidv7(),
              reporterId: account.id,
              subjectId: resolved.subject.id,
              targetKind: resolved.target.kind,
              targetKey: resolved.key,
              target: resolved.target,
              context: resolved.context,
              reason: body.reason,
              note: note || null,
              createdAt: now,
            })
            // The partial unique index (one open report per reporter and target): a concurrent
            // duplicate waits for the first to commit, then inserts nothing.
            .onConflictDoNothing()
            .returning();
          if (!row) {
            const [open] = await tx
              .select({ id: reports.id })
              .from(reports)
              .where(
                and(
                  eq(reports.reporterId, account.id),
                  eq(reports.targetKey, resolved.key),
                  eq(reports.status, 'open'),
                ),
              );
            throw new ApiError(
              409,
              'report_open',
              'You already reported this; a moderator will look at it.',
              {
                reportId: open?.id ?? null,
              },
            );
          }
          await writeAudit(tx, {
            event: 'report.create',
            accountId: account.id,
            data: {
              reportId: row.id,
              targetKind: row.targetKind,
              subjectId: row.subjectId,
              reason: row.reason,
              noteLength: [...(row.note ?? '')].length,
            },
          });
          return row;
        },
      );
      return reply.code(201).send({ report: reportView(report) });
    },
  );

  // "Why can't I post?": the account's own active sanctions with reason and expiry.
  app.get(
    '/account/standing',
    {
      preHandler: app.requireAccount,
      schema: {
        response: {
          200: {
            type: 'object',
            required: ['handle', 'role', 'sanctions', 'renameRequired'],
            properties: {
              handle: { type: 'string' },
              role: { type: 'string' },
              sanctions: { type: 'array', items: sanctionViewSchema },
              renameRequired: { type: 'boolean' },
            },
          },
        },
      },
    },
    async (request) => {
      const account = request.auth!.account;
      const active = await activeSanctions(app.db, account.id, app.authNow());
      return {
        handle: account.handle,
        role: account.role,
        sanctions: active.map(sanctionView),
        renameRequired: active.some((s) => s.kind === 'rename'),
      };
    },
  );

  // The forced rename (a `rename` sanction): the player chooses a new display name. Not a general
  // rename (no sanction → 409). A social write, exempt from mutes.
  app.post(
    '/account/display-name',
    {
      preHandler: app.requireAccount,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['displayName'],
          properties: { displayName: { type: 'string', maxLength: 64 } },
        },
        response: {
          200: {
            type: 'object',
            required: ['displayName'],
            properties: { displayName: { type: 'string' } },
          },
        },
      },
    },
    async (request, reply) => {
      const raw = (request.body as { displayName: string }).displayName;
      const displayName = normalizeDisplayName(raw);
      const error = displayNameError(displayName);
      if (error) {
        throw new ApiError(400, 'validation_failed', error, { fields: { displayName: error } });
      }
      try {
        return await socialWrite(app, request, reply, 'rename', async (tx, { account, now }) => {
          const [rename] = await activeSanctions(tx, account.id, now, ['rename']);
          if (!rename) {
            throw new ApiError(409, 'rename_not_required', 'Your display name needs no change.');
          }
          const previous = String(rename.data.previousName ?? '');
          if (previous.toLowerCase() === displayName.toLowerCase()) {
            const message = 'Choose a different name from the one that was changed.';
            throw new ApiError(400, 'validation_failed', message, {
              fields: { displayName: message },
            });
          }
          await tx
            .update(accounts)
            .set({ displayName, updatedAt: now })
            .where(eq(accounts.id, account.id));
          await tx
            .update(sanctions)
            .set({ liftedAt: now, liftedBy: account.id, liftReason: 'renamed' })
            .where(eq(sanctions.id, rename.id));
          await writeAudit(tx, {
            event: 'account.rename',
            accountId: account.id,
            data: { from: account.displayName, to: displayName, sanctionId: rename.id },
          });
          return { displayName };
        });
      } catch (err) {
        if (
          sqlStateOf(err) === '23505' &&
          constraintOf(err) === 'accounts_display_name_lower_key'
        ) {
          throw new ApiError(409, 'display_name_taken', 'This display name is taken.', {
            fields: { displayName: 'This display name is taken.' },
          });
        }
        throw err;
      }
    },
  );
}
