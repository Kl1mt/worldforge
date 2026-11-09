/**
 * Held value on every spend path (ticket T.5, docs/TRADING.md "Cooldowns", docs/ECONOMY.md
 * "Held value"): gold and materials received in a trade can't be spent for 72 hours, wherever the
 * game spends them. A hero whose whole purse and stock came from a gift is refused by every spend
 * path; 72 hours later the same requests go through. A static guard fails if a new code path
 * writes a hero's gold or materials without going through the two hold-aware helpers.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { characters, itemInstances } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { createTestDatabase } from '../test/db.js';
import { insertItem } from '../test/heroes.js';
import { openWarehouse } from '../test/warehouse.js';
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
import { withTransaction } from '../db/transaction.js';
import { changeGold } from '../economy/shared.js';
import { changeMaterialsTx } from '../materials/store.js';
import { reconcileWithAudit } from '../telemetry/report.js';

const HOUR = 3_600_000;
const START = new Date('2031-04-07T09:00:00.000Z');
let clock = START;
const now = () => clock;

let database: DatabaseHandle;
let app: FastifyInstance;
let t: ReturnType<typeof tradeCalls>;
let giver: Trader;
let held: Trader;

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
  await setTradingSettings(app, database.db, ALL_TRADING_ON);
  await openWarehouse(app, database.db, START);
  giver = await insertTrader(database.db, clock, { gold: 50_000 });
  held = await insertTrader(database.db, clock, { gold: 0 });
  await befriendSince(database.db, giver, held, clock);
  // The gift: 5,000 gold, 100 timber and 30 iron ore, all held on a hero that had none.
  await giveMaterials(database.db, giver.hero.id, { timber: 200, ironOre: 100 });
  const sent = await t.send(giver, held, {
    give: { gold: 5_000, materials: { timber: 100, ironOre: 30 } },
  });
  expect(sent.statusCode, sent.body).toBe(201);
  const ok = await t.act(held, sent.json().id, 'accept', { characterId: held.hero.id });
  expect(ok.statusCode, ok.body).toBe(200);
  // The hero's own (unheld) ashwort, so the craft is short of nothing but unheld gold and timber.
  await giveMaterials(database.db, held.hero.id, { ashwort: 50 });
});

afterAll(async () => {
  await app?.close();
  await database?.close();
});

const call = (path: string, payload: object, method: 'POST' | 'GET' = 'POST') =>
  app.inject({
    method,
    url: `/api/characters/${held.hero.id}${path}`,
    ...(method === 'POST' ? { payload, headers: { 'idempotency-key': randomUUID() } } : {}),
    cookies: { [SESSION_COOKIE]: held.token },
  });

const gold = async () =>
  (await database.db.select().from(characters).where(eq(characters.id, held.hero.id)))[0]!.gold;

/** Every spend path of the game, as the held hero would use it. */
const SPEND_PATHS: [
  string,
  () => Promise<{ statusCode: number; json: () => { error: { code: string } } }>,
][] = [
  [
    'merchant: buy',
    async () => {
      const stock = await call('/merchant', {}, 'GET');
      return call('/merchant/buy', { offerId: stock.json().offers[0].offerId });
    },
  ],
  ['forge: craft', () => call('/forge/craft', { recipeId: 'fieldsmithWork', slot: 'weapon' })],
  [
    'forge: upgrade',
    async () => {
      const item = await insertItem(database.db, held.hero.id, { rarityId: 'rare' });
      return call('/forge/upgrade', { itemId: item.id });
    },
  ],
  [
    'guild: creation',
    () =>
      app.inject({
        method: 'POST',
        url: '/api/guilds',
        payload: { characterId: held.hero.id, name: 'Held Purse Wardens', tag: 'HPW' },
        headers: { 'idempotency-key': randomUUID() },
        cookies: { [SESSION_COOKIE]: held.token },
      }),
  ],
  [
    'community: gold contribution',
    () =>
      app.inject({
        method: 'POST',
        url: '/api/community/projects/restoreWarehouse/contribute',
        payload: {
          characterId: held.hero.id,
          stageId: 'clearRubble',
          offer: [{ resource: 'gold', amount: 500 }],
        },
        headers: { 'idempotency-key': randomUUID() },
        cookies: { [SESSION_COOKIE]: held.token },
      }),
  ],
  [
    'community: material contribution',
    () =>
      app.inject({
        method: 'POST',
        url: '/api/community/projects/restoreWarehouse/contribute',
        payload: {
          characterId: held.hero.id,
          stageId: 'clearRubble',
          offer: [{ resource: 'timber', amount: 30 }],
        },
        headers: { 'idempotency-key': randomUUID() },
        cookies: { [SESSION_COOKIE]: held.token },
      }),
  ],
  ['warehouse: upgrade', () => call('/warehouse/upgrade', { level: 0 })],
  ['shelf: gold deposit', () => call('/shelf/deposit', { gold: 100 })],
  ['shelf: material deposit', () => call('/shelf/deposit', { materials: { timber: 10 } })],
  ['trade: gold in an offer', () => t.send(held, giver, { give: { gold: 100 } })],
  [
    'trade: materials in an offer',
    () => t.send(held, giver, { give: { materials: { ironOre: 5 } } }),
  ],
];

