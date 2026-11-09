/**
 * Trade moderation (ticket T.6, docs/TRADING.md "Moderator reversal and its limits", "T.6 as
 * built" and "Test strategy"): the reversal matrix (within and after the hold; items worn, locked,
 * sold, forged, shelved, stored, moved to another hero; gold and materials partly spent; other
 * trades' holds), all or nothing, idempotency, the 14-day window, the permission matrix, a
 * sanction in the same flow, reporting a trade, the history and case views (no personal data),
 * and value reconciliation. Nothing random runs: heroes are idle, so settling changes nothing;
 * the Forge's outcome doesn't matter (any attempt binds, and the reversal refuses either way).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { type MaterialId } from '@worldforge/game-core';
import { buildApp } from '../app.js';
import {
  accounts,
  auditLog,
  characterMaterials,
  characters,
  itemInstances,
  reports,
  sanctions,
  tradeHolds,
  tradeOffers,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { createTestDatabase } from '../test/db.js';
import { insertAccount, type TestAccount } from '../test/social.js';
import { insertCharacter } from '../test/heroes.js';
import {
  ALL_TRADING_ON,
  befriendSince,
  giveMaterials,
  insertTradeItem,
  insertTrader,
  modTradeCalls,
  setTradingSettings,
  tradeCalls,
  type Trader,
} from '../test/trading.js';
import { openWarehouse } from '../test/warehouse.js';
import { reconcileWithAudit } from '../telemetry/report.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = new Date('2031-04-07T10:00:00.000Z');
let clock = START;
const now = () => clock;

let database: DatabaseHandle;
let app: FastifyInstance;
let t: ReturnType<typeof tradeCalls>;
let mod: ReturnType<typeof modTradeCalls>;
let moderator: TestAccount;
let admin: TestAccount;

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
  mod = modTradeCalls(app);
  moderator = await insertAccount(database.db, { role: 'moderator', now: START });
  admin = await insertAccount(database.db, { role: 'admin', now: START });
  await openWarehouse(app, database.db, START);
});

afterAll(async () => {
  await app?.close();
  await database?.close();
});

beforeEach(async () => {
  clock = START;
  await setTradingSettings(app, db(), ALL_TRADING_ON);
});

const db = () => database.db;

async function pair(opts: { gold?: number } = {}): Promise<[Trader, Trader]> {
  const a = await insertTrader(db(), clock, opts);
  const b = await insertTrader(db(), clock, opts);
  await befriendSince(db(), a, b, clock);
  return [a, b];
}

async function hero(id: string) {
  return (await db().select().from(characters).where(eq(characters.id, id)))[0]!;
}
async function item(id: string) {
  return (await db().select().from(itemInstances).where(eq(itemInstances.id, id)))[0];
}
async function offerRow(id: string) {
  return (await db().select().from(tradeOffers).where(eq(tradeOffers.id, id)))[0]!;
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
async function events(event: string, offerId?: string) {
  const rows = await db().select().from(auditLog).where(eq(auditLog.event, event));
  return offerId ? rows.filter((r) => (r.data as { offerId?: string }).offerId === offerId) : rows;
}
async function expectReconciled() {
  const checks = await reconcileWithAudit(db());
  expect(checks.filter((c) => !c.ok)).toEqual([]);
}
const heroCall = (
  who: Trader,
  path: string,
  payload?: object,
  method: 'POST' | 'DELETE' = 'POST',
) =>
  app.inject({
    method,
    url: `/api/characters/${who.hero.id}${path}`,
    ...(method === 'POST'
      ? { payload: payload ?? {}, headers: { 'idempotency-key': randomUUID() } }
      : {}),
    cookies: { [SESSION_COOKIE]: who.token },
  });

/** A → B: an Epic, 500 gold and 20 timber, accepted. Returns the offer id and the item. */
async function giftTrade(a: Trader, b: Trader, { gold = 500, timber = 20 } = {}) {
  const epic = await insertTradeItem(db(), a.hero.id);
  if (timber > 0) await giveMaterials(db(), a.hero.id, { timber });
  const sent = await t.send(a, b, {
    give: {
      itemIds: [epic.id],
      ...(gold > 0 ? { gold } : {}),
      ...(timber > 0 ? { materials: { timber } } : {}),
    },
  });
  expect(sent.statusCode, sent.body).toBe(201);
  const offerId = sent.json().id as string;
  const ok = await t.act(b, offerId, 'accept', { characterId: b.hero.id });
  expect(ok.statusCode, ok.body).toBe(200);
  return { offerId, epic };
}

