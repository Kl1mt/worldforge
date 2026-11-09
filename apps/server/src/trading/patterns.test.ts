/**
 * The trade pattern report (ticket T.6, docs/TRADING.md "T.6 as built"): fixtures for every
 * signal (one-way flows, pairs that only trade with each other, new accounts receiving a lot,
 * weekly caps reached in several weeks, unprovenanced items flagged, repeated reversals, the same
 * invite and the same sign-up mailbox, invite clusters), the window, who sees which rows, and that
 * nothing personal (emails, account ids, invite ids) ever leaves the server, in the panel's JSON or
 * the command's text. The audit log's own clock is the database's, so this file's clock starts at
 * the real time (nothing waits on it).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { accounts, auditLog, tradeCounters, tradeOffers } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { createTestDatabase } from '../test/db.js';
import { insertAccount, type TestAccount } from '../test/social.js';
import {
  ALL_TRADING_ON,
  befriendSince,
  insertTradeItem,
  insertTrader,
  modTradeCalls,
  setTradingSettings,
  tradeCalls,
  type Trader,
} from '../test/trading.js';
import { formatTradePatterns, tradePatterns } from './patterns.js';
import { parseTradingArgs } from './trading-cli.js';

const DAY = 86_400_000;
const START = new Date(Math.floor(Date.now() / 60_000) * 60_000);
const clock = START;
const now = () => clock;

let database: DatabaseHandle;
let app: FastifyInstance;
let t: ReturnType<typeof tradeCalls>;
let mod: ReturnType<typeof modTradeCalls>;
let moderator: TestAccount;
let admin: TestAccount;
const db = () => database.db;
const people: Record<string, Trader> = {};
const inviteIds = ['invite-cluster-0001', 'invite-pair-0002'];

async function trader(name: string, ageDays = 30): Promise<Trader> {
  const tr = await insertTrader(db(), clock, { name });
  await db()
    .update(accounts)
    .set({ createdAt: new Date(clock.getTime() - ageDays * DAY) })
    .where(eq(accounts.id, tr.id));
  people[name] = tr;
  return tr;
}

async function gift(
  from: Trader,
  to: Trader,
  give: { items?: number; gold?: number } = { items: 1 },
) {
  const itemIds: string[] = [];
  for (let i = 0; i < (give.items ?? 0); i++)
    itemIds.push((await insertTradeItem(db(), from.hero.id)).id);
  const sent = await t.send(from, to, {
    give: { ...(itemIds.length ? { itemIds } : {}), ...(give.gold ? { gold: give.gold } : {}) },
  });
  expect(sent.statusCode, sent.body).toBe(201);
  const ok = await t.act(to, sent.json().id, 'accept', { characterId: to.hero.id });
  expect(ok.statusCode, ok.body).toBe(200);
  return sent.json().id as string;
}

async function friends(a: Trader, b: Trader) {
  await befriendSince(db(), a, b, clock);
}

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
  await setTradingSettings(app, db(), ALL_TRADING_ON);
  moderator = await insertAccount(db(), { role: 'moderator', now: START });
  admin = await insertAccount(db(), { role: 'admin', now: START });

  // One-way, only each other: Alder gives Birch three gifts; neither trades with anyone else.
  const alder = await trader('Alder');
  const birch = await trader('Birch');
  await friends(alder, birch);
  for (let i = 0; i < 3; i++) await gift(alder, birch, { items: 1 });

  // A new account receiving a lot: Cedar (20 days old) gets 3 items from Dogwood, who also swaps
  // with Elm both ways.
  const cedar = await trader('Cedar', 20);
  const dogwood = await trader('Dogwood');
  const elm = await trader('Elm');
  await friends(dogwood, cedar);
  await friends(dogwood, elm);
  await gift(dogwood, cedar, { items: 3 });
  await gift(dogwood, elm, { items: 1 });
  await gift(elm, dogwood, { gold: 200 });

  // Weekly caps reached in two weeks (T.4's counters, set up directly).
  const fir = await trader('Fir');
  for (const weeksAgo of [1, 2]) {
    await db()
      .insert(tradeCounters)
      .values({
        accountId: fir.id,
        period: 'week',
        windowStart: new Date(clock.getTime() - weeksAgo * 7 * DAY).toISOString().slice(0, 10),
        metric: 'gold',
        direction: 'received',
        amount: ALL_TRADING_ON.limits.goldPerWeek,
        updatedAt: clock,
      });
  }

  // An unprovenanced item offered: refused and flagged.
  const gorse = await trader('Gorse');
  await friends(gorse, elm);
  const dup = await insertTradeItem(db(), gorse.hero.id, { unprovenanced: true });
  expect((await t.send(gorse, elm, { give: { itemIds: [dup.id] } })).statusCode).toBe(409);

  // Repeated reversals: two of Hazel's trades with Ivy reversed.
  const hazel = await trader('Hazel');
  const ivy = await trader('Ivy');
  await friends(hazel, ivy);
  for (let i = 0; i < 2; i++) {
    const id = await gift(hazel, ivy, { items: 1 });
    expect((await mod.reverse(admin, id)).statusCode).toBe(200);
  }

  // An invite cluster of three (Juniper, Kale, Larch) and a same-mailbox pair (Maple, Nettle).
  const [juniper, kale, larch] = [
    await trader('Juniper'),
    await trader('Kale'),
    await trader('Larch'),
  ];
  for (const x of [juniper, kale, larch]) {
    await db()
      .insert(auditLog)
      .values({
        id: uuidv7(),
        accountId: x.id,
        event: 'account.register',
        data: { inviteId: inviteIds[0] },
      });
  }
  await friends(juniper, kale);
  await friends(kale, larch);
  await gift(juniper, kale, { items: 1 });
  await gift(kale, larch, { items: 1 });
  await gift(larch, kale, { gold: 100 });
  const maple = await trader('Maple');
  const nettle = await trader('Nettle');
  await db()
    .update(accounts)
    .set({ email: 'samebox+one@example.test' })
    .where(eq(accounts.id, maple.id));
  await db()
    .update(accounts)
    .set({ email: 'samebox+two@example.test' })
    .where(eq(accounts.id, nettle.id));
  await friends(maple, nettle);
  await gift(maple, nettle, { items: 1 });
  await gift(nettle, maple, { items: 1 });

  // Outside the window: an old one-way pair (its trades moved back 40 days).
  const oak = await trader('Oak');
  const pine = await trader('Pine');
  await friends(oak, pine);
  const old = [await gift(oak, pine, { items: 1 }), await gift(oak, pine, { items: 1 })];
  for (const id of old) {
    await db()
      .update(tradeOffers)
      .set({ closedAt: new Date(clock.getTime() - 40 * DAY) })
      .where(eq(tradeOffers.id, id));
  }

  // A moderator trading: only an admin sees that pair.
  const quill = await trader('Quill');
  const rowan = await trader('Rowan');
  await db().update(accounts).set({ role: 'moderator' }).where(eq(accounts.id, quill.id));
  await db().update(accounts).set({ role: 'moderator' }).where(eq(accounts.id, rowan.id));
  await friends(quill, rowan);
  await gift(quill, rowan, { items: 1 });
  await gift(quill, rowan, { items: 1 });
}, 120_000);

afterAll(async () => {
  await app?.close();
  await database?.close();
});

const name = (w: { displayName: string }) => w.displayName;

describe('trade pattern report', () => {
  it('flags every signal, within the window only', async () => {
    const r = await tradePatterns(db(), null, clock);
    const pair = (x: string, y: string) =>
      r.pairs.find((p) => [name(p.a), name(p.b)].sort().join() === [x, y].sort().join());
    expect(pair('Alder', 'Birch')?.flags.sort()).toEqual(['oneWay', 'onlyEachOther']);
    expect(pair('Alder', 'Birch')?.trades).toBe(3);
    expect(pair('Dogwood', 'Elm')?.flags ?? []).toEqual([]);
    expect(pair('Maple', 'Nettle')?.flags).toEqual(['onlyEachOther', 'sameMailbox']);
    expect(pair('Juniper', 'Kale')?.flags).toContain('sameInvite');
    expect(pair('Oak', 'Pine')).toBeUndefined();
    const account = (x: string) => r.accounts.find((a) => a.who.displayName === x);
    expect(account('Cedar')).toMatchObject({
      flags: ['newAccountReceiving'],
      receivedWhileNew: { items: 3, gold: 0, materialUnits: 0 },
      accountAgeDays: 20,
    });
    expect(account('Fir')).toMatchObject({
      flags: ['atCap'],
      weeksAtCap: 2,
      capsReached: ['gold'],
    });
    expect(account('Gorse')).toMatchObject({ flags: ['flaggedItems'], flaggedItems: 1 });
    expect(account('Hazel')).toMatchObject({ flags: ['repeatedReversals'], reversals: 2 });
    expect(account('Ivy')?.flags).toEqual(['repeatedReversals']);
    expect(r.inviteClusters).toEqual([
      {
        members: [people.Juniper, people.Kale, people.Larch]
          .map((p) => ({ handle: p!.handle, displayName: p!.displayName, role: 'player' }))
          .sort((x, y) => x.handle.localeCompare(y.handle)),
        trades: 3,
      },
    ]);
    expect(r.totals.reversed).toBe(2);
    // A wider window finds the old pair.
    const wide = await tradePatterns(db(), null, clock, 60);
    expect(wide.pairs.some((p) => [name(p.a), name(p.b)].sort().join() === 'Oak,Pine')).toBe(true);
  });

  it('shows staff only what they may act on, and never their own', async () => {
    const asMod = await mod.get(moderator, '/api/mod/trading/patterns');
    expect(asMod.statusCode, asMod.body).toBe(200);
    const pairs = (body: { pairs: { a: { displayName: string }; b: { displayName: string } }[] }) =>
      body.pairs.map((p) => [p.a.displayName, p.b.displayName].sort().join());
    expect(pairs(asMod.json())).not.toContain('Quill,Rowan');
    const asAdmin = await mod.get(admin, '/api/mod/trading/patterns');
    expect(pairs(asAdmin.json())).toContain('Quill,Rowan');
    const quill = { ...people.Quill!, role: 'moderator' as const };
    const own = await mod.get(quill, '/api/mod/trading/patterns');
    expect(pairs(own.json())).not.toContain('Quill,Rowan');
    const player = await insertTrader(db(), clock);
    expect((await mod.get(player, '/api/mod/trading/patterns')).statusCode).toBe(404);
    expect((await mod.get(admin, '/api/mod/trading/patterns?days=91')).statusCode).toBe(400);
    const [row] = await db()
      .select()
      .from(auditLog)
      .where(eq(auditLog.event, 'mod.trade.patterns'))
      .limit(1);
    expect(row!.data).toMatchObject({ days: 28 });
  });

  it('carries no personal data: no emails, account ids or invite ids', async () => {
    const all = await db().select({ id: accounts.id, email: accounts.email }).from(accounts);
    const json = (await mod.get(admin, '/api/mod/trading/patterns')).body;
    const text = formatTradePatterns(await tradePatterns(db(), null, clock));
    for (const out of [json, text, JSON.stringify(await tradePatterns(db(), null, clock))]) {
      for (const a of all) {
        expect(out).not.toContain(a.id);
        expect(out).not.toContain(a.email);
      }
      for (const inv of inviteIds) expect(out).not.toContain(inv);
      expect(out).not.toContain('samebox');
      expect(out).not.toContain('@');
    }
    expect(text).toContain('Alder');
    expect(text).toMatch(/oneWay/);
  });

  it('parses the command line', () => {
    expect(parseTradingArgs(['patterns'])).toEqual({ days: 28, json: false });
    expect(parseTradingArgs(['patterns', '--days', '7', '--json'])).toEqual({
      days: 7,
      json: true,
    });
    expect(parseTradingArgs(['patterns', '--days', '0'])).toBeNull();
    expect(parseTradingArgs(['patterns', '--days', '91'])).toBeNull();
    expect(parseTradingArgs(['nothing'])).toBeNull();
    expect(parseTradingArgs([])).toBeNull();
  });
});
