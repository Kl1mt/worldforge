/**
 * Real-PostgreSQL races for the admin tools (ticket D.4). Runs when `DATABASE_URL` is set, skipped
 * otherwise (CI sets `REQUIRE_PG_TESTS=1`). Every race runs several rounds with alternating orders
 * and growing head starts; only what holds in every order is asserted (one outcome or the other,
 * nothing lost or doubled, audit = holdings), never which racer wins, and no transaction is
 * retried (a retry would mean a lock-order problem: a deadlock).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { characters, itemInstances, tradeOffers } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { transactionStats } from '../db/transaction.js';
import { createPostgresTestDatabase } from '../test/db.js';
import { insertAccount, type TestAccount } from '../test/social.js';
import { insertCharacter, insertItem } from '../test/heroes.js';
import {
  ALL_TRADING_ON,
  befriendSince,
  insertTradeItem,
  insertTrader,
  setTradingSettings,
  tradeCalls,
  type Trader,
} from '../test/trading.js';
import { shelfCalls } from '../test/shelf.js';
import { openWarehouse } from '../test/warehouse.js';
import { reconcileWithAudit } from '../telemetry/report.js';
import { setAccountRole } from '../social/roles.js';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === '1') {
  throw new Error('REQUIRE_PG_TESTS=1 but DATABASE_URL is not set');
}

const ROUNDS = 4;
const START = new Date('2031-07-07T08:00:00.000Z');
const clock = START;
const now = () => clock;
const activity = { ...DEFAULT_ACTIVITY_OPTIONS, now };

const later = async <T>(ms: number, fn: () => Promise<T>): Promise<T> => {
  await new Promise((r) => setTimeout(r, ms));
  return fn();
};

describe.skipIf(!url)('real PostgreSQL: admin tools under races', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let t: ReturnType<typeof tradeCalls>;
  let admin: TestAccount;
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
      activity,
    });
    await app.ready();
    t = tradeCalls(app);
    await setTradingSettings(app, db(), ALL_TRADING_ON);
    await openWarehouse(app, db(), START);
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

  async function pair(): Promise<[Trader, Trader]> {
    const a = await insertTrader(db(), clock);
    const b = await insertTrader(db(), clock);
    await befriendSince(db(), a, b, clock);
    return [a, b];
  }
  async function expectReconciled() {
    expect((await reconcileWithAudit(db())).filter((c) => !c.ok)).toEqual([]);
  }
  const item = async (id: string) =>
    (await db().select().from(itemInstances).where(eq(itemInstances.id, id)))[0];

  it('hero deletion vs an accept of its offer: accepted, or voided with the escrow back', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const [a, b] = await pair();
      // The heir keeps the account's shelf rule satisfiable.
      await insertCharacter(db(), a.id);
      const epic = await insertTradeItem(db(), a.hero.id);
      const sent = await t.send(a, b, { give: { itemIds: [epic.id], gold: 300 } });
      expect(sent.statusCode, sent.body).toBe(201);
      const offerId = sent.json().id as string;
      const retries = transactionStats.retries;
      const head = round * 3;
      const accept = () => t.act(b, offerId, 'accept', { characterId: b.hero.id });
      const del = () =>
        post(admin, `/api/admin/accounts/${a.handle}/heroes/${a.hero.id}/delete`, {
          confirm: a.hero.name,
          reason: 'race test',
        });
      const [acc, gone] =
        round % 2 === 0
          ? await Promise.all([accept(), later(head, del)])
          : await Promise.all([later(head, accept), del()]);
      expect(gone.statusCode, gone.body).toBe(200);
      const [offer] = await db().select().from(tradeOffers).where(eq(tradeOffers.id, offerId));
      const row = (await item(epic.id))!;
      if (acc.statusCode === 200) {
        expect(offer!.status).toBe('accepted');
        expect(row.characterId).toBe(b.hero.id);
      } else {
        expect(acc.statusCode).toBe(409);
        expect(offer!.status).toBe('void');
        expect(row.characterId).toBe(a.hero.id);
      }
      expect(row.escrowOfferId).toBeNull();
      expect(transactionStats.retries).toBe(retries);
    }
    await expectReconciled();
  });

  it('hero deletion vs a shelf deposit: the item ends with the heir on the shelf, or in the deleted hero’s pack', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const acc = await insertAccount(db(), { now: clock });
      const doomed = await insertCharacter(db(), acc.id, { level: 10 });
      const heir = await insertCharacter(db(), acc.id, { level: 10 });
      const it = await insertItem(db(), doomed.id, { rarityId: 'epic' });
      const retries = transactionStats.retries;
      const head = round * 3;
      const deposit = () =>
        shelfCalls(app).move(acc.token, doomed.id, 'deposit', { itemIds: [it.id] });
      const del = () =>
        post(admin, `/api/admin/accounts/${acc.handle}/heroes/${doomed.id}/delete`, {
          confirm: doomed.name,
          reason: 'race test',
        });
      const [dep, gone] =
        round % 2 === 0
          ? await Promise.all([deposit(), later(head, del)])
          : await Promise.all([later(head, deposit), del()]);
      expect(gone.statusCode, gone.body).toBe(200);
      const row = (await item(it.id))!;
      if (dep.statusCode === 200) {
        expect(row).toMatchObject({ onShelf: true, characterId: heir.id });
      } else {
        expect(dep.statusCode).toBe(404);
        expect(row).toMatchObject({ onShelf: false, characterId: doomed.id });
      }
      expect(transactionStats.retries).toBe(retries);
    }
    await expectReconciled();
  });

  it('an admin grant vs a trade accept on the same hero: both land, nothing doubled', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const [a, b] = await pair();
      // The admin grants on its own account (cheat tools: own or test accounts).
      await setAccountRole(db(), b.handle, 'admin');
      const self = { ...b, role: 'admin' as const };
      const epic = await insertTradeItem(db(), a.hero.id);
      const sent = await t.send(a, b, { give: { itemIds: [epic.id] } });
      expect(sent.statusCode, sent.body).toBe(201);
      const retries = transactionStats.retries;
      const head = round * 3;
      const accept = () => t.act(b, sent.json().id, 'accept', { characterId: b.hero.id });
      const grant = () =>
        post(self, `/api/admin/accounts/${b.handle}/heroes/${b.hero.id}/items/grant`, {
          baseId: 'longsword',
          rarityId: 'rare',
          itemLevel: 12,
          variant: null,
          upgradeLevel: 0,
          seed: 99 + round,
          reason: 'race test',
        });
      const [acc, gr] =
        round % 2 === 0
          ? await Promise.all([accept(), later(head, grant)])
          : await Promise.all([later(head, accept), grant()]);
      expect(acc.statusCode, acc.body).toBe(200);
      expect(gr.statusCode, gr.body).toBe(200);
      const items = await db()
        .select()
        .from(itemInstances)
        .where(eq(itemInstances.characterId, b.hero.id));
      expect(items.map((i) => i.source).sort()).toEqual(['admin', 'farming']);
      expect(transactionStats.retries).toBe(retries);
    }
    await expectReconciled();
  });

  it('an admin removal vs a sell of the same item: exactly one of them', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const acc = await insertAccount(db(), { now: clock });
      const hero = await insertCharacter(db(), acc.id, { level: 10 });
      const it = await insertItem(db(), hero.id, { rarityId: 'rare' });
      const retries = transactionStats.retries;
      const head = round * 3;
      const sell = () =>
        post(acc, `/api/characters/${hero.id}/merchant/sell`, { itemIds: [it.id] });
      const remove = () =>
        post(admin, `/api/admin/accounts/${acc.handle}/items/${it.id}/remove`, {
          confirm: hero.name,
          reason: 'race test',
        });
      const [sold, removed] =
        round % 2 === 0
          ? await Promise.all([sell(), later(head, remove)])
          : await Promise.all([later(head, sell), remove()]);
      const codes = [sold.statusCode, removed.statusCode];
      expect(
        codes.filter((c) => c === 200),
        `${sold.body} ${removed.body}`,
      ).toHaveLength(1);
      expect(await item(it.id)).toBeUndefined();
      const [h] = await db().select().from(characters).where(eq(characters.id, hero.id));
      expect(h!.gold > 0).toBe(sold.statusCode === 200);
      expect(transactionStats.retries).toBe(retries);
    }
    await expectReconciled();
  });
});