const reasons = (res: { json: () => { error: { details: { reasons: { check: string }[] } } } }) =>
  res.json().error.details.reasons.map((r) => r.check);

describe('reversal within the hold', () => {
  it('moves everything back, restores the item as it was traded, ends the holds once', async () => {
    const [a, b] = await pair();
    const { offerId, epic } = await giftTrade(a, b);
    const aGold = (await hero(a.hero.id)).gold;
    const bGold = (await hero(b.hero.id)).gold;
    // Worn and locked during the hold: allowed, taken off and unlocked.
    expect((await heroCall(b, `/items/${epic.id}/equip`)).statusCode).toBe(200);
    expect((await heroCall(b, `/items/${epic.id}/lock`)).statusCode).toBe(200);
    expect((await item(epic.id))!.firstEquippedAt).not.toBeNull();

    clock = new Date(START.getTime() + 2 * HOUR);
    const view = await mod.get(moderator, `/api/mod/trades/${offerId}`);
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json().reversible).toMatchObject({ possible: true, canAct: true, refusals: [] });
    expect(view.json().moves.toSender).toMatchObject({
      items: [{ id: epic.id, worn: true, locked: true }],
      gold: 500,
      materials: [{ materialId: 'timber', quantity: 20 }],
    });

    const res = await mod.reverse(moderator, offerId, {
      reason: 'Stolen account, items returned.',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().case.reversal).toMatchObject({
      reason: 'Stolen account, items returned.',
      by: { handle: moderator.handle },
    });
    expect(res.json().case.reversible.refusals.map((r: { check: string }) => r.check)).toEqual([
      'already_reversed',
    ]);
    expect(await item(epic.id)).toMatchObject({
      characterId: a.hero.id,
      binding: 'equip',
      boundAccountId: null,
      tradedCount: 0,
      holdUntil: null,
      equippedSlot: null,
      locked: false,
      firstEquippedAt: null,
      escrowOfferId: null,
    });
    expect((await hero(a.hero.id)).gold).toBe(aGold + 500);
    expect((await hero(b.hero.id)).gold).toBe(bGold - 500);
    expect(await stock(b.hero.id, 'timber')).toBe(0);
    expect(await stock(a.hero.id, 'timber')).toBe(20);
    const holds = await db().select().from(tradeHolds).where(eq(tradeHolds.offerId, offerId));
    expect(holds.every((h) => h.releasedAt !== null)).toBe(true);
    const releases = await events('trade.release', offerId);
    expect(releases).toHaveLength(holds.length);
    expect(releases.every((r) => (r.data as { via?: string }).via === 'reverse')).toBe(true);
    // The sweep later finds nothing to release.
    clock = new Date(START.getTime() + 80 * HOUR);
    await t.get(b, '/api/trading/offers');
    expect(await events('trade.release', offerId)).toHaveLength(holds.length);
    // B can spend its own gold again (nothing held any more), and the item is A's to trade again.
    const inbox = await t.get(b, '/api/trading/offers');
    expect(inbox.json().holds).toEqual([]);
    expect((await item(epic.id))!.tradedCount).toBe(0);
    // Both players see it in their history, with the reason.
    for (const who of [a, b]) {
      const history = await t.get(who, '/api/trading/offers/history');
      const row = history.json().offers.find((o: { id: string }) => o.id === offerId);
      expect(row.reversal).toMatchObject({ reason: 'Stolen account, items returned.' });
      expect(row.heldUntil).toBeNull();
    }
    const [reverse] = await events('trade.reverse', offerId);
    expect(reverse!.data).toMatchObject({ kind: 'gift', by: moderator.id });
    await expectReconciled();
  });

  it('reverses a swap both ways', async () => {
    const [a, b] = await pair();
    const mine = await insertTradeItem(db(), a.hero.id);
    const theirs = await insertTradeItem(db(), b.hero.id, { rarityId: 'legendary' });
    await giveMaterials(db(), b.hero.id, { ironOre: 30 });
    const sent = await t.send(a, b, {
      give: { itemIds: [mine.id], gold: 300 },
      ask: { itemIds: [theirs.id], gold: 200, materials: { ironOre: 30 } },
      receiverCharacterId: b.hero.id,
    });
    expect(sent.statusCode, sent.body).toBe(201);
    const ok = await t.act(b, sent.json().id, 'accept', { characterId: b.hero.id });
    expect(ok.statusCode, ok.body).toBe(200);
    const res = await mod.reverse(admin, sent.json().id);
    expect(res.statusCode, res.body).toBe(200);
    expect((await item(mine.id))!.characterId).toBe(a.hero.id);
    expect((await item(theirs.id))!.characterId).toBe(b.hero.id);
    expect((await hero(a.hero.id)).gold).toBe(10_000);
    expect((await hero(b.hero.id)).gold).toBe(10_000);
    expect(await stock(b.hero.id, 'ironOre')).toBe(30);
    expect(await stock(a.hero.id, 'ironOre')).toBe(0);
    await expectReconciled();
  });
});

