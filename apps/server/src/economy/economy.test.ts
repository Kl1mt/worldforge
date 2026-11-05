import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import {
  buyPrice,
  generateItem,
  salvageYield,
  sellPrice,
  type RarityId,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/index.js';
import {
  auditLog,
  characterMaterials,
  characters,
  idempotencyKeys,
  itemInstances,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { createTestDatabase } from '../test/db.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import {
  IDEMPOTENCY_REPLAYED_HEADER,
  canonicalJson,
  pruneIdempotencyKeys,
} from '../idempotency/index.js';
import type { MerchantResponse } from '../merchant/routes.js';
import type { ForgeResponse } from '../forge/routes.js';

const HOUR = 60 * 60 * 1000;
let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.parse('2026-11-04T12:00:00Z');

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({
    database,
    auth: { registerRateLimit: { max: 1000, timeWindowMs: 60_000 } },
    activity: { ...DEFAULT_ACTIVITY_OPTIONS, now: () => new Date(nowMs) },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.close();
});

interface Player {
  token: string;
  accountId: string;
  id: string;
}

let seq = 0;
function letters(n: number): string {
  let s = '';
  do {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  } while (n > 0);
  return s;
}

async function newPlayer(gold = 0, classId = 'warrior'): Promise<Player> {
  seq += 1;
  const reg = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email: `trader${seq}@graumark.test`,
      displayName: `Trader ${seq}`,
      password: 'ashes-and-iron-42',
    },
  });
  const token = reg.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error(`register failed: ${reg.statusCode}`);
  const created = await app.inject({
    method: 'POST',
    url: '/api/characters',
    payload: { name: `Hagen${letters(seq)}`, classId, appearance: { banner: 'ember' } },
    cookies: { [SESSION_COOKIE]: token },
  });
  const id = created.json<{ character: { id: string } }>().character.id;
  if (gold) await database.db.update(characters).set({ gold }).where(eq(characters.id, id));
  return { token, accountId: reg.json<{ account: { id: string } }>().account.id, id };
}

async function grant(
  p: Player,
  baseId = 'iron-helm',
  rarityId: RarityId = 'common',
  itemLevel = 5,
): Promise<string> {
  const item = generateItem({ seed: 11, itemLevel, baseId, rarityId })!;
  const id = uuidv7();
  await database.db
    .insert(itemInstances)
    .values({ id, characterId: p.id, ...item, source: 'test' });
  return id;
}

function call(
  p: Player,
  method: 'GET' | 'POST',
  path: string,
  payload?: object,
  key: string | null = randomUUID(),
) {
  return app.inject({
    method,
    url: `/api/characters/${p.id}${path}`,
    ...(payload ? { payload } : {}),
    headers: key ? { 'idempotency-key': key } : {},
    cookies: { [SESSION_COOKIE]: p.token },
  });
}

const goldOf = async (p: Player) =>
  (await database.db.select().from(characters).where(eq(characters.id, p.id)))[0]!.gold;
const itemsOf = (p: Player) =>
  database.db.select().from(itemInstances).where(eq(itemInstances.characterId, p.id));
const audits = (p: Player, event: string) =>
  database.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.characterId, p.id), eq(auditLog.event, event)));
async function materialsOf(p: Player): Promise<Record<string, number>> {
  const rows = await database.db
    .select()
    .from(characterMaterials)
    .where(eq(characterMaterials.characterId, p.id));
  return Object.fromEntries(
    rows.filter((r) => r.quantity > 0).map((r) => [r.materialId, r.quantity]),
  );
}

