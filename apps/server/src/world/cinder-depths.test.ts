/**
 * Ticket 6.2: the Cinder Depths (the Cinderwastes' second area, 34–40) and its region boss, the
 * Forge Tyrant, fought alone in the Tyrant's Forge. The Depths open at level 34 for a Warden
 * slayer (the Verge's top milestone); the Forge at 36. No world flag yet (6.7's seam): the flags
 * change nothing for them. The Tyrant's hoard is always bound (`hoard:tyrantsForge`) and carries
 * his ember, which only the Tyrantforged Work recipe spends.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, isNotNull } from 'drizzle-orm';
import {
  getArea,
  getItemBase,
  getLootTable,
  simulateDungeonRun,
  type WorldProgress,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { DEFAULT_ACTIVITY_OPTIONS, type ActivityOptions } from '../activity/settle.js';
import type { SettleResponse } from '../activity/routes.js';
import {
  accounts,
  characterMaterials,
  characters,
  dungeonRuns,
  itemInstances,
  worldFlags,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import type { DungeonClaimResponse, DungeonStateResponse } from '../dungeon/routes.js';
import { createTestDatabase } from '../test/db.js';
import { makeCryptReady } from '../test/dungeon.js';
import { insertCharacter } from '../test/heroes.js';
import { caller, insertAccount, type TestAccount } from '../test/social.js';
import { giveMaterials } from '../test/trading.js';
import type { WorldStateResponse } from './routes.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.parse('2026-11-10T12:00:00Z');
const options: ActivityOptions = {
  ...DEFAULT_ACTIVITY_OPTIONS,
  offlineCapMs: 3 * HOUR,
  now: () => new Date(nowMs),
};
const db = () => database.db;
let call: ReturnType<typeof caller>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({ database, auth: { now: () => new Date(nowMs) }, activity: options });
  await app.ready();
  call = caller(app);
  await db()
    .insert(worldFlags)
    .values({ flagId: 'ashenPassCleared', setAt: new Date(nowMs) });
  app.worldState.invalidate();
});

afterAll(async () => {
  await app.close();
  await database.close();
});

const VETERAN: WorldProgress = { gravewardenDefeated: true, cryptTierCleared: 3 };
const WARDEN_SLAYER: WorldProgress = { ...VETERAN, ashenWardenDefeated: true };

type Hero = { who: TestAccount; heroId: string };

/** A warrior at `level` in Legendaries +10 at item level = level (makeCryptReady's kit). */
async function hero(level: number, progress: WorldProgress): Promise<Hero> {
  const who = await insertAccount(db(), { now: new Date(nowMs) });
  const h = await insertCharacter(db(), who.id, { level, progress });
  await db().update(accounts).set({ activeCharacterId: h.id }).where(eq(accounts.id, who.id));
  await makeCryptReady(db(), h.id, 'warrior', level, { rarityId: 'legendary' });
  await db()
    .update(itemInstances)
    .set({ upgradeLevel: 10 })
    .where(and(eq(itemInstances.characterId, h.id), isNotNull(itemInstances.equippedSlot)));
  return { who, heroId: h.id };
}

const keyed = (p: Hero, url: string, payload?: object) =>
  app.inject({
    method: 'POST',
    url,
    ...(payload ? { payload } : {}),
    headers: { 'idempotency-key': randomUUID() },
    cookies: { [SESSION_COOKIE]: p.who.token },
  });
const depths = async (p: Hero) =>
  (await call(p.who, 'GET', `/api/characters/${p.heroId}/world`))
    .json<WorldStateResponse>()
    .areas.find((a) => a.id === 'cinderDepths')!;
const forgeState = async (p: Hero) =>
  (await call(p.who, 'GET', `/api/characters/${p.heroId}/dungeon`))
    .json<DungeonStateResponse>()
    .dungeons.find((d) => d.id === 'tyrantsForge')!;
const enterForge = (p: Hero) =>
  call(p.who, 'POST', `/api/characters/${p.heroId}/dungeon`, { dungeonId: 'tyrantsForge' });
const materials = async (p: Hero) =>
  Object.fromEntries(
    (
      await db()
        .select()
        .from(characterMaterials)
        .where(eq(characterMaterials.characterId, p.heroId))
    ).map((m) => [m.materialId, m.quantity]),
  );

