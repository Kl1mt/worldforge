import type { FastifyInstance, FastifyReply } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { accounts } from '../db/schema.js';
import { writeAudit } from '../db/audit.js';
import { constraintOf, sqlStateOf, withTransaction } from '../db/transaction.js';
import { ApiError } from '../errors.js';
import type { MailMessage, Mailer } from '../mail/mailer.js';
import {
  emailChangedMail,
  passwordChangedMail,
  resetPasswordMail,
  verifyEmailMail,
  type MailLinks,
} from '../mail/templates.js';
import { recordTelemetry } from '../telemetry/record.js';
import { hashPassword, verifyPassword } from './password.js';
import { throttleKey, type LoginThrottle } from './login-throttle.js';
import {
  RESET_TOKEN_TTL_MS,
  VERIFY_TOKEN_TTL_MS,
  checkToken,
  consumeToken,
  countOtherSessions,
  hasLiveToken,
  issueToken,
  revokeSessions,
  withdrawTokens,
} from './tokens.js';
import {
  EMAIL_MAX,
  PASSWORD_MAX,
  emailError,
  normalizeEmail,
  passwordError,
} from './validation.js';
import {
  accountResponseSchema,
  accountView,
  loginThrottled,
  type AuthOptions,
  type RateLimit,
} from './routes.js';

/**
 * Account security routes (ticket 5.7, docs/API_CONVENTIONS.md "Auth & sessions",
 * SECURITY.md "Accounts"):
 * - `POST /api/auth/verify-email` — use a verification link (no session needed);
 * - `POST /api/auth/forgot-password` — ask for a reset link (the same `202` for every address);
 * - `POST /api/auth/reset-password` — set a new password with a reset link; every session ends;
 * - `GET  /api/account/security` — the account screen's security panel;
 * - `POST /api/account/verification` — send the verification link again (rate limited);
 * - `POST /api/account/email` — change the email (current password required);
 * - `POST /api/account/sessions/revoke-others` — "log out other devices".
 */

/** Mails handed to each transport and not yet settled (tests wait on them via `mailSettled`). */
const inFlight = new WeakMap<Mailer, Set<Promise<void>>>();

/** Resolves once every mail handed to this mailer so far has been sent or has failed. */
export async function mailSettled(mailer: Mailer): Promise<void> {
  await Promise.allSettled([...(inFlight.get(mailer) ?? [])]);
}

export interface MailOutbox {
  readonly enabled: boolean;
  /** Hands the mail to the transport without waiting (the request never waits on SMTP). */
  deliver(message: MailMessage): void;
}

/**
 * Sends mails after the request's transaction committed, without holding up the answer (so a
 * slow provider never shows in the timing of a request, and never fails it). The outcome is
 * logged without the address and counted in telemetry (`mail.send`: kind, sent/failed).
 */
export function createMailOutbox(
  app: FastifyInstance,
  mailer: Mailer,
  now: () => Date,
): MailOutbox {
  let pending = inFlight.get(mailer);
  if (!pending) {
    pending = new Set();
    inFlight.set(mailer, pending);
  }
  const live = pending;
  app.addHook('onClose', async () => {
    await Promise.allSettled([...live]);
    mailer.close?.();
  });
  return {
    enabled: mailer.enabled,
    deliver(message) {
      if (!mailer.enabled) return;
      const p: Promise<void> = mailer
        .send(message)
        .then(
          () => 'sent' as const,
          (err: unknown) => {
            // Never the address or the body: provider errors can quote the recipient.
            const e = err as { code?: unknown; responseCode?: unknown; command?: unknown };
            app.log.error(
              {
                mail: message.kind,
                code: e?.code,
                responseCode: e?.responseCode,
                command: e?.command,
              },
              'mail send failed',
            );
            return 'failed' as const;
          },
        )
        .then((outcome) =>
          withTransaction(app.db, async (tx) => {
            recordTelemetry(tx, now(), [{ metric: 'mail.send', dims: [message.kind, outcome] }]);
          }),
        )
        .catch((err: unknown) => app.log.warn({ err }, 'mail telemetry failed'))
        .finally(() => live.delete(p));
      live.add(p);
    },
  };
}

const EMAIL_UNAVAILABLE_MESSAGE =
  'Email is not set up on this server yet, so verification and password reset are not available. Your account works as usual.';