describe('Idempotency-Key', () => {
  it('is required and validated on value-moving endpoints', async () => {
    const p = await newPlayer();
    const item = await grant(p);
    const missing = await call(p, 'POST', '/merchant/sell', { itemIds: [item] }, null);
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('idempotency_key_required');
    const bad = await call(p, 'POST', '/merchant/sell', { itemIds: [item] }, 'short');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('validation_failed');
    expect(await itemsOf(p)).toHaveLength(1);
  });

  it('replays the stored response for a retry and moves value once', async () => {
    const p = await newPlayer();
    const item = await grant(p, 'iron-helm', 'rare', 10);
    const key = randomUUID();
    const first = await call(p, 'POST', '/merchant/sell', { itemIds: [item] }, key);
    expect(first.statusCode).toBe(200);
    expect(first.headers[IDEMPOTENCY_REPLAYED_HEADER]).toBeUndefined();
    const again = await call(p, 'POST', '/merchant/sell', { itemIds: [item] }, key);
    expect(again.statusCode).toBe(200);
    expect(again.headers[IDEMPOTENCY_REPLAYED_HEADER]).toBe('true');
    expect(again.json()).toEqual(first.json());
    expect(await goldOf(p)).toBe(sellPrice({ rarityId: 'rare', itemLevel: 10 }));
    expect(await audits(p, 'merchant.sell')).toHaveLength(1);
    // A new key for the same (now gone) item is a fresh request: 404.
    expect((await call(p, 'POST', '/merchant/sell', { itemIds: [item] })).statusCode).toBe(404);
  });

  it('refuses the same key with another body or path', async () => {
    const p = await newPlayer();
    const [a, b] = [await grant(p), await grant(p)];
    const key = randomUUID();
    expect((await call(p, 'POST', '/merchant/sell', { itemIds: [a] }, key)).statusCode).toBe(200);
    const other = await call(p, 'POST', '/merchant/sell', { itemIds: [b] }, key);
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe('idempotency_conflict');
    const path = await call(p, 'POST', '/forge/salvage', { itemIds: [a] }, key);
    expect(path.json().error.code).toBe('idempotency_conflict');
    expect((await itemsOf(p)).map((i) => i.id)).toEqual([b]);
  });

  it('stores nothing for a failed request, so the key can be retried', async () => {
    const p = await newPlayer(0);
    const stock = (await call(p, 'GET', '/merchant')).json<MerchantResponse>();
    const offer = stock.offers[0]!;
    const key = randomUUID();
    const poor = await call(p, 'POST', '/merchant/buy', { offerId: offer.offerId }, key);
    expect(poor.statusCode).toBe(422);
    expect(poor.json().error).toMatchObject({
      code: 'insufficient_gold',
      details: { required: offer.price, held: 0 },
    });
    await database.db.update(characters).set({ gold: offer.price }).where(eq(characters.id, p.id));
    const rich = await call(p, 'POST', '/merchant/buy', { offerId: offer.offerId }, key);
    expect(rich.statusCode).toBe(200);
    expect(await goldOf(p)).toBe(0);
  });

  it('keys are per account', async () => {
    const [p, q] = [await newPlayer(), await newPlayer()];
    const key = randomUUID();
    const [a, b] = [await grant(p), await grant(q)];
    expect((await call(p, 'POST', '/merchant/sell', { itemIds: [a] }, key)).statusCode).toBe(200);
    const res = await call(q, 'POST', '/merchant/sell', { itemIds: [b] }, key);
    expect(res.statusCode).toBe(200);
    expect(res.headers[IDEMPOTENCY_REPLAYED_HEADER]).toBeUndefined();
  });

  it('expires after 24 hours: the key is reusable and pruned', async () => {
    const p = await newPlayer();
    const [a, b] = [await grant(p), await grant(p)];
    const key = randomUUID();
    expect((await call(p, 'POST', '/merchant/sell', { itemIds: [a] }, key)).statusCode).toBe(200);
    nowMs += 25 * HOUR;
    const reused = await call(p, 'POST', '/merchant/sell', { itemIds: [b] }, key);
    expect(reused.statusCode).toBe(200);
    expect(reused.headers[IDEMPOTENCY_REPLAYED_HEADER]).toBeUndefined();
    nowMs += 25 * HOUR;
    expect(await pruneIdempotencyKeys(database.db, new Date(nowMs))).toBeGreaterThan(0);
    const left = await database.db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.accountId, p.accountId));
    expect(left).toHaveLength(0);
  });

  it('hashes bodies canonically', () => {
    expect(canonicalJson({ b: [1, { d: 1, c: 2 }], a: null })).toBe(
      canonicalJson({ a: null, b: [1, { c: 2, d: 1 }] }),
    );
  });
});