describe('reversal after the hold: what has moved on', () => {
  const AFTER = () => new Date(START.getTime() + 73 * HOUR);

  it('allows an item worn after the hold', async () => {
    const [a, b] = await pair();
    const { offerId, epic } = await giftTrade(a, b, { gold: 0, timber: 0 });
    clock = AFTER();
    expect((await heroCall(b, `/items/${epic.id}/equip`)).statusCode).toBe(200);
    const res = await mod.reverse(moderator, offerId);
    expect(res.statusCode, res.body).toBe(200);
    expect(await item(epic.id)).toMatchObject({ characterId: a.hero.id, equippedSlot: null });
  });

  for (const [name, act, check] of [
    [
      'sold',
      (b: Trader, id: string) => heroCall(b, '/merchant/sell', { itemIds: [id] }),
      'item_gone',
    ],
    [
      'salvaged',
      (b: Trader, id: string) => heroCall(b, '/forge/salvage', { itemIds: [id] }),
      'item_gone',
    ],
    [
      'discarded',
      (b: Trader, id: string) => heroCall(b, `/items/${id}`, undefined, 'DELETE'),
      'item_gone',
    ],
    [
      'in the warehouse',
      (b: Trader, id: string) => heroCall(b, '/warehouse/deposit', { itemIds: [id] }),
      'item_in_warehouse',
    ],
    [
      'on the shelf',
      (b: Trader, id: string) => heroCall(b, '/shelf/deposit', { itemIds: [id] }),
      'item_on_shelf',
    ],
  ] as const) {
    it(`refuses an item ${name} after the hold, and changes nothing`, async () => {
      const [a, b] = await pair();
      const { offerId, epic } = await giftTrade(a, b, { gold: 0, timber: 0 });
      clock = AFTER();
      const done = await act(b, epic.id);
      expect(done.statusCode, done.body).toBeLessThan(300);
      const before = {
        a: await hero(a.hero.id),
        b: await hero(b.hero.id),
        item: await item(epic.id),
      };
      const res = await mod.reverse(moderator, offerId);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe('trade_not_reversible');
      expect(reasons(res)).toEqual([check]);
      expect(res.json().error.details.reasons[0].text).toMatch(/\w/);
      expect((await hero(a.hero.id)).gold).toBe(before.a.gold);
      expect((await hero(b.hero.id)).gold).toBe(before.b.gold);
      expect(await item(epic.id)).toEqual(before.item);
      expect((await offerRow(offerId)).reversedAt).toBeNull();
      expect(await events('trade.reverse', offerId)).toEqual([]);
      // The case view says the same before anyone tries.
      const view = await mod.get(moderator, `/api/mod/trades/${offerId}`);
      expect(view.json().reversible.possible).toBe(false);
      expect(view.json().reversible.refusals.map((r: { check: string }) => r.check)).toEqual([
        check,
      ]);
    });
  }

  it('refuses an item worked at the Forge after the hold', async () => {
    const [a, b] = await pair();
    const { offerId, epic } = await giftTrade(a, b, { gold: 0, timber: 0 });
    clock = AFTER();
    await giveMaterials(db(), b.hero.id, {
      timber: 500,
      ashwort: 500,
      rawHide: 500,
      ironOre: 500,
      soulShard: 500,
      abbeySilver: 50,
    });
    await db().update(characters).set({ gold: 1_000_000 }).where(eq(characters.id, b.hero.id));
    const forged = await heroCall(b, '/forge/upgrade', { itemId: epic.id });
    expect(forged.statusCode, forged.body).toBe(200);
    const res = await mod.reverse(moderator, offerId);
    expect(res.statusCode).toBe(409);
    expect(reasons(res)).toEqual(['item_forged']);
    expect((await item(epic.id))!.characterId).toBe(b.hero.id);
  });

  it('refuses an item another hero of the account took off the shelf', async () => {
    const [a, b] = await pair();
    const { offerId, epic } = await giftTrade(a, b, { gold: 0, timber: 0 });
    clock = AFTER();
    const second = await insertCharacter(db(), b.id, { level: 20 });
    expect((await heroCall(b, '/shelf/deposit', { itemIds: [epic.id] })).statusCode).toBe(200);
    const out = await app.inject({
      method: 'POST',
      url: `/api/characters/${second.id}/shelf/withdraw`,
      payload: { itemIds: [epic.id] },
      headers: { 'idempotency-key': randomUUID() },
      cookies: { [SESSION_COOKIE]: b.token },
    });
    expect(out.statusCode, out.body).toBe(200);
    const res = await mod.reverse(moderator, offerId);
    expect(reasons(res)).toEqual(['item_moved']);
  });

  it('refuses when the gold or materials were partly spent, listing every reason', async () => {
    const [a, b] = await pair({ gold: 0 });
    await db().update(characters).set({ gold: 1_000 }).where(eq(characters.id, a.hero.id));
    const { offerId, epic } = await giftTrade(a, b, { gold: 800, timber: 20 });
    clock = AFTER();
    // B spends part of both: 300 gold on a shelf deposit, 5 timber likewise.
    const spent = await heroCall(b, '/shelf/deposit', { gold: 300, materials: { timber: 5 } });
    expect(spent.statusCode, spent.body).toBe(200);
    const res = await mod.reverse(moderator, offerId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details.reasons).toEqual([
      expect.objectContaining({
        check: 'gold_spent',
        party: 'receiver',
        received: 800,
        available: 500,
      }),
      expect.objectContaining({
        check: 'materials_spent',
        party: 'receiver',
        materialId: 'timber',
        received: 20,
        available: 15,
      }),
    ]);
    // All or nothing: the item stays with B too.
    expect((await item(epic.id))!.characterId).toBe(b.hero.id);
    // Topped up again, the reversal goes through.
    await db().update(characters).set({ gold: 800 }).where(eq(characters.id, b.hero.id));
    await giveMaterials(db(), b.hero.id, { timber: 5 });
    const again = await mod.reverse(moderator, offerId);
    expect(again.statusCode, again.body).toBe(200);
  });

  it('never pays a reversal out of another trade’s held gold', async () => {
    const [a, b] = await pair({ gold: 0 });
    await db().update(characters).set({ gold: 2_000 }).where(eq(characters.id, a.hero.id));
    const first = await giftTrade(a, b, { gold: 500, timber: 0 });
    clock = AFTER();
    // B spends 300 of the first gift, then receives a second gift (held).
    await db().update(characters).set({ gold: 200 }).where(eq(characters.id, b.hero.id));
    const second = await giftTrade(a, b, { gold: 500, timber: 0 });
    expect((await hero(b.hero.id)).gold).toBe(700);
    const res = await mod.reverse(moderator, first.offerId);
    expect(res.json().error.details.reasons).toEqual([
      expect.objectContaining({ check: 'gold_spent', received: 500, available: 200 }),
    ]);
    // The second (held) trade is reversible: its own hold doesn't block it.
    const ok = await mod.reverse(moderator, second.offerId);
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await hero(b.hero.id)).gold).toBe(200);
  });
});

