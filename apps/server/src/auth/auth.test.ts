import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { HANDLE_RE } from '@worldforge/game-core';
import { buildApp, type AppOptions } from '../app.js';
import { accounts, auditLog, sessions } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { SESSION_COOKIE, sessionIdFor, type AccountView } from './index.js';

let database: DatabaseHandle;
let app: FastifyInstance;
const extraApps: FastifyInstance[] = [];

beforeAll(async () => {
  database = await createTestDatabase();
  // Generous limits for the shared app; the rate-limit tests build their own.
  app = buildApp({ database, auth: { registerRateLimit: { max: 1000, timeWindowMs: 60_000 } } });
  await app.ready();
});

afterAll(async () => {
  await Promise.all([app, ...extraApps].map((a) => a.close()));
  await database.close();
});

async function makeApp(auth: NonNullable<AppOptions['auth']>): Promise<FastifyInstance> {
  const a = buildApp({ database, auth });
  extraApps.push(a);
  await a.ready();
  return a;
}

let seq = 0;
function newIdentity() {
  seq += 1;
  return {
    email: `wanderer${seq}@graumark.test`,
    displayName: `Wanderer ${seq}`,
    password: 'ashes-and-iron-42',
  };
}

const register = (a: FastifyInstance, payload: object) =>
  a.inject({ method: 'POST', url: '/api/auth/register', payload });
const login = (a: FastifyInstance, payload: object) =>
  a.inject({ method: 'POST', url: '/api/auth/login', payload });
const me = (a: FastifyInstance, token?: string) =>
  a.inject({
    method: 'GET',
    url: '/api/account',
    cookies: token ? { [SESSION_COOKIE]: token } : {},
  });

function sessionCookie(res: LightMyRequestResponse) {
  return res.cookies.find((c) => c.name === SESSION_COOKIE);
}

function tokenOf(res: LightMyRequestResponse): string {
  const cookie = sessionCookie(res);
  if (!cookie?.value) throw new Error(`no session cookie (status ${res.statusCode})`);
  return cookie.value;
}

async function auditEvents(accountId: string): Promise<string[]> {
  const rows = await database.db
    .select({ event: auditLog.event })
    .from(auditLog)
    .where(eq(auditLog.accountId, accountId))
    .orderBy(auditLog.id);
  return rows.map((r) => r.event);
}

