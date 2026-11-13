/**
 * Ticket 9.4: real-PostgreSQL races for character slots (docs/ACCOUNTS.md "Races"). Runs when
 * `DATABASE_URL` is set, skipped otherwise (CI sets `REQUIRE_PG_TESTS=1`). Every race runs several
 * rounds with alternating orders and growing head starts; only what holds in every order is
 * asserted (live heroes never exceed the slots, a freed or earned slot is used at most once, a
 * grant is made once), never which racer wins, and no transaction is retried (a retry would mean
 * a lock-order problem: a deadlock).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, count, eq, isNull } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { accountGrowthGrants, accounts, auditLog, characters } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { transactionStats, withTransaction } from '../db/transaction.js';
import { createPostgresTestDatabase } from '../test/db.js';
import { insertAccount, type TestAccount } from '../test/social.js';
import { insertCharacter } from '../test/heroes.js';
import { safeLetters } from '../test/names.js';
import { refreshAchievements } from '../achievements/award.js';
import { characterSlotTotal } from './grant.js';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === '1') {
  throw new Error('REQUIRE_PG_TESTS=1 but DATABASE_URL is not set');
}

const ROUNDS = 6;
const START = new Date(Math.floor((Date.now() + 86_400_000) / 3_600_000) * 3_600_000);
const now = () => START;
const activity = { ...DEFAULT_ACTIVITY_OPTIONS, now };

const later = async <T>(ms: number, fn: () => Promise<T>): Promise<T> => {
  await new Promise((r) => setTimeout(r, ms));
  return fn();
};

describe.skipIf(!url)('real PostgreSQL: character slots under races', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let admin: TestAccount;
  let seq = 0;
  const db = () => database.db;

  beforeAll(async () => {
    database = await createPostgresTestDatabase(url!, { poolMax: 20 });
    app = buildApp({
      database,
      auth: {
        now,
        accountRateLimit: { requests: 100_000, actions: 100_000, windowMs: 60_000 },
      },
      activity,
    });
    await app.ready();
    admin = await insertAccount(db(), { role: 'admin', now: START });
  });
  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  const post = (who: TestAccount, path: string, payload: object) =>
    app.inject({
      method: 'POST',
      url: path,
      payload,
      headers: { 'idempotency-key': randomUUID() },
      cookies: { [SESSION_COOKIE]: who.token },
    });
  const create = (who: TestAccount) => {
    seq += 1;
    return post(who, '/api/characters', {
      name: `Tilda${safeLetters(seq)}`,
      classId: 'hunter',
      appearance: { banner: 'ash' },
    });
  };
  const deleteHero = (who: TestAccount, hero: { id: string; name: string }) =>
    post(admin, `/api/admin/accounts/${who.handle}/heroes/${hero.id}/delete`, {
      confirm: hero.name,
      reason: 'race test',
    });
  const restoreHero = (who: TestAccount, heroId: string) =>
    post(admin, `/api/admin/accounts/${who.handle}/heroes/${heroId}/restore`, {
      reason: 'race test',
    });
  async function live(accountId: string) {
    const [row] = await db()
      .select({ n: count() })
      .from(characters)
      .where(and(eq(characters.accountId, accountId), isNull(characters.deletedAt)));
    return row!.n;
  }
  async function total(who: TestAccount) {
    const [row] = await db().select().from(accounts).where(eq(accounts.id, who.id));
    return characterSlotTotal(db(), row!);
  }

  it('creation vs a deletion at full slots: the freed slot is used, or the creation refused', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const who = await insertAccount(db(), { now: START });
      await insertCharacter(db(), who.id);
      const doomed = await insertCharacter(db(), who.id);
      const retries = transactionStats.retries;
      const head = round * 2;
      const [made, gone] =
        round % 2 === 0
          ? await Promise.all([create(who), later(head, () => deleteHero(who, doomed))])
          : await Promise.all([later(head, () => create(who)), deleteHero(who, doomed)]);
      expect(gone.statusCode, gone.body).toBe(200);
      expect([201, 422]).toContain(made.statusCode);
      // In every order: never more live heroes than slots, and exactly what the winner left.
      expect(await live(who.id)).toBe(made.statusCode === 201 ? 2 : 1);
      expect(await live(who.id)).toBeLessThanOrEqual(await total(who));
      expect(transactionStats.retries).toBe(retries);
    }
  });

  it('creation vs a restore for the last free slot: exactly one of them takes it', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const who = await insertAccount(db(), { now: START });
      await insertCharacter(db(), who.id);
      const doomed = await insertCharacter(db(), who.id);
      expect((await deleteHero(who, doomed)).statusCode).toBe(200);
      const retries = transactionStats.retries;
      const head = round * 2;
      const [made, back] =
        round % 2 === 0
          ? await Promise.all([create(who), later(head, () => restoreHero(who, doomed.id))])
          : await Promise.all([later(head, () => create(who)), restoreHero(who, doomed.id)]);
      const won = [made.statusCode === 201, back.statusCode === 200].filter(Boolean);
      expect(won, `${made.body} / ${back.body}`).toHaveLength(1);
      if (made.statusCode !== 201) expect(made.json().error.code).toBe('no_free_slot');
      if (back.statusCode !== 200) expect(back.json().error.code).toBe('no_free_slot');
      expect(await live(who.id)).toBe(2);
      expect(transactionStats.retries).toBe(retries);
    }
  });

  it('creation vs a slot grant: a grant is made once, and the slots are never overfilled', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const who = await insertAccount(db(), { now: START });
      const veteran = await insertCharacter(db(), who.id, { level: 28 });
      await insertCharacter(db(), who.id);
      const retries = transactionStats.retries;
      const grant = () =>
        withTransaction(db(), (tx) =>
          refreshAchievements(tx, veteran, ['maxCharacterLevel'], START),
        );
      const head = round * 2;
      const results =
        round % 2 === 0
          ? await Promise.all([create(who), create(who), grant(), later(head, grant)])
          : await Promise.all([later(head, () => create(who)), grant(), grant(), create(who)]);
      const made = results.filter(
        (r) => typeof r === 'object' && r !== null && 'statusCode' in r && r.statusCode === 201,
      );
      // At most the one earned slot, whichever order the grant and the creations ran in.
      expect(made.length).toBeLessThanOrEqual(1);
      expect(await live(who.id)).toBe(2 + made.length);
      const grants = await db()
        .select()
        .from(accountGrowthGrants)
        .where(
          and(
            eq(accountGrowthGrants.accountId, who.id),
            eq(accountGrowthGrants.grantId, 'level28'),
          ),
        );
      expect(grants).toHaveLength(1);
      const audits = await db()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.accountId, who.id), eq(auditLog.event, 'account.grow')));
      expect(audits.filter((a) => a.data.grantId === 'level28')).toHaveLength(1);
      // Once the grant is committed the slot is there for whoever did not get it.
      if (made.length === 0) expect((await create(who)).statusCode).toBe(201);
      expect((await create(who)).statusCode).toBe(422);
      expect(await live(who.id)).toBe(3);
      expect(transactionStats.retries).toBe(retries);
    }
  });

  it('many creations with an earned slot: exactly the slot total is created', async () => {
    const who = await insertAccount(db(), { now: START });
    await db().insert(accountGrowthGrants).values({
      accountId: who.id,
      grantId: 'level28',
      kind: 'slot',
      source: 'level28',
      grantedAt: START,
    });
    const results = await Promise.all(Array.from({ length: 8 }, () => create(who)));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(3);
    expect(results.filter((r) => r.statusCode === 422)).toHaveLength(5);
    expect(await live(who.id)).toBe(3);
  });
});
