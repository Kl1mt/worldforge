/**
 * Ticket 8.1: the Pale Marches, the first area of Region III (the Hollow Reach). Open to heroes of
 * level 40 who slew the Forge Tyrant; every server path that checks an unlock agrees (the world
 * map, the farming start, the merchant). It has no world flag (8.2's community gate is for the
 * region's later places; nothing live is ever taken away): the flags change nothing for it. Drops
 * are tier-5 bases at item levels 41–47; the merchant always stocks its offers (F.7's lesson).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, isNotNull } from 'drizzle-orm';
import {
  DEFAULT_ECONOMY_CONFIG,
  WORLD_FLAG_IDS,
  getArea,
  getItemBase,
  getLootTable,
  type WorldProgress,
} from '@worldforge/game-core';
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
// The injected clock starts at the wall clock (CLAUDE.md "Dates"), on a whole minute.
let nowMs = Math.floor(Date.now() / MIN) * MIN;
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

const WARDEN_SLAYER: WorldProgress = {
  gravewardenDefeated: true,
  cryptTierCleared: 3,
  ashenWardenDefeated: true,
};
const TYRANT_SLAYER: WorldProgress = { ...WARDEN_SLAYER, forgeTyrantDefeated: true };

type Hero = { who: TestAccount; heroId: string };

/** A hero at `level` in the test kit's Legendaries +10 (tier 4 below 41: today's best gear). */
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

const marches = async (p: Hero) =>
  (await call(p.who, 'GET', `/api/characters/${p.heroId}/world`))
    .json<WorldStateResponse>()
    .areas.find((a) => a.id === 'paleMarches')!;
const farm = (p: Hero) =>
  call(p.who, 'POST', `/api/characters/${p.heroId}/activity`, { areaId: 'paleMarches' });
const merchant = async (p: Hero) => {
  const res = await call(p.who, 'GET', `/api/characters/${p.heroId}/merchant`);
  expect(res.statusCode).toBe(200);
  return res.json<MerchantResponse>();
};
const marchesOffers = async (p: Hero) =>
  (await merchant(p)).offers.filter((o) => o.areaId === 'paleMarches');

describe('the Pale Marches (ticket 8.1)', () => {
  it('stays closed without the Forge Tyrant or below level 40, on every path', async () => {
    const noTyrant = await hero(44, WARDEN_SLAYER);
    expect(await marches(noTyrant)).toEqual({
      id: 'paleMarches',
      unlocked: false,
      blockers: [{ kind: 'forgeTyrantDefeated' }],
    });
    const res = await farm(noTyrant);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: {
        code: 'area_locked',
        details: { areaId: 'paleMarches', blockers: [{ kind: 'forgeTyrantDefeated' }] },
      },
    });
    expect(await marchesOffers(noTyrant)).toEqual([]);

    const young = await hero(39, TYRANT_SLAYER);
    expect((await marches(young)).blockers).toEqual([{ kind: 'level', required: 40 }]);
    expect((await farm(young)).statusCode).toBe(409);
    expect(await marchesOffers(young)).toEqual([]);
  });

  it('opens at 40 for a Tyrant slayer: tier-5 drops at 41–47, existing materials, its merchant', async () => {
    const p = await hero(40, TYRANT_SLAYER);
    expect(await marches(p)).toEqual({ id: 'paleMarches', unlocked: true, blockers: [] });
    const res = await farm(p);
    expect(res.statusCode).toBe(201);
    expect(res.json<ActivityStateResponse>().activity!.areaId).toBe('paleMarches');
    nowMs += HOUR;
    const { summary } = (
      await call(p.who, 'POST', `/api/characters/${p.heroId}/activity/settle`)
    ).json<SettleResponse>();
    // Today's best gear farms it: hundreds of kills an hour, no deaths to speak of.
    expect(summary.kills).toBeGreaterThan(250);
    expect(summary.deaths).toBeLessThanOrEqual(2);
    expect(
      Object.keys(summary.materials ?? {}).every((id) => ['ironOre', 'soulShard'].includes(id)),
    ).toBe(true);
    const table = getLootTable(getArea('paleMarches').lootTableId);
    expect(summary.items.length).toBeGreaterThan(0);
    for (const item of summary.items) {
      expect(item.itemLevel).toBeGreaterThanOrEqual(table.itemLevel!.min);
      expect(item.itemLevel).toBeLessThanOrEqual(table.itemLevel!.max);
    }
    const stored = await db()
      .select({ baseId: itemInstances.baseId, setId: itemInstances.setId })
      .from(itemInstances)
      .where(and(eq(itemInstances.characterId, p.heroId), eq(itemInstances.source, 'farming')));
    // Regular drops are tier 5 (set pieces and Mythics keep their own bases).
    const regular = stored.filter((r) => r.setId === null && !getItemBase(r.baseId).unique);
    expect(regular.length).toBeGreaterThan(0);
    for (const r of regular) expect(getItemBase(r.baseId).tier, r.baseId).toBe(5);
  });

  it('stocks the Marches in full for every hero, every day, at item levels with a base (F.7)', async () => {
    // Level 40 rolls item level 40 for an offer about one time in seven, where the Marches have no
    // base (tier 5 starts at 41): F.7's floor stocks it at 41. Every hero, every day, in every
    // outcome: both offers, tier 5, between 41 and the area's top.
    const heroes = await Promise.all([40, 40, 40, 43, 46].map((level) => hero(level, TYRANT_SLAYER)));
    for (let day = 0; day < 4; day++) {
      for (const p of heroes) {
        const offers = await marchesOffers(p);
        expect(offers).toHaveLength(DEFAULT_ECONOMY_CONFIG.merchant.offersPerArea);
        for (const o of offers) {
          expect(getItemBase(o.item.baseId).tier, o.offerId).toBe(5);
          expect(o.item.itemLevel, o.offerId).toBeGreaterThanOrEqual(41);
          expect(o.item.itemLevel, o.offerId).toBeLessThanOrEqual(46);
        }
      }
      nowMs += 24 * HOUR;
    }
  });

  it('every world flag leaves it as it is (live content, no community gate)', async () => {
    const open = await hero(40, TYRANT_SLAYER);
    const closed = await hero(40, WARDEN_SLAYER);
    const before = [await marches(open), await marches(closed)];
    await db()
      .insert(worldFlags)
      .values(WORLD_FLAG_IDS.map((flagId) => ({ flagId, setAt: new Date(nowMs) })))
      .onConflictDoNothing();
    app.worldState.invalidate();
    expect([await marches(open), await marches(closed)]).toEqual(before);
  });
});
