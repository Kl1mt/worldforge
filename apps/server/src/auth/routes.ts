import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import { eq, sql } from 'drizzle-orm';
import {
  GUIDE_STEP_IDS,
  isStaff,
  normalizeGuide,
  withGuideStep,
  type GuideState,
  type AccountRole,
  type GuideStepId,
} from '@worldforge/game-core';
import { accounts, inviteCodes, type Account } from '../db/schema.js';
import type { RegistrationMode } from '../config.js';
import { constraintOf, sqlStateOf, withTransaction } from '../db/transaction.js';
import { writeAudit } from '../db/audit.js';
import { uuidv7 } from '../db/uuid.js';
import { ApiError, errorBody } from '../errors.js';
import { newHandle } from '../social/handles.js';
import { activeSanctions, sanctionError } from '../social/sanctions.js';
import {
  DEFAULT_SOCIAL_WRITE_LIMIT,
  createSocialWriteLimiter,
  type SocialWriteLimit,
} from '../social/social-write.js';
import { createPresenceRecorder } from '../social/presence.js';
import { inviteCodeHash, inviteStatus, normalizeInviteCode, redeemInvite } from './invites.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './password.js';
import { createSession, resolveSession, revokeSession } from './session.js';
import {
  DEFAULT_ACCOUNT_RATE_LIMIT,
  createAccountRateLimiter,
  type AccountRateLimit,
} from './account-rate-limit.js';
import {
  EMAIL_MAX,
  PASSWORD_MAX,
  normalizeEmail,
  validateRegistration,
  type RegistrationInput,
} from './validation.js';

export const SESSION_COOKIE = 'wf_session';
/** The cookie is only needed by the API, so the browser never sends it for static files. */
const COOKIE_PATH = '/api';

export interface RateLimit {
  max: number;
  timeWindowMs: number;
}

export interface AuthOptions {
  /** Fixed session lifetime from login. Default 30 days. */
  sessionTtlMs: number;
  /** `Secure` cookie flag. Default true; browsers accept Secure cookies on http://localhost. */
  cookieSecure: boolean;
  /** Per client IP. */
  loginRateLimit: RateLimit;
  registerRateLimit: RateLimit;
  /**
   * Per account, on every route behind `requireAccount` (ticket 3.9). Counted on the real clock
   * (`now`), never on the scaled farming clock of the playtest and e2e servers.
   */
  accountRateLimit: AccountRateLimit;
  /** Per account, for social writes (ticket 4.1), on top of `accountRateLimit`. */
  socialWriteLimit: SocialWriteLimit;
  /**
   * Ticket D.2: who may register (`REGISTRATION_MODE`). Default `open`. Login and existing
   * sessions never depend on it.
   */
  registrationMode: RegistrationMode;
  /**
   * Ticket 4.3: presence ("last seen") is written at most once per this interval per account.
   * Default game-core `PRESENCE_WRITE_INTERVAL_MS` (3 min).
   */
  presenceWriteIntervalMs?: number;
  /** Injected clock for session issue/expiry (tests). */
  now: () => Date;
}

export const DEFAULT_AUTH_OPTIONS: AuthOptions = {
  sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
  cookieSecure: true,
  loginRateLimit: { max: 10, timeWindowMs: 60_000 },
  registerRateLimit: { max: 5, timeWindowMs: 60 * 60_000 },
  accountRateLimit: DEFAULT_ACCOUNT_RATE_LIMIT,
  socialWriteLimit: DEFAULT_SOCIAL_WRITE_LIMIT,
  registrationMode: 'open',
  now: () => new Date(),
};

