/**
 * Ticket T.7, the trading exploit review (docs/TRADING.md "T.7 exploit review"): the holes the
 * review found, each pinned by a test that failed before its fix.
 * - F1: an offer's refusal must not tell a stranger (or anyone without a qualifying relation)
 *   anything about the other account's standing, and with a qualifying relation it carries one
 *   bit, never how many rules they miss.
 * - F2: a stranger can't probe another account's heroes or items through the ask side.
 * - F3: a sender can't read the receiver's weekly cap usage (the receiver's caps are checked at
 *   accept, where the receiver sees their own numbers).
 * Nothing random runs: heroes are idle and every clock is injected.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { accounts, sanctions } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import type { DatabaseHandle } from '../db/types.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { createTestDatabase } from '../test/db.js';
import { uuidv7 } from '../db/uuid.js';
import {
  ALL_TRADING_ON,
  befriendSince,
  insertTradeItem,
  insertTrader,
  setTradingSettings,
  tradeCalls,
  type Trader,
} from '../test/trading.js';

const HOUR = 3_600_000;
const START = new Date('2031-05-05T10:00:00.000Z');
let clock = START;
const now = () => clock;

let database: DatabaseHandle;
let app: FastifyInstance;
let t: ReturnType<typeof tradeCalls>;
const db = () => database.db;

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
  await setTradingSettings(app, db(), ALL_TRADING_ON);
});

/** A muted account with an unverified email: two standing rules missed. */
async function makeIneligibleTwice(who: Trader) {
  await db().update(accounts).set({ emailVerifiedAt: null }).where(eq(accounts.id, who.id));
  await db()
    .insert(sanctions)
    .values({
      id: uuidv7(),
      subjectId: who.id,
      kind: 'mute',
      reason: 'Test',
      createdAt: clock,
      expiresAt: new Date(clock.getTime() + 24 * HOUR),
    });
}

const checks = (res: { json: () => unknown }) =>
  (
    res.json() as { error: { details: { reasons?: { check: string }[] } } }
  ).error.details.reasons?.map((r) => r.check) ?? [];

describe('F1: refusals never describe the other account’s standing beyond one bit', () => {
  it('a stranger learns nothing about the receiver’s standing', async () => {
    const me = await insertTrader(db(), clock);
    const clean = await insertTrader(db(), clock);
    const flawed = await insertTrader(db(), clock);
    await makeIneligibleTwice(flawed);
    const item = await insertTradeItem(db(), me.hero.id);
    const toClean = await t.send(me, clean, { give: { itemIds: [item.id] } });
    const toFlawed = await t.send(me, flawed, { give: { itemIds: [item.id] } });
    expect(toClean.statusCode).toBe(409);
    expect(toFlawed.statusCode).toBe(409);
    // The same answer whatever the stranger's standing.
    expect(checks(toFlawed)).toEqual(checks(toClean));
    expect(checks(toFlawed)).toEqual(['no_relation']);
  });

  it('a qualifying friend learns one bit, never how many rules they miss', async () => {
    const me = await insertTrader(db(), clock);
    const friend = await insertTrader(db(), clock);
    await befriendSince(db(), me, friend, clock);
    await makeIneligibleTwice(friend);
    const res = await t.send(me, friend, { give: { gold: 100 } });
    expect(res.statusCode).toBe(409);
    expect(checks(res)).toEqual(['them_not_eligible']);
  });

  it('the receiver accepting from an ineligible sender also sees one line', async () => {
    const a = await insertTrader(db(), clock);
    const b = await insertTrader(db(), clock);
    await befriendSince(db(), a, b, clock);
    const sent = await t.send(a, b, { give: { gold: 100 } });
    expect(sent.statusCode, sent.body).toBe(201);
    await makeIneligibleTwice(a);
    const res = await t.act(b, sent.json().id, 'accept', { characterId: b.hero.id });
    expect(res.statusCode).toBe(409);
    expect(checks(res)).toEqual(['them_not_eligible']);
    const view = await t.get(b, `/api/trading/offers/${sent.json().id}`);
    expect(view.statusCode, view.body).toBe(200);
    const reasons = (view.json() as { canAccept?: { reasons: { check: string }[] } }).canAccept
      ?.reasons;
    if (reasons) {
      expect(reasons.filter((r) => r.check === 'them_not_eligible')).toHaveLength(1);
    }
  });
});

describe('F2: no probing of a stranger’s heroes or items', () => {
  it('asking a stranger for a real or a made-up item gets the same answer', async () => {
    const me = await insertTrader(db(), clock);
    const stranger = await insertTrader(db(), clock);
    const theirs = await insertTradeItem(db(), stranger.hero.id, { locked: true });
    const real = await t.send(me, stranger, {
      give: { gold: 10 },
      ask: { itemIds: [theirs.id] },
      receiverCharacterId: stranger.hero.id,
    });
    const madeUp = await t.send(me, stranger, {
      give: { gold: 10 },
      ask: { itemIds: [uuidv7()] },
      receiverCharacterId: uuidv7(),
    });
    expect(real.statusCode).toBe(409);
    expect(madeUp.statusCode).toBe(409);
    expect(real.json()).toEqual(madeUp.json());
    expect(checks(real)).toEqual(['no_relation']);
  });
});

describe('F3: the receiver’s weekly usage is not readable by the sender', () => {
  it('a send is not refused for the receiver’s caps; their accept is, with their own numbers', async () => {
    const a = await insertTrader(db(), clock);
    const b = await insertTrader(db(), clock);
    await befriendSince(db(), a, b, clock);
    await setTradingSettings(app, db(), {
      ...ALL_TRADING_ON,
      limits: { ...ALL_TRADING_ON.limits, goldPerWeek: 1_000 },
    });
    // A third friend fills B's received gold for the week.
    const c = await insertTrader(db(), clock);
    await befriendSince(db(), c, b, clock);
    const filler = await t.send(c, b, { give: { gold: 1_000 } });
    expect(filler.statusCode, filler.body).toBe(201);
    expect(
      (await t.act(b, filler.json().id, 'accept', { characterId: b.hero.id })).statusCode,
    ).toBe(200);
    const probe = await t.send(a, b, { give: { gold: 1 } });
    expect(probe.statusCode, probe.body).toBe(201);
    const res = await t.act(b, probe.json().id, 'accept', { characterId: b.hero.id });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('trade_cap_reached');
    expect(res.json().error.details.refusals[0]).toMatchObject({ party: 'you', used: 1_000 });
  });
});
