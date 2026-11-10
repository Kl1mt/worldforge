/**
 * Trade offers (ticket T.5, docs/TRADING.md "T.5 as built" and "Test strategy"): the lifecycle
 * matrix (send, cancel, decline, expire, accept, void) with escrow conservation, the swap (all or
 * nothing, binding, counters), the 72-hour hold and its release on an injected clock, idempotency,
 * provenance flags, the inbox and its ETag, and value reconciliation. Seeds don't matter here:
 * nothing random runs (heroes are idle, so settling them changes nothing).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { DEFAULT_TRADING_SETTINGS, type MaterialId } from '@worldforge/game-core';
import { buildApp } from '../app.js';
import {
  auditLog,
  characterMaterials,
  characters,
  itemInstances,
  tradeCounters,
  tradeHolds,
  tradeOffers,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { createTestDatabase } from '../test/db.js';
import {
  ALL_TRADING_ON,
  befriendSince,
  giveMaterials,
  insertTradeItem,
  insertTrader,
  setTradingSettings,
  tradeCalls,
  type Trader,
} from '../test/trading.js';
import { reconcileWithAudit } from '../telemetry/report.js';
import { withTransaction } from '../db/transaction.js';
import { voidForDeletion } from './offers.js';

const HOUR = 3_600_000;
const START = new Date('2031-03-05T10:00:00.000Z');
let clock = START;
const now = () => clock;

let database: DatabaseHandle;
let app: FastifyInstance;
let t: ReturnType<typeof tradeCalls>;

beforeAll(async () => {
  database = await createTestDatabase();
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
});

afterAll(async () => {
  await app?.close();
  await database?.close();
});

beforeEach(async () => {
  clock = START;
  await setTradingSettings(app, database.db, ALL_TRADING_ON);
});

const db = () => database.db;

async function pair(): Promise<[Trader, Trader]> {
  const a = await insertTrader(db(), clock);
  const b = await insertTrader(db(), clock);
  await befriendSince(db(), a, b, clock);
  return [a, b];
}

async function hero(id: string) {
  const [h] = await db().select().from(characters).where(eq(characters.id, id));
  return h!;
}

async function item(id: string) {
  const [i] = await db().select().from(itemInstances).where(eq(itemInstances.id, id));
  return i;
}

async function stock(heroId: string, materialId: MaterialId) {
  const [r] = await db()
    .select()
    .from(characterMaterials)
    .where(
      and(
        eq(characterMaterials.characterId, heroId),
        eq(characterMaterials.materialId, materialId),
      ),
    );
  return r?.quantity ?? 0;
}

async function events(event: string) {
  return db().select().from(auditLog).where(eq(auditLog.event, event));
}

async function expectReconciled() {
  const checks = await reconcileWithAudit(db());
  expect(checks.filter((c) => !c.ok)).toEqual([]);
}

/** Sends A → B a gift of an Epic, 500 gold and 20 timber; returns the offer id. */
async function sendGift(a: Trader, b: Trader) {
  const epic = await insertTradeItem(db(), a.hero.id);
  await giveMaterials(db(), a.hero.id, { timber: 50 });
  const res = await t.send(a, b, {
    give: { itemIds: [epic.id], gold: 500, materials: { timber: 20 } },
  });
  expect(res.statusCode, res.body).toBe(201);
  return { offerId: res.json().id as string, epic };
}