const emailUnavailable = () => new ApiError(503, 'email_unavailable', EMAIL_UNAVAILABLE_MESSAGE);

const tokenError = (status: 'invalid' | 'expired') =>
  status === 'expired'
    ? new ApiError(400, 'token_expired', 'This link has expired. Ask for a new one.')
    : new ApiError(
        400,
        'token_invalid',
        'This link is not valid: it was already used, replaced by a newer one, or mistyped.',
      );

const tokenBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['token'],
  properties: { token: { type: 'string', minLength: 1, maxLength: 128 } },
} as const;

const resetBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['token', 'password'],
  properties: {
    token: { type: 'string', minLength: 1, maxLength: 128 },
    password: { type: 'string', maxLength: PASSWORD_MAX * 4 },
  },
} as const;

const forgotBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['email'],
  properties: { email: { type: 'string', maxLength: 320 } },
} as const;

const emailChangeBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['email', 'password'],
  properties: {
    email: { type: 'string', maxLength: 320 },
    password: { type: 'string', minLength: 1, maxLength: PASSWORD_MAX * 4 },
  },
} as const;

const securityResponseSchema = {
  type: 'object',
  required: ['security'],
  properties: {
    security: {
      type: 'object',
      required: [
        'email',
        'emailVerified',
        'emailVerifiedAt',
        'verificationPending',
        'mailEnabled',
        'otherSessions',
      ],
      properties: {
        email: { type: 'string' },
        emailVerified: { type: 'boolean' },
        emailVerifiedAt: { type: ['string', 'null'] },
        verificationPending: { type: 'boolean' },
        mailEnabled: { type: 'boolean' },
        otherSessions: { type: 'integer' },
      },
    },
  },
} as const;

const UNIQUE_VIOLATION = '23505';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function mailLimited(reply: FastifyReply, retryAfterSeconds: number): ApiError {
  void reply.header('retry-after', String(retryAfterSeconds));
  const wait =
    retryAfterSeconds >= 90 ? `${Math.ceil(retryAfterSeconds / 60)} min` : `${retryAfterSeconds} s`;
  return new ApiError(429, 'rate_limited', `Too many letters for now. Try again in ${wait}.`, {
    retryAfterSeconds,
    limit: 'mail',
  });
}