/** The account behind the request's session; set by `requireAccount`. */
export interface RequestAuth {
  sessionId: string;
  account: Account;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: RequestAuth | null;
  }
  interface FastifyInstance {
    /**
     * preHandler for routes that need a logged-in account. Rejects with `401 unauthenticated`
     * (and clears a stale cookie); otherwise `request.auth` is set. Game routes read the
     * account id only from here, never from the body.
     */
    requireAccount: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * preHandler for moderator routes (ticket 4.1): like `requireAccount`, but anyone who is not
     * staff (moderator or admin), logged in or not, gets the same `404` as an unknown route.
     */
    requireStaff: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export interface AccountView {
  id: string;
  email: string;
  displayName: string;
  /** Public handle (ticket 4.1): what other players and links use, never the id. */
  handle: string;
  /** Ticket 4.1. Shown so the client can offer the moderator queue; checked on the server. */
  role: AccountRole;
  characterSlots: number;
  createdAt: string;
  /** First-session guide (ticket 2.7). */
  guide: GuideState;
}

export function accountView(a: Account): AccountView {
  return {
    id: a.id,
    email: a.email,
    displayName: a.displayName,
    handle: a.handle,
    role: a.role,
    characterSlots: a.characterSlots,
    createdAt: a.createdAt.toISOString(),
    guide: normalizeGuide(a.guide),
  };
}

const accountResponseSchema = {
  type: 'object',
  required: ['account'],
  properties: {
    account: {
      type: 'object',
      required: [
        'id',
        'email',
        'displayName',
        'handle',
        'role',
        'characterSlots',
        'createdAt',
        'guide',
      ],
      properties: {
        id: { type: 'string' },
        email: { type: 'string' },
        displayName: { type: 'string' },
        handle: { type: 'string' },
        role: { type: 'string' },
        characterSlots: { type: 'integer' },
        createdAt: { type: 'string' },
        guide: {
          type: 'object',
          required: ['steps', 'dismissed'],
          properties: {
            steps: { type: 'array', items: { type: 'string' } },
            dismissed: { type: 'boolean' },
          },
        },
      },
    },
  },
} as const;

// Shape only; content rules are in validation.ts. Generous caps so the rules (not Ajv) produce
// the friendly per-field message, while still bounding what reaches argon2.
const registerBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['email', 'displayName', 'password'],
  properties: {
    email: { type: 'string', maxLength: 320 },
    displayName: { type: 'string', maxLength: 64 },
    password: { type: 'string', maxLength: PASSWORD_MAX * 4 },
    // Ticket D.2: needed in `invite` mode, ignored otherwise.
    inviteCode: { type: 'string', maxLength: 64 },
  },
} as const;

const INVITE_INVALID_MESSAGE = 'This invite code is not valid, has expired or has been used up.';
const inviteInvalid = () =>
  new ApiError(403, 'invite_invalid', INVITE_INVALID_MESSAGE, {
    fields: { inviteCode: INVITE_INVALID_MESSAGE },
  });

const loginBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['email', 'password'],
  properties: {
    email: { type: 'string', minLength: 1, maxLength: 320 },
    password: { type: 'string', minLength: 1, maxLength: PASSWORD_MAX * 4 },
  },
} as const;

const UNIQUE_VIOLATION = '23505';

const INVALID_CREDENTIALS = () =>
  new ApiError(401, 'invalid_credentials', 'Email or password is incorrect.');

