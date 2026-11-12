import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import {
  EMPTY_LOOT_FILTER,
  generateItem,
  lootFilterCategories,
  type LootFilterRules,
  type RarityId,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/index.js';
import {
  activities,
  auditLog,
  characterMaterials,
  characterQuests,
  characters,
  dungeonRuns,
  itemInstances,
  type ActivitySummary,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { createTestDatabase } from '../test/db.js';
import { makeCryptReady } from '../test/dungeon.js';
import { DEFAULT_ACTIVITY_OPTIONS, type ActivityOptions } from '../activity/settle.js';
import type { DungeonClaimResponse } from '../dungeon/routes.js';
import type { LootFilterResponse } from './routes.js';
import { NAME_SAFE_LETTERS } from '../test/names.js';

/** Ticket 3.7: loot filter rules, the item lock, and the filter at settlement and crypt claim. */

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.parse('2026-11-06T12:00:00Z');
const advance = (ms: number) => {
  nowMs += ms;
};
const options: ActivityOptions = {
  ...DEFAULT_ACTIVITY_OPTIONS,
  offlineCapMs: 3 * HOUR,
  now: () => new Date(nowMs),
};

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({
    database,
    auth: { registerRateLimit: { max: 1000, timeWindowMs: 60_000 } },
    activity: options,
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
const tag = () => {
  seq += 1;
  let n = seq;
  let s = '';
  do {
    s = NAME_SAFE_LETTERS[n % NAME_SAFE_LETTERS.length]! + s;
    n = Math.floor(n / NAME_SAFE_LETTERS.length);
  } while (n > 0);
  return s;
};

async function newPlayer(classId = 'hunter'): Promise<Player> {
  const t = tag();
  const reg = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email: `sifter-${t}@graumark.test`,
      displayName: `Sifter ${t}`,
      password: 'ashes-and-iron-42',
    },
  });
  const token = reg.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error(`register failed: ${reg.statusCode}`);
  const created = await app.inject({
    method: 'POST',
    url: '/api/characters',
    payload: { name: `Sifter${t}`, classId, appearance: { banner: 'moss' } },
    cookies: { [SESSION_COOKIE]: token },
  });
  return { token, id: created.json<{ character: { id: string } }>().character.id };
}

function call(p: Player, method: 'GET' | 'POST' | 'DELETE', path: string, payload?: object) {
  return app.inject({
    method,
    url: `/api/characters/${p.id}${path}`,
    ...(payload ? { payload } : {}),
    headers: { 'idempotency-key': randomUUID() },
    cookies: { [SESSION_COOKIE]: p.token },
  });
}

const setFilter = (p: Player, rules: LootFilterRules | null) =>
  call(p, 'POST', '/loot-filter', { rules });
const rules = (r: Partial<LootFilterRules>): LootFilterRules => ({ ...EMPTY_LOOT_FILTER, ...r });

async function grant(p: Player, rarityId: RarityId = 'common', baseId = 'iron-helm') {
  const item = generateItem({ seed: 7, itemLevel: 5, baseId, rarityId })!;
  const id = uuidv7();
  await database.db
    .insert(itemInstances)
    .values({ id, characterId: p.id, ...item, source: 'test' });
  return id;
}

const itemsOf = (p: Player) =>
  database.db
    .select()
    .from(itemInstances)
    .where(eq(itemInstances.characterId, p.id))
    .orderBy(asc(itemInstances.createdAt), asc(itemInstances.id));
const characterOf = async (p: Player) =>
  (await database.db.select().from(characters).where(eq(characters.id, p.id)))[0]!;
const materialsOf = async (p: Player) =>
  Object.fromEntries(
    (
      await database.db
        .select()
        .from(characterMaterials)
        .where(eq(characterMaterials.characterId, p.id))
    ).map((m) => [m.materialId, m.quantity]),
  );
const audits = (p: Player, event: string) =>
  database.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.characterId, p.id), eq(auditLog.event, event)))
    .orderBy(asc(auditLog.id));

