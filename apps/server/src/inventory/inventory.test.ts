import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import {
  deriveCharacterStats,
  deriveEquippedStats,
  generateItem,
  type ClassId,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { auditLog, itemInstances } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { itemEffectColumns } from './columns.js';
import { uuidv7 } from '../db/uuid.js';
import { createTestDatabase } from '../test/db.js';
import type { InventoryView } from './routes.js';

let database: DatabaseHandle;
let app: FastifyInstance;

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({ database, auth: { registerRateLimit: { max: 1000, timeWindowMs: 60_000 } } });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.close();
});

interface Player {
  token: string;
  accountId: string;
  characterId: string;
  classId: ClassId;
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

async function newPlayer(classId: ClassId = 'warrior'): Promise<Player> {
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
  const token = reg.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error(`register failed: ${reg.statusCode}`);
  const created = await app.inject({
    method: 'POST',
    url: '/api/characters',
    payload: { name: `Brann${letters(seq)}`, classId, appearance: { banner: 'ember' } },
    cookies: { [SESSION_COOKIE]: token },
  });
  if (created.statusCode !== 201) throw new Error(`create failed: ${created.body}`);
  return {
    token,
    accountId: reg.json<{ account: { id: string } }>().account.id,
    characterId: created.json<{ character: { id: string } }>().character.id,
    classId,
  };
}

/** Stands in for ticket 1.6's loot grant: a generated item inserted into the inventory. */
async function grant(p: Player, baseId: string, seed = 7, itemLevel = 10): Promise<string> {
  const item = generateItem({ seed, itemLevel, baseId, rarityId: 'rare' })!;
  const id = uuidv7();
  await database.db.insert(itemInstances).values({
    id,
    characterId: p.characterId,
    baseId: item.baseId,
    rarityId: item.rarityId,
    itemLevel: item.itemLevel,
    affixes: item.affixes,
    seed: item.seed,
    source: 'test',
  });
  return id;
}

const cookies = (p: Player) => ({ [SESSION_COOKIE]: p.token });
const inventory = (p: Player, characterId = p.characterId) =>
  app.inject({
    method: 'GET',
    url: `/api/characters/${characterId}/inventory`,
    cookies: cookies(p),
  });
const equip = (p: Player, itemId: string, slot?: string, characterId = p.characterId) =>
  app.inject({
    method: 'POST',
    url: `/api/characters/${characterId}/items/${itemId}/equip`,
    cookies: cookies(p),
    ...(slot === undefined ? {} : { payload: { slot } }),
  });
const unequip = (p: Player, itemId: string, characterId = p.characterId) =>
  app.inject({
    method: 'POST',
    url: `/api/characters/${characterId}/items/${itemId}/unequip`,
    cookies: cookies(p),
  });
const discard = (p: Player, itemId: string, characterId = p.characterId) =>
  app.inject({
    method: 'DELETE',
    url: `/api/characters/${characterId}/items/${itemId}`,
    cookies: cookies(p),
  });

const slotsOf = (v: InventoryView) =>
  Object.fromEntries(v.equipped.map((i) => [i.equippedSlot, i.id]));

async function dbRow(id: string) {
  const [row] = await database.db.select().from(itemInstances).where(eq(itemInstances.id, id));
  return row;
}

describe('inventory API', () => {
  it('requires a session', async () => {
    const p = await newPlayer();
    const res = await app.inject({
      method: 'GET',
      url: `/api/characters/${p.characterId}/inventory`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('lists an empty inventory with base stats', async () => {
    const p = await newPlayer('mage');
    const res = await inventory(p);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      equipped: [],
      inventory: [],
      stats: deriveCharacterStats('mage', 1),
    });
  });

  it('equips, recomputes stats, unequips and lists items', async () => {
    const p = await newPlayer();
    const sword = await grant(p, 'longsword-notched');
    const helm = await grant(p, 'iron-helm', 8);

    let res = await equip(p, sword);
    expect(res.statusCode).toBe(200);
    let view = res.json<InventoryView>();
    expect(slotsOf(view)).toEqual({ weapon: sword });
    expect(view.inventory.map((i) => i.id)).toEqual([helm]);
    const row = (await dbRow(sword))!;
    expect(view.stats).toEqual(deriveEquippedStats('warrior', 1, [row]));
    expect(view.stats.physicalDamage).toBeGreaterThan(
      deriveCharacterStats('warrior', 1).physicalDamage,
    );

    view = (await equip(p, helm, 'head')).json<InventoryView>();
    expect(slotsOf(view)).toEqual({ head: helm, weapon: sword });
    // Canonical slot order: head before weapon.
    expect(view.equipped.map((i) => i.equippedSlot)).toEqual(['head', 'weapon']);

    res = await unequip(p, sword);
    expect(res.statusCode).toBe(200);
    view = res.json<InventoryView>();
    expect(slotsOf(view)).toEqual({ head: helm });
    expect(view.inventory.map((i) => i.id)).toEqual([sword]);
    expect((await inventory(p)).json()).toEqual(view);

    // Unequipping an inventory item is a no-op.
    expect((await unequip(p, sword)).json()).toEqual(view);
  });

  it('rejects an invalid slot', async () => {
    const p = await newPlayer();
    const helm = await grant(p, 'iron-helm');
    const wrong = await equip(p, helm, 'chest');
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json()).toMatchObject({ error: { code: 'wrong_slot' } });
    const unknown = await equip(p, helm, 'tail');
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ error: { code: 'validation_failed' } });
    const extra = await app.inject({
      method: 'POST',
      url: `/api/characters/${p.characterId}/items/${helm}/equip`,
      cookies: cookies(p),
      payload: { slot: 'head', gold: 1000 },
    });
    expect(extra.statusCode).toBe(400);
    expect((await dbRow(helm))!.equippedSlot).toBeNull();
  });

  it('rejects a weapon the class cannot use', async () => {
    const p = await newPlayer('mage');
    const sword = await grant(p, 'longsword-notched');
    const shield = await grant(p, 'round-shield');
    for (const [id, slot] of [
      [sword, 'weapon'],
      [shield, 'offhand'],
    ] as const) {
      const res = await equip(p, id, slot);
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: { code: 'wrong_class' } });
    }
    const staff = await grant(p, 'skull-staff');
    expect((await equip(p, staff)).statusCode).toBe(200);
  });

  it('rejects items whose base is no longer in content', async () => {
    const p = await newPlayer();
    const id = await grant(p, 'iron-helm');
    await database.db
      .update(itemInstances)
      .set({ baseId: 'retired-helm' })
      .where(eq(itemInstances.id, id));
    const res = await equip(p, id);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: 'item_unusable' } });
  });

  it("refuses another account's character and another character's item", async () => {
    const owner = await newPlayer();
    const thief = await newPlayer();
    const sword = await grant(owner, 'longsword-notched');

    for (const res of [
      await inventory(thief, owner.characterId),
      await equip(thief, sword, undefined, owner.characterId),
      await unequip(thief, sword, owner.characterId),
      await discard(thief, sword, owner.characterId),
    ]) {
      // 404, not 403: another account's character looks like a missing one (ticket 1.9).
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
    }
    // The thief's own character path with the owner's item id: the item isn't there.
    for (const res of [await equip(thief, sword), await discard(thief, sword)]) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
    }
    const row = (await dbRow(sword))!;
    expect(row.characterId).toBe(owner.characterId);
    expect(row.equippedSlot).toBeNull();

    expect((await equip(owner, uuidv7())).statusCode).toBe(404);
    expect((await inventory(owner, uuidv7())).statusCode).toBe(404);
    expect((await equip(owner, 'not-a-uuid')).statusCode).toBe(400);
  });

  it('replaces the occupant of a slot, which returns to the inventory', async () => {
    const p = await newPlayer();
    const a = await grant(p, 'iron-helm', 1);
    const b = await grant(p, 'horned-helm', 2);
    await equip(p, a);
    const view = (await equip(p, b)).json<InventoryView>();
    expect(slotsOf(view)).toEqual({ head: b });
    expect(view.inventory.map((i) => i.id)).toEqual([a]);
  });

  it('handles both ring slots', async () => {
    const p = await newPlayer('hunter');
    const r1 = await grant(p, 'brass-ring', 1);
    const r2 = await grant(p, 'iron-ring', 2);
    const r3 = await grant(p, 'brass-ring', 3);

    // No slot given: first free ring slot.
    expect(slotsOf((await equip(p, r1)).json())).toEqual({ ring1: r1 });
    expect(slotsOf((await equip(p, r2)).json())).toEqual({ ring1: r1, ring2: r2 });
    // Both full, no slot given: replaces ring1.
    let view = (await equip(p, r3)).json<InventoryView>();
    expect(slotsOf(view)).toEqual({ ring1: r3, ring2: r2 });
    expect(view.inventory.map((i) => i.id)).toEqual([r1]);

    // Moving an equipped ring onto the other ring slot swaps them.
    view = (await equip(p, r3, 'ring2')).json<InventoryView>();
    expect(slotsOf(view)).toEqual({ ring1: r2, ring2: r3 });
    // Re-equipping where it already is changes nothing.
    expect(slotsOf((await equip(p, r3)).json())).toEqual({ ring1: r2, ring2: r3 });
    expect(slotsOf((await equip(p, r3, 'ring2')).json())).toEqual({ ring1: r2, ring2: r3 });
    // A ring never fits the neck.
    expect((await equip(p, r1, 'neck')).statusCode).toBe(422);
  });

  it('is idempotent for a double equip', async () => {
    const p = await newPlayer();
    const helm = await grant(p, 'iron-helm');
    const first = await equip(p, helm, 'head');
    const second = await equip(p, helm, 'head');
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
  });

  it('discards inventory items with an audit entry, but not equipped ones', async () => {
    const p = await newPlayer();
    const helm = await grant(p, 'iron-helm');
    await equip(p, helm);
    const refused = await discard(p, helm);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: { code: 'item_equipped' } });

    await unequip(p, helm);
    const res = await discard(p, helm);
    expect(res.statusCode).toBe(200);
    expect(res.json<InventoryView>().inventory).toEqual([]);
    expect(await dbRow(helm)).toBeUndefined();
    expect((await discard(p, helm)).statusCode).toBe(404);

    const audits = await database.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.characterId, p.characterId), eq(auditLog.event, 'item.discard')));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.data).toMatchObject({ itemId: helm, baseId: 'iron-helm', rarityId: 'rare' });
  });

  describe('concurrency', () => {
    it('keeps one item per slot when two items race for it', async () => {
      const p = await newPlayer();
      const helms = await Promise.all([1, 2, 3, 4].map((s) => grant(p, 'iron-helm', s)));
      const results = await Promise.all(helms.map((h) => equip(p, h, 'head')));
      for (const r of results) expect(r.statusCode).toBe(200);
      const rows = await database.db
        .select()
        .from(itemInstances)
        .where(eq(itemInstances.characterId, p.characterId));
      expect(rows.filter((r) => r.equippedSlot === 'head')).toHaveLength(1);
      expect(rows.filter((r) => r.equippedSlot === null)).toHaveLength(3);
    });

    it('keeps an item in one place under racing equips into both ring slots', async () => {
      const p = await newPlayer();
      const ring = await grant(p, 'brass-ring');
      const results = await Promise.all([
        equip(p, ring, 'ring1'),
        equip(p, ring, 'ring2'),
        equip(p, ring, 'ring1'),
        unequip(p, ring),
      ]);
      for (const r of results) expect(r.statusCode).toBe(200);
      const view = (await inventory(p)).json<InventoryView>();
      expect(view.equipped.length + view.inventory.length).toBe(1);
    });

    it('never discards an item that a racing request equipped', async () => {
      const p = await newPlayer();
      const helm = await grant(p, 'iron-helm');
      const [eq1, del] = await Promise.all([equip(p, helm), discard(p, helm)]);
      const row = await dbRow(helm);
      if (del.statusCode === 200) {
        expect(row).toBeUndefined();
        expect(eq1.statusCode).toBe(404);
      } else {
        expect(del.statusCode).toBe(409);
        expect(row!.equippedSlot).toBe('head');
      }
    });
  });
});

