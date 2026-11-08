/**
 * Ticket 5.7: per-account login throttling, email verification, password reset, email change,
 * "log out other devices" and pruning. Mail goes to an in-memory outbox (never sent anywhere);
 * tokens are read from the captured mails. The clock is injected.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { buildApp, type AppOptions } from '../app.js';
import { accountTokens, accounts, auditLog, sessions, telemetryDaily } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import {
  createMemoryMailer,
  linkIn,
  tokenIn,
  type MailMessage,
  type Mailer,
} from '../mail/mailer.js';
import { SESSION_COOKIE, isEmailVerified, pruneAuthRows } from './index.js';
import { DEFAULT_LOGIN_THROTTLE } from './login-throttle.js';
import { RESET_TOKEN_TTL_MS, VERIFY_TOKEN_TTL_MS } from './tokens.js';
import { mailSettled } from './security-routes.js';

const BASE = 'https://play.example.test';
const PASSWORD = 'ashes-and-iron-42';
const NEW_PASSWORD = 'embers-and-salt-77';
const GENEROUS = { max: 10_000, timeWindowMs: 60_000 };

let database: DatabaseHandle;
let app: FastifyInstance;
const extraApps: FastifyInstance[] = [];
const mailer = createMemoryMailer();
let clockMs = Date.UTC(2026, 10, 8, 12);
const now = () => new Date(clockMs);
const advance = (ms: number) => {
  clockMs += ms;
};

async function makeApp(auth: NonNullable<AppOptions['auth']> = {}): Promise<FastifyInstance> {
  const a = buildApp({
    database,
    auth: {
      registerRateLimit: GENEROUS,
      loginRateLimit: GENEROUS,
      forgotRateLimit: GENEROUS,
      tokenRateLimit: GENEROUS,
      mailer,
      publicBaseUrl: BASE,
      forgotFloorMs: 0,
      now,
      ...auth,
    },
  });
  extraApps.push(a);
  await a.ready();
  return a;
}

beforeAll(async () => {
  database = await createTestDatabase();
  app = await makeApp();
});

afterAll(async () => {
  await Promise.all(extraApps.map((a) => a.close()));
  await database.close();
});

let seq = 0;
function newIdentity(prefix = 'warden') {
  seq += 1;
  return {
    email: `${prefix}${seq}@example.test`,
    displayName: `Warden ${prefix.slice(0, 4)} ${seq}`.replace(/\d/g, (d) => 'abcdefghij'[+d]!),
    password: PASSWORD,
  };
}

function tokenOf(res: LightMyRequestResponse): string {
  const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
  if (!cookie?.value) throw new Error(`no session cookie (status ${res.statusCode}): ${res.body}`);
  return cookie.value;
}

const post = (a: FastifyInstance, url: string, payload?: object, session?: string, ip?: string) =>
  a.inject({
    method: 'POST',
    url,
    ...(payload ? { payload } : {}),
    cookies: session ? { [SESSION_COOKIE]: session } : {},
    ...(ip ? { remoteAddress: ip } : {}),
  });
const get = (a: FastifyInstance, url: string, session?: string) =>
  a.inject({ method: 'GET', url, cookies: session ? { [SESSION_COOKIE]: session } : {} });

async function registerPlayer(a = app, prefix?: string) {
  const id = newIdentity(prefix);
  const res = await post(a, '/api/auth/register', id);
  expect(res.statusCode, res.body).toBe(201);
  const account = res.json<{ account: { id: string; emailVerified: boolean } }>().account;
  return { ...id, id: account.id, session: tokenOf(res), account };
}

const login = (a: FastifyInstance, email: string, password: string, ip?: string) =>
  post(a, '/api/auth/login', { email, password }, undefined, ip);

function lastMail(to: string, kind: MailMessage['kind']): MailMessage {
  const m = mailer.last(to, kind);
  if (!m) throw new Error(`no ${kind} mail to ${to}`);
  return m;
}
const tokenOfMail = (m: MailMessage) => tokenIn(m)!;

async function auditEvents(accountId: string): Promise<string[]> {
  const rows = await database.db
    .select({ event: auditLog.event })
    .from(auditLog)
    .where(eq(auditLog.accountId, accountId))
    .orderBy(auditLog.id);
  return rows.map((r) => r.event);
}

async function telemetry(metric: string, dim1: string, dim2 = ''): Promise<number> {
  const rows = await database.db
    .select({ events: telemetryDaily.events })
    .from(telemetryDaily)
    .where(
      and(
        eq(telemetryDaily.metric, metric),
        eq(telemetryDaily.dim1, dim1),
        eq(telemetryDaily.dim2, dim2),
      ),
    );
  return rows.reduce((s, r) => s + r.events, 0);
}

function errorOf(res: LightMyRequestResponse) {
  return res.json<{ error: { code: string; message: string; details?: Record<string, unknown> } }>()
    .error;
}

describe('per-account login throttling', () => {
  const free = DEFAULT_LOGIN_THROTTLE.freeAttempts;

  /** The statuses and bodies of `n` wrong guesses, then one with the right password. */
  async function guess(email: string, n: number, right: string) {
    const out: { status: number; body: unknown }[] = [];
    for (let i = 0; i < n; i += 1) {
      const res = await login(app, email, 'not-the-password-1');
      out.push({ status: res.statusCode, body: res.json() });
    }
    const res = await login(app, email, right);
    out.push({ status: res.statusCode, body: res.json() });
    return out;
  }

  it('locks known and unknown addresses alike, with the same answers', async () => {
    const player = await registerPlayer();
    const unknown = `nobody${seq}@example.test`;
    const known = await guess(player.email, free + 1, player.password);
    const ghost = await guess(unknown, free + 1, player.password);
    // Free attempts, then the failure that starts the lock (still 401), then 429.
    expect(known.map((r) => r.status)).toEqual([...Array(free + 1).fill(401), 429]);
    expect(ghost).toEqual(known);
    expect(known.at(-1)!.body).toEqual({
      error: {
        code: 'rate_limited',
        message: expect.stringContaining('Too many failed attempts for this account') as string,
        details: { retryAfterSeconds: 30, limit: 'account' },
      },
    });
    // Audited on the account (and on no account for the unknown address), counted in telemetry.
    // Rows of one transaction share a millisecond, so their uuidv7 order is not defined: compare
    // as a multiset.
    expect((await auditEvents(player.id)).sort()).toEqual(
      [
        'account.register',
        'account.verification_sent',
        ...Array(free + 1).fill('auth.login_failed'),
        'auth.login_locked',
      ].sort(),
    );
    expect(await telemetry('auth.login', 'locked')).toBeGreaterThanOrEqual(2);
    expect(await telemetry('auth.login', 'throttled')).toBeGreaterThanOrEqual(2);
  });

  it('refuses even the right password while locked; the lock ends, backs off and resets', async () => {
    const player = await registerPlayer();
    for (let i = 0; i <= free; i += 1) await login(app, player.email, 'not-the-password-1');
    const locked = await login(app, player.email, player.password);
    expect(locked.statusCode).toBe(429);
    expect(locked.headers['retry-after']).toBe('30');

    // The lock runs out: the next failure locks for twice as long.
    advance(30_000);
    expect((await login(app, player.email, 'not-the-password-1')).statusCode).toBe(401);
    expect(errorOf(await login(app, player.email, player.password)).details).toEqual({
      retryAfterSeconds: 60,
      limit: 'account',
    });

    // An hour without failures: the count starts over (free attempts again).
    advance(DEFAULT_LOGIN_THROTTLE.resetAfterMs);
    for (let i = 0; i < free; i += 1) {
      expect((await login(app, player.email, 'not-the-password-1')).statusCode).toBe(401);
    }
    // A success clears the count: the free attempts are back in full.
    expect((await login(app, player.email, player.password)).statusCode).toBe(200);
    for (let i = 0; i < free; i += 1) {
      expect((await login(app, player.email, 'not-the-password-1')).statusCode).toBe(401);
    }
    expect((await login(app, player.email, player.password)).statusCode).toBe(200);
  });

  it('is per account across IPs, while the per-IP limit still applies on top', async () => {
    const ipApp = await makeApp({ loginRateLimit: { max: free + 4, timeWindowMs: 60 * 60_000 } });
    const victim = await registerPlayer(ipApp);
    const other = await registerPlayer(ipApp);
    // Lock the victim from one IP.
    for (let i = 0; i <= free; i += 1)
      await login(ipApp, victim.email, 'wrong-guess-12', '198.51.100.1');
    // The same IP can still log into another account (its IP budget is not spent yet).
    expect((await login(ipApp, other.email, other.password, '198.51.100.1')).statusCode).toBe(200);
    // Another IP cannot get into the locked account: the lock is per account.
    const elsewhere = await login(ipApp, victim.email, victim.password, '198.51.100.2');
    expect(elsewhere.statusCode).toBe(429);
    expect(errorOf(elsewhere).details).toMatchObject({ limit: 'account' });
    // The per-IP limit stops the first IP even for an account that is not locked.
    for (let i = 0; i < 3; i += 1)
      await login(ipApp, other.email, 'wrong-guess-12', '198.51.100.1');
    const ipLimited = await login(ipApp, other.email, other.password, '198.51.100.1');
    expect(ipLimited.statusCode).toBe(429);
    expect(errorOf(ipLimited).details).not.toMatchObject({ limit: 'account' });
    // …while a third IP gets in to that account.
    expect((await login(ipApp, other.email, other.password, '198.51.100.3')).statusCode).toBe(200);
  });
});