describe('merchant', () => {
  it('shows a daily stock for unlocked areas only, the same on every call', async () => {
    const p = await newPlayer();
    const first = (await call(p, 'GET', '/merchant')).json<MerchantResponse>();
    expect(first.day).toBe(new Date(nowMs).toISOString().slice(0, 10));
    expect(first.offers.length).toBeGreaterThan(0);
    expect(new Set(first.offers.map((o) => o.areaId))).toEqual(new Set(['abandonedFields']));
    for (const o of first.offers) expect(o.price).toBe(buyPrice(o.item));
    expect((await call(p, 'GET', '/merchant')).json()).toEqual(first);
    await database.db.update(characters).set({ level: 9 }).where(eq(characters.id, p.id));
    const later = (await call(p, 'GET', '/merchant')).json<MerchantResponse>();
    expect(new Set(later.offers.map((o) => o.areaId))).toEqual(
      new Set(['abandonedFields', 'crowwood', 'oldBurialGrounds']),
    );
  });

  it('sells an offer once per day, spending the price', async () => {
    const p = await newPlayer(10_000);
    const offer = (await call(p, 'GET', '/merchant')).json<MerchantResponse>().offers[0]!;
    const res = await call(p, 'POST', '/merchant/buy', { offerId: offer.offerId });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.character.gold).toBe(10_000 - offer.price);
    expect(body.item).toMatchObject({ ...offer.item, source: 'merchant', equippedSlot: null });
    expect(body.inventory.inventory.map((i: { id: string }) => i.id)).toContain(body.item.id);
    const twice = await call(p, 'POST', '/merchant/buy', { offerId: offer.offerId });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.code).toBe('offer_sold_out');
    const after = (await call(p, 'GET', '/merchant')).json<MerchantResponse>();
    expect(after.offers.find((o) => o.offerId === offer.offerId)!.soldOut).toBe(true);
    expect(await audits(p, 'merchant.buy')).toHaveLength(1);
  });

  it('refuses stale, unknown and locked offers', async () => {
    const p = await newPlayer(10_000);
    const offer = (await call(p, 'GET', '/merchant')).json<MerchantResponse>().offers[0]!;
    const day = offer.offerId.slice(0, 10);
    expect((await call(p, 'POST', '/merchant/buy', { offerId: 'nonsense' })).statusCode).toBe(404);
    const locked = await call(p, 'POST', '/merchant/buy', { offerId: `${day}.blackwater.0` });
    expect(locked.statusCode).toBe(404);
    expect(
      (await call(p, 'POST', '/merchant/buy', { offerId: `${day}.abandonedFields.9` })).statusCode,
    ).toBe(404);
    nowMs += 24 * HOUR;
    const stale = await call(p, 'POST', '/merchant/buy', { offerId: offer.offerId });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('offer_expired');
    expect(await goldOf(p)).toBe(10_000);
  });

  it('refuses to buy into a full pack', async () => {
    const p = await newPlayer(10_000);
    const capacity = DEFAULT_ACTIVITY_OPTIONS.rules.inventory.capacity;
    const item = generateItem({ seed: 3, itemLevel: 2, baseId: 'iron-helm', rarityId: 'common' })!;
    await database.db.insert(itemInstances).values(
      Array.from({ length: capacity }, () => ({
        id: uuidv7(),
        characterId: p.id,
        ...item,
        source: 'test',
      })),
    );
    const offer = (await call(p, 'GET', '/merchant')).json<MerchantResponse>().offers[0]!;
    const res = await call(p, 'POST', '/merchant/buy', { offerId: offer.offerId });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('inventory_full');
  });

  it('buys several items at their quoted prices, but never equipped ones', async () => {
    const p = await newPlayer();
    const a = await grant(p, 'iron-helm', 'common', 5);
    const b = await grant(p, 'brass-ring', 'epic', 12);
    const worn = await grant(p, 'leather-boots');
    expect((await call(p, 'POST', `/items/${worn}/equip`)).statusCode).toBe(200);
    const quotes = (await call(p, 'GET', '/merchant')).json<MerchantResponse>().sellPrices;
    expect(quotes.map((q) => q.itemId).sort()).toEqual([a, b].sort());
    const equipped = await call(p, 'POST', '/merchant/sell', { itemIds: [a, worn] });
    expect(equipped.statusCode).toBe(409);
    expect(equipped.json().error.code).toBe('item_equipped');
    expect(await itemsOf(p)).toHaveLength(3);
    const res = await call(p, 'POST', '/merchant/sell', { itemIds: [a, b] });
    const total = quotes.reduce((s, q) => s + q.price, 0);
    expect(res.json()).toMatchObject({ goldGained: total, character: { gold: total } });
    expect((await itemsOf(p)).map((i) => i.id)).toEqual([worn]);
  });

  it('does not let another account touch the character', async () => {
    const [p, q] = [await newPlayer(), await newPlayer()];
    const item = await grant(p);
    const res = await call({ ...q, id: p.id }, 'POST', '/merchant/sell', { itemIds: [item] });
    expect(res.statusCode).toBe(404);
    expect((await call({ ...q, id: p.id }, 'GET', '/merchant')).statusCode).toBe(404);
    expect(await itemsOf(p)).toHaveLength(1);
  });
});

