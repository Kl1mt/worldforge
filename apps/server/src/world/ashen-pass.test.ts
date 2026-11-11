/**
 * Ticket 4.8: the Ashen Pass and the Warden's Watch are closed for everyone until the community
 * clears the pass (world flag `ashenPassCleared`, ticket 4.6), and open for everyone after. Every
 * server path that checks an unlock reads the flag: the world map, the farming start, the merchant
 * and the dungeon door. The crypt's progress is untouched by the Watch's boss.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, isNotNull } from 'drizzle-orm';
import { getArea, getLootTable, type WorldProgress } from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { DEFAULT_ACTIVITY_OPTIONS, type ActivityOptions } from '../activity/settle.js';
import type { ActivityStateResponse, SettleResponse } from '../activity/routes.js';
import { accounts, characters, dungeonRuns, itemInstances, worldFlags } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import type { DungeonClaimResponse, DungeonStateResponse } from '../dungeon/routes.js';
import type { MerchantResponse } from '../merchant/routes.js';
import { createTestDatabase } from '../test/db.js';
import { makeCryptReady } from '../test/dungeon.js';
import { insertCharacter } from '../test/heroes.js';
import { caller, insertAccount, type TestAccount } from '../test/social.js';
import type { WorldStateResponse } from './routes.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.parse('2026-11-07T12:00:00Z');
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
});

afterAll(async () => {
  await app.close();
  await database.close();
});

const VETERAN: WorldProgress = { gravewardenDefeated: true, cryptTierCleared: 3 };

/** An account whose active hero is a Gravewarden-slayer at `level` in Legendary +10 gear. */
async function veteran(level = 28): Promise<{ who: TestAccount; heroId: string }> {
  const who = await insertAccount(db(), { now: new Date(nowMs) });
  const hero = await insertCharacter(db(), who.id, { level, progress: VETERAN });
  await db().update(accounts).set({ activeCharacterId: hero.id }).where(eq(accounts.id, who.id));
  await makeCryptReady(db(), hero.id, 'warrior', level, { rarityId: 'legendary' });
  await db()
    .update(itemInstances)
    .set({ upgradeLevel: 10 })
    .where(and(eq(itemInstances.characterId, hero.id), isNotNull(itemInstances.equippedSlot)));
  return { who, heroId: hero.id };
}

async function setFlag(): Promise<void> {
  await db()
    .insert(worldFlags)
    .values({ flagId: 'ashenPassCleared', setAt: new Date(nowMs) })
    .onConflictDoNothing();
  app.worldState.invalidate();
}

const world = async (p: { who: TestAccount; heroId: string }) =>
  (await call(p.who, 'GET', `/api/characters/${p.heroId}/world`)).json<WorldStateResponse>();
const farm = (p: { who: TestAccount; heroId: string }, areaId: string) =>
  call(p.who, 'POST', `/api/characters/${p.heroId}/activity`, { areaId });
const enter = (p: { who: TestAccount; heroId: string }, dungeonId: string, tier?: number) =>
  call(p.who, 'POST', `/api/characters/${p.heroId}/dungeon`, {
    dungeonId,
    ...(tier ? { tier } : {}),
  });
const dungeons = async (p: { who: TestAccount; heroId: string }) =>
  (await call(p.who, 'GET', `/api/characters/${p.heroId}/dungeon`)).json<DungeonStateResponse>();
const merchantAreas = async (p: { who: TestAccount; heroId: string }) => {
  const res = await call(p.who, 'GET', `/api/characters/${p.heroId}/merchant`);
  expect(res.statusCode).toBe(200);
  return new Set(res.json<MerchantResponse>().offers.map((o) => o.areaId));
};