describe('email verification', () => {
  it('mails a single-use link on registration that verifies the account', async () => {
    const player = await registerPlayer();
    expect(player.account.emailVerified).toBe(false);
    const mail = lastMail(player.email, 'verify_email');
    expect(linkIn(mail)).toMatch(new RegExp(`^${BASE}/#/verify\\?token=[A-Za-z0-9_-]{43}$`));
    // No personal data beyond the address it goes to.
    expect(mail.text).not.toContain(player.displayName);
    expect(mail.html).not.toContain(player.displayName);
    expect(mail.html).toContain(linkIn(mail)!);

    const security = await get(app, '/api/account/security', player.session);
    expect(security.json()).toEqual({
      security: {
        email: player.email,
        emailVerified: false,
        emailVerifiedAt: null,
        verificationPending: true,
        mailEnabled: true,
        otherSessions: 0,
      },
    });
    expect(await isEmailVerified(database.db, player.id)).toBe(false);

    const token = tokenOfMail(mail);
    const ok = await post(app, '/api/auth/verify-email', { token });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ verified: true });
    expect(await isEmailVerified(database.db, player.id)).toBe(true);
    expect((await get(app, '/api/account', player.session)).json()).toMatchObject({
      account: { emailVerified: true },
    });
    // Single use.
    const again = await post(app, '/api/auth/verify-email', { token });
    expect(again.statusCode).toBe(400);
    expect(errorOf(again).code).toBe('token_invalid');
    // Already verified: nothing to resend.
    const resend = await post(app, '/api/account/verification', undefined, player.session);
    expect(resend.statusCode).toBe(409);
    expect(errorOf(resend).code).toBe('already_verified');
    expect((await auditEvents(player.id)).sort()).toEqual(
      ['account.register', 'account.verification_sent', 'account.email_verified'].sort(),
    );
  });

  it('expires exactly at its end time; garbage and unknown tokens are invalid', async () => {
    const player = await registerPlayer();
    const token = tokenOfMail(lastMail(player.email, 'verify_email'));
    advance(VERIFY_TOKEN_TTL_MS - 1);
    expect((await get(app, '/api/account/security', player.session)).json()).toMatchObject({
      security: { verificationPending: true },
    });
    advance(1);
    const expired = await post(app, '/api/auth/verify-email', { token });
    expect(expired.statusCode).toBe(400);
    expect(errorOf(expired)).toEqual({
      code: 'token_expired',
      message: 'This link has expired. Ask for a new one.',
    });
    expect(await isEmailVerified(database.db, player.id)).toBe(false);
    for (const t of ['x', 'A'.repeat(43), `${token.slice(0, 42)}?`]) {
      const res = await post(app, '/api/auth/verify-email', { token: t });
      expect(errorOf(res).code).toBe('token_invalid');
    }
  });

  it('resends a new link (the old one stops working), at most three an hour', async () => {
    const mailApp = await makeApp();
    const player = await registerPlayer(mailApp);
    const first = tokenOfMail(lastMail(player.email, 'verify_email'));
    const resend = await post(mailApp, '/api/account/verification', undefined, player.session);
    expect(resend.statusCode).toBe(202);
    const second = tokenOfMail(lastMail(player.email, 'verify_email'));
    expect(second).not.toBe(first);
    expect(errorOf(await post(mailApp, '/api/auth/verify-email', { token: first })).code).toBe(
      'token_invalid',
    );
    await post(mailApp, '/api/account/verification', undefined, player.session);
    await post(mailApp, '/api/account/verification', undefined, player.session);
    const limited = await post(mailApp, '/api/account/verification', undefined, player.session);
    expect(limited.statusCode).toBe(429);
    expect(errorOf(limited).details).toEqual({ retryAfterSeconds: 3600, limit: 'mail' });
    // The newest link still works.
    const newest = tokenOfMail(lastMail(player.email, 'verify_email'));
    expect((await post(mailApp, '/api/auth/verify-email', { token: newest })).statusCode).toBe(200);
  });
});