describe('closed by default', () => {
  it('refuses every offer while the master switch is off, and the inbox says so', async () => {
    const [a, b] = await pair();
    await setTradingSettings(app, db(), structuredClone(DEFAULT_TRADING_SETTINGS));
    const epic = await insertTradeItem(db(), a.hero.id);
    const res = await t.send(a, b, { give: { itemIds: [epic.id] } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('trade_refused');
    expect(res.json().error.details.reasons.map((r: { check: string }) => r.check)).toContain(
      'trading_off',
    );
    const inbox = await t.get(a, '/api/trading/offers');
    expect(inbox.json()).toMatchObject({ open: false, received: [], sent: [] });
    expect((await item(epic.id))!.escrowOfferId).toBeNull();
  });
});

describe('send and escrow', () => {
  it('moves the sender’s side into escrow, out of reach of everything else', async () => {
    const [a, b] = await pair();
    const { offerId, epic } = await sendGift(a, b);
    expect((await item(epic.id))!.escrowOfferId).toBe(offerId);
    expect((await hero(a.hero.id)).gold).toBe(9_500);
    expect(await stock(a.hero.id, 'timber')).toBe(30);
    // Out of the pack.
    const inv = await t.get(a, `/api/characters/${a.hero.id}/inventory`);
    expect(JSON.stringify(inv.json())).not.toContain(epic.id);
    // Sell, salvage, equip, lock, discard, warehouse, shelf, a second offer: all refused.
    const key = { 'idempotency-key': crypto.randomUUID() };
    const cookie = { wf_session: a.token };
    const tries = [
      ['POST', `/api/characters/${a.hero.id}/merchant/sell`, { itemIds: [epic.id] }],
      ['POST', `/api/characters/${a.hero.id}/forge/salvage`, { itemIds: [epic.id] }],
      ['POST', `/api/characters/${a.hero.id}/items/${epic.id}/equip`, {}],
      ['POST', `/api/characters/${a.hero.id}/items/${epic.id}/lock`, {}],
      ['POST', `/api/characters/${a.hero.id}/shelf/deposit`, { itemIds: [epic.id] }],
    ] as const;
    for (const [method, url, payload] of tries) {
      const res = await app.inject({ method, url, payload, headers: key, cookies: cookie });
      expect([404, 409], `${url}: ${res.body}`).toContain(res.statusCode);
      if (res.statusCode === 409)
        expect(['item_in_offer', 'warehouse_closed']).toContain(res.json().error.code);
    }
    const discard = await app.inject({
      method: 'DELETE',
      url: `/api/characters/${a.hero.id}/items/${epic.id}`,
      cookies: cookie,
    });
    expect(discard.statusCode).toBe(409);
    expect(discard.json().error.code).toBe('item_in_offer');
    const again = await t.send(a, b, { give: { itemIds: [epic.id] } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('item_in_offer');
    expect((await item(epic.id))!.escrowOfferId).toBe(offerId);
    await expectReconciled();
  });

  it('shows the offer in both inboxes, with an ETag', async () => {
    const [a, b] = await pair();
    const { offerId } = await sendGift(a, b);
    const inbox = await t.get(b, '/api/trading/offers');
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json().received.map((o: { id: string }) => o.id)).toEqual([offerId]);
    expect(inbox.json().received[0]).toMatchObject({
      role: 'receiver',
      gift: true,
      with: { handle: a.handle },
      give: { gold: 500, materials: [{ materialId: 'timber', quantity: 20 }] },
    });
    const etag = inbox.headers.etag as string;
    const again = await t.get(b, '/api/trading/offers', { 'if-none-match': etag });
    expect(again.statusCode).toBe(304);
    const sent = await t.get(a, '/api/trading/offers');
    expect(sent.json().sent[0].id).toBe(offerId);
  });

  it('needs an Idempotency-Key and replays the stored answer', async () => {
    const [a, b] = await pair();
    const epic = await insertTradeItem(db(), a.hero.id);
    const none = await t.send(a, b, { give: { itemIds: [epic.id] } }, null);
    expect(none.statusCode).toBe(400);
    const key = crypto.randomUUID();
    const first = await t.send(a, b, { give: { itemIds: [epic.id] } }, key);
    const replay = await t.send(a, b, { give: { itemIds: [epic.id] } }, key);
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json().id).toBe(first.json().id);
    expect(
      await events('trade.offer').then((r) => r.filter((e) => e.accountId === a.id)),
    ).toHaveLength(1);
  });

  it('refuses a stranger, a blocked or unknown player, and someone’s items you can’t see', async () => {
    const a = await insertTrader(db(), clock);
    const stranger = await insertTrader(db(), clock);
    const epic = await insertTradeItem(db(), a.hero.id);
    const res = await t.send(a, stranger, { give: { itemIds: [epic.id] } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details.reasons[0].check).toBe('no_relation');
    const unknown = await t.send(a, { ...stranger, handle: 'zzzzzzzzzzzz' }, { give: { gold: 1 } });
    expect(unknown.statusCode).toBe(404);
  });

  it('refuses an unprovenanced item and flags it', async () => {
    const [a, b] = await pair();
    const dupe = await insertTradeItem(db(), a.hero.id, { unprovenanced: true });
    const res = await t.send(a, b, { give: { itemIds: [dupe.id] } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details.reasons.map((r: { check: string }) => r.check)).toContain(
      'item_unprovenanced',
    );
    const flags = (await events('trade.flag')).filter((e) => e.accountId === a.id);
    expect(flags.map((f) => (f.data as { itemId: string }).itemId)).toEqual([dupe.id]);
  });

  it('refuses held gold and materials, and gold beyond the purse', async () => {
    const [a, b] = await pair();
    const res = await t.send(a, b, { give: { gold: 20_000 } });
    expect(res.statusCode).toBe(409); // over the 5,000 per offer
    const poor = await t.send(a, b, { give: { gold: 5_000 } });
    expect(poor.statusCode).toBe(201);
    expect((await t.send(a, b, { give: { gold: 5_000 } })).statusCode).toBe(201);
    const empty = await t.send(a, b, { give: { gold: 1 } });
    expect(empty.statusCode).toBe(422);
    expect(empty.json().error.code).toBe('insufficient_gold');
  });

  it('keeps to the open-offer limits (3 sent)', async () => {
    const [a, b] = await pair();
    for (let i = 0; i < 3; i++)
      expect((await t.send(a, b, { give: { gold: 10 } })).statusCode).toBe(201);
    const fourth = await t.send(a, b, { give: { gold: 10 } });
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json().error).toMatchObject({
      code: 'open_offer_limit',
      details: { party: 'you' },
    });
  });
});

describe('ending without a trade', () => {
  for (const end of ['cancel', 'decline', 'expire'] as const) {
    it(`${end}: everything goes back to the sender, nothing is held`, async () => {
      const [a, b] = await pair();
      const { offerId, epic } = await sendGift(a, b);
      // Only the right party may act; anyone else is told the offer doesn't exist.
      const wrong = end === 'decline' ? a : b;
      if (end !== 'expire') {
        const res = await t.act(wrong, offerId, end);
        expect(res.statusCode).toBe(404);
      }
      if (end === 'expire') {
        clock = new Date(START.getTime() + 48 * HOUR);
        // Accepting after 48 hours is refused; the inbox's sweep expires it.
        const late = await t.act(b, offerId, 'accept', { characterId: b.hero.id });
        expect(late.statusCode).toBe(409);
        expect(late.json().error.code).toBe('offer_expired');
        await t.get(b, '/api/trading/offers');
      } else {
        const res = await t.act(end === 'cancel' ? a : b, offerId, end);
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json().status).toBe(end === 'cancel' ? 'cancelled' : 'declined');
        expect(res.json().endText).toMatch(/went back to the sender/);
      }
      const [offer] = await db().select().from(tradeOffers).where(eq(tradeOffers.id, offerId));
      expect(offer!.status).toBe(
        { cancel: 'cancelled', decline: 'declined', expire: 'expired' }[end],
      );
      expect((await item(epic.id))!).toMatchObject({
        escrowOfferId: null,
        characterId: a.hero.id,
        tradedCount: 0,
        holdUntil: null,
      });
      expect((await hero(a.hero.id)).gold).toBe(10_000);
      expect(await stock(a.hero.id, 'timber')).toBe(50);
      expect((await hero(b.hero.id)).gold).toBe(10_000);
      expect(await db().select().from(tradeHolds).where(eq(tradeHolds.offerId, offerId))).toEqual(
        [],
      );
      const rows = (await events(`trade.${end}`)).filter(
        (e) => (e.data as { offerId: string }).offerId === offerId,
      );
      expect(rows).toHaveLength(1);
      // A second ending of any kind is refused.
      const twice = await t.act(a, offerId, 'cancel');
      expect(twice.statusCode).toBe(409);
      expect(twice.json().error.code).toBe('offer_closed');
      await expectReconciled();
    });
  }
});

describe('accept: the swap', () => {
  it('a gift: items, gold and materials change hands, bound to the new account and held', async () => {
    const [a, b] = await pair();
    const { offerId, epic } = await sendGift(a, b);
    const res = await t.act(b, offerId, 'accept', { characterId: b.hero.id });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: 'accepted', gift: true });
    const until = new Date(START.getTime() + 72 * HOUR);
    expect(res.json().heldUntil).toBe(until.toISOString());
    expect((await item(epic.id))!).toMatchObject({
      characterId: b.hero.id,
      escrowOfferId: null,
      binding: 'account',
      boundAccountId: b.id,
      tradedCount: 1,
      holdUntil: until,
    });
    expect((await hero(a.hero.id)).gold).toBe(9_500);
    expect((await hero(b.hero.id)).gold).toBe(10_500);
    expect(await stock(b.hero.id, 'timber')).toBe(20);
    const holds = await db().select().from(tradeHolds).where(eq(tradeHolds.offerId, offerId));
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({
      characterId: b.hero.id,
      gold: 500,
      materials: { timber: 20 },
      itemIds: [epic.id],
    });
    // T.4's counters: one trade each, an Epic and gold and materials given / received.
    const counters = await db()
      .select()
      .from(tradeCounters)
      .where(eq(tradeCounters.accountId, b.id));
    const got = Object.fromEntries(counters.map((c) => [`${c.metric}:${c.direction}`, c.amount]));
    expect(got).toMatchObject({
      'trades:any': 1,
      'epic:received': 1,
      'gold:received': 500,
      'commonMaterials:received': 20,
    });
    expect(
      (await events('trade.accept')).filter(
        (e) => (e.data as { offerId: string }).offerId === offerId,
      ),
    ).toHaveLength(1);
    await expectReconciled();
  });

  it('a swap: the receiver’s side is taken at accept, all or nothing', async () => {
    const [a, b] = await pair();
    const mine = await insertTradeItem(db(), a.hero.id, { rarityId: 'legendary' });
    const theirs = await insertTradeItem(db(), b.hero.id, { rarityId: 'epic' });
    await giveMaterials(db(), b.hero.id, { ironOre: 10 });
    const sent = await t.send(a, b, {
      give: { itemIds: [mine.id] },
      ask: { itemIds: [theirs.id], gold: 300, materials: { ironOre: 10 } },
      receiverCharacterId: b.hero.id,
    });
    expect(sent.statusCode, sent.body).toBe(201);
    // The receiver's side stays with them until the accept.
    expect((await item(theirs.id))!.escrowOfferId).toBeNull();
    // Short of gold: refused, nothing moves.
    await db().update(characters).set({ gold: 100 }).where(eq(characters.id, b.hero.id));
    const short = await t.act(b, sent.json().id, 'accept', {});
    expect(short.statusCode).toBe(422);
    expect((await item(mine.id))!.characterId).toBe(a.hero.id);
    expect((await item(theirs.id))!.characterId).toBe(b.hero.id);
    expect(await stock(b.hero.id, 'ironOre')).toBe(10);
    expect(
      await db().select().from(tradeCounters).where(eq(tradeCounters.accountId, b.id)),
    ).toEqual([]);
    await db().update(characters).set({ gold: 1_000 }).where(eq(characters.id, b.hero.id));
    const ok = await t.act(b, sent.json().id, 'accept', {});
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().gift).toBe(false);
    expect((await item(mine.id))!).toMatchObject({
      characterId: b.hero.id,
      tradedCount: 1,
      boundAccountId: b.id,
    });
    expect((await item(theirs.id))!).toMatchObject({
      characterId: a.hero.id,
      tradedCount: 1,
      boundAccountId: a.id,
    });
    expect((await hero(a.hero.id)).gold).toBe(10_300);
    expect((await hero(b.hero.id)).gold).toBe(700);
    expect(await stock(a.hero.id, 'ironOre')).toBe(10);
    expect(await stock(b.hero.id, 'ironOre')).toBe(0);
    const holds = await db()
      .select()
      .from(tradeHolds)
      .where(eq(tradeHolds.offerId, sent.json().id));
    expect(holds.map((h) => [h.characterId, h.gold]).sort()).toEqual(
      [
        [a.hero.id, 300],
        [b.hero.id, 0],
      ].sort(),
    );
    await expectReconciled();
  });

  it('re-checks the receiver’s items at accept (locked or gone)', async () => {
    const [a, b] = await pair();
    const theirs = await insertTradeItem(db(), b.hero.id);
    const sent = await t.send(a, b, {
      give: { gold: 100 },
      ask: { itemIds: [theirs.id] },
      receiverCharacterId: b.hero.id,
    });
    await db().update(itemInstances).set({ locked: true }).where(eq(itemInstances.id, theirs.id));
    const locked = await t.act(b, sent.json().id, 'accept', {});
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error.details.reasons.map((r: { check: string }) => r.check)).toContain(
      'item_locked',
    );
    await db().delete(itemInstances).where(eq(itemInstances.id, theirs.id));
    const gone = await t.act(b, sent.json().id, 'accept', {});
    expect(gone.statusCode).toBe(409);
    expect(gone.json().error.code).toBe('item_gone');
  });

  it('a double accept trades once; a replay returns the same answer', async () => {
    const [a, b] = await pair();
    const { offerId } = await sendGift(a, b);
    const key = crypto.randomUUID();
    const first = await t.act(b, offerId, 'accept', { characterId: b.hero.id }, key);
    const replay = await t.act(b, offerId, 'accept', { characterId: b.hero.id }, key);
    const second = await t.act(b, offerId, 'accept', { characterId: b.hero.id });
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(second.statusCode).toBe(409);
    expect((await hero(b.hero.id)).gold).toBe(10_500);
  });

  it('a traded item can’t be traded again (bound), and lowering a limit refuses at accept', async () => {
    const [a, b] = await pair();
    const { offerId, epic } = await sendGift(a, b);
    await setTradingSettings(app, db(), {
      ...ALL_TRADING_ON,
      limits: { ...ALL_TRADING_ON.limits, epicPerWeek: 0 },
    });
    const capped = await t.act(b, offerId, 'accept', { characterId: b.hero.id });
    expect(capped.statusCode).toBe(409);
    expect(capped.json().error.code).toBe('trade_cap_reached');
    const [still] = await db().select().from(tradeOffers).where(eq(tradeOffers.id, offerId));
    expect(still!.status).toBe('open'); // lowering a limit never voids
    await setTradingSettings(app, db(), ALL_TRADING_ON);
    expect((await t.act(b, offerId, 'accept', { characterId: b.hero.id })).statusCode).toBe(200);
    clock = new Date(START.getTime() + 100 * HOUR);
    const c = await insertTrader(db(), clock);
    await befriendSince(db(), b, c, clock);
    const resale = await t.send(b, c, { give: { itemIds: [epic.id] } });
    expect(resale.statusCode).toBe(409);
    expect(resale.json().error.details.reasons.map((r: { check: string }) => r.check)).toContain(
      'item_bound',
    );
  });
});