export async function registerAccountSecurity(
  app: FastifyInstance,
  ctx: {
    options: AuthOptions;
    throttle: LoginThrottle;
    links: MailLinks;
    outbox: MailOutbox;
    /** Per key (account id, or the address for resets): returns seconds to wait, or 0. */
    mailLimit: (key: string) => Promise<number>;
    rateLimitConfig: (limit: RateLimit) => object;
  },
): Promise<void> {
  const { options, throttle, links, outbox, mailLimit, rateLimitConfig } = ctx;
  const { now } = options;

  // --- Email verification -------------------------------------------------------------------

  app.post<{ Body: { token: string } }>(
    '/auth/verify-email',
    { config: rateLimitConfig(options.tokenRateLimit), schema: { body: tokenBodySchema } },
    async (request) => {
      const at = now();
      const result = await withTransaction(app.db, async (tx) => {
        const used = await consumeToken(tx, 'verify_email', request.body.token, at);
        if (used.status !== 'ok') return used;
        await tx
          .update(accounts)
          .set({ emailVerifiedAt: at, updatedAt: sql`now()` })
          .where(eq(accounts.id, used.account.id));
        await withdrawTokens(tx, used.account.id, ['verify_email'], at);
        await writeAudit(tx, { event: 'account.email_verified', accountId: used.account.id });
        return used;
      });
      if (result.status !== 'ok') throw tokenError(result.status);
      return { verified: true };
    },
  );

  app.post('/account/verification', { preHandler: app.requireAccount }, async (request, reply) => {
    const account = request.auth!.account;
    if (!outbox.enabled) throw emailUnavailable();
    if (account.emailVerifiedAt !== null) {
      throw new ApiError(409, 'already_verified', 'This email address is already verified.');
    }
    const wait = await mailLimit(`account:${account.id}`);
    if (wait > 0) throw mailLimited(reply, wait);
    const at = now();
    const issued = await withTransaction(app.db, async (tx) => {
      const t = await issueToken(tx, account, 'verify_email', at);
      await writeAudit(tx, {
        event: 'account.verification_sent',
        accountId: account.id,
        data: { resend: true },
      });
      return t;
    });
    outbox.deliver(verifyEmailMail(account.email, links.verify(issued.token), VERIFY_TOKEN_TTL_MS));
    return reply.code(202).send({ sent: true });
  });

  // --- Password reset -----------------------------------------------------------------------

  app.post<{ Body: { email: string } }>(
    '/auth/forgot-password',
    { config: rateLimitConfig(options.forgotRateLimit), schema: { body: forgotBodySchema } },
    async (request, reply) => {
      // The same for every address (mail is either set up or not), so this reveals nothing.
      if (!outbox.enabled) throw emailUnavailable();
      const started = performance.now();
      const email = normalizeEmail(request.body.email);
      const [account] =
        email.length > 0 && email.length <= EMAIL_MAX
          ? await app.db
              .select()
              .from(accounts)
              .where(sql`lower(${accounts.email}) = lower(${email})`)
              .limit(1)
          : [];
      const at = now();
      // At most `mailLimit.max` reset letters per address and window: nobody can flood a mailbox.
      // Counted for unknown addresses too, so the cap behaves the same for every address.
      const capped = (await mailLimit(`reset:${throttleKey(email)}`)) > 0;
      const issued = await withTransaction(app.db, async (tx) => {
        const token =
          account && !capped ? await issueToken(tx, account, 'reset_password', at) : null;
        await writeAudit(tx, {
          event: 'auth.reset_requested',
          accountId: account?.id ?? null,
          data: {
            sent: token !== null,
            ...(token ? {} : { reason: account ? 'capped' : 'unknown_email' }),
          },
        });
        return token;
      });
      if (account && issued) {
        outbox.deliver(
          resetPasswordMail(account.email, links.reset(issued.token), RESET_TOKEN_TTL_MS),
        );
      }
      // Same status, body and (padded) timing for known and unknown addresses.
      const left = options.forgotFloorMs - (performance.now() - started);
      if (left > 0) await sleep(left);
      return reply.code(202).send({ accepted: true });
    },
  );

  app.post<{ Body: { token: string; password: string } }>(
    '/auth/reset-password',
    { config: rateLimitConfig(options.tokenRateLimit), schema: { body: resetBodySchema } },
    async (request) => {
      const { token, password } = request.body;
      // Cheap early answer before the slow hash; `consumeToken` in the transaction is the guard.
      const check = await checkToken(app.db, 'reset_password', token, now());
      if (check.status !== 'ok') throw tokenError(check.status);
      const problem = passwordError(password, check.row.email);
      if (problem) {
        throw new ApiError(400, 'validation_failed', 'Some fields need attention.', {
          fields: { password: problem },
        });
      }
      const passwordHash = await hashPassword(password);
      const at = now();
      const result = await withTransaction(app.db, async (tx) => {
        const used = await consumeToken(tx, 'reset_password', token, at);
        if (used.status !== 'ok') return used;
        const accountId = used.account.id;
        // The reset link proved the mailbox, so the address counts as verified from now on.
        await tx
          .update(accounts)
          .set({
            passwordHash,
            emailVerifiedAt: used.account.emailVerifiedAt ?? at,
            updatedAt: sql`now()`,
          })
          .where(eq(accounts.id, accountId));
        const sessionsRevoked = await revokeSessions(tx, accountId, at);
        const tokensWithdrawn = await withdrawTokens(
          tx,
          accountId,
          ['reset_password', 'verify_email'],
          at,
        );
        await writeAudit(tx, {
          event: 'auth.password_reset',
          accountId,
          data: { sessionsRevoked, tokensWithdrawn },
        });
        return used;
      });
      if (result.status !== 'ok') throw tokenError(result.status);
      await throttle.clear(throttleKey(result.account.email));
      outbox.deliver(passwordChangedMail(result.account.email, links.forgot(), at));
      return { reset: true };
    },
  );

  // --- The security panel -------------------------------------------------------------------

  app.get(
    '/account/security',
    { preHandler: app.requireAccount, schema: { response: { 200: securityResponseSchema } } },
    async (request) => {
      const { account, sessionId } = request.auth!;
      const at = now();
      const [pending, otherSessions] = await Promise.all([
        account.emailVerifiedAt === null
          ? hasLiveToken(app.db, account.id, 'verify_email', at)
          : Promise.resolve(false),
        countOtherSessions(app.db, account.id, sessionId, at),
      ]);
      return {
        security: {
          email: account.email,
          emailVerified: account.emailVerifiedAt !== null,
          emailVerifiedAt: account.emailVerifiedAt?.toISOString() ?? null,
          verificationPending: pending,
          mailEnabled: outbox.enabled,
          otherSessions,
        },
      };
    },
  );

  app.post(
    '/account/sessions/revoke-others',
    { preHandler: app.requireAccount },
    async (request) => {
      const { account, sessionId } = request.auth!;
      const at = now();
      const revoked = await withTransaction(app.db, async (tx) => {
        const n = await revokeSessions(tx, account.id, at, sessionId);
        await writeAudit(tx, {
          event: 'auth.logout_others',
          accountId: account.id,
          data: { revoked: n },
        });
        return n;
      });
      return { revoked };
    },
  );

  // --- Email change -------------------------------------------------------------------------

  app.post<{ Body: { email: string; password: string } }>(
    '/account/email',
    {
      preHandler: app.requireAccount,
      schema: { body: emailChangeBodySchema, response: { 200: accountResponseSchema } },
    },
    async (request, reply) => {
      const current = request.auth!.account;
      const email = normalizeEmail(request.body.email);
      const problem = emailError(email);
      if (problem) {
        throw new ApiError(400, 'validation_failed', 'Some fields need attention.', {
          fields: { email: problem },
        });
      }
      if (email.toLowerCase() === current.email.toLowerCase()) {
        throw new ApiError(400, 'validation_failed', 'Some fields need attention.', {
          fields: { email: 'This is already your email address.' },
        });
      }
      // The current password, under the same per-account throttle as login.
      const key = throttleKey(current.email);
      // Ticket 5.8: reserved before the check, as at login (parallel guesses get no extra tries).
      const lockedMs = await throttle.begin(key);
      if (lockedMs > 0) throw loginThrottled(reply, lockedMs);
      let passwordOk: boolean;
      try {
        passwordOk = await verifyPassword(current.passwordHash, request.body.password);
        if (!passwordOk) await throttle.fail(key);
      } finally {
        await throttle.end(key);
      }
      if (!passwordOk) {
        const lockMs = await throttle.lockedFor(key);
        await withTransaction(app.db, async (tx) => {
          await writeAudit(tx, {
            event: 'account.email_change_refused',
            accountId: current.id,
            data: {
              reason: 'bad_password',
              ...(lockMs > 0 ? { lockSeconds: Math.ceil(lockMs / 1000) } : {}),
            },
          });
        });
        throw new ApiError(403, 'wrong_password', 'That password is not right.', {
          fields: { password: 'That password is not right.' },
        });
      }
      // Ticket 5.8: three changes an hour with mail off too, so the change can't test addresses
      // (`409 email_taken`) faster than registration does.
      {
        const wait = await mailLimit(`account:${current.id}`);
        if (wait > 0) throw mailLimited(reply, wait);
      }
      const at = now();
      let changed;
      try {
        changed = await withTransaction(app.db, async (tx) => {
          const [updated] = await tx
            .update(accounts)
            .set({ email, emailVerifiedAt: null, updatedAt: sql`now()` })
            .where(eq(accounts.id, current.id))
            .returning();
          // Links sent to the old address stop working.
          await withdrawTokens(tx, current.id, ['verify_email', 'reset_password'], at);
          const verify = outbox.enabled ? await issueToken(tx, updated!, 'verify_email', at) : null;
          // No addresses in the audit row (personal data); the account row has the new one.
          await writeAudit(tx, {
            event: 'account.email_change',
            accountId: current.id,
            data: { verificationSent: verify !== null },
          });
          return { account: updated!, verify };
        });
      } catch (err) {
        if (
          sqlStateOf(err) === UNIQUE_VIOLATION &&
          constraintOf(err) === 'accounts_email_lower_key'
        ) {
          throw new ApiError(409, 'email_taken', 'An account with this email already exists.', {
            fields: { email: 'An account with this email already exists.' },
          });
        }
        throw err;
      }
      if (changed.verify) {
        outbox.deliver(
          verifyEmailMail(
            changed.account.email,
            links.verify(changed.verify.token),
            VERIFY_TOKEN_TTL_MS,
          ),
        );
      }
      outbox.deliver(emailChangedMail(current.email, links.impressum()));
      return { account: accountView(changed.account) };
    },
  );
}
