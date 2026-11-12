import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import { GAME_VERSION, NO_WORLD_FLAGS, RARITY_IDS, WORLD_ERAS } from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { accountNotifications, accounts, auditLog, characters } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { withTransaction } from '../db/transaction.js';
import { uuidv7 } from '../db/uuid.js';
import { createTestDatabase } from '../test/db.js';
import { insertCharacter } from '../test/heroes.js';
import { insertAccount, type TestAccount } from '../test/social.js';
import {
  ALL_TRADING_ON,
  befriendSince,
  insertTradeItem,
  insertTrader,
  setTradingSettings,
  tradeCalls,
  type Trader,
} from '../test/trading.js';
import { arenaCalls, befriend, block, equipKit } from '../test/arena.js';
import { recordEraChange } from '../community/era.js';
import { voidForDeletion } from '../trading/offers.js';
import type { ArenaStateResponse } from '../arena/routes.js';
import {
  INBOX_KEEP,
  INBOX_KEEP_DAYS,
  broadcastTx,
  isDropWorthSeeing,
  notifyDropsTx,
  notifyTx,
  pruneInboxes,
} from './notify.js';
import type { InboxEntryView } from './routes.js';

/**
 * Ticket 8.5: the notification inbox (docs/NOTIFICATIONS.md): entries per source written in the
 * event's own transaction, read and unread, pruning, privacy (only one's own entries, nothing
 * foreign in them), blocks and test accounts, and the badge's ETag. The clock is derived from the
 * wall clock (CLAUDE.md "Dates"); nothing here depends on a random outcome.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = Date.now();
let nowMs = START;
const now = () => new Date(nowMs);

let database: DatabaseHandle;
let app: FastifyInstance;
let trade: ReturnType<typeof tradeCalls>;
let arena: ReturnType<typeof arenaCalls>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({
    database,
    auth: {
      now,
      accountRateLimit: { requests: 100_000, actions: 100_000, windowMs: 60_000 },
      socialWriteLimit: { windows: [{ windowMs: 60_000, max: 100_000 }] },
      tradeWriteLimit: { windows: [{ windowMs: 60_000, max: 100_000 }] },
    },
    activity: { ...DEFAULT_ACTIVITY_OPTIONS, now },
  });
  await app.ready();
  trade = tradeCalls(app);
  arena = arenaCalls(app);
});

afterAll(async () => {
  await app?.close();
  await database?.close();
});

beforeEach(() => {
  nowMs = START;
});

const db = () => database.db;

const get = (who: TestAccount, url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers, cookies: { [SESSION_COOKIE]: who.token } });
const post = (who: TestAccount, url: string, payload: object) =>
  app.inject({ method: 'POST', url, payload, cookies: { [SESSION_COOKIE]: who.token } });

async function inbox(who: TestAccount, limit = 200) {
  const res = await get(who, `/api/inbox?limit=${limit}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ entries: InboxEntryView[]; unread: number }>();
}
const ofKind = async (who: TestAccount, kind: string) =>
  (await inbox(who)).entries.filter((e) => e.kind === kind);
const rowsOf = (accountId: string) =>
  db()
    .select()
    .from(accountNotifications)
    .where(eq(accountNotifications.accountId, accountId))
    .orderBy(asc(accountNotifications.createdAt));

/** Every id in a player's answer that belongs to someone else. */
function foreignIds(body: string, others: readonly string[]): string[] {
  return others.filter((id) => body.includes(id));
}

