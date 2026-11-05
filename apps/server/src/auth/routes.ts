import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import { eq, sql } from 'drizzle-orm';
import {
  GUIDE_STEP_IDS,
  normalizeGuide,
  withGuideStep,
  type GuideState,
  type GuideStepId,
} from '@worldforge/game-core';
import { accounts, type Account } from '../db/schema.js';
import { constraintOf, sqlStateOf, withTransaction } from '../db/transaction.js';
import { writeAudit } from '../db/audit.js';
import { uuidv7 } from '../db/uuid.js';
import { ApiError } from '../errors.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './password.js';
import { createSession, resolveSession, revokeSession } from './session.js';
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
  /** Injected clock for session issue/expiry (tests). */
  now: () => Date;
}

export const DEFAULT_AUTH_OPTIONS: AuthOptions = {
  sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
  cookieSecure: true,
  loginRateLimit: { max: 10, timeWindowMs: 60_000 },
  registerRateLimit: { max: 5, timeWindowMs: 60 * 60_000 },
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
  }
}

export interface AccountView {
  id: string;
  email: string;
  displayName: string;
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
      required: ['id', 'email', 'displayName', 'characterSlots', 'createdAt', 'guide'],
      properties: {
        id: { type: 'string' },
        email: { type: 'string' },
        displayName: { type: 'string' },
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
  },
} as const;

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

  app.decorate('requireAccount', async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.cookies[SESSION_COOKIE];
    const resolved = token ? await resolveSession(app.db, token, now()) : null;
    if (!resolved) {
      if (token) clearSessionCookie(reply);
      throw new ApiError(401, 'unauthenticated', 'Not logged in.');
    }
    request.auth = resolved;
  });

  const rateLimitConfig = (limit: RateLimit) => ({
    rateLimit: { max: limit.max, timeWindow: limit.timeWindowMs },
  });

  app.post<{ Body: RegistrationInput }>(
    '/auth/register',
    {
      config: rateLimitConfig(options.registerRateLimit),
      schema: { body: registerBodySchema, response: { 201: accountResponseSchema } },
    },
    async (request, reply) => {
      const { value, errors } = validateRegistration(request.body);
      if (Object.keys(errors).length > 0) {
        throw new ApiError(400, 'validation_failed', 'Some fields need attention.', {
          fields: errors,
        });
      }
      // Hash outside the transaction: it is slow and has no database side effects.
      const passwordHash = await hashPassword(value.password);
      const issuedAt = now();
      try {
        const { account, session } = await withTransaction(app.db, async (tx) => {
          const [account] = await tx
            .insert(accounts)
            .values({
              id: uuidv7(),
              email: value.email,
              displayName: value.displayName,
              passwordHash,
              createdAt: issuedAt,
              updatedAt: issuedAt,
            })
            .returning();
          const session = await createSession(tx, account!.id, issuedAt, options.sessionTtlMs);
          await writeAudit(tx, { event: 'account.register', accountId: account!.id });
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
