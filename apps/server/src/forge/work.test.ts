import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import {
  attemptUpgrade,
  createRng,
  generateItem,
  improveAffix,
  quoteUpgrade,
  rerollAffix,
  type RarityId,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/index.js';
import {
  activities,
  auditLog,
  characterMaterials,
  characters,
  itemInstances,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { createTestDatabase } from '../test/db.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { IDEMPOTENCY_REPLAYED_HEADER } from '../idempotency/index.js';
import type { ForgeActionResponse, ForgeItemResponse } from './work.js';

const HOUR = 60 * 60 * 1000;
let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.parse('2026-11-05T12:00:00Z');

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

async function newPlayer(gold = 100_000): Promise<Player> {
  seq += 1;
  const reg = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email: `smith${seq}@graumark.test`,
      displayName: `Smith ${seq}`,
      password: 'ashes-and-iron-42',
    },
  });
  const token = reg.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  const created = await app.inject({
    method: 'POST',
    url: '/api/characters',
    payload: { name: `Wieland${letters(seq)}`, classId: 'warrior', appearance: { banner: 'ash' } },
    cookies: { [SESSION_COOKIE]: token },
  });
  const id = created.json<{ character: { id: string } }>().character.id;
  await database.db.update(characters).set({ gold }).where(eq(characters.id, id));
  await database.db.insert(characterMaterials).values(
    (['timber', 'rawHide', 'ironOre', 'soulShard'] as const).map((materialId) => ({
      characterId: id,
      materialId,
      quantity: 10_000,
    })),
  );
  return { token, id };
}

async function grant(
  p: Player,
  { baseId = 'barbute', rarityId = 'rare' as RarityId, itemLevel = 14, seed = 5 } = {},
  extra: Partial<typeof itemInstances.$inferInsert> = {},
): Promise<string> {
  const item = generateItem({ seed, itemLevel, baseId, rarityId, classId: 'warrior' })!;
  const id = uuidv7();
  await database.db
    .insert(itemInstances)
    .values({ id, characterId: p.id, ...item, source: 'test', ...extra });
  return id;
}

function post(p: Player, path: string, payload: object, key: string | null = randomUUID()) {
  return app.inject({
    method: 'POST',
    url: `/api/characters/${p.id}/forge/${path}`,
    payload,
    headers: key ? { 'idempotency-key': key } : {},
    cookies: { [SESSION_COOKIE]: p.token },
  });
}

const row = async (id: string) =>
  (await database.db.select().from(itemInstances).where(eq(itemInstances.id, id)))[0]!;
const hero = async (id: string) =>
  (await database.db.select().from(characters).where(eq(characters.id, id)))[0]!;
const materials = async (id: string) =>
  Object.fromEntries(
    (
      await database.db
        .select()
        .from(characterMaterials)
        .where(eq(characterMaterials.characterId, id))
    ).map((m) => [m.materialId, m.quantity]),
  );
const audits = (id: string, event: string) =>
  database.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.characterId, id), eq(auditLog.event, event)));
const setItem = (id: string, patch: Partial<typeof itemInstances.$inferInsert>) =>
  database.db.update(itemInstances).set(patch).where(eq(itemInstances.id, id));

/** What the item's stream says the next upgrade does (the server must agree exactly). */
async function predictUpgrade(itemId: string) {
  const r = await row(itemId);
  return attemptUpgrade(r, createRng(`${r.forgeSecret}:${r.forgeCounter}`));
}