describe('held gold and materials on every spend path', () => {
  it('refuses every path while held', async () => {
    const before = await gold();
    expect(before).toBe(5_000);
    for (const [name, attempt] of SPEND_PATHS) {
      const res = await attempt();
      expect(res.statusCode, `${name}: ${JSON.stringify(res.json())}`).toBe(422);
      expect(['insufficient_gold', 'insufficient_materials'], name).toContain(
        res.json().error.code,
      );
    }
    // Some community projects may be closed in a fresh world; whatever answered, nothing was spent.
    expect(await gold()).toBe(before);
  });

  it('lets the same requests through once the hold ends', async () => {
    clock = new Date(START.getTime() + 72 * HOUR);
    // Enough of the hero's own gold for every path in a row (the 5,000 alone covers each one).
    await database.db
      .update(characters)
      .set({ gold: 30_000 })
      .where(eq(characters.id, held.hero.id));
    for (const [name, attempt] of SPEND_PATHS) {
      const res = await attempt();
      expect([200, 201], `${name}: ${JSON.stringify(res.json())}`).toContain(res.statusCode);
    }
    expect(await gold()).toBeLessThan(30_000);
    const checks = await reconcileWithAudit(database.db);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  });

  it('the helpers themselves refuse a spend into held value', async () => {
    const other = await insertTrader(database.db, clock, { gold: 0 });
    await befriendSince(database.db, giver, other, clock);
    const sent = await t.send(giver, other, { give: { gold: 1_000, materials: { timber: 10 } } });
    await t.act(other, sent.json().id, 'accept', { characterId: other.hero.id });
    const [hero] = await database.db
      .select()
      .from(characters)
      .where(eq(characters.id, other.hero.id));
    await expect(
      withTransaction(database.db, (tx) => changeGold(tx, hero!, -1, clock)),
    ).rejects.toMatchObject({ code: 'insufficient_gold' });
    await expect(
      withTransaction(database.db, (tx) =>
        changeMaterialsTx(tx, other.hero.id, { timber: -1 }, clock),
      ),
    ).rejects.toMatchObject({ code: 'insufficient_materials' });
    // Gains are never refused.
    await withTransaction(database.db, (tx) => changeGold(tx, hero!, 10, clock));
  });
});

/**
 * The guard: every write to a hero's gold or material stacks lives in a known place. Spends go
 * through `changeGold` / `changeMaterialsTx` (hold-aware); the other sites only ever add (farming
 * and crypt settlement, quest rewards). A new file that writes either directly fails here: route
 * it through the helpers (or, if it only adds, list it with the reason).
 */
/**
 * Every way an item can leave its hero or be changed for good, tried on an item received in a
 * trade (ticket T.5, docs/TRADING.md "Cooldowns"): each is refused with `item_held` until the
 * 72-hour hold ends, so a reversal (T.6) always finds the item on the hero. Wearing it is allowed;
 * taking items out of the warehouse is never refused.
 */
