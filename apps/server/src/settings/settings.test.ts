/**
 * Trading settings (ticket T.2): defaults, hard maxima (refused on write, clamped on read), the
 * permission matrix, audit and history, concurrent edits, idempotency, the cache (injected clock),
 * the switch-off seam, `tradeable` in item views, and invariance (nothing else changes).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import {
  DEFAULT_TRADING_SETTINGS,
  TRADING_LIMITS,
  TRADING_LIMIT_IDS,
  type TradingSettings,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { auditLog, characters, gameSettings, itemInstances } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { withTransaction } from '../db/transaction.js';
import { createTestDatabase } from '../test/db.js';
import { insertCharacter, insertItem } from '../test/heroes.js';
import { insertAccount, type TestAccount } from '../test/social.js';
import type { InventoryView } from '../inventory/routes.js';
import {
  DEFAULT_SETTINGS_TTL_MS,
  GameSettingsCache,
  TRADING_SETTINGS_KEY,
  type TradingSettingsChangeEvent,
} from './store.js';

type Who = 'anonymous' | 'player' | 'moderator' | 'admin';
const WHO: Who[] = ['anonymous', 'player', 'moderator', 'admin'];
const READ = '/api/mod/settings/trading';
const WRITE = '/api/admin/settings/trading';

const clone = (s: Readonly<TradingSettings>): TradingSettings =>
  JSON.parse(JSON.stringify(s)) as TradingSettings;

let database: DatabaseHandle;
let app: FastifyInstance;
let clockMs = 1_000_000;
const who = {} as Record<Exclude<Who, 'anonymous'>, TestAccount>;
let secondAdmin: TestAccount;

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({
    database,
    auth: { accountRateLimit: { requests: 100_000, actions: 100_000, windowMs: 60_000 } },
    settings: { clock: () => clockMs },
  });
  await app.ready();
  who.player = await insertAccount(database.db, { name: 'Plain Pell' });
  who.moderator = await insertAccount(database.db, { role: 'moderator', name: 'Warden Brann' });
  who.admin = await insertAccount(database.db, { role: 'admin', name: 'Castellan Ysolde' });
  secondAdmin = await insertAccount(database.db, { role: 'admin', name: 'Steward Oryn' });
});

afterAll(async () => {
  await app?.close();
  await database?.close();
});

/** Every test starts from "never saved" (version 0, the defaults). */
async function reset() {
  await database.db.delete(gameSettings);
  await database.db.delete(auditLog).where(eq(auditLog.event, 'settings.update'));
  app.gameSettings.invalidate();
}

const get = (as: TestAccount | null, url = READ) =>
  app.inject({
    method: 'GET',
    url,
    ...(as ? { cookies: { [SESSION_COOKIE]: as.token } } : {}),
  });

const put = (as: TestAccount | null, payload: unknown, key: string | null = randomUUID()) =>
  app.inject({
    method: 'PUT',
    url: WRITE,
    payload: payload as object,
    headers: key ? { 'idempotency-key': key } : {},
    ...(as ? { cookies: { [SESSION_COOKIE]: as.token } } : {}),
  });

const save = (as: TestAccount, settings: TradingSettings, expectedVersion: number, key?: string) =>
  put(as, { expectedVersion, settings }, key);

const opened = (): TradingSettings => {
  const s = clone(DEFAULT_TRADING_SETTINGS);
  s.trading = true;
  s.trade.items = true;
  return s;
};

const settingsAudits = () =>
  database.db.select().from(auditLog).where(eq(auditLog.event, 'settings.update'));

describe('defaults', () => {
  beforeEach(reset);

  it('a fresh database reads the TRADING.md defaults at version 0, with no history', async () => {
    const res = await get(who.admin);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      settings: DEFAULT_TRADING_SETTINGS,
      defaults: DEFAULT_TRADING_SETTINGS,
      version: 0,
      updatedAt: null,
      updatedBy: null,
      canEdit: true,
      history: [],
      nextCursor: null,
    });
    expect(await app.gameSettings.trading()).toEqual(DEFAULT_TRADING_SETTINGS);
  });

  it('a stored row missing fields falls back to the defaults (no backfill needed)', async () => {
    await database.db.insert(gameSettings).values({
      key: TRADING_SETTINGS_KEY,
      value: { trading: true },
      version: 1,
      updatedAt: new Date(),
    });
    const body = (await get(who.admin)).json();
    expect(body.settings).toEqual({ ...DEFAULT_TRADING_SETTINGS, trading: true });
  });
});