export async function registerAuth(app: FastifyInstance, options: AuthOptions): Promise<void> {
  const { now } = options;

  await app.register(fastifyCookie);
  // Only routes that opt in via `config.rateLimit` are limited. The store is in-process memory,
  // which is correct for the single API instance assumed in TECH_STACK.md.
  await app.register(fastifyRateLimit, {
    global: false,
    errorResponseBuilder: (_request, context) =>
      new ApiError(429, 'rate_limited', `Too many attempts. Try again in ${context.after}.`, {
        retryAfterSeconds: Math.ceil(context.ttl / 1000),
      }),
  });

  app.decorateRequest('auth', null);

  const setSessionCookie = (reply: FastifyReply, token: string, expiresAt: Date) => {
    void reply.setCookie(SESSION_COOKIE, token, {
      path: COOKIE_PATH,
      httpOnly: true,
      secure: options.cookieSecure,
      sameSite: 'lax',
      expires: expiresAt,
    });
  };
  const clearSessionCookie = (reply: FastifyReply) => {
    void reply.clearCookie(SESSION_COOKIE, {
      path: COOKIE_PATH,
      httpOnly: true,
      secure: options.cookieSecure,
      sameSite: 'lax',
    });
  };

  const accountRateLimit = createAccountRateLimiter(options.accountRateLimit, now);
  app.decorate('authNow', now);
  app.decorate('socialWriteLimit', createSocialWriteLimiter(options.socialWriteLimit, now));
  const seen = createPresenceRecorder(
    app.db,
    (err) => app.log.warn({ err }, 'presence write failed'),
    options.presenceWriteIntervalMs,
  );
  app.decorate('requireAccount', async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.cookies[SESSION_COOKIE];
    const at = now();
    const resolved = token ? await resolveSession(app.db, token, at) : null;
    if (!resolved) {
      if (token) clearSessionCookie(reply);
      throw new ApiError(401, 'unauthenticated', 'Not logged in.');
    }
    // Ticket 4.1: a suspension stops every session at once (checked on each request, so it also
    // lifts on its own when it expires). The body says why and until when.
    const [suspension] = await activeSanctions(app.db, resolved.account.id, at, ['suspend']);
    if (suspension) throw sanctionError(suspension);
    // Ticket 3.9: per-account limits, checked before any game work (or idempotency claim).
    accountRateLimit(resolved.account.id, request.method, reply);
    // Ticket 4.3: presence, coalesced (one write every few minutes per account at most).
    await seen(resolved.account.id, at);
    request.auth = resolved;
  });
  app.decorate('requireStaff', async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.cookies[SESSION_COOKIE];
    const resolved = token ? await resolveSession(app.db, token, now()) : null;
    if (!resolved || !isStaff(resolved.account.role)) {
      // Exactly the not-found handler's answer, so the routes can't be told from missing ones.
      return reply
        .code(404)
        .send(errorBody('not_found', `Route ${request.method} ${request.url} not found`));
    }
    await app.requireAccount(request, reply);
  });

  const rateLimitConfig = (limit: RateLimit) => ({
    rateLimit: { max: limit.max, timeWindow: limit.timeWindowMs },
  });

  // Ticket D.2: public, so the register screen knows whether to ask for an invite code.
  app.get('/config', async (_request, reply) => {
    void reply.header('Cache-Control', 'no-cache');
    return { registration: { mode: options.registrationMode } };
  });

  app.post<{ Body: RegistrationInput & { inviteCode?: string } }>(
    '/auth/register',
    {
      config: rateLimitConfig(options.registerRateLimit),
      schema: { body: registerBodySchema, response: { 201: accountResponseSchema } },
    },
    async (request, reply) => {
      const mode = options.registrationMode;
      if (mode === 'closed') {
        throw new ApiError(403, 'registration_closed', 'Registration is closed right now.');
      }
      const { inviteCode: rawInvite, ...fields } = request.body;
      const inviteCode = mode === 'invite' ? (rawInvite ?? '').trim() : '';
      const { value, errors } = validateRegistration(fields);
      if (mode === 'invite' && inviteCode === '') {
        (errors as Record<string, string>).inviteCode = 'Enter your invite code.';
      }
      if (Object.keys(errors).length > 0) {
        throw new ApiError(400, 'validation_failed', 'Some fields need attention.', {
          fields: errors,
        });
      }
      if (mode === 'invite') {
        // Cheap early answer before the slow password hash. Not the guard: the conditional
        // UPDATE in the transaction is what makes redemption atomic.
        const normalized = normalizeInviteCode(inviteCode);
        const [invite] = normalized
          ? await app.db
              .select()
              .from(inviteCodes)
              .where(eq(inviteCodes.codeHash, inviteCodeHash(normalized)))
          : [];
        if (!invite || inviteStatus(invite, now()) !== 'active') throw inviteInvalid();
      }
      // Hash outside the transaction: it is slow and has no database side effects.
      const passwordHash = await hashPassword(value.password);
      const issuedAt = now();
      try {
        const { account, session } = await withTransaction(app.db, async (tx) => {
          let inviteId: string | null = null;
          if (mode === 'invite') {
            inviteId = await redeemInvite(tx, inviteCode, issuedAt);
            if (!inviteId) throw inviteInvalid();
          }
          const [account] = await tx
            .insert(accounts)
            .values({
              id: uuidv7(),
              email: value.email,
              displayName: value.displayName,
              handle: newHandle(),
              passwordHash,
              createdAt: issuedAt,
              updatedAt: issuedAt,
            })
            .returning();
          const session = await createSession(tx, account!.id, issuedAt, options.sessionTtlMs);
          await writeAudit(tx, {
            event: 'account.register',
            accountId: account!.id,
            // Ticket D.2: which invite created the account (its id, never the code).
            ...(inviteId ? { data: { inviteId } } : {}),
          });
          return { account: account!, session };
        });
        setSessionCookie(reply, session.token, session.expiresAt);
        return reply.code(201).send({ account: accountView(account) });
      } catch (err) {
        if (sqlStateOf(err) === UNIQUE_VIOLATION) {
          const constraint = constraintOf(err);
          if (constraint === 'accounts_email_lower_key') {
            throw new ApiError(409, 'email_taken', 'An account with this email already exists.', {
              fields: { email: 'An account with this email already exists.' },
            });
          }
          if (constraint === 'accounts_display_name_lower_key') {
            throw new ApiError(409, 'display_name_taken', 'This display name is taken.', {
              fields: { displayName: 'This display name is taken.' },
            });
          }
        }
        throw err;
      }
    },
  );

  app.post<{ Body: { email: string; password: string } }>(
    '/auth/login',
    {
      config: rateLimitConfig(options.loginRateLimit),
      schema: { body: loginBodySchema, response: { 200: accountResponseSchema } },
    },
    async (request, reply) => {
      const email = normalizeEmail(request.body.email);
      const { password } = request.body;
      const [account] =
        email.length > 0 && email.length <= EMAIL_MAX
          ? await app.db
              .select()
              .from(accounts)
              .where(sql`lower(${accounts.email}) = lower(${email})`)
              .limit(1)
          : [];

      const ok = account
        ? await verifyPassword(account.passwordHash, password)
        : await verifyAgainstDummy(password);
      if (!account || !ok) {
        // Same status, code and message for both cases; only the audit row tells them apart.
        await writeAudit(app.db, {
          event: 'auth.login_failed',
          accountId: account?.id ?? null,
          data: { reason: account ? 'bad_password' : 'unknown_email' },
        });
        throw INVALID_CREDENTIALS();
      }

      // Ticket 4.1: a suspended account gets no session (told why only after the right password).
      const [suspension] = await activeSanctions(app.db, account.id, now(), ['suspend']);
      if (suspension) {
        await writeAudit(app.db, {
          event: 'auth.login_refused',
          accountId: account.id,
          data: { reason: 'suspended', sanctionId: suspension.id },
        });
        throw sanctionError(suspension);
      }

      const session = await withTransaction(app.db, async (tx) => {
        const created = await createSession(tx, account.id, now(), options.sessionTtlMs);
        await writeAudit(tx, { event: 'auth.login', accountId: account.id });
        return created;
      });
      setSessionCookie(reply, session.token, session.expiresAt);
      return { account: accountView(account) };
    },
  );

  // Idempotent: always clears the cookie and answers 204, with or without a live session.
  app.post('/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    const resolved = token ? await resolveSession(app.db, token, now()) : null;
    if (resolved) {
      await withTransaction(app.db, async (tx) => {
        if (await revokeSession(tx, resolved.sessionId, now())) {
          await writeAudit(tx, { event: 'auth.logout', accountId: resolved.account.id });
        }
      });
    }
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.get(
    '/account',
    { preHandler: app.requireAccount, schema: { response: { 200: accountResponseSchema } } },
    async (request) => ({ account: accountView(request.auth!.account) }),
  );

  // First-session guide (ticket 2.7): mark a step done and/or dismiss or reopen the guide.
  // UI state only (it grants nothing), so reporting a step is the client's word. Locked row,
  // so two tabs marking different steps never lose one.
  app.post(
    '/account/guide',
    {
      preHandler: app.requireAccount,
      schema: { body: guideBodySchema, response: { 200: accountResponseSchema } },
    },
    async (request) => {
      const body = request.body as { step?: GuideStepId; dismissed?: boolean };
      if (body.step === undefined && body.dismissed === undefined) {
        throw new ApiError(400, 'validation_failed', 'Send a step or dismissed.');
      }
      const accountId = request.auth!.account.id;
      const account = await withTransaction(app.db, async (tx) => {
        const [row] = await tx
          .select({ guide: accounts.guide })
          .from(accounts)
          .where(eq(accounts.id, accountId))
          .for('update');
        let guide = normalizeGuide(row?.guide);
        if (body.step !== undefined) guide = withGuideStep(guide, body.step);
        if (body.dismissed !== undefined) guide = { ...guide, dismissed: body.dismissed };
        const [updated] = await tx
          .update(accounts)
          .set({ guide, updatedAt: sql`now()` })
          .where(eq(accounts.id, accountId))
          .returning();
        return updated!;
      });
      return { account: accountView(account) };
    },
  );
}

const guideBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    step: { type: 'string', enum: [...GUIDE_STEP_IDS] },
    dismissed: { type: 'boolean' },
  },
} as const;