describe('the 72-hour hold', () => {
  it('held items can be worn, not sold or salvaged; held gold can’t be spent or sent; release once', async () => {
    const [a, b] = await pair();
    const { offerId, epic } = await sendGift(a, b);
    await t.act(b, offerId, 'accept', { characterId: b.hero.id });
    const cookie = { wf_session: b.token };
    const key = () => ({ 'idempotency-key': crypto.randomUUID() });
    const sell = await app.inject({
      method: 'POST',
      url: `/api/characters/${b.hero.id}/merchant/sell`,
      payload: { itemIds: [epic.id] },
      headers: key(),
      cookies: cookie,
    });
    expect(sell.statusCode).toBe(409);
    expect(sell.json().error.code).toBe('item_held');
    const salvage = await app.inject({
      method: 'POST',
      url: `/api/characters/${b.hero.id}/forge/salvage`,
      payload: { itemIds: [epic.id] },
      headers: key(),
      cookies: cookie,
    });
    expect(salvage.json().error.code).toBe('item_held');
    const discard = await app.inject({
      method: 'DELETE',
      url: `/api/characters/${b.hero.id}/items/${epic.id}`,
      cookies: cookie,
    });
    expect(discard.json().error.code).toBe('item_held');
    // Held gold: b has 10,500 of which 500 held; sending 5,000 twice is fine, the third (500) not.
    const c = await insertTrader(db(), clock);
    await befriendSince(db(), b, c, clock);
    expect((await t.send(b, c, { give: { gold: 5_000 } })).statusCode).toBe(201);
    expect((await t.send(b, c, { give: { gold: 5_000 } })).statusCode).toBe(201);
    const held = await t.send(b, c, { give: { gold: 500 } });
    expect(held.statusCode).toBe(422);
    expect(held.json().error.details).toMatchObject({ onHold: 500, spendable: 0 });
    const timber = await t.send(b, c, { give: { materials: { timber: 1 } } });
    expect(timber.json().error.code).toBe('insufficient_materials');
    // The inbox shows the hold.
    const inbox = await t.get(b, '/api/trading/offers');
    expect(inbox.json().holds).toEqual([
      expect.objectContaining({ characterId: b.hero.id, gold: 500, items: 1 }),
    ]);
    // 72 hours later: released exactly once, and spendable.
    clock = new Date(START.getTime() + 72 * HOUR);
    await t.get(b, '/api/trading/offers');
    await t.get(b, '/api/trading/offers');
    const releases = (await events('trade.release')).filter((e) => e.accountId === b.id);
    expect(releases).toHaveLength(1);
    const after = await t.send(b, c, { give: { gold: 500 } });
    expect(after.statusCode, after.body).toBe(201);
    await expectReconciled();
  });
});

