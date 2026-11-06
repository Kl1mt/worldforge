/**
 * Real-PostgreSQL races for friends and blocks (ticket 4.3). Runs when `DATABASE_URL` is set,
 * skipped otherwise (CI sets `REQUIRE_PG_TESTS=1`). Every change to a pair runs under both
 * accounts' social locks, so: two players asking each other at once become friends once; a block
 * racing an accept always ends blocked with no friendship; an unfriend or cancel racing an accept
 * ends in the state the audit log says; caps hold exactly. Each race runs a few rounds in varied
 * orders and asserts only what holds in every order (Phase 3 retrospective).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { FRIEND_LIMITS } from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { accounts, auditLog, blocks, friendships } from '../db/schema.js';
import { transactionStats } from '../db/transaction.js';
import type { DatabaseHandle } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { createPostgresTestDatabase } from '../test/db.js';
import { caller, insertAccount, type TestAccount } from '../test/social.js';
import { pairOf, relationBetween } from './relations.js';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === '1') {
  throw new Error('REQUIRE_PG_TESTS=1 but DATABASE_URL is not set');
}

const N = 8;
const ROUNDS = 3;

function shuffled<T>(xs: T[], round: number): T[] {
  const out = [...xs];
  let seed = 11 + round * 37;
  for (let i = out.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe.skipIf(!url)('real PostgreSQL: friends and blocks race safely', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let call: ReturnType<typeof caller>;

  beforeAll(async () => {
    database = await createPostgresTestDatabase(url!, { poolMax: N * 3 + 2 });
    app = buildApp({
      database,
      auth: { socialWriteLimit: { windows: [{ windowMs: 60_000, max: 100_000 }] } },
    });
    await app.ready();
    call = caller(app);
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  const account = () => insertAccount(database.db);
  const send = (from: TestAccount, to: TestAccount) =>
    call(from, 'POST', '/api/friends/requests', { handle: to.handle });
  const pairRows = async (a: TestAccount, b: TestAccount) => {
    const { low, high } = pairOf(a.id, b.id);
    return database.db
      .select()
      .from(friendships)
      .where(and(eq(friendships.accountLow, low), eq(friendships.accountHigh, high)));
  };
  const events = async (event: string, ids: string[]) =>
    database.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.event, event), inArray(auditLog.accountId, ids)));

  it('both send a request at once → one friendship (many pairs at once)', async () => {
    const retries = transactionStats.retries;
    for (let round = 0; round < ROUNDS; round++) {
      const pairs = await Promise.all(
        Array.from({ length: N }, async () => [await account(), await account()] as const),
      );
      const jobs = shuffled(
        pairs.flatMap(([a, b]) => [
          { from: a, to: b },
          { from: b, to: a },
        ]),
        round,
      );
      const results = await Promise.all(jobs.map((j) => send(j.from, j.to)));
      for (const [a, b] of pairs) {
        const mine = results
          .filter((_, i) => jobs[i]!.from === a || jobs[i]!.from === b)
          .map((r) => {
            expect(r.statusCode, r.body).toBe(200);
            return r.json<{ relation: string }>().relation;
          });
        expect(mine.sort()).toEqual(['friend', 'requested-by-me']);
        const rows = await pairRows(a, b);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.status).toBe('friends');
        expect(await relationBetween(database.db, a.id, b.id)).toBe('friend');
        expect(await events('friend.request', [a.id, b.id])).toHaveLength(1);
        expect(await events('friend.accept', [a.id, b.id])).toHaveLength(1);
      }
    }
    expect(transactionStats.retries).toBe(retries);
  });

  it('a block racing an accept: always blocked, never friends; the audit says which came first', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const pairs = await Promise.all(
        Array.from({ length: N }, async () => {
          const a = await account();
          const b = await account();
          expect((await send(a, b)).statusCode).toBe(200);
          return { a, b };
        }),
      );
      // Half the pairs: the asker blocks; the other half: the asked player blocks while
      // accepting from another tab. Either way the accept comes from the asked player.
      const jobs = shuffled(
        pairs.flatMap(({ a, b }, i) => [
          {
            kind: 'accept' as const,
            pair: i,
            run: () => call(b, 'POST', `/api/friends/requests/${a.handle}/accept`),
          },
          {
            kind: 'block' as const,
            pair: i,
            run: () =>
              i % 2 === 0
                ? call(a, 'POST', '/api/blocks', { handle: b.handle })
                : call(b, 'POST', '/api/blocks', { handle: a.handle }),
          },
        ]),
        round,
      );
      const results = await Promise.all(jobs.map((j) => j.run()));
      for (const [i, { a, b }] of pairs.entries()) {
        const blocker = i % 2 === 0 ? a : b;
        const accept = results[jobs.findIndex((j) => j.pair === i && j.kind === 'accept')]!;
        const block = results[jobs.findIndex((j) => j.pair === i && j.kind === 'block')]!;
        expect(block.statusCode, block.body).toBe(200);
        expect([200, 404]).toContain(accept.statusCode);
        expect(await pairRows(a, b)).toEqual([]);
        const blockRows = await database.db
          .select()
          .from(blocks)
          .where(inArray(blocks.blockerId, [a.id, b.id]));
        expect(blockRows.map((r) => r.blockerId)).toEqual([blocker.id]);
        const accepted = await events('friend.accept', [b.id]);
        const [blockAudit] = await events('friend.block', [blocker.id]);
        // Reconciles with the audit log in either order.
        expect(accepted.length).toBe(accept.statusCode === 200 ? 1 : 0);
        expect(blockAudit!.data).toMatchObject({
          removed: accept.statusCode === 200 ? 'friends' : 'pending',
        });
      }
    }
  });

  it('an unfriend or cancel racing an accept: the final state follows the audit log', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const pairs = await Promise.all(
        Array.from({ length: N }, async () => {
          const a = await account();
          const b = await account();
          expect((await send(a, b)).statusCode).toBe(200);
          return { a, b };
        }),
      );
      const jobs = shuffled(
        pairs.flatMap(({ a, b }, i) => [
          {
            pair: i,
            kind: 'accept',
            run: () => call(b, 'POST', `/api/friends/requests/${a.handle}/accept`),
          },
          // The asker withdraws: an unfriend in even pairs, a cancel in odd ones.
          {
            pair: i,
            kind: 'withdraw',
            run: () =>
              i % 2 === 0
                ? call(a, 'POST', `/api/friends/${b.handle}/remove`)
                : call(a, 'POST', `/api/friends/requests/${b.handle}/cancel`),
          },
        ]),
        round,
      );
      const results = await Promise.all(jobs.map((j) => j.run()));
      for (const [i, { a, b }] of pairs.entries()) {
        const accept = results[jobs.findIndex((j) => j.pair === i && j.kind === 'accept')]!;
        const withdraw = results[jobs.findIndex((j) => j.pair === i && j.kind === 'withdraw')]!;
        const rows = await pairRows(a, b);
        const accepted = (await events('friend.accept', [b.id])).length;
        const withdrawn = (await events(i % 2 === 0 ? 'friend.remove' : 'friend.cancel', [a.id]))
          .length;
        expect(accepted).toBe(accept.statusCode === 200 ? 1 : 0);
        expect(withdrawn).toBe(withdraw.statusCode === 200 ? 1 : 0);
        if (i % 2 === 0) {
          // Unfriend only works after the accept: either both happened (strangers) or the
          // unfriend came first and failed (friends).
          expect(accepted).toBe(1);
          expect(rows.map((r) => r.status)).toEqual(withdrawn ? [] : ['friends']);
        } else {
          // Cancel only works before the accept: exactly one of them succeeded.
          expect(accepted + withdrawn).toBe(1);
          expect(rows.map((r) => r.status)).toEqual(accepted ? ['friends'] : []);
        }
      }
    }
  });

  it('caps hold exactly under concurrent accepts and sends', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      // One slot left among friends: N waiting requests accepted at once → exactly one.
      const full = await account();
      const filler = await database.db
        .insert(accounts)
        .values(
          Array.from({ length: FRIEND_LIMITS.friends - 1 }, (_, i) => ({
            id: uuidv7(),
            email: `cap-${round}-${i}-${uuidv7()}@graumark.test`,
            displayName: `Cap ${uuidv7().slice(-12)}`,
            passwordHash: 'x',
          })),
        )
        .returning({ id: accounts.id });
      await database.db.insert(friendships).values(
        filler.map(({ id }) => ({
          ...((p) => ({ accountLow: p.low, accountHigh: p.high }))(pairOf(full.id, id)),
          status: 'friends' as const,
          requestedBy: id,
        })),
      );
      const askers = await Promise.all(Array.from({ length: N }, () => account()));
      for (const a of askers) expect((await send(a, full)).statusCode).toBe(200);
      const order = shuffled(askers, round);
      const results = await Promise.all(
        order.map((a) => call(full, 'POST', `/api/friends/requests/${a.handle}/accept`)),
      );
      const codes = results.map((r) => (r.statusCode === 200 ? 'ok' : r.json().error.code));
      expect(codes.filter((c) => c === 'ok')).toHaveLength(1);
      expect(codes.filter((c) => c === 'friend_limit')).toHaveLength(N - 1);

      // One inbox slot left: N strangers send at once → exactly one lands.
      const popular = await account();
      const waiting = await Promise.all(
        Array.from({ length: FRIEND_LIMITS.incomingRequests - 1 }, () => account()),
      );
      for (const w of waiting) await send(w, popular);
      const senders = await Promise.all(Array.from({ length: N }, () => account()));
      const sent = await Promise.all(shuffled(senders, round).map((s) => send(s, popular)));
      expect(sent.filter((r) => r.statusCode === 200)).toHaveLength(1);
      expect(
        sent.filter((r) => r.statusCode === 409 && r.json().error.code === 'inbox_full'),
      ).toHaveLength(N - 1);
    }
  });
});