/**
 * Pins the started run's secret to one game-core says the hero wins (CLAUDE.md: search for a seed
 * that exhibits the case with game-core's own rules), and returns the predicted result.
 */
async function pinWinningSeed(p: Hero) {
  const [run] = await db().select().from(dungeonRuns).where(eq(dungeonRuns.characterId, p.heroId));
  for (let i = 0; i < 200; i++) {
    const seed = `forge-win:${i}`;
    const r = simulateDungeonRun({
      dungeonId: run!.dungeonId,
      tier: run!.tier,
      character: run!.snapshot,
      equipment: run!.snapshot.equipment,
      seed,
      bossLootEligible: run!.bossLootEligible,
      inventoryCount: 0,
    });
    if (r.bossDefeated) {
      await db().update(dungeonRuns).set({ seedSecret: seed }).where(eq(dungeonRuns.id, run!.id));
      return r;
    }
  }
  throw new Error('no winning seed in 200');
}

describe('the Cinder Depths (ticket 6.2)', () => {
  it('stays closed below 34 or without the Ashen Warden, on the map and for farming', async () => {
    const young = await hero(33, WARDEN_SLAYER);
    expect(await depths(young)).toEqual({
      id: 'cinderDepths',
      unlocked: false,
      blockers: [{ kind: 'level', required: 34 }],
    });
    const res = await call(young.who, 'POST', `/api/characters/${young.heroId}/activity`, {
      areaId: 'cinderDepths',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('area_locked');
    const noWarden = await hero(40, VETERAN);
    expect((await depths(noWarden)).blockers).toEqual([{ kind: 'ashenWardenDefeated' }]);
    // The Forge waits for level 36 (and the Warden).
    expect((await forgeState(young)).blockers).toEqual([{ kind: 'level', required: 36 }]);
    expect((await enterForge(young)).statusCode).toBe(409);
    expect((await forgeState(noWarden)).blockers).toEqual([{ kind: 'ashenWardenDefeated' }]);
  });

  it('opens at 34: Verge-level gear farms it, tier-4 drops at 35–41, existing materials', async () => {
    const p = await hero(34, WARDEN_SLAYER);
    expect(await depths(p)).toEqual({ id: 'cinderDepths', unlocked: true, blockers: [] });
    const res = await call(p.who, 'POST', `/api/characters/${p.heroId}/activity`, {
      areaId: 'cinderDepths',
    });
    expect(res.statusCode).toBe(201);
    nowMs += HOUR;
    const { summary } = (
      await call(p.who, 'POST', `/api/characters/${p.heroId}/activity/settle`)
    ).json<SettleResponse>();
    // Holds in every seed for this kit (balance.test.ts measures 6–13 kills a minute, no deaths).
    expect(summary.kills).toBeGreaterThan(200);
    expect(summary.deaths).toBeLessThanOrEqual(3);
    expect(
      Object.keys(summary.materials ?? {}).every((id) => ['ironOre', 'soulShard'].includes(id)),
    ).toBe(true);
    const table = getLootTable(getArea('cinderDepths').lootTableId);
    for (const item of summary.items) {
      expect(item.itemLevel).toBeGreaterThanOrEqual(table.itemLevel!.min);
      expect(item.itemLevel).toBeLessThanOrEqual(table.itemLevel!.max);
    }
    const stored = await db()
      .select({ baseId: itemInstances.baseId, setId: itemInstances.setId })
      .from(itemInstances)
      .where(and(eq(itemInstances.characterId, p.heroId), eq(itemInstances.source, 'farming')));
    for (const r of stored.filter((x) => x.setId === null && !getItemBase(x.baseId).unique))
      expect(getItemBase(r.baseId).tier, r.baseId).toBe(4);
    await call(p.who, 'POST', `/api/characters/${p.heroId}/activity/stop`);
  });

  it('the Forge: a boss-only run, its own progress, an always-bound hoard and the ember', async () => {
    const p = await hero(40, WARDEN_SLAYER);
    expect(await forgeState(p)).toMatchObject({ unlocked: true, tierCleared: 0 });
    const start = await enterForge(p);
    expect(start.statusCode, start.body).toBe(201);
    expect(start.json().run).toMatchObject({ tier: 1, bossLootEligible: true });
    const predicted = await pinWinningSeed(p);
    nowMs += 2 * HOUR;
    const claim = await keyed(p, `/api/characters/${p.heroId}/dungeon/claim`);
    expect(claim.statusCode, claim.body).toBe(200);
    const result = claim.json<DungeonClaimResponse>().result;
    expect(result).toMatchObject({
      dungeonId: 'tyrantsForge',
      tier: 1,
      totalRooms: 0,
      outcome: 'cleared',
      bossDefeated: true,
      bossLoot: true,
      firstBossKill: true,
      firstTierClear: true,
      materials: { tyrantsEmber: 1 },
    });
    expect(result.xpGained).toBe(predicted.xpGained);
    expect(result.items.length + result.itemsSalvaged).toBe(2);
    const [row] = await db().select().from(characters).where(eq(characters.id, p.heroId));
    expect(row!.progress).toEqual({ ...WARDEN_SLAYER, forgeTyrantDefeated: true });
    expect((await materials(p)).tyrantsEmber).toBe(1);
    // T.1: every hoard item is bound to the account, whatever its rarity (never tradeable).
    const hoard = await db()
      .select()
      .from(itemInstances)
      .where(
        and(
          eq(itemInstances.characterId, p.heroId),
          eq(itemInstances.source, 'hoard:tyrantsForge'),
        ),
      );
    expect(hoard.length).toBe(result.items.length);
    for (const item of hoard) {
      expect(item.binding, item.rarityId).toBe('account');
      expect(item.itemLevel).toBeGreaterThanOrEqual(39);
    }
    const state = await forgeState(p);
    expect(state.tierCleared).toBe(1);
    // Its own hoard cooldown: the Watch's hoard is still ready.
    expect(state.bossLootReadyAt).not.toBeNull();
    const all = (
      await call(p.who, 'GET', `/api/characters/${p.heroId}/dungeon`)
    ).json<DungeonStateResponse>();
    expect(all.dungeons.find((d) => d.id === 'ashenWatch')!.bossLootReadyAt).toBeNull();
    // A second run in the cooldown drops no hoard and no ember.
    const again = await enterForge(p);
    expect(again.json().run.bossLootEligible).toBe(false);
  });

  it('the ember’s sink: Tyrantforged Work spends exactly one per tier-4 item', async () => {
    const p = await hero(38, { ...WARDEN_SLAYER, forgeTyrantDefeated: true });
    const forge = async () =>
      (await call(p.who, 'GET', `/api/characters/${p.heroId}/forge`))
        .json<{
          recipes: { recipeId: string; blockers: { kind: string; materialId?: string }[] }[];
        }>()
        .recipes.find((r) => r.recipeId === 'tyrantforgedWork')!;
    await db().update(characters).set({ gold: 10_000 }).where(eq(characters.id, p.heroId));
    await giveMaterials(db(), p.heroId, { ironOre: 200, soulShard: 40 });
    expect((await forge()).blockers).toEqual([
      expect.objectContaining({ kind: 'material', materialId: 'tyrantsEmber' }),
    ]);
    const refused = await keyed(p, `/api/characters/${p.heroId}/forge/craft`, {
      recipeId: 'tyrantforgedWork',
      slot: 'chest',
    });
    expect(refused.statusCode).toBe(422);
    await giveMaterials(db(), p.heroId, { tyrantsEmber: 1 });
    const crafted = await keyed(p, `/api/characters/${p.heroId}/forge/craft`, {
      recipeId: 'tyrantforgedWork',
      slot: 'chest',
    });
    expect(crafted.statusCode, crafted.body).toBe(200);
    const item = crafted.json().item as { baseId: string; itemLevel: number; rarityId: string };
    expect(getItemBase(item.baseId).tier).toBe(4);
    expect(getItemBase(item.baseId).slot).toBe('chest');
    expect(item.itemLevel).toBe(38);
    expect(['rare', 'epic']).toContain(item.rarityId);
    expect(await materials(p)).toMatchObject({ tyrantsEmber: 0, ironOre: 140, soulShard: 28 });
    const [row] = await db().select().from(characters).where(eq(characters.id, p.heroId));
    expect(row!.gold).toBe(7_000);
  });
});