describe('the window, the state and idempotency', () => {
  it('is open for exactly 14 days after the accept', async () => {
    const [a, b] = await pair();
    const late = await giftTrade(a, b, { gold: 0, timber: 0 });
    const inTime = await giftTrade(a, b, { gold: 0, timber: 0 });
    clock = new Date(START.getTime() + 14 * DAY);
    const res = await mod.reverse(moderator, late.offerId);
    expect(res.statusCode).toBe(409);
    expect(reasons(res)).toEqual(['too_old']);
    clock = new Date(START.getTime() + 14 * DAY - 1);
    expect((await mod.reverse(moderator, inTime.offerId)).statusCode).toBe(200);
  });

  it('refuses an offer that never completed', async () => {
    const [a, b] = await pair();
    const epic = await insertTradeItem(db(), a.hero.id);
    const sent = await t.send(a, b, { give: { itemIds: [epic.id] } });
    const open = await mod.reverse(moderator, sent.json().id);
    expect(reasons(open)).toEqual(['not_completed']);
    await t.act(b, sent.json().id, 'decline');
    expect(reasons(await mod.reverse(moderator, sent.json().id))).toEqual(['not_completed']);
  });

  it('replays a retried reversal and refuses a second one', async () => {
    const [a, b] = await pair();
    const { offerId } = await giftTrade(a, b);
    const key = randomUUID();
    const first = await mod.reverse(moderator, offerId, { reason: 'Gold seller.' }, key);
    expect(first.statusCode).toBe(200);
    const replay = await mod.reverse(moderator, offerId, { reason: 'Gold seller.' }, key);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    const other = await mod.reverse(moderator, offerId, { reason: 'Gold seller.' });
    expect(other.statusCode).toBe(409);
    expect(reasons(other)).toEqual(['already_reversed']);
    expect(await events('trade.reverse', offerId)).toHaveLength(1);
    // Without a key: refused before anything.
    expect(
      (await mod.reverse(moderator, offerId, { reason: 'Gold seller.' }, null)).statusCode,
    ).toBe(400);
    // A reason is required (3–300 characters).
    const [c, d] = await pair();
    const next = await giftTrade(c, d, { gold: 0, timber: 0 });
    expect((await mod.reverse(moderator, next.offerId, { reason: 'x' })).statusCode).toBe(400);
    await expectReconciled();
  });
});

