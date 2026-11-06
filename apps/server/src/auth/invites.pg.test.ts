/**
 * Invite redemption races against a real PostgreSQL server (ticket D.2). Like
 * `concurrency.pg.test.ts`: runs when `DATABASE_URL` is set, skipped otherwise, required in CI.
 * PGlite runs one transaction at a time, so only here do registrations really overlap on the
 * invite row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { accounts, auditLog, inviteCodes } from '../db/schema.js';
import { transactionStats } from '../db/transaction.js';
import type { DatabaseHandle } from '../db/types.js';
import { createPostgresTestDatabase } from '../test/db.js';
import { createInvite } from './invites.js';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === '1') {
  throw new Error('REQUIRE_PG_TESTS=1 but DATABASE_URL is not set');
}
const N = 8;

describe.skipIf(!url)('invite redemption on real PostgreSQL', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let seq = 0;

  beforeAll(async () => {
    database = await createPostgresTestDatabase(url!, { poolMax: N * 2 + 2 });
    app = buildApp({
      database,
      auth: {
        registrationMode: 'invite',
        registerRateLimit: { max: 10_000, timeWindowMs: 60_000 },
      },
    });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  async function race(maxUses: number) {
    const { code, invite } = await createInvite(
      database.db,
      { maxUses, expiresAt: null, note: 'race', via: 'cli' },
      new Date(),
    );
    const retriesBefore = transactionStats.retries;
    const results = await Promise.all(
      Array.from({ length: N }, () => {
        seq += 1;
        return app.inject({
          method: 'POST',
          url: '/api/auth/register',
          payload: {
            email: `racer${seq}@graumark.test`,
            displayName: `Racer ${seq}`,
            password: 'ashes-and-iron-42',
            inviteCode: code,
          },
        });
      }),
    );
    const won = results.filter((r) => r.statusCode === 201);
    const lost = results.filter((r) => r.statusCode !== 201);
    for (const r of lost) {
      expect(r.statusCode).toBe(403);
      expect(r.json().error.code).toBe('invite_invalid');
    }
    const [row] = await database.db.select().from(inviteCodes).where(eq(inviteCodes.id, invite.id));
    const audits = await database.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.event, 'account.register'));
    const created = audits.filter((a) => (a.data as { inviteId?: string }).inviteId === invite.id);
    for (const r of won) {
      const [account] = await database.db
        .select()
        .from(accounts)
        .where(eq(accounts.id, r.json().account.id));
      expect(account).toBeDefined();
    }
    expect(transactionStats.retries).toBe(retriesBefore);
    return { won: won.length, uses: row!.uses, audited: created.length };
  }

  it(`${N} registrations racing for a 1-use code: exactly one succeeds`, async () => {
    expect(await race(1)).toEqual({ won: 1, uses: 1, audited: 1 });
  });

  it(`${N} registrations racing for a 3-use code: exactly three succeed`, async () => {
    expect(await race(3)).toEqual({ won: 3, uses: 3, audited: 3 });
  });
});