describe('voiding', () => {
  const offerOf = async (id: string) =>
    (await db().select().from(tradeOffers).where(eq(tradeOffers.id, id)))[0]!;

  it('a switch turned off voids the offers it closes and only those', async () => {
    const [a, b] = await pair();
    const gold = await t.send(a, b, { give: { gold: 100 } });
    const epic = await insertTradeItem(db(), a.hero.id);
    const items = await t.send(a, b, { give: { itemIds: [epic.id] } });
    // The listener runs in the saving transaction; call it the way the admin route does.
    const { updateTradingSettings, loadGameSettings } = await import('../settings/store.js');
    const { trading } = await loadGameSettings(db());
    await withTransaction(db(), (tx) =>
      updateTradingSettings(tx, {
        settings: { ...ALL_TRADING_ON, trade: { ...ALL_TRADING_ON.trade, gold: false } },
        expectedVersion: trading.version,
        actorAccountId: a.id,
        now: clock,
        events: app.settingsEvents,
      }),
    );
    expect((await offerOf(gold.json().id)).status).toBe('void');
    expect((await offerOf(gold.json().id)).voidReason).toBe('switch');
    expect((await offerOf(items.json().id)).status).toBe('open');
    expect((await hero(a.hero.id)).gold).toBe(10_000);
    const detail = await t.get(b, `/api/trading/offers/${gold.json().id}`);
    expect(detail.json().offer.endText).toBe(
      'This offer was withdrawn: trading of gold is paused. Everything in it went back to the sender.',
    );
    await expectReconciled();
  });

  it('"Tradeable: Prismatic" gates Prismatic items alone, voids them when turned off, and counts toward the Mythic/Void week (ticket 6.4)', async () => {
    const [a, b] = await pair();
    const prism = await insertTradeItem(db(), a.hero.id, {
      rarityId: 'legendary',
      variant: 'prismatic',
    });
    const voided = await insertTradeItem(db(), a.hero.id, {
      rarityId: 'legendary',
      variant: 'void',
    });
    // Off (the default for this switch): the Prismatic item is refused, the Void one is not.
    await setTradingSettings(app, db(), {
      ...ALL_TRADING_ON,
      tradeable: { ...ALL_TRADING_ON.tradeable, prismatic: false },
    });
    const refused = await t.send(a, b, { give: { itemIds: [prism.id] } });
    expect(refused.statusCode).toBeGreaterThanOrEqual(400);
    expect(refused.json().error.details.reasons).toEqual([
      expect.objectContaining({ check: 'item_category_off', itemId: prism.id }),
    ]);
    const voidOffer = await t.send(a, b, { give: { itemIds: [voided.id] } });
    expect(voidOffer.statusCode, voidOffer.body).toBe(201);

    // On: it can be offered; turned off again, only its offer is voided.
    await setTradingSettings(app, db(), ALL_TRADING_ON);
    const sent = await t.send(a, b, { give: { itemIds: [prism.id] } });
    expect(sent.statusCode, sent.body).toBe(201);
    const { updateTradingSettings, loadGameSettings } = await import('../settings/store.js');
    const { trading } = await loadGameSettings(db());
    await withTransaction(db(), (tx) =>
      updateTradingSettings(tx, {
        settings: {
          ...ALL_TRADING_ON,
          tradeable: { ...ALL_TRADING_ON.tradeable, prismatic: false },
        },
        expectedVersion: trading.version,
        actorAccountId: a.id,
        now: clock,
        events: app.settingsEvents,
      }),
    );
    expect((await offerOf(sent.json().id)).status).toBe('void');
    expect((await offerOf(sent.json().id)).voidReason).toBe('switch');
    expect((await offerOf(voidOffer.json().id)).status).toBe('open');
    // The escrowed item is back with its sender, still Prismatic.
    expect((await item(prism.id))!.characterId).toBe(a.hero.id);
    expect((await item(prism.id))!.variant).toBe('prismatic');
    await expectReconciled();
  });

  it('a Prismatic item counts toward "Mythic, Void or Prismatic items per week" (ticket 6.4)', async () => {
    const [a, b] = await pair();
    await setTradingSettings(app, db(), {
      ...ALL_TRADING_ON,
      limits: { ...ALL_TRADING_ON.limits, mythicVoidPerWeek: 0 },
    });
    const prism = await insertTradeItem(db(), a.hero.id, {
      rarityId: 'legendary',
      variant: 'prismatic',
    });
    const res = await t.send(a, b, { give: { itemIds: [prism.id] } });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).toContain('mythicVoid');
  });

  it('a block, an unfriend, a trade restriction and a suspension void; a mute doesn’t', async () => {
    const { sanctions } = await import('../db/schema.js');
    for (const trigger of ['block', 'unfriend', 'trade', 'suspend', 'mute'] as const) {
      const [a, b] = await pair();
      const sent = await t.send(a, b, { give: { gold: 100 } });
      expect(sent.statusCode).toBe(201);
      if (trigger === 'block' || trigger === 'unfriend') {
        const res = await app.inject({
          method: 'POST',
          url: trigger === 'block' ? '/api/blocks' : `/api/friends/${a.handle}/remove`,
          ...(trigger === 'block' ? { payload: { handle: a.handle } } : {}),
          cookies: { wf_session: b.token },
        });
        expect(res.statusCode, res.body).toBe(200);
      } else {
        // The sanction seam, as the moderator route calls it (the route itself is T.4's test).
        await withTransaction(db(), async (tx) => {
          await tx.insert(sanctions).values({
            id: crypto.randomUUID(),
            subjectId: b.id,
            kind: trigger,
            reason: 'Test',
            createdAt: clock,
            expiresAt: new Date(clock.getTime() + 24 * HOUR),
          });
          await app.sanctionEvents.emit(
            {
              sanction: {} as never,
              kind: trigger,
              subjectId: b.id,
              actorAccountId: a.id,
              at: clock,
            },
            tx,
          );
        });
      }
      const o = await offerOf(sent.json().id);
      expect(o.status, trigger).toBe(trigger === 'mute' ? 'open' : 'void');
      if (trigger !== 'mute') {
        expect(o.voidReason).toBe(
          trigger === 'block' ? 'block' : trigger === 'unfriend' ? 'relation' : 'sanction',
        );
        expect((await hero(a.hero.id)).gold).toBe(10_000);
      }
    }
    await expectReconciled();
  });

  it('the deletion seam voids a hero’s open offers', async () => {
    const [a, b] = await pair();
    const sent = await t.send(a, b, { give: { gold: 100 } });
    await withTransaction(db(), (tx) =>
      voidForDeletion(tx, a.hero.id, clock, { ...DEFAULT_ACTIVITY_OPTIONS, now }),
    );
    expect((await offerOf(sent.json().id)).voidReason).toBe('deletion');
    expect((await hero(a.hero.id)).gold).toBe(10_000);
  });
});

