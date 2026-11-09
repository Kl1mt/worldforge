/**
 * Ticket 5.7: mailed-token races against a real PostgreSQL server. Like `invites.pg.test.ts`:
 * runs when `DATABASE_URL` is set, skipped otherwise, required in CI. PGlite runs one transaction
 * at a time, so only here do requests with the same token really overlap.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { accountTokens, accounts, sessions } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { createPostgresTestDatabase } from '../test/db.js';
import { createMemoryMailer, tokenIn } from '../mail/mailer.js';
import { SESSION_COOKIE, verifyPassword } from './index.js';
import { issueToken, RESET_TOKEN_TTL_MS } from './tokens.js';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === '1') {
  throw new Error('REQUIRE_PG_TESTS=1 but DATABASE_URL is not set');
}
const N = 8;
const GENEROUS = { max: 10_000, timeWindowMs: 60_000 };
const PASSWORD = 'ashes-and-iron-42';

describe.skipIf(!url)('account tokens on real PostgreSQL', () => {
  let database: DatabaseHandle;
  const mailer = createMemoryMailer();
  const start = Date.UTC(2026, 10, 8, 12);
  const apps: FastifyInstance[] = [];
  let seq = 0;

  const appAt = async (offsetMs: number) => {
    const a = buildApp({
      database,
      auth: {
        registerRateLimit: GENEROUS,
        loginRateLimit: GENEROUS,
        forgotRateLimit: GENEROUS,
        tokenRateLimit: GENEROUS,
        mailer,
        mailLimit: { max: 1000, windowMs: 60_000 },
        publicBaseUrl: 'https://play.example.test',
        forgotFloorMs: 0,
        now: () => new Date(start + offsetMs),
      },
    });
    apps.push(a);
    await a.ready();
    return a;
  };
  let app: FastifyInstance;

  beforeAll(async () => {
    database = await createPostgresTestDatabase(url!, { poolMax: N * 2 + 2 });
    app = await appAt(0);
  });
  afterAll(async () => {
    await Promise.all(apps.map((a) => a.close()));
    await database?.close();
  });

  async function player() {
    seq += 1;
    const email = `racer${seq}@example.test`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email,
        displayName: `Racer ${'abcdefghij'[seq % 10]}${'abcdefghij'[(seq / 10) | 0]}`,
        password: PASSWORD,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json<{ account: { id: string } }>().account.id;
    return { email, id };
  }

  it('a verification link verifies exactly once, however many requests race', async () => {
    const p = await player();
    const token = tokenIn(mailer.last(p.email, 'verify_email')!)!;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        app.inject({ method: 'POST', url: '/api/auth/verify-email', payload: { token } }),
      ),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, ...Array(N - 1).fill(400)]);
    for (const r of results.filter((r) => r.statusCode === 400)) {
      expect(r.json()).toMatchObject({ error: { code: 'token_invalid' } });
    }
  });

  it('a reset link sets exactly one password, however many requests race', async () => {
    const p = await player();
    await app.inject({
      method: 'POST',
      url: '/api/auth/forgot-password',
      payload: { email: p.email },
    });
    const token = tokenIn(mailer.last(p.email, 'reset_password')!)!;
    const passwords = Array.from({ length: N }, (_, i) => `new-password-${i}-xyz`);
    const results = await Promise.all(
      passwords.map((password) =>
        app.inject({
          method: 'POST',
          url: '/api/auth/reset-password',
          payload: { token, password },
        }),
      ),
    );
    const winners = results.flatMap((r, i) => (r.statusCode === 200 ? [i] : []));
    expect(winners).toHaveLength(1);
    // Exactly the winner's password is stored (checked on the hash: logging in with every
    // candidate would trip the per-account throttle, whichever request won).
    const [row] = await database.db
      .select({ hash: accounts.passwordHash })
      .from(accounts)
      .where(eq(accounts.id, p.id));
    for (const [i, password] of passwords.entries()) {
      expect(await verifyPassword(row!.hash, password)).toBe(i === winners[0]);
    }
  });

  it('two live reset links racing: the account lock lets only one through', async () => {
    const p = await player();
    // Two live links at once (as two forgot requests interleaving could leave them).
    const [account] = await database.db.select().from(accounts).where(eq(accounts.id, p.id));
    const at = new Date(start);
    const a = await issueToken(database.db, account!, 'reset_password', at);
    await database.db
      .update(accountTokens)
      .set({ usedAt: null })
      .where(eq(accountTokens.accountId, p.id));
    const b = await issueToken(database.db, account!, 'reset_password', at);
    await database.db
      .update(accountTokens)
      .set({ usedAt: null })
      .where(eq(accountTokens.accountId, p.id));
    const results = await Promise.all(
      [a.token, b.token].flatMap((token) =>
        Array.from({ length: N / 2 }, (_, i) =>
          app.inject({
            method: 'POST',
            url: '/api/auth/reset-password',
            payload: { token, password: `racing-pass-${i}-abc` },
          }),
        ),
      ),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    const live = await database.db
      .select()
      .from(accountTokens)
      .where(and(eq(accountTokens.accountId, p.id), isNull(accountTokens.usedAt)));
    expect(live).toEqual([]);
  });

  it('at the expiry boundary: requests before it may win once, requests at or after it never do', async () => {
    const p = await player();
    await app.inject({
      method: 'POST',
      url: '/api/auth/forgot-password',
      payload: { email: p.email },
    });
    const token = tokenIn(mailer.last(p.email, 'reset_password')!)!;
    const before = await appAt(RESET_TOKEN_TTL_MS - 1);
    const at = await appAt(RESET_TOKEN_TTL_MS);
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        (i % 2 === 0 ? before : at).inject({
          method: 'POST',
          url: '/api/auth/reset-password',
          payload: { token, password: `boundary-pass-${i}-q` },
        }),
      ),
    );
    const ok = results.flatMap((r, i) => (r.statusCode === 200 ? [i] : []));
    expect(ok).toHaveLength(1);
    expect(ok[0]! % 2).toBe(0);
    for (const [i, r] of results.entries()) {
      if (i % 2 === 1)
        expect(r.json()).toMatchObject({
          error: { code: expect.stringMatching(/^token_(expired|invalid)$/) as string },
        });
    }
  });

  it('a reset racing logins with the old password: no old-password session survives', async () => {
    const p = await player();
    await app.inject({
      method: 'POST',
      url: '/api/auth/forgot-password',
      payload: { email: p.email },
    });
    const token = tokenIn(mailer.last(p.email, 'reset_password')!)!;
    // A login that checked the old password commits its session before the reset (which then
    // revokes it) or re-reads the new hash under the row lock and is refused. Every order ends
    // with no live session.
    const [reset, ...logins] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/auth/reset-password',
        payload: { token, password: 'after-the-race-1' },
      }),
      ...Array.from({ length: N - 1 }, () =>
        app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { email: p.email, password: PASSWORD },
        }),
      ),
    ]);
    expect(reset!.statusCode).toBe(200);
    for (const l of logins) {
      // Ticket 5.8: past the free attempts and one more, checks for one address wait their turn
      // (`429`, nothing read, no session), so a burst like this one can be refused in part.
      expect([200, 401, 429]).toContain(l.statusCode);
      const cookie = l.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
      if (!cookie) continue;
      const me = await app.inject({
        method: 'GET',
        url: '/api/account',
        cookies: { [SESSION_COOKIE]: cookie },
      });
      expect(me.statusCode).toBe(401);
    }
    const live = await database.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.accountId, p.id), isNull(sessions.revokedAt)));
    // Only the registration's session existed before; the reset revoked it too.
    expect(live).toEqual([]);
  });
});
