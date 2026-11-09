/**
 * Ticket 6.1: the Ashfall Verge, the first area of the Cinderwastes. Open to heroes of level 28 who
 * slew the Ashen Warden; every server path that checks an unlock agrees (the world map, the
 * farming start, the merchant). No world flag yet (6.7 adds the community gate): the flags change
 * nothing for it. Drops are tier-4 bases at item levels 29–35.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, isNotNull } from 'drizzle-orm';
import { getArea, getItemBase, getLootTable, type WorldProgress } from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS, type ActivityOptions } from '../activity/settle.js';
import type { ActivityStateResponse, SettleResponse } from '../activity/routes.js';
import { accounts, itemInstances, worldFlags } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
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
let nowMs = Date.parse('2026-11-09T12:00:00Z');
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
  // The Pass is open (its community project done): the Warden can be fought.
  await db()
    .insert(worldFlags)
    .values({ flagId: 'ashenPassCleared', setAt: new Date(nowMs) });
  app.worldState.invalidate();
});

afterAll(async () => {
  await app.close();
  await database.close();
});

const PASS_VETERAN: WorldProgress = { gravewardenDefeated: true, cryptTierCleared: 3 };
const WARDEN_SLAYER: WorldProgress = { ...PASS_VETERAN, ashenWardenDefeated: true };

type Hero = { who: TestAccount; heroId: string };

/** A hero at `level` in Legendaries +10 (the test kit, item level below the hero's). */
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

const verge = async (p: Hero) =>
  (await call(p.who, 'GET', `/api/characters/${p.heroId}/world`))
    .json<WorldStateResponse>()
    .areas.find((a) => a.id === 'ashfallVerge')!;
const farm = (p: Hero) =>
  call(p.who, 'POST', `/api/characters/${p.heroId}/activity`, { areaId: 'ashfallVerge' });
const merchantAreas = async (p: Hero) => {
  const res = await call(p.who, 'GET', `/api/characters/${p.heroId}/merchant`);
  expect(res.statusCode).toBe(200);
  return new Set(res.json<MerchantResponse>().offers.map((o) => o.areaId));
};

describe('the Ashfall Verge (ticket 6.1)', () => {
  it('stays closed without the Ashen Warden or below level 28, on every path', async () => {
    const noWarden = await hero(30, PASS_VETERAN);
    expect(await verge(noWarden)).toEqual({
      id: 'ashfallVerge',
      unlocked: false,
      blockers: [{ kind: 'ashenWardenDefeated' }],
    });
    const res = await farm(noWarden);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: {
        code: 'area_locked',
        details: { areaId: 'ashfallVerge', blockers: [{ kind: 'ashenWardenDefeated' }] },
      },
    });
    expect((await merchantAreas(noWarden)).has('ashfallVerge')).toBe(false);

    const young = await hero(27, WARDEN_SLAYER);
    expect((await verge(young)).blockers).toEqual([{ kind: 'level', required: 28 }]);
    expect((await farm(young)).statusCode).toBe(409);
    expect((await merchantAreas(young)).has('ashfallVerge')).toBe(false);
  });

  it('opens at 28 for a Warden slayer: tier-4 drops at 29–35, existing materials, its merchant', async () => {
    const p = await hero(28, WARDEN_SLAYER);
    expect(await verge(p)).toEqual({ id: 'ashfallVerge', unlocked: true, blockers: [] });
    const res = await farm(p);
    expect(res.statusCode).toBe(201);
    expect(res.json<ActivityStateResponse>().activity!.areaId).toBe('ashfallVerge');
    nowMs += HOUR;
    const { summary } = (
      await call(p.who, 'POST', `/api/characters/${p.heroId}/activity/settle`)
    ).json<SettleResponse>();
    // The Pass's best plain gear farms it: hundreds of kills an hour, no deaths to speak of.
    expect(summary.kills).toBeGreaterThan(250);
    expect(summary.deaths).toBeLessThanOrEqual(2);
    expect(
      Object.keys(summary.materials ?? {}).every((id) => ['ironOre', 'soulShard'].includes(id)),
    ).toBe(true);
    const table = getLootTable(getArea('ashfallVerge').lootTableId);
    expect(summary.items.length).toBeGreaterThan(0);
    for (const item of summary.items) {
      expect(item.itemLevel).toBeGreaterThanOrEqual(table.itemLevel!.min);
      expect(item.itemLevel).toBeLessThanOrEqual(table.itemLevel!.max);
    }
    const stored = await db()
      .select({ baseId: itemInstances.baseId, setId: itemInstances.setId })
      .from(itemInstances)
      .where(and(eq(itemInstances.characterId, p.heroId), eq(itemInstances.source, 'farming')));
    // Regular drops are tier 4 (set pieces and Mythics keep their own bases).
    const regular = stored.filter((r) => r.setId === null && !getItemBase(r.baseId).unique);
    expect(regular.length).toBeGreaterThan(0);
    for (const r of regular) expect(getItemBase(r.baseId).tier, r.baseId).toBe(4);
    expect((await merchantAreas(p)).has('ashfallVerge')).toBe(true);
  });
});