describe('held items on every path that moves or uses them up', () => {
  const BASE = new Date(START.getTime() + 200 * HOUR);
  let receiver: Trader;
  let itemId: string;
  const as = (path: string, payload: object, method: 'POST' | 'DELETE' = 'POST') =>
    app.inject({
      method,
      url: `/api/characters/${receiver.hero.id}${path}`,
      ...(method === 'POST' ? { payload, headers: { 'idempotency-key': randomUUID() } } : {}),
      cookies: { [SESSION_COOKIE]: receiver.token },
    });
  const ITEM_PATHS: [
    string,
    () => Promise<{ statusCode: number; json: () => { error: { code: string } } }>,
  ][] = [
    ['merchant: sell', () => as('/merchant/sell', { itemIds: [itemId] })],
    ['forge: salvage', () => as('/forge/salvage', { itemIds: [itemId] })],
    ['forge: upgrade', () => as('/forge/upgrade', { itemId })],
    ['inventory: discard', () => as(`/items/${itemId}`, {}, 'DELETE')],
    ['shelf: deposit', () => as('/shelf/deposit', { itemIds: [itemId] })],
    ['warehouse: deposit', () => as('/warehouse/deposit', { itemIds: [itemId] })],
    ['trade: offer', () => t.send(receiver, giver, { give: { itemIds: [itemId] } })],
  ];

  beforeAll(async () => {
    clock = BASE;
    receiver = await insertTrader(database.db, clock, { gold: 0 });
    await befriendSince(database.db, giver, receiver, clock);
    const epic = await insertTradeItem(database.db, giver.hero.id);
    itemId = epic.id;
    const sent = await t.send(giver, receiver, { give: { itemIds: [itemId] } });
    expect(sent.statusCode, sent.body).toBe(201);
    const ok = await t.act(receiver, sent.json().id, 'accept', { characterId: receiver.hero.id });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('refuses every path while held (the trade offer as a bound item), and keeps the item', async () => {
    clock = BASE;
    for (const [name, attempt] of ITEM_PATHS) {
      const res = await attempt();
      expect(res.statusCode, `${name}: ${JSON.stringify(res.json())}`).toBe(409);
      // A traded item is bound for good, so offering it again is refused for that reason first.
      expect(['item_held', 'trade_refused'], name).toContain(res.json().error.code);
      if (name !== 'trade: offer') expect(res.json().error.code, name).toBe('item_held');
    }
    const [row] = await database.db
      .select()
      .from(itemInstances)
      .where(eq(itemInstances.id, itemId));
    expect(row).toMatchObject({
      characterId: receiver.hero.id,
      inWarehouse: false,
      onShelf: false,
    });
  });

  it('lets it go into the warehouse once the hold ends, and out again', async () => {
    clock = new Date(BASE.getTime() + 72 * HOUR);
    const stored = await as('/warehouse/deposit', { itemIds: [itemId] });
    expect(stored.statusCode, stored.body).toBe(200);
    const back = await as('/warehouse/withdraw', { itemIds: [itemId] });
    expect(back.statusCode, back.body).toBe(200);
  });
});

describe('spend-path guard', () => {
  const SRC = join(import.meta.dirname, '..');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) return files(p);
      return p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.includes(`${'/test/'}`) ? [p] : [];
    });
  const sources = files(SRC).map((p) => ({
    path: relative(SRC, p),
    text: readFileSync(p, 'utf8'),
  }));

  /** Files allowed to write `characters.gold`, and why. */
  const GOLD_WRITERS: Record<string, string> = {
    'economy/shared.ts': 'changeGold: every spend (hold-aware) and credit',
    'activity/settle.ts': 'farming settlement credits gold',
    'dungeon/routes.ts': 'a crypt claim credits gold',
    'quests/store.ts': 'quest rewards credit gold',
    'telemetry/simulate.ts':
      'the offline balance simulation seeds its heroes (never a server path)',
  };
  /** Files allowed to write `character_materials`, and why. */
  const MATERIAL_WRITERS: Record<string, string> = {
    'materials/store.ts': 'changeMaterialsTx: every spend (hold-aware) and credit; gathering',
    'quests/store.ts': 'quest rewards credit materials',
    'telemetry/simulate.ts':
      'the offline balance simulation seeds its heroes (never a server path)',
  };

  it('finds every gold write in an allowed file', () => {
    const writers = sources
      .filter(({ text }) =>
        [...text.matchAll(/\.update\(characters\)([\s\S]*?)\.where\(/g)].some((m) =>
          /\bgold\b/.test(m[1]!),
        ),
      )
      .map((s) => s.path)
      .sort();
    expect(writers).toEqual(Object.keys(GOLD_WRITERS).sort());
  });

  it('finds every material write in an allowed file', () => {
    const writers = sources
      .filter(({ text }) => /\.(insert|update|delete)\(characterMaterials\)/.test(text))
      .map((s) => s.path)
      .sort();
    expect(writers).toEqual(Object.keys(MATERIAL_WRITERS).sort());
  });

  it('allowed non-helper sites only add', () => {
    for (const path of ['activity/settle.ts', 'dungeon/routes.ts', 'quests/store.ts']) {
      const text = sources.find((s) => s.path === path)!.text;
      expect(text, path).not.toMatch(/characters\.gold\}\s*-/);
      expect(text, path).not.toMatch(/characterMaterials\.quantity\}\s*-/);
    }
  });
});