describe('forge', () => {
  it('salvages items into materials and a little gold', async () => {
    const p = await newPlayer();
    const a = await grant(p, 'iron-helm', 'common', 5);
    const b = await grant(p, 'barbute', 'rare', 10);
    const view = (await call(p, 'GET', '/forge')).json<ForgeResponse>();
    expect(view.salvage).toHaveLength(2);
    const res = await call(p, 'POST', '/forge/salvage', { itemIds: [a, b] });
    expect(res.statusCode).toBe(200);
    const ya = salvageYield({ baseId: 'iron-helm', rarityId: 'common', itemLevel: 5 });
    const yb = salvageYield({ baseId: 'barbute', rarityId: 'rare', itemLevel: 10 });
    expect(res.json().salvaged.gold).toBe(ya.gold + yb.gold);
    expect(await goldOf(p)).toBe(ya.gold + yb.gold);
    expect(await materialsOf(p)).toEqual({ timber: 3, rawHide: 2, soulShard: 1 });
    expect(res.json().materials).toEqual([
      { materialId: 'timber', quantity: 3 },
      { materialId: 'rawHide', quantity: 2 },
      { materialId: 'soulShard', quantity: 1 },
    ]);
    expect(await itemsOf(p)).toHaveLength(0);
    expect(await audits(p, 'forge.salvage')).toHaveLength(1);
  });

  it('crafts gear in the chosen slot, spending materials and gold', async () => {
    const p = await newPlayer(100, 'mage');
    await database.db.insert(characterMaterials).values([
      { characterId: p.id, materialId: 'timber', quantity: 32 },
      { characterId: p.id, materialId: 'ashwort', quantity: 15 },
    ]);
    const view = (await call(p, 'GET', '/forge')).json<ForgeResponse>();
    const t1 = view.recipes.find((r) => r.recipeId === 'fieldsmithWork')!;
    expect(t1.blockers).toEqual([]);
    expect(t1.slots).not.toContain('offhand');
    expect(view.recipes.find((r) => r.recipeId === 'marchwardenWork')!.blockers[0]).toEqual({
      kind: 'level',
      required: 9,
    });
    const wrong = await call(p, 'POST', '/forge/craft', {
      recipeId: 'fieldsmithWork',
      slot: 'offhand',
    });
    expect(wrong.json().error.code).toBe('wrong_slot');
    const res = await call(p, 'POST', '/forge/craft', {
      recipeId: 'fieldsmithWork',
      slot: 'weapon',
    });
    expect(res.statusCode).toBe(200);
    const { item, character } = res.json();
    expect(item).toMatchObject({ baseId: 'skull-staff', source: 'forge' });
    expect(item.rarityId).not.toBe('common');
    expect(character.gold).toBe(70);
    expect(await materialsOf(p)).toEqual({ timber: 2 });
    const again = await call(p, 'POST', '/forge/craft', {
      recipeId: 'fieldsmithWork',
      slot: 'weapon',
    });
    expect(again.statusCode).toBe(422);
    expect(again.json().error).toMatchObject({ code: 'insufficient_materials' });
    expect(again.json().error.details.blockers).toContainEqual({
      kind: 'material',
      materialId: 'timber',
      required: 30,
      held: 2,
    });
    expect(await itemsOf(p)).toHaveLength(1);
  });

  it('replays a craft with the same key instead of crafting twice', async () => {
    const p = await newPlayer(1_000);
    await database.db.insert(characterMaterials).values([
      { characterId: p.id, materialId: 'timber', quantity: 100 },
      { characterId: p.id, materialId: 'ashwort', quantity: 100 },
    ]);
    const key = randomUUID();
    const body = { recipeId: 'fieldsmithWork', slot: 'chest' };
    const first = await call(p, 'POST', '/forge/craft', body, key);
    const second = await call(p, 'POST', '/forge/craft', body, key);
    expect(second.json()).toEqual(first.json());
    expect(await itemsOf(p)).toHaveLength(1);
    expect(await goldOf(p)).toBe(970);
    expect(await materialsOf(p)).toEqual({ timber: 70, ashwort: 85 });
  });

  it('refuses recipes above the level and unknown recipes', async () => {
    const p = await newPlayer(10_000);
    const res = await call(p, 'POST', '/forge/craft', { recipeId: 'knightlyWork', slot: 'head' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('recipe_locked');
    const unknown = await call(p, 'POST', '/forge/craft', { recipeId: 'awakening', slot: 'head' });
    expect(unknown.statusCode).toBe(400);
  });

  it('settles the running activity before changing the pack (ticket 1.9)', async () => {
    const p = await newPlayer();
    const item = await grant(p);
    const start = await call(p, 'POST', '/activity', { areaId: 'abandonedFields' }, null);
    expect(start.statusCode).toBe(201);
    nowMs += HOUR;
    const res = await call(p, 'POST', '/forge/salvage', { itemIds: [item] });
    expect(res.statusCode).toBe(200);
    expect(await audits(p, 'activity.reward')).toHaveLength(1);
    await call(p, 'POST', '/activity/stop', undefined, null);
  });
});