describe('POST /api/auth/register', () => {
  it('creates the account, starts a session and audits it', async () => {
    const id = newIdentity();
    const res = await register(app, { ...id, email: `  ${id.email.toUpperCase()} ` });
    expect(res.statusCode).toBe(201);
    const { account } = res.json<{ account: AccountView }>();
    expect(account).toMatchObject({
      email: id.email.toUpperCase(),
      displayName: id.displayName,
      characterSlots: 2,
    });
    expect(Object.keys(account).sort()).toEqual(
      [
        'characterSlots',
        'createdAt',
        'displayName',
        'email',
        'guide',
        'handle',
        'id',
        'role',
      ].sort(),
    );
    // Ticket 4.1: a new account is a player with an opaque handle, unrelated to its id.
    expect(account.role).toBe('player');
    expect(account.handle).toMatch(HANDLE_RE);
    expect(account.id.replace(/-/g, '')).not.toContain(account.handle);

    const cookie = sessionCookie(res)!;
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/api' });
    expect(cookie.expires!.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000);

    const [row] = await database.db.select().from(accounts).where(eq(accounts.id, account.id));
    expect(row!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row!.passwordHash).not.toContain(id.password);

    // The raw token is never stored; only its SHA-256.
    const token = cookie.value;
    const [session] = await database.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionIdFor(token)));
    expect(session?.accountId).toBe(account.id);
    expect(await database.db.select().from(sessions).where(eq(sessions.id, token))).toEqual([]);

    expect(await auditEvents(account.id)).toEqual(['account.register']);
    const current = await me(app, token);
    expect(current.statusCode).toBe(200);
    expect(current.json<{ account: AccountView }>().account.id).toBe(account.id);
  });

  it('reports every invalid field at once', async () => {
    const res = await register(app, { email: 'not-an-email', displayName: 'x', password: 'short' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: {
        code: 'validation_failed',
        message: 'Some fields need attention.',
        details: {
          fields: {
            email: 'Enter a valid email address.',
            displayName: 'Use 3–20 characters.',
            password: 'Use at least 10 characters.',
          },
        },
      },
    });
    expect(sessionCookie(res)).toBeUndefined();
  });

  it('rejects unknown and missing properties by schema', async () => {
    const extra = await register(app, { ...newIdentity(), gold: 999999 });
    expect(extra.statusCode).toBe(400);
    expect(extra.json().error.code).toBe('validation_failed');
    const missing = await register(app, { email: 'a@b.test' });
    expect(missing.statusCode).toBe(400);
  });

  it('rejects a duplicate email case-insensitively', async () => {
    const id = newIdentity();
    expect((await register(app, id)).statusCode).toBe(201);
    const res = await register(app, {
      ...newIdentity(),
      email: ` ${id.email.toUpperCase()}`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'email_taken',
      details: { fields: { email: expect.any(String) } },
    });
    expect(sessionCookie(res)).toBeUndefined();
  });

  it('rejects a duplicate display name case-insensitively', async () => {
    const id = newIdentity();
    expect((await register(app, id)).statusCode).toBe(201);
    const res = await register(app, {
      ...newIdentity(),
      displayName: id.displayName.toLowerCase(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('display_name_taken');
  });
});

describe('POST /api/auth/login', () => {
  it('logs in with any email casing and audits it', async () => {
    const id = newIdentity();
    const created = (await register(app, id)).json<{ account: AccountView }>().account;
    const res = await login(app, { email: id.email.toUpperCase(), password: id.password });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ account: AccountView }>().account.id).toBe(created.id);
    const token = tokenOf(res);
    expect((await me(app, token)).statusCode).toBe(200);
    expect(await auditEvents(created.id)).toEqual(['account.register', 'auth.login']);
  });

  it('answers a wrong password and an unknown email identically', async () => {
    const id = newIdentity();
    const created = (await register(app, id)).json<{ account: AccountView }>().account;

    const badPassword = await login(app, { email: id.email, password: 'wrong-password-1' });
    const unknown = await login(app, { email: 'nobody@graumark.test', password: id.password });
    for (const res of [badPassword, unknown]) {
      expect(res.statusCode).toBe(401);
      expect(sessionCookie(res)).toBeUndefined();
    }
    expect(badPassword.json()).toEqual({
      error: { code: 'invalid_credentials', message: 'Email or password is incorrect.' },
    });
    expect(unknown.body).toBe(badPassword.body);

    const failures = await database.db
      .select({ accountId: auditLog.accountId, data: auditLog.data })
      .from(auditLog)
      .where(eq(auditLog.event, 'auth.login_failed'));
    expect(failures).toEqual(
      expect.arrayContaining([
        { accountId: created.id, data: { reason: 'bad_password' } },
        { accountId: null, data: { reason: 'unknown_email' } },
      ]),
    );
  });

  it('rejects an empty body by schema', async () => {
    const res = await login(app, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_failed');
  });
});

describe('sessions', () => {
  it('requires a session for the current account', async () => {
    const res = await me(app);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthenticated');
  });

  it('rejects an unknown token and clears the cookie', async () => {
    const res = await me(app, 'forged-token');
    expect(res.statusCode).toBe(401);
    const cleared = sessionCookie(res)!;
    expect(cleared.value).toBe('');
    expect(cleared.path).toBe('/api');
  });

  it('revokes the session on logout', async () => {
    const id = newIdentity();
    const reg = await register(app, id);
    const accountId = reg.json<{ account: AccountView }>().account.id;
    const token = tokenOf(reg);

    const out = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(out.statusCode).toBe(204);
    expect(sessionCookie(out)?.value).toBe('');
    expect((await me(app, token)).statusCode).toBe(401);

    const [row] = await database.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, sessionIdFor(token)), eq(sessions.accountId, accountId)));
    expect(row?.revokedAt).toBeInstanceOf(Date);
    expect(await auditEvents(accountId)).toEqual(['account.register', 'auth.logout']);

    // Logging out again (or with no cookie at all) is a harmless no-op.
    const again = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(again.statusCode).toBe(204);
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout' })).statusCode).toBe(204);
    expect(await auditEvents(accountId)).toEqual(['account.register', 'auth.logout']);
  });

  it('expires sessions after their lifetime', async () => {
    let clock = new Date('2026-11-04T12:00:00.000Z');
    const hour = 60 * 60 * 1000;
    const timed = await makeApp({ sessionTtlMs: hour, now: () => clock });

    const reg = await register(timed, newIdentity());
    const token = tokenOf(reg);
    expect(sessionCookie(reg)!.expires!.toISOString()).toBe('2026-11-04T13:00:00.000Z');

    clock = new Date(clock.getTime() + hour - 1);
    expect((await me(timed, token)).statusCode).toBe(200);
    clock = new Date(clock.getTime() + 1);
    const expired = await me(timed, token);
    expect(expired.statusCode).toBe(401);
    expect(expired.json().error.code).toBe('unauthenticated');
  });

  it('can issue non-Secure cookies when configured', async () => {
    const plain = await makeApp({ cookieSecure: false });
    const res = await register(plain, newIdentity());
    expect(sessionCookie(res)?.secure).toBeUndefined();
  });
});

