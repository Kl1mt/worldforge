/**
 * Ticket 8.2: the Hollow Deep (the Hollow Reach's second area, 46–52) and its region boss, the
 * Hollow Sovereign, fought alone in the Hollow Throne. Both wait for the lanterns of the deep (a
 * world flag the community sets; new content, so nothing live is taken away), the Forge Tyrant and
 * a level (46 for the Deep, 48 for the Throne). The Sovereign's hoard is always bound
 * (`hoard:hollowThrone`) and carries a crown shard, which only the Crownforged Work recipe spends.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, isNotNull } from 'drizzle-orm';
import {
  UNTRADEABLE_MATERIALS,
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
const DAY = 24 * HOUR;
// Derived from the wall clock (CLAUDE.md "Dates"): noon UTC of a day a week ahead.
let nowMs = Math.floor((Date.now() + 7 * DAY) / DAY) * DAY + DAY / 2;
let database: DatabaseHandle;
let app: FastifyInstance;
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
    .values([
      { flagId: 'ashenPassCleared', setAt: new Date(nowMs) },
      { flagId: 'forgewardRaised', setAt: new Date(nowMs) },
    ]);
  app.worldState.invalidate();
});

afterAll(async () => {
  await app.close();
  await database.close();
});

async function lightLanterns() {
  await db()
    .insert(worldFlags)
    .values({ flagId: 'deepLanternsLit', setAt: new Date(nowMs) })
    .onConflictDoNothing();
  app.worldState.invalidate();
}

const TYRANT_SLAYER: WorldProgress = {
  gravewardenDefeated: true,
  cryptTierCleared: 4,
  ashenWardenDefeated: true,
  forgeTyrantDefeated: true,
};

type Hero = { who: TestAccount; heroId: string };

/** A warrior at `level` in Legendaries +10 at item level `itemLevel` (the best Marches gear). */
async function hero(level: number, progress: WorldProgress, itemLevel = 47): Promise<Hero> {
  const who = await insertAccount(db(), { now: new Date(nowMs) });
  const h = await insertCharacter(db(), who.id, { level, progress });
  await db().update(accounts).set({ activeCharacterId: h.id }).where(eq(accounts.id, who.id));
  await makeCryptReady(db(), h.id, 'warrior', itemLevel, { rarityId: 'legendary' });
  // makeCryptReady sets the level to the kit's item level: put the hero's own back.
  await db().update(characters).set({ level }).where(eq(characters.id, h.id));
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
const deep = async (p: Hero) =>
  (await call(p.who, 'GET', `/api/characters/${p.heroId}/world`))
    .json<WorldStateResponse>()
    .areas.find((a) => a.id === 'hollowDeep')!;
const throneState = async (p: Hero) =>
  (await call(p.who, 'GET', `/api/characters/${p.heroId}/dungeon`))
    .json<DungeonStateResponse>()
    .dungeons.find((d) => d.id === 'hollowThrone')!;
const enterThrone = (p: Hero) =>
  call(p.who, 'POST', `/api/characters/${p.heroId}/dungeon`, { dungeonId: 'hollowThrone' });
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
 * Pins the started run's secret to one game-core says the hero wins, with the run's stored boss
 * modifier (CLAUDE.md: search for a seed that exhibits the case with game-core's own rules).
 */
async function pinWinningSeed(p: Hero) {
  const [run] = await db().select().from(dungeonRuns).where(eq(dungeonRuns.characterId, p.heroId));
  for (let i = 0; i < 200; i++) {
    const seed = `throne-win:${i}`;
    const r = simulateDungeonRun({
      dungeonId: run!.dungeonId,
      tier: run!.tier,
      character: run!.snapshot,
      equipment: run!.snapshot.equipment,
      seed,
      bossLootEligible: run!.bossLootEligible,
      inventoryCount: 0,
      bossModifier: run!.bossModifier,
    });
    if (r.bossDefeated) {
      await db().update(dungeonRuns).set({ seedSecret: seed }).where(eq(dungeonRuns.id, run!.id));
      return r;
    }
  }
  throw new Error('no winning seed in 200');
}

describe('the Hollow Deep and the Hollow Throne (ticket 8.2)', () => {
  it('stay closed until the lanterns are lit, whatever the hero’s level and kills', async () => {
    // Each test sets the flag it needs (no test relies on another's order).
    await db().delete(worldFlags).where(eq(worldFlags.flagId, 'deepLanternsLit'));
    app.worldState.invalidate();
    const top = await hero(52, { ...TYRANT_SLAYER, hollowSovereignDefeated: true });
    expect(await deep(top)).toEqual({
      id: 'hollowDeep',
      unlocked: false,
      blockers: [{ kind: 'worldFlag', flag: 'deepLanternsLit' }],
    });
    const res = await call(top.who, 'POST', `/api/characters/${top.heroId}/activity`, {
      areaId: 'hollowDeep',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('area_locked');
    expect((await throneState(top)).blockers).toEqual([
      { kind: 'worldFlag', flag: 'deepLanternsLit' },
    ]);
    expect((await enterThrone(top)).statusCode).toBe(409);
    // The Pale Marches stay open as they were.
    const marches = (await call(top.who, 'GET', `/api/characters/${top.heroId}/world`))
      .json<WorldStateResponse>()
      .areas.find((a) => a.id === 'paleMarches')!;
    expect(marches).toEqual({ id: 'paleMarches', unlocked: true, blockers: [] });
  });

  it('with the lanterns: level 46 and the Tyrant for the Deep, 48 for the Throne', async () => {
    await lightLanterns();
    const young = await hero(45, TYRANT_SLAYER);
    expect((await deep(young)).blockers).toEqual([{ kind: 'level', required: 46 }]);
    const noTyrant = await hero(52, { ...TYRANT_SLAYER, forgeTyrantDefeated: false });
    expect((await deep(noTyrant)).blockers).toEqual([{ kind: 'forgeTyrantDefeated' }]);
    expect((await throneState(noTyrant)).blockers).toEqual([{ kind: 'forgeTyrantDefeated' }]);
    const at47 = await hero(47, TYRANT_SLAYER);
    expect((await deep(at47)).unlocked).toBe(true);
    expect((await throneState(at47)).blockers).toEqual([{ kind: 'level', required: 48 }]);
    expect((await enterThrone(at47)).statusCode).toBe(409);
  });

  it('opens at 46: the best Marches gear farms it, tier-5 drops at 47–53, existing materials', async () => {
    await lightLanterns();
    const p = await hero(46, TYRANT_SLAYER);
    expect(await deep(p)).toEqual({ id: 'hollowDeep', unlocked: true, blockers: [] });
    const res = await call(p.who, 'POST', `/api/characters/${p.heroId}/activity`, {
      areaId: 'hollowDeep',
    });
    expect(res.statusCode).toBe(201);
    nowMs += HOUR;
    const { summary } = (
      await call(p.who, 'POST', `/api/characters/${p.heroId}/activity/settle`)
    ).json<SettleResponse>();
    // Holds in every seed for this kit (hollow-deep-balance.test.ts: 7–10 kills a minute, none
    // lost with the Marches' Legendaries +10).
    expect(summary.kills).toBeGreaterThan(250);
    expect(summary.deaths).toBeLessThanOrEqual(3);
    expect(
      Object.keys(summary.materials ?? {}).every((id) => ['ironOre', 'soulShard'].includes(id)),
    ).toBe(true);
    const table = getLootTable(getArea('hollowDeep').lootTableId);
    for (const item of summary.items) {
      expect(item.itemLevel).toBeGreaterThanOrEqual(table.itemLevel!.min);
      expect(item.itemLevel).toBeLessThanOrEqual(table.itemLevel!.max);
    }
    const stored = await db()
      .select({ baseId: itemInstances.baseId, setId: itemInstances.setId })
      .from(itemInstances)
      .where(and(eq(itemInstances.characterId, p.heroId), eq(itemInstances.source, 'farming')));
    for (const r of stored.filter((x) => x.setId === null && !getItemBase(x.baseId).unique))
      expect(getItemBase(r.baseId).tier, r.baseId).toBe(5);
    await call(p.who, 'POST', `/api/characters/${p.heroId}/activity/stop`);
  });

  it('the Throne: a boss-only run with the week’s modifier, its own progress, a bound hoard and the shard', async () => {
    await lightLanterns();
    const p = await hero(50, TYRANT_SLAYER);
    expect(await throneState(p)).toMatchObject({ unlocked: true, tierCleared: 0 });
    const start = await enterThrone(p);
    expect(start.statusCode, start.body).toBe(201);
    expect(start.json().run).toMatchObject({ tier: 1, bossLootEligible: true });
    // 6.3: the week's modifier is stored with the run (the Sovereign takes one).
    const [run] = await db()
      .select()
      .from(dungeonRuns)
      .where(eq(dungeonRuns.characterId, p.heroId));
    expect(run!.bossModifier).not.toBeNull();
    const predicted = await pinWinningSeed(p);
    nowMs += 2 * HOUR;
    const claim = await keyed(p, `/api/characters/${p.heroId}/dungeon/claim`);
    expect(claim.statusCode, claim.body).toBe(200);
    const result = claim.json<DungeonClaimResponse>().result;
    expect(result).toMatchObject({
      dungeonId: 'hollowThrone',
      tier: 1,
      totalRooms: 0,
      outcome: 'cleared',
      bossDefeated: true,
      bossLoot: true,
      firstBossKill: true,
      firstTierClear: true,
      materials: { crownShard: 1 },
    });
    expect(result.xpGained).toBe(predicted.xpGained);
    expect(result.items.length + result.itemsSalvaged).toBe(2);
    const [row] = await db().select().from(characters).where(eq(characters.id, p.heroId));
    expect(row!.progress).toEqual({ ...TYRANT_SLAYER, hollowSovereignDefeated: true });
    expect((await materials(p)).crownShard).toBe(1);
    // T.1: every hoard item is bound to the account, whatever its rarity (never tradeable).
    const hoard = await db()
      .select()
      .from(itemInstances)
      .where(
        and(
          eq(itemInstances.characterId, p.heroId),
          eq(itemInstances.source, 'hoard:hollowThrone'),
        ),
      );
    expect(hoard.length).toBe(result.items.length);
    for (const item of hoard) {
      expect(item.binding, item.rarityId).toBe('account');
      expect(item.itemLevel).toBeGreaterThanOrEqual(51);
      expect(getItemBase(item.baseId).tier).toBe(5);
    }
    // The shard is never tradeable, like the Tyrant's Ember.
    expect(UNTRADEABLE_MATERIALS).toContain('crownShard');
    const state = await throneState(p);
    expect(state.tierCleared).toBe(1);
    expect(state.bossLootReadyAt).not.toBeNull();
    // Its own hoard cooldown: the Tyrant's hoard is still ready.
    const all = (
      await call(p.who, 'GET', `/api/characters/${p.heroId}/dungeon`)
    ).json<DungeonStateResponse>();
    expect(all.dungeons.find((d) => d.id === 'tyrantsForge')!.bossLootReadyAt).toBeNull();
    const again = await enterThrone(p);
    expect(again.json().run.bossLootEligible).toBe(false);
  });

  it('the shard’s sink: Crownforged Work spends exactly one per tier-5 piece, at the lantern smithy’s price', async () => {
    await lightLanterns();
    const p = await hero(49, { ...TYRANT_SLAYER, hollowSovereignDefeated: true });
    const forge = async () =>
      (await call(p.who, 'GET', `/api/characters/${p.heroId}/forge`))
        .json<{
          recipes: {
            recipeId: string;
            gold: number;
            townUpgrade?: { id: string; baseGold: number };
            blockers: { kind: string; materialId?: string }[];
          }[];
        }>()
        .recipes.find((r) => r.recipeId === 'crownforgedWork')!;
    await db().update(characters).set({ gold: 10_000 }).where(eq(characters.id, p.heroId));
    await giveMaterials(db(), p.heroId, { ironOre: 200, soulShard: 40 });
    const listed = await forge();
    expect(listed.blockers).toEqual([
      expect.objectContaining({ kind: 'material', materialId: 'crownShard' }),
    ]);
    // The lanterns are lit: the lantern smithy takes a fifth off the gold.
    expect(listed).toMatchObject({
      gold: 3_600,
      townUpgrade: { id: 'lanternSmithy', baseGold: 4_500 },
    });
    const refused = await keyed(p, `/api/characters/${p.heroId}/forge/craft`, {
      recipeId: 'crownforgedWork',
      slot: 'weapon',
    });
    expect(refused.statusCode).toBe(422);
    await giveMaterials(db(), p.heroId, { crownShard: 1 });
    const crafted = await keyed(p, `/api/characters/${p.heroId}/forge/craft`, {
      recipeId: 'crownforgedWork',
      slot: 'weapon',
    });
    expect(crafted.statusCode, crafted.body).toBe(200);
    const item = crafted.json().item as { baseId: string; itemLevel: number; rarityId: string };
    expect(getItemBase(item.baseId).tier).toBe(5);
    expect(getItemBase(item.baseId).slot).toBe('weapon');
    expect(item.itemLevel).toBe(49);
    expect(['rare', 'epic']).toContain(item.rarityId);
    expect(await materials(p)).toMatchObject({ crownShard: 0, ironOre: 120, soulShard: 24 });
    const [row] = await db().select().from(characters).where(eq(characters.id, p.heroId));
    expect(row!.gold).toBe(6_400);
  });
});