describe('email change', () => {
  it('needs the current password, unverifies, mails both addresses and voids old links', async () => {
    const player = await registerPlayer();
    await post(app, '/api/auth/verify-email', {
      token: tokenOfMail(lastMail(player.email, 'verify_email')),
    });
    await post(app, '/api/auth/forgot-password', { email: player.email });
    const oldReset = tokenOfMail(lastMail(player.email, 'reset_password'));
    const next = `moved${seq}@example.test`;

    const wrong = await post(
      app,
      '/api/account/email',
      { email: next, password: 'not-my-password-1' },
      player.session,
    );
    expect(wrong.statusCode).toBe(403);
    expect(errorOf(wrong)).toMatchObject({
      code: 'wrong_password',
      details: { fields: { password: 'That password is not right.' } },
    });
    const same = await post(
      app,
      '/api/account/email',
      { email: player.email.toUpperCase(), password: PASSWORD },
      player.session,
    );
    expect(same.statusCode).toBe(400);

    const ok = await post(
      app,
      '/api/account/email',
      { email: next, password: PASSWORD },
      player.session,
    );
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ account: { email: next, emailVerified: false } });
    expect(await isEmailVerified(database.db, player.id)).toBe(false);
    // The old address is told, without the new one in the letter.
    const notice = lastMail(player.email, 'email_changed');
    expect(notice.text).not.toContain(next);
    expect(notice.html).not.toContain(next);
    // A reset link mailed to the old address no longer works.
    const stale = await post(app, '/api/auth/reset-password', {
      token: oldReset,
      password: NEW_PASSWORD,
    });
    expect(errorOf(stale).code).toBe('token_invalid');
    // The new address verifies with its own link.
    const verify = tokenOfMail(lastMail(next, 'verify_email'));
    expect((await post(app, '/api/auth/verify-email', { token: verify })).statusCode).toBe(200);
    expect(await isEmailVerified(database.db, player.id)).toBe(true);

    const taken = await registerPlayer();
    const clash = await post(
      app,
      '/api/account/email',
      { email: next.toUpperCase(), password: PASSWORD },
      taken.session,
    );
    expect(clash.statusCode).toBe(409);
    expect(errorOf(clash).code).toBe('email_taken');
    expect(await auditEvents(player.id)).toContain('account.email_change');
  });
});

