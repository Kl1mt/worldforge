import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDatabase } from '../test/db.js';
import { accounts, auditLog, sessions } from './schema.js';
import { migrateDatabase } from './migrate.js';
import { writeAudit } from './audit.js';
import { withTransaction } from './transaction.js';
import { uuidv7 } from './uuid.js';
import { queryRows } from './query.js';
import type { DatabaseHandle } from './types.js';

let database: DatabaseHandle;
const db = () => database.db;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await db().execute(sql`truncate audit_log, sessions, accounts cascade`);
});

function newAccount(overrides: Partial<typeof accounts.$inferInsert> = {}) {
  const id = uuidv7();
  return {
    id,
    email: `${id}@example.test`,
    displayName: `hero-${id.slice(-8)}`,
    passwordHash: '$scrypt$placeholder',
    ...overrides,
  };
}

async function errorOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected the promise to reject');
}

/** PostgreSQL SQLSTATE of a (Drizzle-wrapped) driver error. */
async function sqlState(p: Promise<unknown>): Promise<string | undefined> {
  const err = (await errorOf(p)) as { code?: string; cause?: { code?: string } };
  return err.cause?.code ?? err.code;
}

describe('migrations', () => {
  it('create exactly the Phase 1.1 tables from scratch', async () => {
    const rows = await queryRows<{ table_name: string }>(
      db(),
      sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`,
    );
    expect(rows.map((r) => r.table_name)).toEqual(['accounts', 'audit_log', 'sessions']);
  });

  it('are idempotent: re-running applies nothing and keeps data', async () => {
    await db().insert(accounts).values(newAccount());
    await migrateDatabase(db());
    const applied = await queryRows(
      db(),
      sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
    );
    expect(applied[0]).toEqual({ n: 1 });
    expect(await db().$count(accounts)).toBe(1);
  });
});

describe('accounts', () => {
  it('applies defaults', async () => {
    const [row] = await db().insert(accounts).values(newAccount()).returning();
    expect(row!.characterSlots).toBe(2);
    expect(row!.createdAt).toBeInstanceOf(Date);
    expect(row!.updatedAt).toBeInstanceOf(Date);
  });

  it('rejects emails and display names that differ only in case', async () => {
    await db()
      .insert(accounts)
      .values(newAccount({ email: 'Ash@Example.test', displayName: 'Ash' }));
    expect(
      await sqlState(
        db()
          .insert(accounts)
          .values(newAccount({ email: 'ash@example.TEST' })),
      ),
    ).toBe('23505');
    expect(
      await sqlState(
        db()
          .insert(accounts)
          .values(newAccount({ displayName: 'ASH' })),
      ),
    ).toBe('23505');
  });

  it('rejects negative character slots', async () => {
    expect(
      await sqlState(
        db()
          .insert(accounts)
          .values(newAccount({ characterSlots: -1 })),
      ),
    ).toBe('23514');
  });
});

describe('sessions', () => {
  it('belong to an existing account and are deleted with it', async () => {
    const account = newAccount();
    await db().insert(accounts).values(account);
    const expiresAt = new Date(Date.now() + 3600_000);
    await db()
      .insert(sessions)
      .values({ id: 'a'.repeat(64), accountId: account.id, expiresAt });

    expect(
      await sqlState(
        db()
          .insert(sessions)
          .values({ id: 'b'.repeat(64), accountId: uuidv7(), expiresAt }),
      ),
    ).toBe('23503');

    await db().delete(accounts).where(eq(accounts.id, account.id));
    expect(await db().$count(sessions)).toBe(0);
  });

  it('must expire after they were created', async () => {
    const account = newAccount();
    await db().insert(accounts).values(account);
    expect(
      await sqlState(
        db()
          .insert(sessions)
          .values({ id: 'c'.repeat(64), accountId: account.id, expiresAt: new Date(0) }),
      ),
    ).toBe('23514');
  });
});

describe('audit log', () => {
  it('stores events with jsonb data and keeps them when the account is deleted', async () => {
    const account = newAccount();
    await db().insert(accounts).values(account);
    const entry = await writeAudit(db(), {
      event: 'account.register',
      accountId: account.id,
      data: { ip: '127.0.0.1', nested: { ok: true } },
    });
    expect(entry).toMatchObject({ event: 'account.register', characterId: null });
    expect(entry.data).toEqual({ ip: '127.0.0.1', nested: { ok: true } });

    await db().delete(accounts).where(eq(accounts.id, account.id));
    const [kept] = await db().select().from(auditLog).where(eq(auditLog.id, entry.id));
    expect(kept!.accountId).toBeNull();
    expect(kept!.event).toBe('account.register');
  });

  it('defaults data to an empty object and allows anonymous events', async () => {
    const entry = await writeAudit(db(), { event: 'auth.login_failed' });
    expect(entry.accountId).toBeNull();
    expect(entry.data).toEqual({});
  });
});

describe('withTransaction', () => {
  it('commits all writes together', async () => {
    const account = newAccount();
    const result = await withTransaction(db(), async (tx) => {
      await tx.insert(accounts).values(account);
      await writeAudit(tx, { event: 'account.register', accountId: account.id });
      return 'done';
    });
    expect(result).toBe('done');
    expect(await db().$count(accounts)).toBe(1);
    expect(await db().$count(auditLog)).toBe(1);
  });

  it('rolls back every write when the callback throws', async () => {
    const account = newAccount();
    await expect(
      withTransaction(db(), async (tx) => {
        await tx.insert(accounts).values(account);
        await writeAudit(tx, { event: 'account.register', accountId: account.id });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(await db().$count(accounts)).toBe(0);
    expect(await db().$count(auditLog)).toBe(0);
  });

  it('rolls back when a statement fails mid-transaction', async () => {
    const first = newAccount({ email: 'dupe@example.test' });
    const err = await errorOf(
      withTransaction(db(), async (tx) => {
        await tx.insert(accounts).values(first);
        await tx.insert(accounts).values(newAccount({ email: 'DUPE@example.test' }));
      }),
    );
    expect(err).toBeInstanceOf(Error);
    expect(await db().$count(accounts)).toBe(0);
  });

  it('runs at the requested isolation level', async () => {
    const level = await withTransaction(
      db(),
      async (tx) => {
        const rows = await queryRows<{ transaction_isolation: string }>(
          tx,
          sql`show transaction_isolation`,
        );
        return rows[0]!.transaction_isolation;
      },
      { isolationLevel: 'serializable' },
    );
    expect(level).toBe('serializable');
  });
});