describe('the inbox (ticket 8.5)', () => {
  it('starts with this version’s patch notes, once, and counts unread', async () => {
    const a = await insertAccount(db(), { now: now() });
    const first = await inbox(a);
    expect(first.entries).toEqual([
      expect.objectContaining({ kind: 'release', data: { version: GAME_VERSION }, read: false }),
    ]);
    expect(first.unread).toBe(1);
    await inbox(a);
    expect((await get(a, '/api/inbox/summary')).json()).toEqual({
      unread: 1,
      newest: first.entries[0]!.id,
    });
    expect(await rowsOf(a.id)).toHaveLength(1);
  });

  it('marks one or all read, only the account’s own, and answers 304 while nothing changed', async () => {
    const a = await insertAccount(db(), { now: now() });
    const b = await insertAccount(db(), { now: now() });
    for (const n of [1, 2, 3]) {
      nowMs += 1000;
      await withTransaction(db(), (tx) =>
        notifyTx(tx, {
          accountId: a.id,
          kind: 'world.era',
          data: { from: 'x', to: `y${n}` },
          now: now(),
        }),
      );
    }
    await withTransaction(db(), (tx) =>
      notifyTx(tx, {
        accountId: b.id,
        kind: 'world.era',
        data: { from: 'x', to: 'b' },
        now: now(),
      }),
    );
    const summary = await get(a, '/api/inbox/summary');
    const etag = summary.headers.etag as string;
    expect(summary.json()).toMatchObject({ unread: 4 });
    expect((await get(a, '/api/inbox/summary', { 'if-none-match': etag })).statusCode).toBe(304);

    const list = await inbox(a);
    // Newest first.
    expect(list.entries.filter((e) => e.kind === 'world.era').map((e) => e.data.to)).toEqual([
      'y3',
      'y2',
      'y1',
    ]);
    const bEntries = (await inbox(b)).entries;
    // Someone else's entry ids do nothing.
    const foreign = await post(a, '/api/inbox/read', { ids: bEntries.map((e) => e.id) });
    expect(foreign.json()).toEqual({ marked: 0, unread: 4 });
    const one = await post(a, '/api/inbox/read', { ids: [list.entries[0]!.id] });
    expect(one.json()).toEqual({ marked: 1, unread: 3 });
    expect((await post(a, '/api/inbox/read', { ids: [list.entries[0]!.id] })).json()).toEqual({
      marked: 0,
      unread: 3,
    });
    // The badge's ETag moved.
    const after = await get(a, '/api/inbox/summary', { 'if-none-match': etag });
    expect(after.statusCode).toBe(200);
    expect((await post(a, '/api/inbox/read', { all: true })).json()).toEqual({
      marked: 3,
      unread: 0,
    });
    expect((await inbox(a)).entries.every((e) => e.read)).toBe(true);
    expect((await inbox(b)).unread).toBe(2);
    // Malformed bodies.
    for (const body of [{}, { ids: ['nope'] }, { all: false }, { ids: [], all: true }]) {
      expect((await post(a, '/api/inbox/read', body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await app.inject({ method: 'GET', url: '/api/inbox' })).statusCode).toBe(401);
  });

  it('keeps the newest entries per account and prunes by age', async () => {
    const a = await insertAccount(db(), { now: now() });
    const b = await insertAccount(db(), { now: now() });
    // Old entries straight into the table (test set-up), then one live write.
    const old = new Date(nowMs - (INBOX_KEEP_DAYS + 1) * DAY);
    await db()
      .insert(accountNotifications)
      .values(
        Array.from({ length: INBOX_KEEP + 20 }, (_, i) => ({
          id: uuidv7(nowMs - 10 * DAY + i),
          accountId: a.id,
          kind: 'world.stage',
          data: { n: i },
          createdAt: new Date(nowMs - 10 * DAY + i * 1000),
        })),
      );
    await db()
      .insert(accountNotifications)
      .values({
        id: uuidv7(old.getTime()),
        accountId: b.id,
        kind: 'world.stage',
        data: { n: 'old' },
        createdAt: old,
      });
    // The hourly pruning: a's oldest twenty and b's stale entry go.
    expect(await pruneInboxes(db(), now())).toBe(21);
    expect(await rowsOf(a.id)).toHaveLength(INBOX_KEEP);
    expect(await rowsOf(b.id)).toHaveLength(0);
    // A live write keeps the account at the cap, dropping its oldest.
    await withTransaction(db(), (tx) =>
      notifyTx(tx, { accountId: a.id, kind: 'world.era', data: {}, now: now() }),
    );
    const rows = await rowsOf(a.id);
    expect(rows).toHaveLength(INBOX_KEEP);
    expect((rows[0]!.data as { n: number }).n).toBe(21);
    expect(rows.at(-1)!.kind).toBe('world.era');
  });

  it('writes town-wide entries to every account once', async () => {
    const a = await insertAccount(db(), { now: now() });
    const b = await insertAccount(db(), { now: now() });
    const before = (await db().select().from(accounts)).length;
    const era = WORLD_ERAS[1]!;
    const changed = await withTransaction(db(), (tx) =>
      recordEraChange(tx, NO_WORLD_FLAGS, { ...NO_WORLD_FLAGS, [era.beganBy!]: true }, now(), {
        by: 'admin',
      }),
    );
    expect(changed).toEqual({ from: WORLD_ERAS[0]!.id, to: era.id });
    expect((await ofKind(a, 'world.era')).map((e) => e.data)).toEqual([
      { from: WORLD_ERAS[0]!.id, to: era.id },
    ]);
    expect(await ofKind(b, 'world.era')).toHaveLength(1);
    const n = await withTransaction(db(), (tx) =>
      broadcastTx(tx, {
        kind: 'world.stage',
        data: { projectId: 'p', stageId: 's', stageIndex: 0 },
        now: now(),
        dedupeKey: 'stage:p:s',
      }),
    );
    expect(n).toBe(before);
    // Resumed: nothing twice.
    await withTransaction(db(), (tx) =>
      broadcastTx(tx, { kind: 'world.stage', data: {}, now: now(), dedupeKey: 'stage:p:s' }),
    );
    expect(await ofKind(a, 'world.stage')).toHaveLength(1);
    expect(await ofKind(b, 'world.stage')).toHaveLength(1);
  });

  it('skips entries a test account or a block would cause on another account', async () => {
    const a = await insertAccount(db(), { now: now() });
    const tester = await insertAccount(db(), { now: now() });
    const blocker = await insertAccount(db(), { now: now() });
    await db().update(accounts).set({ isTest: true }).where(eq(accounts.id, tester.id));
    await block(db(), blocker.id, a.id);
    const write = (accountId: string, from: string) =>
      withTransaction(db(), (tx) =>
        notifyTx(tx, { accountId, kind: 'duel.defence', data: {}, now: now(), from }),
      );
    expect(await write(a.id, tester.id)).toBe(false);
    expect(await write(blocker.id, a.id)).toBe(false);
    expect(await write(a.id, blocker.id)).toBe(false);
    // A test account's own entries are its own.
    expect(await write(tester.id, tester.id)).toBe(true);
    expect(await write(tester.id, a.id)).toBe(true);
    expect(await ofKind(a, 'duel.defence')).toHaveLength(0);
  });

  it('lists drops worth seeing: Legendary and better, set, Void, Prismatic', async () => {
    const a = await insertAccount(db(), { now: now() });
    const items = [
      { baseId: 'longsword', rarityId: 'epic' },
      { baseId: 'longsword', rarityId: 'rare', variant: null },
      { baseId: 'longsword', rarityId: 'legendary', variant: 'void' },
      { baseId: 'longsword', rarityId: 'legendary', setId: 'someSet' },
      { baseId: 'longsword', rarityId: 'mythic', mythicId: 'someMythic' },
      { baseId: 'longsword', rarityId: 'legendary', variant: 'prismatic' },
      { baseId: 'longsword', rarityId: 'legendary' },
      { baseId: 'longsword', rarityId: 'legendary' },
    ];
    expect(items.map(isDropWorthSeeing)).toEqual([
      false,
      false,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    await withTransaction(db(), (tx) =>
      notifyDropsTx(tx, {
        accountId: a.id,
        characterId: 'hero',
        source: 'crypt',
        placeId: 'crypt',
        items,
        now: now(),
      }),
    );
    const [drop] = await ofKind(a, 'drop');
    expect(drop!.data).toMatchObject({ count: 6, source: 'crypt' });
    expect((drop!.data.items as unknown[]).length).toBe(5);
    expect(drop!.data.items).toContainEqual({
      baseId: 'longsword',
      rarityId: 'legendary',
      variant: 'void',
    });
    // Nothing worth seeing, no entry.
    await withTransaction(db(), (tx) =>
      notifyDropsTx(tx, {
        accountId: a.id,
        characterId: 'hero',
        source: 'farming',
        placeId: 'x',
        items: items.slice(0, 2),
        now: now(),
      }),
    );
    expect(await ofKind(a, 'drop')).toHaveLength(1);
  });

  it('writes a farming settlement’s notable drops in the settlement (any seed)', async () => {
    const who = await insertAccount(db(), { now: now() });
    const hero = await insertCharacter(db(), who.id, { classId: 'warrior', level: 26 });
    await db()
      .update(characters)
      .set({ progress: { gravewardenDefeated: true } })
      .where(eq(characters.id, hero.id));
    await equipKit(db(), hero.id, 'warrior', 25, 'epic', 'inbox');
    await db().update(accounts).set({ activeCharacterId: hero.id }).where(eq(accounts.id, who.id));
    const start = await app.inject({
      method: 'POST',
      url: `/api/characters/${hero.id}/activity`,
      payload: { areaId: 'sunkenAbbey' },
      cookies: { [SESSION_COOKIE]: who.token },
    });
    expect(start.statusCode, start.body).toBe(201);
    nowMs += 3 * HOUR;
    await app.inject({
      method: 'POST',
      url: `/api/characters/${hero.id}/activity/settle`,
      cookies: { [SESSION_COOKIE]: who.token },
    });
    const rewards = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.characterId, hero.id), eq(auditLog.event, 'activity.reward')));
    const notable = rewards.flatMap(
      (r) => (r.data as { notableItems: { rarityId: string }[] }).notableItems,
    );
    const legendary = notable.filter(
      (i) => RARITY_IDS.indexOf(i.rarityId as never) >= RARITY_IDS.indexOf('legendary'),
    );
    const drops = await ofKind(who, 'drop');
    // One entry per settlement that kept something worth seeing; exactly the kept ones listed.
    expect(drops).toHaveLength(legendary.length > 0 ? rewards.length : 0);
    expect(drops.reduce((n, d) => n + (d.data.count as number), 0)).toBe(legendary.length);
    for (const d of drops)
      expect(d.data).toMatchObject({ characterId: hero.id, source: 'farming' });
  });

  describe('trades', () => {
    async function pair(): Promise<[Trader, Trader]> {
      const a = await insertTrader(db(), now());
      const b = await insertTrader(db(), now());
      await befriendSince(db(), a, b, now());
      return [a, b];
    }

    beforeEach(async () => {
      await setTradingSettings(app, db(), ALL_TRADING_ON);
    });

    it('tells the receiver of an offer, the sender of its acceptance, and both of a release', async () => {
      const [a, b] = await pair();
      const epic = await insertTradeItem(db(), a.hero.id);
      const sent = await trade.send(a, b, { give: { itemIds: [epic.id], gold: 100 } });
      expect(sent.statusCode, sent.body).toBe(201);
      const offerId = sent.json().id as string;
      expect((await ofKind(b, 'trade.received')).map((e) => e.data)).toEqual([{ offerId }]);
      expect(await ofKind(a, 'trade.received')).toHaveLength(0);

      const accepted = await trade.act(b, offerId, 'accept', { characterId: b.hero.id });
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect((await ofKind(a, 'trade.accepted')).map((e) => e.data)).toEqual([{ offerId }]);
      // 72 hours later the hold ends (the inbox read runs the release).
      nowMs += 72 * HOUR + 1000;
      await trade.get(b, '/api/trading/offers');
      const released = await ofKind(b, 'trade.released');
      expect(released.map((e) => e.data)).toEqual([{ offerId, items: 1, gold: 100 }]);
      // Nothing foreign in either inbox.
      const body = (await get(b, '/api/inbox')).body + (await get(a, '/api/inbox')).body;
      expect(foreignIds(body, [a.id, b.id, a.hero.id, b.hero.id])).toEqual([]);
    });

    it('tells both sides of a void, and nothing across a block', async () => {
      const [a, b] = await pair();
      const sent = await trade.send(a, b, { give: { gold: 50 } });
      const offerId = sent.json().id as string;
      await withTransaction(db(), (tx) =>
        voidForDeletion(tx, a.hero.id, now(), { ...DEFAULT_ACTIVITY_OPTIONS, now }),
      );
      expect((await ofKind(a, 'trade.voided')).map((e) => e.data)).toEqual([
        { offerId, reason: 'deletion', side: 'sent' },
      ]);
      expect((await ofKind(b, 'trade.voided')).map((e) => e.data)).toEqual([
        { offerId, reason: 'deletion', side: 'received' },
      ]);
    });
  });

  it('tells a defender of a duel against their defence (not across a block, not from a test account)', async () => {
    const make = async () => {
      const who = await insertAccount(db(), { now: now() });
      const hero = await insertCharacter(db(), who.id, { classId: 'warrior', level: 12 });
      await equipKit(db(), hero.id, 'warrior', 11, 'rare', who.id);
      return { who, hero };
    };
    const challenger = await make();
    const defender = await make();
    const set = await arena.setDefence(defender.who, defender.hero.id);
    expect(set.statusCode, set.body).toBe(200);
    const defenceId = set.json<ArenaStateResponse>().defence!.defenceId;
    await befriend(db(), challenger.who.id, defender.who.id, 'friends');
    const fought = await arena.duel(challenger.who, challenger.hero.id, defenceId, 'friendly');
    expect(fought.statusCode, fought.body).toBe(201);
    const duelId = fought.json<{ duel: { id: string } }>().duel.id;
    const [entry] = await ofKind(defender.who, 'duel.defence');
    expect(entry!.data).toMatchObject({ duelId, kind: 'friendly' });
    expect(['held', 'fell', 'draw']).toContain(entry!.data.outcome);
    expect(entry!.data).not.toHaveProperty('rating');
    // The defender may open that duel.
    const open = await get(defender.who, `/api/arena/duels/${duelId}`);
    expect(open.statusCode).toBe(200);
    expect(await ofKind(challenger.who, 'duel.defence')).toHaveLength(0);
    const body = (await get(defender.who, '/api/inbox')).body;
    expect(foreignIds(body, [challenger.who.id, challenger.hero.id])).toEqual([]);

    // A test account's duel leaves nothing in the real defender's inbox.
    const tester = await make();
    await db().update(accounts).set({ isTest: true }).where(eq(accounts.id, tester.who.id));
    await befriend(db(), tester.who.id, defender.who.id, 'friends');
    const testDuel = await arena.duel(
      tester.who,
      tester.hero.id,
      defenceId,
      'friendly',
      randomUUID(),
    );
    expect(testDuel.statusCode, testDuel.body).toBe(201);
    expect(await ofKind(defender.who, 'duel.defence')).toHaveLength(1);
  });
});