describe('rate limiting', () => {
  it('limits login attempts per client', async () => {
    const limited = await makeApp({ loginRateLimit: { max: 3, timeWindowMs: 60_000 } });
    const body = { email: 'nobody@graumark.test', password: 'whatever-123' };
    for (let i = 0; i < 3; i++) expect((await login(limited, body)).statusCode).toBe(401);

    const res = await login(limited, body);
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    expect(res.json().error).toMatchObject({
      code: 'rate_limited',
      details: { retryAfterSeconds: expect.any(Number) },
    });
    // Even correct credentials are refused until the window passes.
    const id = newIdentity();
    expect((await register(limited, id)).statusCode).toBe(201);
    expect((await login(limited, id)).statusCode).toBe(429);
  });

  it('limits registrations per client', async () => {
    const limited = await makeApp({ registerRateLimit: { max: 2, timeWindowMs: 60_000 } });
    expect((await register(limited, newIdentity())).statusCode).toBe(201);
    expect((await register(limited, { email: 'x' })).statusCode).toBe(400);
    const res = await register(limited, newIdentity());
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('rate_limited');
  });

  it('keys on the client address', async () => {
    const limited = await makeApp({ loginRateLimit: { max: 1, timeWindowMs: 60_000 } });
    const body = { email: 'nobody@graumark.test', password: 'whatever-123' };
    const from = (remoteAddress: string) =>
      limited.inject({ method: 'POST', url: '/api/auth/login', payload: body, remoteAddress });
    expect((await from('10.0.0.1')).statusCode).toBe(401);
    expect((await from('10.0.0.1')).statusCode).toBe(429);
    expect((await from('10.0.0.2')).statusCode).toBe(401);
  });
});

describe('POST /api/account/guide (ticket 2.7)', () => {
  const guide = (token: string | undefined, payload: object) =>
    app.inject({
      method: 'POST',
      url: '/api/account/guide',
      cookies: token ? { [SESSION_COOKIE]: token } : {},
      payload,
    });

  it('starts empty, records steps once in guide order, and remembers a dismissal', async () => {
    const reg = await register(app, newIdentity());
    const token = tokenOf(reg);
    expect(reg.json<{ account: AccountView }>().account.guide).toEqual({
      steps: [],
      dismissed: false,
    });

    await guide(token, { step: 'equip' });
    await guide(token, { step: 'character' });
    const again = await guide(token, { step: 'equip' });
    expect(again.statusCode).toBe(200);
    expect(again.json<{ account: AccountView }>().account.guide.steps).toEqual([
      'character',
      'equip',
    ]);

    await guide(token, { dismissed: true });
    // Remembered per account: a new login sees it dismissed.
    const id = reg.json<{ account: AccountView }>().account;
    const current = await me(app, token);
    expect(current.json<{ account: AccountView }>().account).toMatchObject({
      id: id.id,
      guide: { steps: ['character', 'equip'], dismissed: true },
    });

    const reopened = await guide(token, { dismissed: false });
    expect(reopened.json<{ account: AccountView }>().account.guide.dismissed).toBe(false);
  });

  it('refuses unknown steps, empty bodies and anonymous calls', async () => {
    const token = tokenOf(await register(app, newIdentity()));
    expect((await guide(token, { step: 'slayDragon' })).statusCode).toBe(400);
    expect((await guide(token, {})).statusCode).toBe(400);
    expect((await guide(token, { step: 'farm', gold: 999 })).statusCode).toBe(400);
    expect((await guide(undefined, { step: 'farm' })).statusCode).toBe(401);
  });
});