describe('password reset', () => {
  it('answers the same for known and unknown addresses', async () => {
    const player = await registerPlayer();
    const before = mailer.outbox.length;
    const known = await post(app, '/api/auth/forgot-password', { email: player.email });
    const unknown = await post(app, '/api/auth/forgot-password', {
      email: `ghost${seq}@example.test`,
    });
    const malformed = await post(app, '/api/auth/forgot-password', { email: 'not an address' });
    for (const res of [known, unknown, malformed]) {
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ accepted: true });
      expect(Object.keys(res.headers).sort()).toEqual(Object.keys(known.headers).sort());
    }
    // Only the known address got a letter.
    expect(mailer.outbox.length).toBe(before + 1);
    expect(lastMail(player.email, 'reset_password').to).toBe(player.email);
  });

  it('takes about the same time for known and unknown addresses', async () => {
    const floor = 300;
    const timed = await makeApp({
      forgotFloorMs: floor,
      mailLimit: { max: 100, windowMs: 60_000 },
    });
    const player = await registerPlayer(timed);
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      for (const [email, out] of [
        [player.email, known],
        [`ghost-t${i}@example.test`, unknown],
      ] as const) {
        const t0 = performance.now();
        const res = await post(timed, '/api/auth/forgot-password', { email });
        out.push(performance.now() - t0);
        expect(res.statusCode).toBe(202);
      }
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    // Both are padded to the floor; the work behind it (a lookup, or a lookup and an insert) is
    // far below it, so the medians sit together just above the floor.
    expect(median(known)).toBeGreaterThanOrEqual(floor - 5);
    expect(median(unknown)).toBeGreaterThanOrEqual(floor - 5);
    expect(Math.abs(median(known) - median(unknown))).toBeLessThan(floor / 2);
  });

  it('sets a new password once, ends every session and voids other links', async () => {
    const player = await registerPlayer();
    const second = tokenOf(await login(app, player.email, PASSWORD));
    await post(app, '/api/auth/forgot-password', { email: player.email });
    const token = tokenOfMail(lastMail(player.email, 'reset_password'));
    expect(linkIn(lastMail(player.email, 'reset_password'))).toBe(`${BASE}/#/reset?token=${token}`);

    const weak = await post(app, '/api/auth/reset-password', { token, password: 'short' });
    expect(weak.statusCode).toBe(400);
    expect(errorOf(weak)).toMatchObject({
      code: 'validation_failed',
      details: { fields: { password: 'Use at least 10 characters.' } },
    });

    const ok = await post(app, '/api/auth/reset-password', { token, password: NEW_PASSWORD });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({ reset: true });
    expect(ok.cookies.find((c) => c.name === SESSION_COOKIE)).toBeUndefined();

    // Every session ended, on every device.
    for (const s of [player.session, second]) {
      expect((await get(app, '/api/account', s)).statusCode).toBe(401);
    }
    // Single use.
    const again = await post(app, '/api/auth/reset-password', {
      token,
      password: 'another-pass-99',
    });
    expect(errorOf(again).code).toBe('token_invalid');
    // Old password out, new one in; the mailbox was proven, so the address counts as verified.
    expect((await login(app, player.email, PASSWORD)).statusCode).toBe(401);
    const fresh = await login(app, player.email, NEW_PASSWORD);
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json()).toMatchObject({ account: { emailVerified: true } });
    // The verification link from registration was withdrawn with the reset.
    const verifyToken = tokenOfMail(lastMail(player.email, 'verify_email'));
    expect(errorOf(await post(app, '/api/auth/verify-email', { token: verifyToken })).code).toBe(
      'token_invalid',
    );
    // The player is told.
    const notice = lastMail(player.email, 'password_changed');
    expect(linkIn(notice)).toBe(`${BASE}/#/forgot`);
    expect(await auditEvents(player.id)).toEqual(
      expect.arrayContaining(['auth.reset_requested', 'auth.password_reset']),
    );
    const [row] = await database.db
      .select({ data: auditLog.data })
      .from(auditLog)
      .where(and(eq(auditLog.accountId, player.id), eq(auditLog.event, 'auth.password_reset')));
    expect(row!.data).toEqual({ sessionsRevoked: 2, tokensWithdrawn: 1 });
  });

  it('keeps only the newest link, which expires after 30 minutes', async () => {
    const player = await registerPlayer();
    await post(app, '/api/auth/forgot-password', { email: player.email });
    const first = tokenOfMail(lastMail(player.email, 'reset_password'));
    await post(app, '/api/auth/forgot-password', { email: player.email });
    const second = tokenOfMail(lastMail(player.email, 'reset_password'));
    expect(
      errorOf(await post(app, '/api/auth/reset-password', { token: first, password: NEW_PASSWORD }))
        .code,
    ).toBe('token_invalid');
    advance(RESET_TOKEN_TTL_MS);
    const expired = await post(app, '/api/auth/reset-password', {
      token: second,
      password: NEW_PASSWORD,
    });
    expect(errorOf(expired).code).toBe('token_expired');
    expect((await login(app, player.email, PASSWORD)).statusCode).toBe(200);
  });

  it('sends at most three letters an hour to one address, answering the same', async () => {
    const capped = await makeApp();
    const player = await registerPlayer(capped);
    const count = () =>
      mailer.outbox.filter((m) => m.to === player.email && m.kind === 'reset_password').length;
    for (let i = 0; i < 5; i += 1) {
      const res = await post(capped, '/api/auth/forgot-password', { email: player.email });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ accepted: true });
    }
    expect(count()).toBe(3);
    advance(60 * 60_000);
    await post(capped, '/api/auth/forgot-password', { email: player.email });
    expect(count()).toBe(4);
  });

  it('works while login is locked, and lifts the lock', async () => {
    const player = await registerPlayer();
    for (let i = 0; i <= DEFAULT_LOGIN_THROTTLE.freeAttempts; i += 1) {
      await login(app, player.email, 'not-the-password-1');
    }
    expect((await login(app, player.email, PASSWORD)).statusCode).toBe(429);
    await post(app, '/api/auth/forgot-password', { email: player.email });
    const token = tokenOfMail(lastMail(player.email, 'reset_password'));
    expect(
      (await post(app, '/api/auth/reset-password', { token, password: NEW_PASSWORD })).statusCode,
    ).toBe(200);
    expect((await login(app, player.email, NEW_PASSWORD)).statusCode).toBe(200);
  });
});