describe('item model v2 (ticket 3.1)', () => {
  it('shows the Phase 3 columns at their defaults, and forge affix state round-trips', async () => {
    const p = await newPlayer();
    const id = await grant(p, 'iron-helm');
    const res = await inventory(p);
    expect(res.statusCode).toBe(200);
    const item = res.json<InventoryView>().inventory.find((i) => i.id === id)!;
    expect(item).toMatchObject({
      upgradeLevel: 0,
      variant: null,
      effectId: null,
      effectRoll: null,
      setId: null,
      mythicId: null,
      locked: false,
    });
    const [row] = await database.db.select().from(itemInstances).where(eq(itemInstances.id, id));
    expect(row).toMatchObject({
      upgradePity: 0,
      forgeCounter: 0,
      rerollCount: 0,
      effectRoll: null,
    });

    // The jsonb affix shape carries 3.4's per-affix forge state through the API.
    const affixes = row!.affixes.map((a, i) =>
      i === 0 ? { ...a, improvements: 2, rerolled: true } : a,
    );
    await database.db
      .update(itemInstances)
      .set({ affixes, upgradeLevel: 10, variant: 'void', locked: true, effectRoll: 1 })
      .where(eq(itemInstances.id, id));
    const after = (await inventory(p)).json<InventoryView>().inventory.find((i) => i.id === id)!;
    expect(after).toMatchObject({ upgradeLevel: 10, variant: 'void', locked: true });
    expect(after.affixes[0]).toMatchObject({ improvements: 2, rerolled: true });
  });

  it('enforces the column ranges in the database', async () => {
    const p = await newPlayer();
    const id = await grant(p, 'iron-helm');
    const set = (patch: Partial<typeof itemInstances.$inferInsert>) =>
      database.db.update(itemInstances).set(patch).where(eq(itemInstances.id, id));
    await expect(set({ upgradeLevel: 11 })).rejects.toThrow();
    await expect(set({ upgradeLevel: -1 })).rejects.toThrow();
    await expect(set({ upgradePity: -1 })).rejects.toThrow();
    await expect(set({ forgeCounter: -1 })).rejects.toThrow();
    await expect(set({ rerollCount: -1 })).rejects.toThrow();
    await expect(set({ variant: 'prismatic' as 'void' })).rejects.toThrow();
    await expect(set({ effectRoll: 1.5 })).rejects.toThrow();
  });
});