describe('forge item view (ticket 3.4)', () => {
  it('quotes the next upgrade, rerolls and improvements, and never shows the forge secret', async () => {
    const p = await newPlayer();
    const itemId = await grant(p);
    const res = await app.inject({
      method: 'GET',
      url: `/api/characters/${p.id}/forge/items/${itemId}`,
      cookies: { [SESSION_COOKIE]: p.token },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ForgeItemResponse>();
    const r = await row(itemId);
    expect(res.body).not.toContain(r.forgeSecret);
    expect(body.forge.upgrade).toMatchObject({
      fromLevel: 0,
      toLevel: 1,
      chance: 1,
      guaranteed: true,
      blockers: [],
    });
    expect(body.forge.reroll!.options).toHaveLength(r.affixes.length);
    for (const options of body.forge.reroll!.options) {
      expect(options.length).toBeGreaterThan(0);
      // A reroll never yields an affix the item keeps.
      const kept = r.affixes.map((a) => a.affixId);
      expect(options.filter((o) => kept.includes(o.affixId)).length).toBeLessThanOrEqual(1);
    }
    expect(body.forge.improve).toHaveLength(r.affixes.length);
    for (const imp of body.forge.improve) {
      expect(imp.value).toBeGreaterThanOrEqual(imp.min);
      expect(imp.value).toBeLessThanOrEqual(imp.max);
    }
  });

  it('answers 404 for an item of another character', async () => {
    const p = await newPlayer();
    const q = await newPlayer();
    const theirs = await grant(q);
    const res = await app.inject({
      method: 'GET',
      url: `/api/characters/${p.id}/forge/items/${theirs}`,
      cookies: { [SESSION_COOKIE]: p.token },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('upgrades (ticket 3.4)', () => {
  it('pays, applies the stream’s outcome and advances the counter once', async () => {
    const p = await newPlayer();
    const itemId = await grant(p);
    const before = await row(itemId);
    const quote = quoteUpgrade(before);
    if (!quote.ok) throw new Error(quote.reason);
    const res = await post(p, 'upgrade', { itemId });
    expect(res.statusCode).toBe(200);
    const body = res.json<ForgeActionResponse>();
    expect(body.outcome).toMatchObject({ action: 'upgrade', success: true, upgradeLevel: 1 });
    expect(body.item.upgradeLevel).toBe(1);
    expect(body.paid.gold).toBe(quote.value.cost.gold);
    expect(body.character.gold).toBe(100_000 - quote.value.cost.gold);
    const after = await row(itemId);
    expect(after).toMatchObject({ upgradeLevel: 1, upgradePity: 0, forgeCounter: 1 });
    expect(after.forgeSecret).toBe(before.forgeSecret);
    const mats = await materials(p.id);
    for (const [id, n] of Object.entries(quote.value.cost.materials)) {
      expect(mats[id]).toBe(10_000 - n!);
    }
    const [audit] = await audits(p.id, 'forge.upgrade');
    expect(audit!.data).toMatchObject({ itemId, fromLevel: 0, toLevel: 1, forgeCounter: 0 });
    expect(JSON.stringify(audit!.data)).not.toContain(before.forgeSecret);
  });

  it('every outcome is the one the item’s stream fixed in advance; failures never downgrade', async () => {
    const p = await newPlayer(1_000_000);
    const itemId = await grant(p, { rarityId: 'epic' }, { upgradeLevel: 7 });
    let failures = 0;
    for (let i = 0; i < 25; i++) {
      const before = await row(itemId);
      if (before.upgradeLevel === 10) break;
      const expected = await predictUpgrade(itemId);
      const res = await post(p, 'upgrade', { itemId });
      expect(res.statusCode).toBe(200);
      const out = res.json<ForgeActionResponse>().outcome;
      expect(out).toMatchObject({
        success: expected.success,
        upgradeLevel: expected.upgradeLevel,
        upgradePity: expected.upgradePity,
      });
      const after = await row(itemId);
      expect(after.upgradeLevel).toBeGreaterThanOrEqual(before.upgradeLevel);
      expect(after.forgeCounter).toBe(before.forgeCounter + 1);
      if (!expected.success) failures += 1;
    }
    expect((await row(itemId)).upgradeLevel).toBe(10);
    // +7 → +10 at 33 %, 25 % and 20 %: practically always a failure on the way.
    expect(failures).toBeGreaterThan(0);
    const max = await post(p, 'upgrade', { itemId });
    expect(max.statusCode).toBe(422);
    expect(max.json().error.code).toBe('max_upgrade');
  });

  it('the pity forces a success after N failures', async () => {
    const p = await newPlayer();
    // +9 → +10 needs 7 failures for the pity; start at 7.
    const itemId = await grant(p, {}, { upgradeLevel: 9, upgradePity: 7 });
    const res = await post(p, 'upgrade', { itemId });
    expect(res.json<ForgeActionResponse>().outcome).toMatchObject({
      success: true,
      guaranteed: true,
      upgradeLevel: 10,
      upgradePity: 0,
    });
  });

  it('a replay returns the stored outcome; a retry with a new key draws the next one', async () => {
    const p = await newPlayer();
    const itemId = await grant(p, {}, { upgradeLevel: 8 });
    const key = randomUUID();
    const first = await post(p, 'upgrade', { itemId }, key);
    const goldAfter = (await hero(p.id)).gold;
    const again = await post(p, 'upgrade', { itemId }, key);
    expect(again.headers[IDEMPOTENCY_REPLAYED_HEADER]).toBe('true');
    expect(again.json()).toEqual(first.json());
    expect((await hero(p.id)).gold).toBe(goldAfter);
    expect((await row(itemId)).forgeCounter).toBe(1);
    expect(await audits(p.id, 'forge.upgrade')).toHaveLength(1);
    // A new request is a new, paid attempt from the next draw, never the first one again.
    const next = await predictUpgrade(itemId);
    const retry = await post(p, 'upgrade', { itemId });
    expect(retry.json<ForgeActionResponse>().outcome).toMatchObject({
      success: next.success,
      upgradePity: next.upgradePity,
    });
    expect((await row(itemId)).forgeCounter).toBe(2);
  });

  it('the outcome depends only on the item’s secret stream: no request input changes it', async () => {
    const p = await newPlayer();
    const secret = randomUUID();
    const a = await grant(p, {}, { upgradeLevel: 9, forgeSecret: secret, forgeCounter: 4 });
    const b = await grant(
      p,
      { seed: 99 },
      { upgradeLevel: 9, forgeSecret: secret, forgeCounter: 4 },
    );
    const ra = (await post(p, 'upgrade', { itemId: a })).json<ForgeActionResponse>().outcome;
    const rb = (await post(p, 'upgrade', { itemId: b })).json<ForgeActionResponse>().outcome;
    expect(ra).toEqual(rb);
  });

  it('refuses without paying when gold or materials are short (the counter does not move)', async () => {
    const p = await newPlayer(10);
    const itemId = await grant(p, {}, { upgradeLevel: 6 });
    const res = await post(p, 'upgrade', { itemId });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('insufficient_gold');
    await database.db
      .update(characterMaterials)
      .set({ quantity: 0 })
      .where(eq(characterMaterials.characterId, p.id));
    await database.db.update(characters).set({ gold: 100_000 }).where(eq(characters.id, p.id));
    const short = await post(p, 'upgrade', { itemId });
    expect(short.json().error.code).toBe('insufficient_materials');
    expect(await row(itemId)).toMatchObject({ upgradeLevel: 6, forgeCounter: 0 });
    expect((await hero(p.id)).gold).toBe(100_000);
    expect(await audits(p.id, 'forge.upgrade')).toHaveLength(0);
  });

  it('needs an Idempotency-Key', async () => {
    const p = await newPlayer();
    const itemId = await grant(p);
    expect((await post(p, 'upgrade', { itemId }, null)).statusCode).toBe(400);
    expect((await row(itemId)).forgeCounter).toBe(0);
  });

  it('upgrading an equipped item raises the derived stats; a farming hero is settled first', async () => {
    const p = await newPlayer();
    const itemId = await grant(p, {}, { equippedSlot: 'head', upgradeLevel: 4 });
    const start = await app.inject({
      method: 'POST',
      url: `/api/characters/${p.id}/activity`,
      payload: { areaId: 'abandonedFields' },
      cookies: { [SESSION_COOKIE]: p.token },
    });
    expect(start.statusCode).toBe(201);
    nowMs += HOUR;
    const inv = await app.inject({
      method: 'GET',
      url: `/api/characters/${p.id}/inventory`,
      cookies: { [SESSION_COOKIE]: p.token },
    });
    const armorBefore = inv.json<{ stats: { armor: number } }>().stats.armor;
    await setItem(itemId, { upgradePity: 9 }); // guaranteed success
    const res = await post(p, 'upgrade', { itemId });
    const body = res.json<ForgeActionResponse>();
    expect(body.inventory.stats.armor).toBeGreaterThan(armorBefore);
    // Settled to now before the upgrade applied: the hour counted at +4.
    const [act] = await database.db
      .select()
      .from(activities)
      .where(eq(activities.characterId, p.id));
    expect(act!.settledAt.getTime()).toBeGreaterThan(nowMs - 5 * 60_000);
    const rewards = await audits(p.id, 'activity.reward');
    const [upgrade] = await audits(p.id, 'forge.upgrade');
    expect(rewards.length).toBeGreaterThan(0);
    expect(rewards.every((r) => r.id < upgrade!.id)).toBe(true);
  });
});

describe('affix reroll and improvement (ticket 3.4)', () => {
  it('rerolls exactly the picked affix as the stream says; the price rises', async () => {
    const p = await newPlayer();
    const itemId = await grant(p);
    const start = await row(itemId);
    let price = 0;
    for (let i = 0; i < 3; i++) {
      const before = await row(itemId);
      const expected = rerollAffix(
        before,
        1,
        'warrior',
        createRng(`${before.forgeSecret}:${before.forgeCounter}`),
      );
      if (!expected.ok) throw new Error(expected.reason);
      const res = await post(p, 'reroll', { itemId, affixIndex: 1 });
      expect(res.statusCode).toBe(200);
      const body = res.json<ForgeActionResponse>();
      expect(body.item.affixes).toEqual(expected.value);
      expect(body.item.affixes[1]!.rerolled).toBe(true);
      expect(body.item.affixes.filter((_, j) => j !== 1)).toEqual(
        start.affixes.filter((_, j) => j !== 1),
      );
      expect(body.paid.gold).toBeGreaterThan(price);
      price = body.paid.gold;
      expect(await row(itemId)).toMatchObject({ rerollCount: i + 1, forgeCounter: i + 1 });
    }
    const bad = await post(p, 'reroll', { itemId, affixIndex: 9 });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('no_such_affix');
    expect((await row(itemId)).forgeCounter).toBe(3);
  });

  it('improves an affix as the stream says, inside its tier, up to the cap', async () => {
    const p = await newPlayer();
    const itemId = await grant(p);
    let done = 0;
    for (let i = 0; i < 4; i++) {
      const before = await row(itemId);
      const expected = improveAffix(
        before,
        0,
        createRng(`${before.forgeSecret}:${before.forgeCounter}`),
      );
      const res = await post(p, 'improve', { itemId, affixIndex: 0 });
      if (!expected.ok) {
        expect(res.statusCode).toBe(422);
        expect(['improvement_cap', 'affix_at_max']).toContain(res.json().error.code);
        expect((await row(itemId)).forgeCounter).toBe(before.forgeCounter);
        break;
      }
      expect(res.statusCode).toBe(200);
      const body = res.json<ForgeActionResponse>();
      expect(body.item.affixes).toEqual(expected.value);
      expect(body.outcome).toMatchObject({ action: 'improve', affixIndex: 0 });
      done += 1;
      const view = body.forge.improve[0]!;
      expect(view.value).toBeLessThanOrEqual(view.max);
      expect(view.improvements).toBe(done);
    }
    expect(done).toBeGreaterThan(0);
    expect(done).toBeLessThanOrEqual(3);
  });
});

describe('Void items (ticket 3.5)', () => {
  it('the inventory shows the variant and its stats; forge work never adds or removes it', async () => {
    const p = await newPlayer();
    const voidId = await grant(
      p,
      { rarityId: 'legendary', seed: 11 },
      { equippedSlot: 'head', variant: 'void' },
    );
    const plainId = await grant(p, { rarityId: 'legendary', seed: 11 });
    const inventory = async () =>
      (
        await app.inject({
          method: 'GET',
          url: `/api/characters/${p.id}/inventory`,
          cookies: { [SESSION_COOKIE]: p.token },
        })
      ).json<{
        stats: { armor: number };
        equipped: { id: string; variant: string | null }[];
        inventory: { id: string; variant: string | null }[];
      }>();
    const before = await inventory();
    expect(before.equipped.find((i) => i.id === voidId)!.variant).toBe('void');
    expect(before.inventory.find((i) => i.id === plainId)!.variant).toBeNull();
    // The same Legendary without Void: the base values are 10 % lower.
    await setItem(voidId, { variant: null });
    const armorPlain = (await inventory()).stats.armor;
    expect(before.stats.armor).toBeGreaterThan(armorPlain);
    await setItem(voidId, { variant: 'void' });

    for (const id of [voidId, plainId]) {
      const variant = (await row(id)).variant;
      await setItem(id, { upgradePity: 9 });
      expect((await post(p, 'upgrade', { itemId: id })).statusCode).toBe(200);
      expect((await post(p, 'reroll', { itemId: id, affixIndex: 0 })).statusCode).toBe(200);
      const improved = await post(p, 'improve', { itemId: id, affixIndex: 1 });
      expect([200, 422]).toContain(improved.statusCode);
      const after = await row(id);
      expect(after.forgeCounter).toBeGreaterThanOrEqual(2);
      expect(after.variant, id).toBe(variant);
    }
    const res = await post(p, 'upgrade', { itemId: voidId });
    expect(res.json<ForgeActionResponse>().item.variant).toBe('void');
  });
});