describe('log out other devices', () => {
  it('ends every other session and keeps this one', async () => {
    const player = await registerPlayer();
    const phone = tokenOf(await login(app, player.email, PASSWORD));
    const laptop = tokenOf(await login(app, player.email, PASSWORD));
    expect((await get(app, '/api/account/security', player.session)).json()).toMatchObject({
      security: { otherSessions: 2 },
    });
    const res = await post(app, '/api/account/sessions/revoke-others', undefined, player.session);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ revoked: 2 });
    expect((await get(app, '/api/account', player.session)).statusCode).toBe(200);
    for (const s of [phone, laptop])
      expect((await get(app, '/api/account', s)).statusCode).toBe(401);
    expect((await get(app, '/api/account/security', player.session)).json()).toMatchObject({
      security: { otherSessions: 0 },
    });
    const again = await post(app, '/api/account/sessions/revoke-others', undefined, player.session);
    expect(again.json()).toEqual({ revoked: 0 });
    expect(await auditEvents(player.id)).toContain('auth.logout_others');
    expect((await post(app, '/api/account/sessions/revoke-others')).statusCode).toBe(401);
  });
});

describe('without SMTP settings', () => {
  it('starts and plays; verification and reset say email is not set up', async () => {
    const plain = buildApp({
      database,
      auth: { registerRateLimit: GENEROUS, loginRateLimit: GENEROUS, now },
    });
    extraApps.push(plain);
    await plain.ready();
    expect((await get(plain, '/api/config')).json()).toEqual({
      registration: { mode: 'open' },
      email: { enabled: false },
    });
    const player = await registerPlayer(plain);
    expect(player.account.emailVerified).toBe(false);
    const tokens = await database.db
      .select()
      .from(accountTokens)
      .where(eq(accountTokens.accountId, player.id));
    expect(tokens).toEqual([]);
    expect((await login(plain, player.email, PASSWORD)).statusCode).toBe(200);
    expect((await get(plain, '/api/account/security', player.session)).json()).toMatchObject({
      security: { mailEnabled: false, emailVerified: false, verificationPending: false },
    });
    const unavailable = {
      error: {
        code: 'email_unavailable',
        message: expect.stringContaining('Email is not set up on this server yet') as string,
      },
    };
    for (const email of [player.email, 'ghost@example.test']) {
      const res = await post(plain, '/api/auth/forgot-password', { email });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual(unavailable);
    }
    const resend = await post(plain, '/api/account/verification', undefined, player.session);
    expect(resend.statusCode).toBe(503);
    expect(resend.json()).toEqual(unavailable);
    // Changing the email still works (no letter goes out).
    const moved = await post(
      plain,
      '/api/account/email',
      { email: `plain${seq}@example.test`, password: PASSWORD },
      player.session,
    );
    expect(moved.statusCode).toBe(200);
  });
});