/** A hunter farming the Old Burial Grounds with a fixed seed secret. */
async function farmer(seedSecret = 'filter-fixed') {
  const p = await newPlayer();
  await database.db.update(characters).set({ level: 12 }).where(eq(characters.id, p.id));
  const res = await call(p, 'POST', '/activity', { areaId: 'oldBurialGrounds' });
  expect(res.statusCode).toBe(201);
  await database.db.update(activities).set({ seedSecret }).where(eq(activities.characterId, p.id));
  return p;
}
const settle = async (p: Player) =>
  (await call(p, 'POST', '/activity/settle')).json<{ summary: ActivitySummary }>().summary;

type Audit = {
  gold: number;
  filtered?: {
    sold: number;
    salvaged: number;
    gold: number;
    items: { seed: number; action: string }[];
  };
};

describe('loot filter rules', () => {
  it('start empty, can be set, normalised, audited once per change, and cleared', async () => {
    const p = await newPlayer();
    const initial = (await call(p, 'GET', '/loot-filter')).json<LootFilterResponse>();
    expect(initial).toEqual({ characterId: p.id, rules: null, active: false, presets: [] });

    const r = rules({
      action: 'sell',
      belowRarity: 'rare',
      wantedAffixes: ['gold-find', 'armor'],
      include: ['void'],
    });
    const set = await setFilter(p, r);
    expect(set.statusCode).toBe(200);
    expect(set.json<LootFilterResponse>()).toEqual({
      characterId: p.id,
      rules: { ...r, wantedAffixes: ['armor', 'gold-find'] },
      active: true,
      presets: [],
    });
    expect((await setFilter(p, { ...r, wantedAffixes: ['armor', 'gold-find'] })).statusCode).toBe(
      200,
    );
    expect(await audits(p, 'loot_filter.update')).toHaveLength(1);

    const off = await setFilter(p, null);
    expect(off.json<LootFilterResponse>()).toMatchObject({ rules: null, active: false });
    expect(await audits(p, 'loot_filter.update')).toHaveLength(2);
    expect((await characterOf(p)).lootFilter).toBeNull();
  });

  it('refuses unknown ids, categories, fields and another account’s character', async () => {
    const p = await newPlayer();
    const other = await newPlayer();
    for (const bad of [
      { ...EMPTY_LOOT_FILTER, wantedAffixes: ['no-such-affix'] },
      { ...EMPTY_LOOT_FILTER, wantedEffects: ['no-such-effect'] },
      { ...EMPTY_LOOT_FILTER, include: ['rare'] },
      { ...EMPTY_LOOT_FILTER, belowRarity: 'shiny' },
      { ...EMPTY_LOOT_FILTER, action: 'destroy' },
      { ...EMPTY_LOOT_FILTER, extra: true },
      { action: 'sell' },
    ]) {
      const res = await setFilter(p, bad as LootFilterRules);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await call(p, 'POST', '/loot-filter', { rules: null, gold: 5 })).statusCode).toBe(400);
    const foreign = await app.inject({
      method: 'POST',
      url: `/api/characters/${p.id}/loot-filter`,
      payload: { rules: null },
      cookies: { [SESSION_COOKIE]: other.token },
    });
    expect(foreign.statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/characters/${p.id}/loot-filter`,
          cookies: { [SESSION_COOKIE]: other.token },
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('the filter at settlement', () => {
  const filter = rules({ action: 'salvage', belowRarity: 'rare' });

  it('never changes what drops; it only sells or salvages new drops, and is audited', async () => {
    const plain = await farmer('same-drops');
    const sifted = await farmer('same-drops');
    expect((await setFilter(sifted, filter)).statusCode).toBe(200);
    // A pack item and a locked item below the threshold: the filter never touches owned items.
    const packed = await grant(sifted, 'common');
    const locked = await grant(sifted, 'uncommon');
    expect((await call(sifted, 'POST', `/items/${locked}/lock`)).statusCode).toBe(200);
    const plainPacked = await grant(plain, 'common');
    await grant(plain, 'uncommon');
    advance(2 * HOUR);
    const plainSummary = await settle(plain);
    const siftedSummary = await settle(sifted);

    const plainDrops = (await itemsOf(plain)).filter((i) => i.source === 'farming');
    const kept = (await itemsOf(sifted)).filter((i) => i.source === 'farming');
    const [audit] = (await audits(sifted, 'activity.reward')).slice(-1);
    const data = audit!.data as Audit;
    expect(data.filtered!.salvaged).toBeGreaterThan(3);
    expect(siftedSummary.filtered).toMatchObject({
      sold: 0,
      salvaged: data.filtered!.salvaged,
      gold: data.filtered!.gold,
    });
    // Same seeds: kept ∪ filtered is exactly the plain drop list.
    const seeds = [...kept.map((i) => i.seed), ...data.filtered!.items.map((i) => i.seed)];
    expect(seeds.sort()).toEqual(plainDrops.map((i) => i.seed).sort());
    for (const i of kept) expect(['rare', 'epic', 'legendary', 'mythic']).toContain(i.rarityId);
    expect(plainSummary.filtered).toBeUndefined();
    expect((await audits(plain, 'activity.reward'))[0]!.data).not.toHaveProperty('filtered');

    // Owned items are untouched.
    const ids = (await itemsOf(sifted)).map((i) => i.id);
    expect(ids).toContain(packed);
    expect(ids).toContain(locked);
    expect((await itemsOf(plain)).map((i) => i.id)).toContain(plainPacked);

    // The value: the same kill gold and XP, plus the filter's salvage gold and materials.
    const a = await characterOf(plain);
    const b = await characterOf(sifted);
    expect(b.experience).toBe(a.experience);
    expect(b.gold - a.gold).toBe(data.filtered!.gold);
    expect(siftedSummary.goldGained - plainSummary.goldGained).toBe(data.filtered!.gold);
    const matA = await materialsOf(plain);
    const matB = await materialsOf(sifted);
    for (const [id, n] of Object.entries(siftedSummary.filtered!.materials)) {
      expect(matB[id]! - (matA[id] ?? 0)).toBe(n);
    }
    // Gathering (which quests count) does not include the salvage.
    expect(siftedSummary.materials).toEqual(plainSummary.materials);
  });

  it('is split-invariant: settling every few minutes gives what one settlement gives', async () => {
    const spam = await farmer('split-filter');
    const lazy = await farmer('split-filter');
    for (const p of [spam, lazy])
      await setFilter(p, rules({ action: 'sell', belowRarity: 'epic' }));
    for (let t = 0; t < 2 * HOUR; t += 7 * MIN) {
      advance(7 * MIN);
      await settle(spam);
    }
    await settle(lazy);
    const strip = (rows: Awaited<ReturnType<typeof itemsOf>>) =>
      rows.map((i) => `${i.seed}:${i.baseId}:${i.rarityId}`);
    expect(strip(await itemsOf(spam)).sort()).toEqual(strip(await itemsOf(lazy)).sort());
    const [a, b] = [await characterOf(spam), await characterOf(lazy)];
    expect(a.gold).toBe(b.gold);
    expect(a.experience).toBe(b.experience);
    const sold = async (p: Player) =>
      (await audits(p, 'activity.reward'))
        .flatMap((x) => (x.data as Audit).filtered?.items ?? [])
        .map((i) => i.seed);
    expect((await sold(spam)).sort()).toEqual((await sold(lazy)).sort());
    expect((await sold(lazy)).length).toBeGreaterThan(0);
  });

  it('a change settles first: earlier drops keep the old rules, later ones get the new', async () => {
    const changed = await farmer('change-window');
    const reference = await farmer('change-window');
    advance(HOUR);
    // The reference settles at the change moment with no filter, then gets the filter.
    await settle(reference);
    expect((await setFilter(reference, filter)).statusCode).toBe(200);
    expect((await setFilter(changed, filter)).statusCode).toBe(200);
    const [first] = await audits(changed, 'activity.reward');
    expect(first!.data).not.toHaveProperty('filtered');
    advance(HOUR);
    await settle(changed);
    await settle(reference);
    const strip = (rows: Awaited<ReturnType<typeof itemsOf>>) =>
      rows.map((i) => `${i.seed}:${i.rarityId}:${i.createdAt.toISOString()}`);
    // Items of one settlement share a timestamp; compare them as sets.
    expect(strip(await itemsOf(changed)).sort()).toEqual(strip(await itemsOf(reference)).sort());
    const later = (await audits(changed, 'activity.reward'))[1]!.data as Audit;
    expect(later.filtered!.salvaged).toBeGreaterThan(0);
    expect((await characterOf(changed)).gold).toBe((await characterOf(reference)).gold);
  });

  it('frees pack space: with a full pack, filtered drops are not overflow-salvaged', async () => {
    const p = await farmer('full-pack');
    const capacity = DEFAULT_ACTIVITY_OPTIONS.rules.inventory.capacity;
    const rows = Array.from({ length: capacity }, () => ({
      id: uuidv7(),
      characterId: p.id,
      ...generateItem({ seed: 3, itemLevel: 5, baseId: 'iron-helm', rarityId: 'common' })!,
      source: 'test',
    }));
    await database.db.insert(itemInstances).values(rows);
    await setFilter(p, rules({ action: 'sell', belowRarity: 'rare' }));
    advance(2 * HOUR);
    const summary = await settle(p);
    expect(summary.filtered!.sold).toBeGreaterThan(0);
    // Only the drops the filter kept could overflow; the pack itself is unchanged.
    expect(summary.itemsGained).toBe(0);
    expect((await itemsOf(p)).length).toBe(capacity);
  });
});

describe('item lock', () => {
  it('blocks sell, salvage and discard; lock and unlock are idempotent', async () => {
    const p = await newPlayer();
    const item = await grant(p, 'rare');
    const free = await grant(p, 'common');
    for (let i = 0; i < 2; i++) {
      const res = await call(p, 'POST', `/items/${item}/lock`);
      expect(res.statusCode).toBe(200);
      expect(
        res
          .json<{ inventory: { id: string; locked: boolean }[] }>()
          .inventory.find((x) => x.id === item)!.locked,
      ).toBe(true);
    }
    for (const [method, path, payload] of [
      ['POST', '/merchant/sell', { itemIds: [item] }],
      ['POST', '/forge/salvage', { itemIds: [item] }],
      ['POST', '/merchant/sell', { itemIds: [free, item] }],
      ['POST', '/forge/salvage', { itemIds: [free, item] }],
      ['DELETE', `/items/${item}`, undefined],
    ] as const) {
      const res = await call(p, method, path, payload);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        error: { code: 'item_locked', details: { itemId: item } },
      });
    }
    // All or nothing: the unlocked item of the refused bulk sale is still there.
    expect((await itemsOf(p)).map((i) => i.id).sort()).toEqual([item, free].sort());
    expect((await characterOf(p)).gold).toBe(0);

    for (let i = 0; i < 2; i++) {
      expect((await call(p, 'POST', `/items/${item}/unlock`)).statusCode).toBe(200);
    }
    const sold = await call(p, 'POST', '/merchant/sell', { itemIds: [item, free] });
    expect(sold.statusCode).toBe(200);
    expect(await itemsOf(p)).toEqual([]);
  });

  it('equipped items can be locked and stay usable; ids are not probeable', async () => {
    const p = await newPlayer('warrior');
    const other = await newPlayer();
    const item = await grant(p, 'rare');
    expect((await call(p, 'POST', `/items/${item}/lock`)).statusCode).toBe(200);
    expect((await call(p, 'POST', `/items/${item}/equip`)).statusCode).toBe(200);
    expect((await call(p, 'POST', `/items/${item}/unequip`)).statusCode).toBe(200);
    expect((await itemsOf(p))[0]!.locked).toBe(true);
    const foreign = await app.inject({
      method: 'POST',
      url: `/api/characters/${other.id}/items/${item}/lock`,
      cookies: { [SESSION_COOKIE]: other.token },
    });
    expect(foreign.statusCode).toBe(404);
  });
});

describe('the filter at the crypt claim', () => {
  async function delver(seed: string) {
    const p = await newPlayer('warrior');
    await makeCryptReady(database.db, p.id, 'warrior', 18, { rarityId: 'rare' });
    const res = await call(p, 'POST', '/dungeon', { dungeonId: 'namelessCrypt', tier: 1 });
    expect(res.statusCode).toBe(201);
    const [run] = await database.db
      .select()
      .from(dungeonRuns)
      .where(eq(dungeonRuns.characterId, p.id));
    await database.db
      .update(dungeonRuns)
      .set({ seedSecret: seed })
      .where(eq(dungeonRuns.id, run!.id));
    return p;
  }

  it('applies the rules at claim, over the same drops, and audits them', async () => {
    const plain = await delver('crypt-filter');
    const sifted = await delver('crypt-filter');
    await setFilter(sifted, rules({ action: 'sell', belowRarity: 'legendary', include: [] }));
    advance(2 * HOUR);
    const a = (await call(plain, 'POST', '/dungeon/claim')).json<DungeonClaimResponse>().result;
    const b = (await call(sifted, 'POST', '/dungeon/claim')).json<DungeonClaimResponse>().result;
    expect(a.filtered).toBeUndefined();
    expect(b.filtered!.sold).toBeGreaterThan(0);
    expect(b.items.length + b.filtered!.items.length).toBe(a.items.length);
    expect(b.goldGained - a.goldGained).toBe(b.filtered!.gold);
    expect(b.xpGained).toBe(a.xpGained);
    for (const i of b.items) expect(['legendary', 'mythic']).toContain(i.rarityId);
    const [audit] = await audits(sifted, 'dungeon.claim');
    expect((audit!.data as Audit).filtered!.items).toHaveLength(b.filtered!.items.length);
  });
});

describe('never filtered', () => {
  it('quest rewards, including targeted contract rewards', async () => {
    const p = await newPlayer();
    await setFilter(
      p,
      rules({ action: 'sell', belowRarity: 'mythic', include: ['legendary', 'set', 'void'] }),
    );
    const rewards = [
      { baseId: 'iron-helm', rarityId: 'uncommon' as const, itemLevel: 5 },
      {
        slot: 'ring' as const,
        rarityId: 'rare' as const,
        itemLevel: 18,
        lootTableId: 'sunkenAbbey',
      },
    ];
    for (const [n, item] of rewards.entries()) {
      const id = uuidv7();
      await database.db.insert(characterQuests).values({
        id,
        characterId: p.id,
        kind: 'story',
        questId: n === 0 ? 'furrowsOfTheDead' : 'wolvesAtTheFence',
        objectives: [],
        progress: [],
        reward: { xp: 0, gold: 0, materials: {}, item },
        status: 'active',
        acceptedAt: new Date(nowMs),
      });
      const res = await call(p, 'POST', `/quests/${id}/turn-in`);
      expect(res.statusCode, res.body).toBe(200);
    }
    const owned = await itemsOf(p);
    expect(owned.map((i) => i.source)).toEqual(['quest', 'quest']);
    expect(owned.every((i) => lootFilterCategories(i as never).length === 0)).toBe(true);
  });
});