describe('permission matrix', () => {
  beforeEach(reset);

  for (const w of WHO) {
    it(`${w}: read ${w === 'anonymous' || w === 'player' ? '404' : '200'}, write ${w === 'admin' ? '200' : '404'}`, async () => {
      const as = w === 'anonymous' ? null : who[w];
      const read = await get(as);
      const first = await put(as, { expectedVersion: 0, settings: opened() });
      const w2 = await put(as, { expectedVersion: 0, settings: opened() });
      if (w === 'anonymous' || w === 'player') {
        expect(read.statusCode).toBe(404);
        expect(read.json().error.code).toBe('not_found');
      } else {
        expect(read.statusCode).toBe(200);
        expect(read.json().canEdit).toBe(w === 'admin');
      }
      if (w === 'admin') {
        // The first save wins; the second from the same version is a conflict.
        expect(first.statusCode).toBe(200);
        expect(w2.statusCode).toBe(409);
        expect((await get(who.admin)).json().version).toBe(1);
      } else {
        expect(first.statusCode).toBe(404);
        expect(w2.statusCode).toBe(404);
        // Exactly the not-found handler's answer, before body validation.
        const bad = await put(as, { nonsense: true });
        expect(bad.statusCode).toBe(404);
        expect((await settingsAudits()).length).toBe(0);
        expect((await database.db.select().from(gameSettings)).length).toBe(0);
      }
    });
  }

  it('an admin write needs an Idempotency-Key', async () => {
    const res = await put(who.admin, { expectedVersion: 0, settings: opened() }, null);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('idempotency_key_required');
  });

  it('a role revoked mid-session stops the next write', async () => {
    const temp = await insertAccount(database.db, { role: 'admin' });
    await database.db.execute(sql`update accounts set role = 'player' where id = ${temp.id}`);
    expect((await save(temp, opened(), 0)).statusCode).toBe(404);
  });
});

describe('hard maxima', () => {
  beforeEach(reset);

  it('refuses one over each maximum, naming the field, and stores nothing', async () => {
    for (const id of TRADING_LIMIT_IDS) {
      const s = clone(DEFAULT_TRADING_SETTINGS);
      s.limits[id] = TRADING_LIMITS[id].max + 1;
      const res = await save(who.admin, s, 0);
      expect(res.statusCode, id).toBe(400);
      expect(res.json().error.code).toBe('validation_failed');
      expect(Object.keys(res.json().error.details.fields)).toEqual([`settings.limits.${id}`]);
    }
    const neg = clone(DEFAULT_TRADING_SETTINGS);
    neg.limits.goldPerOffer = -1;
    expect((await save(who.admin, neg, 0)).statusCode).toBe(400);
    expect((await database.db.select().from(gameSettings)).length).toBe(0);
    expect((await settingsAudits()).length).toBe(0);
  });

  it('accepts every number at its maximum', async () => {
    const s = clone(DEFAULT_TRADING_SETTINGS);
    for (const id of TRADING_LIMIT_IDS) s.limits[id] = TRADING_LIMITS[id].max;
    const res = await save(who.admin, s, 0);
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.limits).toEqual(s.limits);
  });

  it('clamps a stored value above its maximum when read', async () => {
    await database.db.insert(gameSettings).values({
      key: TRADING_SETTINGS_KEY,
      value: { ...clone(DEFAULT_TRADING_SETTINGS), limits: { goldPerWeek: 10_000_000 } },
      version: 3,
      updatedAt: new Date(),
    });
    expect((await get(who.admin)).json().settings.limits.goldPerWeek).toBe(50_000);
    expect((await app.gameSettings.trading()).limits.goldPerWeek).toBe(50_000);
  });
});