describe('mail delivery', () => {
  it('never holds up or fails a request; outcomes are counted', async () => {
    const broken: Mailer = {
      transport: 'smtp',
      enabled: true,
      send: () =>
        Promise.reject(
          Object.assign(new Error('550 rejected someone@example.test'), { code: 'EENVELOPE' }),
        ),
    };
    const flaky = await makeApp({ mailer: broken });
    const before = await telemetry('mail.send', 'verify_email', 'failed');
    const player = await registerPlayer(flaky);
    await mailSettled(broken);
    expect(await telemetry('mail.send', 'verify_email', 'failed')).toBe(before + 1);
    expect(player.account.emailVerified).toBe(false);
    await mailSettled(mailer);
    expect(await telemetry('mail.send', 'verify_email', 'sent')).toBeGreaterThan(0);
  });
});

describe('pruning', () => {
  it('removes expired and long-revoked sessions and expired tokens, and keeps the rest', async () => {
    const player = await registerPlayer();
    const revoked = tokenOf(await login(app, player.email, PASSWORD));
    await post(app, '/api/auth/logout', undefined, revoked);
    const countSessions = async () =>
      (await database.db.select().from(sessions).where(eq(sessions.accountId, player.id))).length;
    const countTokens = async () =>
      (await database.db.select().from(accountTokens).where(eq(accountTokens.accountId, player.id)))
        .length;
    expect(await countSessions()).toBe(2);
    expect(await countTokens()).toBe(1);

    // A day later: the verify token has expired; the revoked session is kept for a week.
    await pruneAuthRows(database.db, new Date(clockMs + VERIFY_TOKEN_TTL_MS));
    expect(await countTokens()).toBe(0);
    expect(await countSessions()).toBe(2);
    // Eight days later the revoked one goes; the live one stays until it expires (30 days).
    await pruneAuthRows(database.db, new Date(clockMs + 8 * 24 * 60 * 60_000));
    expect(await countSessions()).toBe(1);
    expect((await get(app, '/api/account', player.session)).statusCode).toBe(200);
    await pruneAuthRows(database.db, new Date(clockMs + 31 * 24 * 60 * 60_000));
    expect(await countSessions()).toBe(0);
    // The account itself is untouched.
    expect(
      await database.db
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.id, player.id)),
    ).toHaveLength(1);
  });
});