describe('permissions', () => {
  it('player, moderator and admin, per party role (404 for what they may not see)', async () => {
    const player = await insertTrader(db(), clock);
    const [a, b] = await pair();
    const plain = await giftTrade(a, b, { gold: 0, timber: 0 });
    // A trade with a moderator in it: a moderator sees it (the player is in reach) but can't
    // reverse it; an admin can.
    const modTrader = await insertTrader(db(), clock);
    await db().update(accounts).set({ role: 'moderator' }).where(eq(accounts.id, modTrader.id));
    const c = await insertTrader(db(), clock);
    await befriendSince(db(), modTrader, c, clock);
    const withMod = await giftTrade(modTrader, c, { gold: 0, timber: 0 });
    // A moderator's own trade: invisible to that moderator.
    const own = { ...modTrader, role: 'moderator' as const };

    const urls = (id: string) => [
      '/api/mod/trades',
      `/api/mod/trades/${id}`,
      '/api/mod/trading/patterns',
    ];
    for (const who of [null, player]) {
      for (const u of urls(plain.offerId)) expect((await mod.get(who, u)).statusCode, u).toBe(404);
      expect((await mod.reverse(who, plain.offerId)).statusCode).toBe(404);
    }
    const seen = await mod.get(moderator, `/api/mod/trades/${withMod.offerId}`);
    expect(seen.statusCode).toBe(200);
    expect(seen.json().reversible).toMatchObject({ canAct: false });
    expect(seen.json().reversible.cannotAct).toMatch(/higher role/);
    expect((await mod.reverse(moderator, withMod.offerId)).statusCode).toBe(403);
    expect((await mod.get(own, `/api/mod/trades/${withMod.offerId}`)).statusCode).toBe(404);
    expect((await mod.reverse(own, withMod.offerId)).statusCode).toBe(403);
    const ownList = await mod.get(own, '/api/mod/trades');
    expect(ownList.json().trades.map((x: { id: string }) => x.id)).not.toContain(withMod.offerId);
    expect((await mod.reverse(admin, withMod.offerId)).statusCode).toBe(200);
    expect((await mod.reverse(moderator, plain.offerId)).statusCode).toBe(200);
  });
});