describe('the Ashen Pass behind the world flag (ticket 4.8)', () => {
  it('is closed for everyone until the pass is cleared: map, farming, merchant and the Watch', async () => {
    const p = await veteran();
    const w = await world(p);
    const pass = w.areas.find((a) => a.id === 'ashenPass')!;
    expect(pass).toEqual({
      id: 'ashenPass',
      unlocked: false,
      blockers: [{ kind: 'worldFlag', flag: 'ashenPassCleared' }],
    });
    // Every other area is open to this veteran: the flag closes only the pass.
    // Ticket 6.1: the Ashfall Verge waits for the Ashen Warden (never slain here); 6.2 the Depths.
    expect(w.areas.filter((a) => !a.unlocked).map((a) => a.id)).toEqual([
      'ashenPass',
      'ashfallVerge',
      'cinderDepths',
      // Ticket 8.1: the Pale Marches wait for the Forge Tyrant.
      'paleMarches',
    ]);
    expect(w.dungeons.find((d) => d.id === 'ashenWatch')).toEqual({
      id: 'ashenWatch',
      unlocked: false,
      available: true,
      blockers: [{ kind: 'worldFlag', flag: 'ashenPassCleared' }],
    });

    const res = await farm(p, 'ashenPass');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: {
        code: 'area_locked',
        details: {
          areaId: 'ashenPass',
          blockers: [{ kind: 'worldFlag', flag: 'ashenPassCleared' }],
        },
      },
    });
    expect((await merchantAreas(p)).has('ashenPass')).toBe(false);

    const watch = (await dungeons(p)).dungeons.find((d) => d.id === 'ashenWatch')!;
    expect(watch).toMatchObject({ unlocked: false, tierCleared: 0, bossLootReadyAt: null });
    expect(watch.tiers.map((t) => t.tier)).toEqual([1]);
    const door = await enter(p, 'ashenWatch');
    expect(door.statusCode).toBe(409);
    expect(door.json()).toMatchObject({
      error: { code: 'dungeon_locked', details: { dungeonId: 'ashenWatch', tier: 1 } },
    });
    // The Watch has one tier only.
    for (const tier of [2, 3]) {
      const bad = await enter(p, 'ashenWatch', tier);
      expect(bad.statusCode, `tier ${tier}`).toBe(400);
      expect(bad.json()).toMatchObject({
        error: { code: 'validation_failed', details: { fields: { tier: 'Choose one of: 1.' } } },
      });
    }
    // Nothing was started or stopped by the refusals.
    expect(
      await db().select().from(dungeonRuns).where(eq(dungeonRuns.characterId, p.heroId)),
    ).toEqual([]);
  });

  it('opens for everyone once the flag is set; the level and the Gravewarden still gate it', async () => {
    const young = await veteran(23);
    const fresh = await insertAccount(db(), { now: new Date(nowMs) });
    const noBoss = await insertCharacter(db(), fresh.id, { level: 28 });
    await setFlag();

    const p = await veteran();
    const w = await world(p);
    // The Cinderwastes (6.1, 6.2) wait for the Ashen Warden.
    // Ticket 8.1: and the Hollow Reach for the Forge Tyrant.
    const cinderwastes = ['ashfallVerge', 'cinderDepths', 'tyrantsForge', 'paleMarches'];
    expect(w.areas.every((a) => a.unlocked || cinderwastes.includes(a.id))).toBe(true);
    expect(w.dungeons.every((d) => d.unlocked || cinderwastes.includes(d.id))).toBe(true);
    expect(w.dungeons.find((d) => d.id === 'ashenWatch')!.unlocked).toBe(true);
    expect((await world(young)).areas.find((a) => a.id === 'ashenPass')!.blockers).toEqual([
      { kind: 'level', required: 24 },
    ]);
    expect((await world(young)).dungeons.find((d) => d.id === 'ashenWatch')!.blockers).toEqual([
      { kind: 'level', required: 26 },
    ]);
    const other = { who: fresh, heroId: noBoss.id };
    expect((await world(other)).areas.find((a) => a.id === 'ashenPass')!.blockers).toEqual([
      { kind: 'gravewardenDefeated' },
    ]);

    // Farming: the pass's foes and materials, its loot at its item levels.
    const res = await farm(p, 'ashenPass');
    expect(res.statusCode).toBe(201);
    expect(res.json<ActivityStateResponse>().activity!.areaId).toBe('ashenPass');
    nowMs += HOUR;
    const settled = (
      await call(p.who, 'POST', `/api/characters/${p.heroId}/activity/settle`)
    ).json<SettleResponse>();
    const { summary } = settled;
    expect(summary.kills).toBeGreaterThan(300);
    expect(
      Object.keys(summary.materials ?? {}).every((id) => ['ironOre', 'soulShard'].includes(id)),
    ).toBe(true);
    // Drops come from the pass's table, at its item levels (23–29).
    const table = getLootTable(getArea('ashenPass').lootTableId);
    expect(summary.items.length).toBeGreaterThan(0);
    for (const item of summary.items) {
      expect(item.itemLevel).toBeGreaterThanOrEqual(table.itemLevel!.min);
      expect(item.itemLevel).toBeLessThanOrEqual(table.itemLevel!.max);
    }
    expect((await merchantAreas(p)).has('ashenPass')).toBe(true);
    expect((await merchantAreas(young)).has('ashenPass')).toBe(false);
  });

  it('the Watch: a boss-only run against the Ashen Warden, its own progress and hoard', async () => {
    await setFlag();
    const p = await veteran();
    const start = await enter(p, 'ashenWatch');
    expect(start.statusCode).toBe(201);
    const run = start.json<{ run: { tier: number; endsAt: string; bossLootEligible: boolean } }>()
      .run;
    expect(run).toMatchObject({ tier: 1, bossLootEligible: true });
    // Another run, of either dungeon, waits for the claim.
    expect((await enter(p, 'namelessCrypt', 3)).statusCode).toBe(409);
    nowMs = Date.parse(run.endsAt) + 1;
    const claim = await app.inject({
      method: 'POST',
      url: `/api/characters/${p.heroId}/dungeon/claim`,
      headers: { 'idempotency-key': `watch-${p.heroId}` },
      cookies: { [SESSION_COOKIE]: p.who.token },
    });
    expect(claim.statusCode).toBe(200);
    const result = claim.json<DungeonClaimResponse>().result;
    expect(result).toMatchObject({
      dungeonId: 'ashenWatch',
      tier: 1,
      totalRooms: 0,
      outcome: 'cleared',
      bossDefeated: true,
      bossLoot: true,
      firstBossKill: true,
      firstTierClear: true,
    });
    expect(result.items).toHaveLength(2);
    for (const item of result.items) {
      expect(item.itemLevel).toBeGreaterThanOrEqual(27);
      expect(item.itemLevel).toBeLessThanOrEqual(29);
    }
    const [hero] = await db().select().from(characters).where(eq(characters.id, p.heroId));
    // Its own progress; the crypt's is unchanged.
    expect(hero!.progress).toEqual({ ...VETERAN, ashenWardenDefeated: true });
    const sources = await db()
      .select({ source: itemInstances.source })
      .from(itemInstances)
      .where(
        and(
          eq(itemInstances.characterId, p.heroId),
          // Ticket T.1: a boss-only run drops only the hoard.
          eq(itemInstances.source, 'hoard:ashenWatch'),
        ),
      );
    expect(sources.length).toBeGreaterThan(0);
    const state = await dungeons(p);
    const watch = state.dungeons.find((d) => d.id === 'ashenWatch')!;
    const crypt = state.dungeons.find((d) => d.id === 'namelessCrypt')!;
    expect(watch.tierCleared).toBe(1);
    expect(crypt.tierCleared).toBe(3);
    // The Watch's hoard has its own cooldown: the crypt's hoard is still ready.
    expect(watch.bossLootReadyAt).not.toBeNull();
    expect(crypt.bossLootReadyAt).toBeNull();
  });
});