describe('audit and history', () => {
  beforeEach(reset);

  it('writes settings.update (who, when, old, new) and lists it newest first', async () => {
    const first = opened();
    const r1 = await save(who.admin, first, 0);
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ changed: true, version: 1, settings: first });
    const second = clone(first);
    second.limits.goldPerWeek = 20_000;
    second.tradeable.epic = false;
    const r2 = await save(secondAdmin, second, 1);
    expect(r2.json().version).toBe(2);

    const rows = await settingsAudits();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.accountId).sort()).toEqual([who.admin.id, secondAdmin.id].sort());
    const history = (await get(who.moderator)).json();
    expect(history.updatedBy).toEqual({
      handle: secondAdmin.handle,
      displayName: secondAdmin.displayName,
    });
    expect(history.history).toHaveLength(2);
    expect(history.history[0]).toMatchObject({
      version: 2,
      by: { handle: secondAdmin.handle },
      changes: [
        { path: 'tradeable.epic', old: true, new: false },
        { path: 'limits.goldPerWeek', old: 10_000, new: 20_000 },
      ],
    });
    expect(history.history[1]).toMatchObject({
      version: 1,
      by: { handle: who.admin.handle },
      changes: [
        { path: 'trading', old: false, new: true },
        { path: 'trade.items', old: false, new: true },
      ],
    });
    expect(typeof history.history[0].at).toBe('string');
  });

  it('a save that changes nothing writes nothing', async () => {
    const res = await save(who.admin, clone(DEFAULT_TRADING_SETTINGS), 0);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ changed: false, version: 0 });
    expect((await settingsAudits()).length).toBe(0);
    expect((await database.db.select().from(gameSettings)).length).toBe(0);
  });

  it('pages the history with a cursor', async () => {
    let s = clone(DEFAULT_TRADING_SETTINGS);
    for (let v = 0; v < 52; v++) {
      s = clone(s);
      s.limits.goldPerWeek = 1_000 + v;
      expect((await save(who.admin, s, v)).statusCode).toBe(200);
    }
    const page1 = (await get(who.admin)).json();
    expect(page1.history).toHaveLength(50);
    expect(page1.history[0].version).toBe(52);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = (await get(who.admin, `${READ}?cursor=${page1.nextCursor}`)).json();
    expect(page2.history.map((h: { version: number }) => h.version)).toEqual([2, 1]);
    expect(page2.nextCursor).toBeNull();
  });
});

describe('concurrent edits and idempotency', () => {
  beforeEach(reset);

  it('two admins saving from the same version: one wins, the other gets 409', async () => {
    for (const from of [0, 1]) {
      if (from === 1) {
        await reset();
        expect((await save(who.admin, opened(), 0)).statusCode).toBe(200);
      }
      const a = opened();
      a.limits.goldPerWeek = 11_111;
      const b = opened();
      b.limits.goldPerWeek = 22_222;
      const [ra, rb] = await Promise.all([save(who.admin, a, from), save(secondAdmin, b, from)]);
      const codes = [ra.statusCode, rb.statusCode].sort();
      expect(codes).toEqual([200, 409]);
      const loser = ra.statusCode === 409 ? ra : rb;
      expect(loser.json().error.code).toBe('settings_conflict');
      expect(loser.json().error.details.currentVersion).toBe(from + 1);
      const winner = ra.statusCode === 200 ? a : b;
      const now = (await get(who.admin)).json();
      expect(now.version).toBe(from + 1);
      expect(now.settings).toEqual(winner);
      // One audit row per stored version: nothing was clobbered silently.
      expect((await settingsAudits()).length).toBe(from + 1);
    }
  });

  it('a stale version is refused even when nobody else is saving', async () => {
    expect((await save(who.admin, opened(), 0)).statusCode).toBe(200);
    const stale = await save(secondAdmin, clone(DEFAULT_TRADING_SETTINGS), 0);
    expect(stale.statusCode).toBe(409);
  });

  it('a retried request with the same key replays and writes once', async () => {
    const key = randomUUID();
    const r1 = await save(who.admin, opened(), 0, key);
    const r2 = await save(who.admin, opened(), 0, key);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r2.headers['idempotency-replayed']).toBe('true');
    expect(r2.json().changed).toBe(true);
    expect((await settingsAudits()).length).toBe(1);
    const other = clone(DEFAULT_TRADING_SETTINGS);
    expect((await save(who.admin, other, 1, key)).statusCode).toBe(409);
  });
});

