import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { gameSettings } from '../db/schema.js';
import { writeAudit } from '../db/audit.js';
import { withTransaction } from '../db/transaction.js';
import { ApiError } from '../errors.js';
import { idempotentTransaction } from '../idempotency/index.js';
import { testLetterMail } from '../mail/templates.js';
import { createWindowLimiter, rateLimited } from '../shared/limiter.js';
import { recordTelemetry } from '../telemetry/record.js';
import {
  PRIVACY_CHECK_IDS,
  PRIVACY_EVENT,
  PRIVACY_SETTINGS_KEY,
  READINESS_ITEMS,
  TEST_LETTER_EVENT,
  normalisePrivacyTicks,
  readinessReport,
  type PrivacyCheckId,
  type ReadinessSources,
} from './readiness.js';
import { lockAdmin } from './tools.js';

/**
 * The admin panel's Readiness tab (ticket 8.6, docs/GOING_LIVE.md), under `/api/admin` (so the
 * scope's `requireAdmin` answers everyone else with the not-found `404`):
 *
 * - `GET /readiness`: the board (read-only; audited `admin.view` `{ section: 'readiness' }`).
 * - `PUT /readiness/privacy`: the owner's ticks of what the privacy policy mentions, stored in
 *   `game_settings` key `readiness.privacy` with a version (a stale form is `409
 *   settings_conflict`), audited `admin.readiness.privacy` with the ids before and after.
 * - `POST /readiness/test-letter`: sends one short letter through the configured transport to an
 *   address the admin types, and says whether the transport accepted it. **The address is never
 *   stored or logged:** not in the audit row (`admin.readiness.test_letter` `{ outcome, code }`),
 *   not in telemetry (`mail.send` `[test_letter, outcome]`), not in the log (only the provider's
 *   error code), not in an idempotency record (the route takes none: a repeated click sends
 *   another letter, and the limit bounds that). Its own limit: `testLetterLimit` per admin.
 */
export interface ReadinessRouteOptions extends ReadinessSources {
  now: () => Date;
  testLetterLimit?: { max: number; windowMs: number };
  /** How long the transport may take before the letter counts as failed. */
  testLetterTimeoutMs?: number;
}

export const DEFAULT_TEST_LETTER_LIMIT = { max: 3, windowMs: 60 * 60_000 };
const TEST_LETTER_TIMEOUT_MS = 20_000;
/** Shape only (the transport has the final word): one `@`, a dot in the domain, no spaces. */
const ADDRESS_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

const factSchema = {
  type: 'object',
  required: ['label', 'value'],
  additionalProperties: false,
  properties: { label: { type: 'string' }, value: { type: 'string' } },
} as const;

const linkSchema = {
  type: 'object',
  required: ['kind', 'label'],
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['tab', 'doc'] },
    label: { type: 'string' },
    section: { type: 'string' },
    path: { type: 'string' },
    anchor: { type: 'string' },
  },
} as const;

/** The response is serialised from this schema: a field not listed here never leaves the server. */
export const readinessSchema = {
  type: 'object',
  required: ['items', 'privacy', 'testLetter', 'generatedAt'],
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'title', 'status', 'summary', 'facts', 'links'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', enum: READINESS_ITEMS },
          title: { type: 'string' },
          status: { type: 'string', enum: ['done', 'attention', 'not_set'] },
          summary: { type: 'string' },
          facts: { type: 'array', items: factSchema },
          links: { type: 'array', items: linkSchema },
        },
      },
    },
    privacy: {
      type: 'object',
      required: ['checklist', 'version', 'updatedAt'],
      additionalProperties: false,
      properties: {
        checklist: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'label', 'hint', 'ticked'],
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              hint: { type: 'string' },
              ticked: { type: 'boolean' },
            },
          },
        },
        version: { type: 'integer' },
        updatedAt: { type: ['string', 'null'] },
      },
    },
    testLetter: {
      type: 'object',
      required: ['available'],
      additionalProperties: false,
      properties: { available: { type: 'boolean' } },
    },
    generatedAt: { type: 'string' },
  },
} as const;