describe('Legendary and Mythic items (ticket 3.2)', () => {
  it('stores the rolled effect and named Mythic and shows them in the item view', async () => {
    const p = await newPlayer();
    const legendary = generateItem({
      seed: 11,
      itemLevel: 18,
      rarityId: 'legendary',
      classId: 'warrior',
    })!;
    const mythic = generateItem({ seed: 12, itemLevel: 18, baseId: 'gravecallers-edge' })!;
    expect(legendary.effectId).toBeDefined();
    expect(mythic.mythicId).toBe('gravecallers-edge');
    const ids: string[] = [];
    for (const item of [legendary, mythic]) {
      const id = uuidv7();
      ids.push(id);
      await database.db.insert(itemInstances).values({
        id,
        characterId: p.characterId,
        baseId: item.baseId,
        rarityId: item.rarityId,
        itemLevel: item.itemLevel,
        affixes: item.affixes,
        seed: item.seed,
        source: 'test',
        ...itemEffectColumns(item),
      });
    }
    const view = (await inventory(p)).json<InventoryView>().inventory;
    expect(view.find((i) => i.id === ids[0])).toMatchObject({
      rarityId: 'legendary',
      effectId: legendary.effectId,
      effectRoll: legendary.effectRoll,
      mythicId: null,
    });
    expect(view.find((i) => i.id === ids[1])).toMatchObject({
      rarityId: 'mythic',
      effectId: 'gravecallers-hunger',
      effectRoll: null,
      mythicId: 'gravecallers-edge',
    });
  });
});

describe('set pieces (ticket 3.3)', () => {
  it('stores the set id of a set piece and shows it in the item view', async () => {
    const p = await newPlayer();
    const piece = generateItem({ seed: 13, itemLevel: 18, baseId: 'vigil-helm' })!;
    expect(piece.setId).toBe('drowned-vigil');
    expect(itemEffectColumns(piece)).toEqual({
      effectId: null,
      effectRoll: null,
      mythicId: null,
      setId: 'drowned-vigil',
      variant: null,
    });
    const id = uuidv7();
    await database.db.insert(itemInstances).values({
      id,
      characterId: p.characterId,
      baseId: piece.baseId,
      rarityId: piece.rarityId,
      itemLevel: piece.itemLevel,
      affixes: piece.affixes,
      seed: piece.seed,
      source: 'test',
      ...itemEffectColumns(piece),
    });
    const view = (await inventory(p)).json<InventoryView>().inventory;
    expect(view.find((i) => i.id === id)).toMatchObject({
      baseId: 'vigil-helm',
      rarityId: 'legendary',
      setId: 'drowned-vigil',
      effectId: null,
      variant: null,
    });
  });
});
