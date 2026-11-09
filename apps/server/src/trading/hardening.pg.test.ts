/**
 * Ticket T.7, the trading exploit review on real PostgreSQL (docs/TRADING.md "T.7 exploit
 * review"): the two lock gaps the review found, three rounds each with varied head starts,
 * asserting only what holds in every order, and no transaction retried (a deadlock shows up as a
 * retry).
 * - F4: a sanction voiding several offers (their senders' heroes locked in hero-id order) racing
 *   an accept between two of those senders (offer → heroes in id order).
 * - F5: a send racing a block between the same pair: never an open offer between a blocked pair.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, or } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { accounts, tradeOffers } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { transactionStats, withTransaction } from '../db/transaction.js';
import { createPostgresTestDatabase } from '../test/db.js';
import { insertAccount, type TestAccount } from '../test/social.js';
import {
  ALL_TRADING_ON,
  befriendSince,
  insertTrader,
  setTradingSettings,
  tradeCalls,
  type Trader,
} from '../test/trading.js';
import { issueSanction } from '../social/moderation.js';
import { reconcileWithAudit } from '../telemetry/report.js';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === '1') {
  throw new Error('REQUIRE_PG_TESTS=1 but DATABASE_URL is not set');
}

const ROUNDS = 3;
const START = new Date('2031-07-07T08:00:00.000Z');
const now = () => START;

const later = async <T>(ms: number, fn: () => Promise<T>): Promise<T> => {
  await new Promise((r) => setTimeout(r, ms));
  return fn();
};

describe.skipIf(!url)('real PostgreSQL: trading exploit review (T.7)', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let t: ReturnType<typeof tradeCalls>;
  let moderator: TestAccount;
  const db = () => database.db;

  beforeAll(async () => {
    database = await createPostgresTestDatabase(url!, { poolMax: 20 });
    app = buildApp({
      database,
      auth: {
        now,
        accountRateLimit: { requests: 100_000, actions: 100_000, windowMs: 60_000 },
        socialWriteLimit: { windows: [{ windowMs: 60_000, max: 10_000 }] },
        tradeWriteLimit: { windows: [{ windowMs: 60_000, max: 10_000 }] },
      },
      activity: { ...DEFAULT_ACTIVITY_OPTIONS, now },
    });
    await app.ready();
    t = tradeCalls(app);
    await setTradingSettings(app, db(), ALL_TRADING_ON);
    moderator = await insertAccount(db(), { role: 'moderator', now: START });
  });
  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  async function restrict(subjectId: string) {
    await withTransaction(db(), async (tx) => {
      const [actor] = await tx
        .select()
        .from(accounts)
        .where(eq(accounts.id, moderator.id))
        .for('share');
      const [subject] = await tx
        .select()
        .from(accounts)
        .where(eq(accounts.id, subjectId))
        .for('update');
      await issueSanction(tx, {
        actor: actor!,
        subject: subject!,
        action: 'restrictTrade',
        reason: 'Race test',
        durationHours: 24,
        targetKey: null,
        target: null,
        now: START,
        events: app.sanctionEvents,
      });
    });
  }

  it('F4: a sanction voiding two senders’ offers vs an accept between those senders', async () => {
    const retries = transactionStats.retries;
    for (let round = 0; round < ROUNDS; round++) {
      const s = await insertTrader(db(), START);
      const p = await insertTrader(db(), START);
      const q = await insertTrader(db(), START);
      // Y1 has the lower hero id, Y2 the higher.
      const [y1, y2] = (p.hero.id < q.hero.id ? [p, q] : [q, p]) as [Trader, Trader];
      await befriendSince(db(), s, y1, START);
      await befriendSince(db(), s, y2, START);
      await befriendSince(db(), y1, y2, START);
      // The higher hero's offer to S first (lower offer id), then the lower hero's.
      const oa = await t.send(y2, s, { give: { gold: 50 } });
      const ob = await t.send(y1, s, { give: { gold: 60 } });
      const trade = await t.send(y1, y2, { give: { gold: 70 } });
      for (const r of [oa, ob, trade]) expect(r.statusCode, r.body).toBe(201);
      const head = round * 3;
      const sanction = () => restrict(s.id);
      const accept = () => t.act(y2, trade.json().id, 'accept', { characterId: y2.hero.id });
      const [, accepted] =
        round % 2 === 0
          ? await Promise.all([sanction(), later(head, accept)])
          : await Promise.all([later(head, sanction), accept()]);
      expect(accepted.statusCode, accepted.body).toBe(200);
      const status = async (id: string) =>
        (await db().select().from(tradeOffers).where(eq(tradeOffers.id, id)))[0]!.status;
      expect(await status(oa.json().id)).toBe('void');
      expect(await status(ob.json().id)).toBe('void');
      expect(await status(trade.json().id)).toBe('accepted');
    }
    expect((await reconcileWithAudit(db())).filter((c) => !c.ok)).toEqual([]);
    expect(transactionStats.retries - retries).toBe(0);
  });

  it('F5: a send racing a block never leaves an open offer between a blocked pair', async () => {
    const retries = transactionStats.retries;
    for (let round = 0; round < ROUNDS; round++) {
      const a = await insertTrader(db(), START);
      const b = await insertTrader(db(), START);
      await befriendSince(db(), a, b, START);
      const head = round * 2;
      const send = () => t.send(a, b, { give: { gold: 100 } });
      const block = () =>
        app.inject({
          method: 'POST',
          url: '/api/blocks',
          payload: { handle: a.handle },
          cookies: { [SESSION_COOKIE]: b.token },
        });
      const [sent, blocked] =
        round % 2 === 0
          ? await Promise.all([send(), later(head, block)])
          : await Promise.all([later(head, send), block()]);
      expect(blocked.statusCode, blocked.body).toBe(200);
      // 404 when the block landed first: a player who blocks you reads as unknown.
      expect([201, 404, 409], sent.body).toContain(sent.statusCode);
      const open = await db()
        .select()
        .from(tradeOffers)
        .where(
          and(
            eq(tradeOffers.status, 'open'),
            or(eq(tradeOffers.senderAccountId, a.id), eq(tradeOffers.receiverAccountId, a.id)),
          ),
        );
      expect(open, `round ${round}`).toEqual([]);
    }
    expect((await reconcileWithAudit(db())).filter((c) => !c.ok)).toEqual([]);
    expect(transactionStats.retries - retries).toBe(0);
  });
});