export async function registerReadinessAdmin(
  admin: FastifyInstance,
  options: ReadinessRouteOptions,
): Promise<void> {
  const { now } = options;
  const takeLetter = createWindowLimiter(
    admin.limitStore,
    'test_letter',
    [options.testLetterLimit ?? DEFAULT_TEST_LETTER_LIMIT],
    now,
  );
  const timeoutMs = options.testLetterTimeoutMs ?? TEST_LETTER_TIMEOUT_MS;

  admin.get('/readiness', { schema: { response: { 200: readinessSchema } } }, async (request) => {
    const report = await readinessReport(admin.db, options, now());
    await writeAudit(admin.db, {
      event: 'admin.view',
      accountId: request.auth!.account.id,
      data: { section: 'readiness' },
    }).catch((err: unknown) => request.log.warn({ err }, 'audit write failed'));
    return report;
  });

  admin.put(
    '/readiness/privacy',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['expectedVersion', 'ticked'],
          properties: {
            expectedVersion: { type: 'integer', minimum: 0 },
            ticked: {
              type: 'array',
              uniqueItems: true,
              maxItems: PRIVACY_CHECK_IDS.length,
              items: { type: 'string', enum: PRIVACY_CHECK_IDS },
            },
          },
        },
        response: { 200: readinessSchema },
      },
    },
    async (request, reply) => {
      const body = request.body as { expectedVersion: number; ticked: PrivacyCheckId[] };
      return idempotentTransaction(admin, request, reply, { now }, async (tx) => {
        const adminId = request.auth!.account.id;
        await lockAdmin(tx, adminId);
        const at = now();
        const [row] = await tx
          .select()
          .from(gameSettings)
          .where(eq(gameSettings.key, PRIVACY_SETTINGS_KEY))
          .for('update');
        const current = row?.version ?? 0;
        const conflict = () =>
          new ApiError(
            409,
            'settings_conflict',
            'Someone else changed the privacy checklist since you opened it. Reload to see their change.',
            { currentVersion: current },
          );
        if (body.expectedVersion !== current) throw conflict();
        const before = normalisePrivacyTicks(row?.value);
        const after = normalisePrivacyTicks({ ticked: body.ticked });
        if (before.join(',') !== after.join(',')) {
          const version = current + 1;
          const value = { ticked: after };
          if (row) {
            const updated = await tx
              .update(gameSettings)
              .set({ value, version, updatedBy: adminId, updatedAt: at })
              .where(
                and(eq(gameSettings.key, PRIVACY_SETTINGS_KEY), eq(gameSettings.version, current)),
              )
              .returning({ key: gameSettings.key });
            if (updated.length === 0) throw conflict();
          } else {
            const inserted = await tx
              .insert(gameSettings)
              .values({
                key: PRIVACY_SETTINGS_KEY,
                value,
                version,
                updatedBy: adminId,
                updatedAt: at,
              })
              .onConflictDoNothing()
              .returning({ key: gameSettings.key });
            if (inserted.length === 0) throw conflict();
          }
          await writeAudit(tx, {
            event: PRIVACY_EVENT,
            accountId: adminId,
            data: { key: PRIVACY_SETTINGS_KEY, version, before, after },
          });
        }
        return readinessReport(tx, options, at);
      });
    },
  );

  admin.post(
    '/readiness/test-letter',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['to'],
          properties: { to: { type: 'string', minLength: 3, maxLength: 254 } },
        },
        response: {
          200: {
            type: 'object',
            required: ['outcome', 'code', 'at'],
            additionalProperties: false,
            properties: {
              outcome: { type: 'string', enum: ['sent', 'failed'] },
              /** The provider's error code on a failure (e.g. `EAUTH`, `550`), never its text. */
              code: { type: ['string', 'null'] },
              at: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const adminId = request.auth!.account.id;
      const to = (request.body as { to: string }).to.trim();
      if (!ADDRESS_RE.test(to)) {
        throw new ApiError(400, 'validation_failed', 'That does not look like an email address.', {
          fields: { to: 'Type a whole address, like you@example.com.' },
        });
      }
      if (!options.mailer.enabled) {
        throw new ApiError(
          503,
          'email_unavailable',
          'Email is not set up on this server yet, so no letter can be sent.',
        );
      }
      const out = await takeLetter(adminId);
      if (out.retryAfterMs > 0) {
        rateLimited(reply, out.retryAfterMs, 'test_letter', 'Only a few test letters an hour.');
      }
      const at = now();
      let code: string | null = null;
      let timer: NodeJS.Timeout | undefined;
      const outcome = await Promise.race([
        options.mailer.send(testLetterMail(to, at)).then(() => 'sent' as const),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })),
            timeoutMs,
          );
        }),
      ])
        .catch((err: unknown) => {
          // Never the address or the provider's text: provider errors can quote the recipient.
          const e = err as { code?: unknown; responseCode?: unknown; command?: unknown };
          const raw = e?.responseCode ?? e?.code;
          code =
            typeof raw === 'number' || typeof raw === 'string' ? String(raw).slice(0, 24) : null;
          if (code !== null && !/^[A-Za-z0-9_.-]+$/.test(code)) code = null;
          request.log.error(
            {
              mail: 'test_letter',
              code: e?.code,
              responseCode: e?.responseCode,
              command: e?.command,
            },
            'test letter failed',
          );
          return 'failed' as const;
        })
        .finally(() => clearTimeout(timer));
      await withTransaction(admin.db, async (tx) => {
        recordTelemetry(tx, at, [{ metric: 'mail.send', dims: ['test_letter', outcome] }]);
        await writeAudit(tx, {
          event: TEST_LETTER_EVENT,
          accountId: adminId,
          data: { outcome, code, transport: options.mailer.transport },
        });
      });
      return { outcome, code, at: at.toISOString() };
    },
  );
}