describe('cache', () => {
  beforeEach(reset);

  it('serves from memory for the TTL, then reloads (injected clock)', async () => {
    let t = 0;
    const cache = new GameSettingsCache(database.db, DEFAULT_SETTINGS_TTL_MS, () => t);
    expect((await cache.trading()).trading).toBe(false);
    expect(cache.loads).toBe(1);
    // Another instance writes the table directly.
    await database.db.insert(gameSettings).values({
      key: TRADING_SETTINGS_KEY,
      value: opened() as unknown as Record<string, unknown>,
      version: 1,
      updatedAt: new Date(),
    });
    t = DEFAULT_SETTINGS_TTL_MS - 1;
    expect((await cache.trading()).trading).toBe(false);
    expect(cache.loads).toBe(1);
    t = DEFAULT_SETTINGS_TTL_MS;
    expect((await cache.trading()).trading).toBe(true);
    expect(cache.loads).toBe(2);
    // A clock that goes backwards reloads rather than trusting the copy.
    t = 0;
    await cache.trading();
    expect(cache.loads).toBe(3);
  });

  it('invalidate() shows a change at once; a load racing it does not store the old copy', async () => {
    const cache = new GameSettingsCache(database.db, DEFAULT_SETTINGS_TTL_MS, () => 0);
    const racing = cache.trading();
    cache.invalidate();
    await racing;
    await database.db.insert(gameSettings).values({
      key: TRADING_SETTINGS_KEY,
      value: opened() as unknown as Record<string, unknown>,
      version: 1,
      updatedAt: new Date(),
    });
    expect((await cache.trading()).trading).toBe(true);
  });

  it('the writing instance sees an admin save at once, without waiting for the TTL', async () => {
    expect((await app.gameSettings.trading()).trading).toBe(false);
    const loads = app.gameSettings.loads;
    expect((await save(who.admin, opened(), 0)).statusCode).toBe(200);
    expect((await app.gameSettings.trading()).trading).toBe(true);
    expect(app.gameSettings.loads).toBe(loads + 1);
    clockMs += 1; // still well inside the TTL
    await app.gameSettings.trading();
    expect(app.gameSettings.loads).toBe(loads + 1);
  });
});

describe('the onSettingsChanged seam (T.5 voids offers here)', () => {
  beforeEach(reset);

  it('runs inside the edit with the switches turned off', async () => {
    const seen: TradingSettingsChangeEvent[] = [];
    const off = app.settingsEvents.onSettingsChanged(async (event, tx) => {
      seen.push(event);
      // Inside the transaction: the new row is visible.
      const [row] = await tx.select().from(gameSettings);
      expect(row?.version).toBe(event.version);
    });
    try {
      await save(who.admin, opened(), 0);
      const closed = opened();
      closed.trading = false;
      closed.tradeable.epic = false;
      await save(who.admin, closed, 1);
    } finally {
      off();
    }
    expect(seen.map((e) => e.switchedOff)).toEqual([[], ['trading', 'tradeable.epic']]);
    expect(seen[1]).toMatchObject({ version: 2, actorAccountId: who.admin.id });
  });

  it('a listener that throws refuses the whole edit', async () => {
    const off = app.settingsEvents.onSettingsChanged(async () => {
      throw new Error('void failed');
    });
    try {
      const res = await save(who.admin, opened(), 0);
      expect(res.statusCode).toBe(500);
    } finally {
      off();
    }
    expect((await database.db.select().from(gameSettings)).length).toBe(0);
    expect((await settingsAudits()).length).toBe(0);
  });
});