describe('a sanction in the same flow', () => {
  it('restricts trading for one of the two, voiding their open offers, all in one go', async () => {
    const [a, b] = await pair();
    const { offerId } = await giftTrade(a, b);
    const c = await insertTrader(db(), clock);
    await befriendSince(db(), b, c, clock);
    const other = await insertTradeItem(db(), c.hero.id);
    const open = await t.send(c, b, { give: { itemIds: [other.id], gold: 100 } });
    expect(open.statusCode, open.body).toBe(201);
    const res = await mod.reverse(moderator, offerId, {
      reason: 'Real-money trade.',
      sanction: { handle: b.handle, action: 'restrictTrade', durationHours: 7 * 24 },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().sanction).toMatchObject({ kind: 'trade', reason: 'Real-money trade.' });
    const s = await db().select().from(sanctions).where(eq(sanctions.subjectId, b.id));
    expect(s.map((x) => x.kind)).toEqual(['trade']);
    expect((await offerRow(open.json().id)).status).toBe('void');
    expect((await item(other.id))!.escrowOfferId).toBeNull();
    expect((await offerRow(offerId)).reversedAt).not.toBeNull();
    await expectReconciled();
  });

  it('refuses a sanction for someone outside the trade, and rolls back the reversal with it', async () => {
    const [a, b] = await pair();
    const { offerId } = await giftTrade(a, b);
    const stranger = await insertTrader(db(), clock);
    const res = await mod.reverse(moderator, offerId, {
      reason: 'Real-money trade.',
      sanction: { handle: stranger.handle, action: 'mute', durationHours: 24 },
    });
    expect(res.statusCode).toBe(422);
    expect((await offerRow(offerId)).reversedAt).toBeNull();
    // An already active sanction of that kind refuses everything too.
    await mod.reverse(moderator, offerId, {
      reason: 'First.',
      sanction: { handle: a.handle, action: 'mute', durationHours: 24 },
    });
    const [c, d] = await pair();
    await befriendSince(db(), a, c, clock);
    const second = await giftTrade(c, d, { gold: 0, timber: 0 });
    expect(
      (
        await mod.reverse(moderator, second.offerId, {
          reason: 'Again.',
          sanction: { handle: a.handle, action: 'mute', durationHours: 24 },
        })
      ).statusCode,
    ).toBe(422);
  });
});

describe('reporting a trade', () => {
  it('lets either player report it; the queue shows the trade; nobody else can', async () => {
    const [a, b] = await pair();
    const { offerId } = await giftTrade(a, b, { gold: 0, timber: 0 });
    const report = (who: TestAccount) =>
      app.inject({
        method: 'POST',
        url: '/api/reports',
        payload: {
          target: { kind: 'trade', id: offerId },
          reason: 'scam',
          note: 'Promised gold back.',
        },
        cookies: { [SESSION_COOKIE]: who.token },
      });
    const stranger = await insertTrader(db(), clock);
    expect((await report(stranger)).statusCode).toBe(404);
    const ok = await report(a);
    expect(ok.statusCode, ok.body).toBe(201);
    const [row] = await db()
      .select()
      .from(reports)
      .where(eq(reports.targetKey, `trade:${offerId}`));
    expect(row!.subjectId).toBe(b.id);
    const queue = await mod.get(moderator, '/api/mod/queue');
    const theCase = queue
      .json()
      .cases.find((c: { target: { kind: string; id?: string } }) => c.target.id === offerId);
    expect(theCase).toMatchObject({
      target: { kind: 'trade', id: offerId },
      subject: { handle: b.handle },
      current: { value: 'Completed trade' },
    });
    const view = await mod.get(moderator, `/api/mod/trades/${offerId}`);
    expect(view.json().reports).toEqual({ open: 1, reportId: row!.id });
  });
});

describe('history and case views', () => {
  it('lists by account and by pair, and never shows emails or account ids', async () => {
    const [a, b] = await pair();
    const c = await insertTrader(db(), clock);
    await befriendSince(db(), a, c, clock);
    const ab = await giftTrade(a, b, { gold: 0, timber: 0 });
    const ac = await giftTrade(a, c, { gold: 100, timber: 0 });
    const byAccount = await mod.get(moderator, `/api/mod/trades?handle=${a.handle}`);
    expect(byAccount.json().trades.map((x: { id: string }) => x.id)).toEqual([
      ac.offerId,
      ab.offerId,
    ]);
    const byPair = await mod.get(moderator, `/api/mod/trades?handle=${a.handle}&with=${c.handle}`);
    expect(byPair.json().trades.map((x: { id: string }) => x.id)).toEqual([ac.offerId]);
    expect(byPair.json().trades[0]).toMatchObject({
      status: 'accepted',
      kind: 'gift',
      give: { items: 1, gold: 100, rarities: ['epic'] },
    });
    const page = await mod.get(moderator, `/api/mod/trades?handle=${a.handle}&limit=1`);
    expect(page.json().nextCursor).toBe(ac.offerId);
    const next = await mod.get(
      moderator,
      `/api/mod/trades?handle=${a.handle}&limit=1&before=${page.json().nextCursor}`,
    );
    expect(next.json().trades.map((x: { id: string }) => x.id)).toEqual([ab.offerId]);
    await mod.reverse(moderator, ab.offerId);
    const reversed = await mod.get(moderator, `/api/mod/trades?handle=${a.handle}&status=reversed`);
    expect(reversed.json().trades.map((x: { id: string }) => x.id)).toEqual([ab.offerId]);

    const view = await mod.get(moderator, `/api/mod/trades/${ab.offerId}`);
    expect(view.json().trail.map((e: { event: string }) => e.event)).toEqual([
      'trade.offer',
      'trade.accept',
      'trade.release',
      'trade.reverse',
    ]);
    const emails = await db()
      .select({ id: accounts.id, email: accounts.email })
      .from(accounts)
      .where(sql`${accounts.id} in (${a.id}, ${b.id}, ${c.id}, ${moderator.id})`);
    for (const body of [byAccount.body, byPair.body, view.body]) {
      for (const e of emails) {
        expect(body).not.toContain(e.email);
        expect(body).not.toContain(e.id);
      }
    }
  });
});