describe('history and reconciliation', () => {
  it('lists ended offers newest first, paged', async () => {
    const [a, b] = await pair();
    for (let i = 0; i < 3; i++) {
      const s = await t.send(a, b, { give: { gold: 10 } });
      await t.act(a, s.json().id, 'cancel');
    }
    const page = await t.get(a, '/api/trading/offers/history');
    expect(page.json().offers).toHaveLength(3);
    expect(page.json().offers.every((o: { status: string }) => o.status === 'cancelled')).toBe(
      true,
    );
  });

  it('holds every trade in the audit log (sql sanity)', async () => {
    const n = (await db().select().from(tradeOffers)).length;
    expect(n).toBeGreaterThan(0);
    await expectReconciled();
  });
});

describe('invariance', () => {
  it('5.1 scores read worn gear only: escrow and held items change no score; held items can be worn', async () => {
    const [a, b] = await pair();
    const score = async (who: Trader) =>
      (await t.get(who, `/api/characters/${who.hero.id}/scores`)).json().scores;
    const [sa, sb] = [await score(a), await score(b)];
    const { offerId, epic } = await sendGift(a, b);
    expect(await score(a)).toEqual(sa);
    await t.act(b, offerId, 'accept', { characterId: b.hero.id });
    expect(await score(b)).toEqual(sb);
    const wear = await app.inject({
      method: 'POST',
      url: `/api/characters/${b.hero.id}/items/${epic.id}/equip`,
      payload: {},
      cookies: { wf_session: b.token },
    });
    expect(wear.statusCode, wear.body).toBe(200);
    expect((await item(epic.id))!.equippedSlot).not.toBeNull();
  });
});