describe('item views and invariance', () => {
  let owner: TestAccount;
  let heroId: string;
  let epicId: string;
  let voidMythicId: string;

  beforeAll(async () => {
    owner = await insertAccount(database.db, { name: 'Trader Tamsin' });
    heroId = (await insertCharacter(database.db, owner.id, { level: 20 })).id;
    epicId = (await insertItem(database.db, heroId, { rarityId: 'epic' })).id;
    voidMythicId = (await insertItem(database.db, heroId, { rarityId: 'mythic' })).id;
    const bound = await insertItem(database.db, heroId, { rarityId: 'rare' });
    // Fresh farming drops: bind on equip (T.1).
    await database.db
      .update(itemInstances)
      .set({ source: 'farming', binding: 'equip' })
      .where(sql`${itemInstances.id} in (${epicId}, ${voidMythicId})`);
    await database.db
      .update(itemInstances)
      .set({ variant: 'void' })
      .where(eq(itemInstances.id, voidMythicId));
    await database.db
      .update(itemInstances)
      .set({ source: 'farming', binding: 'account' })
      .where(eq(itemInstances.id, bound.id));
  });

  beforeEach(reset);

  const inventory = async (): Promise<InventoryView> => {
    const res = await get(owner, `/api/characters/${heroId}/inventory`);
    expect(res.statusCode).toBe(200);
    return res.json();
  };
  const tradeable = async () =>
    Object.fromEntries((await inventory()).inventory.map((i) => [i.id, i.tradeable]));

  it('tradeable flips only when master + items + category are all on', async () => {
    let version = 0;
    for (const trading of [false, true]) {
      for (const items of [false, true]) {
        for (const epic of [false, true]) {
          const s = clone(DEFAULT_TRADING_SETTINGS);
          s.trading = trading;
          s.trade.items = items;
          s.tradeable.epic = epic;
          // Unrelated switches on: they open nothing.
          s.trade.materials = s.trade.gold = true;
          s.shelf.items = s.shelf.materials = s.shelf.gold = true;
          s.tradeable.mythic = true;
          const res = await save(who.admin, s, version);
          expect(res.statusCode).toBe(200);
          version = res.json().version;
          const t = await tradeable();
          expect(t[epicId], `${trading}/${items}/${epic}`).toBe(trading && items && epic);
          // The Void Mythic also needs "Tradeable: Void".
          expect(t[voidMythicId]).toBe(false);
          // An account-bound item never is.
          expect(Object.values(t).filter(Boolean).length).toBe(trading && items && epic ? 1 : 0);
        }
      }
    }
    const all = opened();
    for (const c of Object.keys(all.tradeable) as (keyof TradingSettings['tradeable'])[]) {
      all.tradeable[c] = true;
    }
    expect((await save(who.admin, all, version)).statusCode).toBe(200);
    expect((await tradeable())[voidMythicId]).toBe(true);
  });

  it('nothing is tradeable at launch (the defaults)', async () => {
    expect(Object.values(await tradeable()).every((t) => t === false)).toBe(true);
  });

  it('invariance: opening everything changes only `tradeable`, never the hero or its items', async () => {
    const before = await inventory();
    const [heroBefore] = await database.db
      .select()
      .from(characters)
      .where(eq(characters.id, heroId));
    const itemsBefore = await database.db
      .select()
      .from(itemInstances)
      .where(eq(itemInstances.characterId, heroId));
    const all = opened();
    all.trade.materials = all.trade.gold = true;
    all.shelf.items = all.shelf.materials = all.shelf.gold = true;
    for (const c of Object.keys(all.tradeable) as (keyof TradingSettings['tradeable'])[]) {
      all.tradeable[c] = true;
    }
    for (const id of TRADING_LIMIT_IDS) all.limits[id] = TRADING_LIMITS[id].max;
    expect((await save(who.admin, all, 0)).statusCode).toBe(200);
    const after = await inventory();
    const strip = (v: InventoryView) => ({
      ...v,
      inventory: v.inventory.map(({ tradeable: _t, ...rest }) => rest),
      equipped: v.equipped.map(({ tradeable: _t, ...rest }) => rest),
    });
    expect(strip(after)).toEqual(strip(before));
    expect(after.stats).toEqual(before.stats);
    const [heroAfter] = await database.db
      .select()
      .from(characters)
      .where(eq(characters.id, heroId));
    expect(heroAfter).toEqual(heroBefore);
    expect(
      await database.db.select().from(itemInstances).where(eq(itemInstances.characterId, heroId)),
    ).toEqual(itemsBefore);
  });
});

describe('store helpers', () => {
  beforeEach(reset);

  it('loadTradingSettings inside a transaction reads the table, not the cache', async () => {
    const { loadTradingSettings } = await import('./store.js');
    await app.gameSettings.trading(); // warm the cache with the defaults
    await database.db.insert(gameSettings).values({
      key: TRADING_SETTINGS_KEY,
      value: opened() as unknown as Record<string, unknown>,
      version: 1,
      updatedAt: new Date(),
    });
    const inTx = await withTransaction(database.db, (tx) => loadTradingSettings(tx));
    expect(inTx.trading).toBe(true);
    expect((await app.gameSettings.trading()).trading).toBe(false);
  });
});
