import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import {
  awakeningCost,
  generateItem,
  itemEffectInstances,
  type MaterialId,
  type RarityId,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { auditLog, characterMaterials, characters, itemInstances } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { IDEMPOTENCY_REPLAYED_HEADER } from '../idempotency/index.js';
import { createTestDatabase } from '../test/db.js';
import {
  ALL_TRADING_ON,
  befriendSince,
  giveMaterials,
  insertTrader,
  setTradingSettings,
  tradeCalls,
  type Trader,
} from '../test/trading.js';
import { ALL_SHELF_ON, setShelfSwitches, shelfCalls } from '../test/shelf.js';
import { insertCharacter } from '../test/heroes.js';
import { openWarehouse } from '../test/warehouse.js';
import { reconcileWithAudit } from '../telemetry/report.js';
import type { ForgeActionResponse, ForgeItemResponse } from './work.js';

/**
 * Ticket 6.5b: the Forge's awaken action (docs/AWAKENING.md "As built"). The clock is injected
 * and derived from the wall clock (CLAUDE.md "Dates"); awakening has no random draw, so nothing
 * here depends on a seed.
 */

const HOUR = 3_600_000;
const START = new Date(Math.floor(Date.now() / HOUR) * HOUR);
let clock = START;
const now = () => clock;

let database: DatabaseHandle;
let app: FastifyInstance;
let t: ReturnType<typeof tradeCalls>;

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
});

afterAll(async () => {
  await app?.close();
  await database?.close();
});

beforeEach(() => {
  clock = START;
});

const db = () => database.db;
const PRICE = { tyrantsEmber: 3, gravewardenSeal: 2, soulShard: 30 } as const;

/** A smith with enough of everything for `n` awakenings. */
async function smith(n = 1, gold = 100_000): Promise<Trader> {
  const s = await insertTrader(db(), clock, { gold });
  await giveMaterials(db(), s.hero.id, {
    tyrantsEmber: PRICE.tyrantsEmber * n,
    gravewardenSeal: PRICE.gravewardenSeal * n,
    soulShard: PRICE.soulShard * n,
  });
  return s;
}

/** An item row: by default a +10 Legendary longsword at item level 37 with its rolled effect. */
async function item(
  characterId: string,
  {
    baseId = 'longsword',
    rarityId = 'legendary' as RarityId,
    itemLevel = 37,
    seed = 9,
  }: { baseId?: string; rarityId?: RarityId; itemLevel?: number; seed?: number } = {},
  extra: Partial<typeof itemInstances.$inferInsert> = {},
) {
  const generated = generateItem({ seed, itemLevel, baseId, rarityId, classId: 'warrior' })!;
  const [row] = await db()
    .insert(itemInstances)
    .values({
      id: uuidv7(),
      characterId,
      ...generated,
      source: 'farming',
      binding: 'account',
      upgradeLevel: 10,
      ...extra,
    })
    .returning();
  return row!;
}

function forge(s: Trader, path: string, payload: object, key: string | null = randomUUID()) {
  return app.inject({
    method: 'POST',
    url: `/api/characters/${s.hero.id}/forge/${path}`,
    payload,
    headers: key ? { 'idempotency-key': key } : {},
    cookies: { wf_session: s.token },
  });
}
const awaken = (s: Trader, itemId: string, key?: string) => forge(s, 'awaken', { itemId }, key);
const quote = async (s: Trader, itemId: string) =>
  (
    await app.inject({
      method: 'GET',
      url: `/api/characters/${s.hero.id}/forge/items/${itemId}`,
      cookies: { wf_session: s.token },
    })
  ).json<ForgeItemResponse>();

const row = async (id: string) =>
  (await db().select().from(itemInstances).where(eq(itemInstances.id, id)))[0]!;
const goldOf = async (id: string) =>
  (await db().select().from(characters).where(eq(characters.id, id)))[0]!.gold;
async function stock(characterId: string, materialId: MaterialId) {
  const [r] = await db()
    .select()
    .from(characterMaterials)
    .where(
      and(
        eq(characterMaterials.characterId, characterId),
        eq(characterMaterials.materialId, materialId),
      ),
    );
  return r?.quantity ?? 0;
}

describe('the quote', () => {
  it('shows the price at the item level, what is missing, and why an item can’t awaken', async () => {
    const s = await insertTrader(db(), clock);
    const sword = await item(s.hero.id);
    const q = await quote(s, sword.id);
    const gold = awakeningCost(sword).gold;
    expect(gold).toBe(25_200);
    expect(q.forge.awaken).toEqual({
      refusal: null,
      cost: {
        gold,
        materials: expect.arrayContaining([
          { materialId: 'gravewardenSeal', quantity: 2 },
          { materialId: 'soulShard', quantity: 30 },
          { materialId: 'tyrantsEmber', quantity: 3 },
        ]),
      },
      blockers: expect.arrayContaining([
        expect.objectContaining({ kind: 'gold', required: gold, held: 10_000 }),
        expect.objectContaining({ kind: 'material', materialId: 'tyrantsEmber', required: 3 }),
      ]),
      effectStrength: 1.1,
    });
    const at9 = await item(s.hero.id, {}, { upgradeLevel: 9 });
    expect((await quote(s, at9.id)).forge.awaken!.refusal).toBe('upgrade_level');
  });
});

describe('eligibility (refused before anything is paid)', () => {
  const cases: [string, Parameters<typeof item>[1], Parameters<typeof item>[2], string][] = [
    ['+9', {}, { upgradeLevel: 9 }, 'not_awakenable'],
    ['item level 22', { itemLevel: 22 }, {}, 'not_awakenable'],
    ['an Epic', { rarityId: 'epic' }, {}, 'not_awakenable'],
    ['a Legendary without an effect', {}, { effectId: null, effectRoll: null }, 'not_awakenable'],
  ];
  for (const [label, spec, extra, code] of cases) {
    it(`refuses ${label}`, async () => {
      const s = await smith();
      const it0 = await item(s.hero.id, spec, extra);
      const res = await awaken(s, it0.id);
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe(code);
      expect(res.json().error.message).toMatch(/awaken/i);
      expect(await goldOf(s.hero.id)).toBe(100_000);
      expect(await stock(s.hero.id, 'tyrantsEmber')).toBe(3);
      expect((await row(it0.id)).awakening).toBeNull();
    });
  }

  it('refuses an item in the Warehouse, on the shelf, held after a trade, or not the hero’s', async () => {
    const s = await smith();
    const stored = await item(s.hero.id, {}, { inWarehouse: true });
    expect((await awaken(s, stored.id)).json().error.code).toBe('item_in_warehouse');
    const shelved = await item(s.hero.id, {}, { onShelf: true, shelfAccountId: s.id });
    expect((await awaken(s, shelved.id)).json().error.code).toBe('item_on_shelf');
    // (Inserted on the shelf directly: take it off again so the shelf audit reconciles below.)
    await db()
      .update(itemInstances)
      .set({ onShelf: false, shelfAccountId: null })
      .where(eq(itemInstances.id, shelved.id));
    const held = await item(s.hero.id, {}, { holdUntil: new Date(clock.getTime() + 10 * HOUR) });
    const r = await awaken(s, held.id);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('item_held');
    const other = await smith();
    const theirs = await item(other.hero.id);
    expect((await awaken(s, theirs.id)).statusCode).toBe(404);
    expect(await goldOf(s.hero.id)).toBe(100_000);
  });

  it('refuses without the price, naming what is missing', async () => {
    const s = await insertTrader(db(), clock, { gold: 100_000 });
    await giveMaterials(db(), s.hero.id, { tyrantsEmber: 2, gravewardenSeal: 2, soulShard: 30 });
    const sword = await item(s.hero.id);
    const res = await awaken(s, sword.id);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('insufficient_materials');
    expect(res.json().error.details.blockers).toEqual([
      { kind: 'material', materialId: 'tyrantsEmber', required: 3, held: 2 },
    ]);
    expect(await goldOf(s.hero.id)).toBe(100_000);
  });
});

describe('awakening', () => {
  it('pays exactly once, marks and binds the item, audits it; a replay changes nothing', async () => {
    const s = await smith(2);
    const sword = await item(s.hero.id, {}, { binding: 'equip', forgeCounter: 0 });
    const key = randomUUID();
    const res = await awaken(s, sword.id, key);
    expect(res.statusCode).toBe(200);
    const body = res.json<ForgeActionResponse>();
    const gold = awakeningCost(sword).gold;
    expect(body.outcome).toEqual({ action: 'awaken', awakened: 'effect', effectStrength: 1.1 });
    expect(body.paid.gold).toBe(gold);
    expect(body.item.awakening).toEqual({ option: 'effect', effectStrength: 1.1 });
    expect(body.item.awakenedAt).toBe(clock.toISOString());
    expect(body.item).toMatchObject({ binding: 'account', bindingReason: 'awakened' });
    expect(body.forge.awaken).toBeNull();
    const after = await row(sword.id);
    expect(after.awakening).toEqual({ option: 'effect', effectStrength: 1.1 });
    expect(after.awakenedAt?.toISOString()).toBe(clock.toISOString());
    expect(after.forgeCounter).toBe(1);
    expect(after.affixes).toEqual(sword.affixes);
    expect(after.effectRoll).toBe(sword.effectRoll);
    expect(await goldOf(s.hero.id)).toBe(100_000 - gold);
    expect(await stock(s.hero.id, 'tyrantsEmber')).toBe(3);
    expect(await stock(s.hero.id, 'gravewardenSeal')).toBe(2);
    expect(await stock(s.hero.id, 'soulShard')).toBe(30);
    // The combat reader sees it.
    expect(itemEffectInstances(after)[0]!.strength).toBe(1.1);

    const replay = await awaken(s, sword.id, key);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers[IDEMPOTENCY_REPLAYED_HEADER]).toBeDefined();
    expect(await goldOf(s.hero.id)).toBe(100_000 - gold);
    const again = await awaken(s, sword.id);
    expect(again.statusCode).toBe(422);
    expect(again.json().error.code).toBe('already_awakened');
    expect(await stock(s.hero.id, 'tyrantsEmber')).toBe(3);

    const audits = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.event, 'forge.awaken'), eq(auditLog.characterId, s.hero.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.data).toMatchObject({
      itemId: sword.id,
      gold,
      materials: PRICE,
      awakening: { option: 'effect', effectStrength: 1.1 },
      awakened: 'effect',
      forgeCounter: 0,
    });
  });

  it('a set piece awakens toward its set; a Void item keeps its variant', async () => {
    const s = await smith(2);
    const helm = await item(s.hero.id, { baseId: 'vigil-helm' });
    expect(helm.setId).toBe('drowned-vigil');
    const r = await awaken(s, helm.id);
    expect(r.statusCode).toBe(200);
    expect(r.json<ForgeActionResponse>().outcome).toMatchObject({ awakened: 'set' });
    const voidSword = await item(s.hero.id, { seed: 31 }, { variant: 'void' });
    const v = await awaken(s, voidSword.id);
    expect(v.statusCode).toBe(200);
    expect((await row(voidSword.id)).variant).toBe('void');
    expect(itemEffectInstances(await row(voidSword.id))[0]!.strength).toBeCloseTo(1.21, 10);
  });

  it('can’t spend gold or materials on hold after a trade', async () => {
    await setTradingSettings(app, db(), ALL_TRADING_ON);
    const giver = await insertTrader(db(), clock);
    const s = await insertTrader(db(), clock, { gold: 100_000 });
    await befriendSince(db(), giver, s, clock);
    await giveMaterials(db(), s.hero.id, { tyrantsEmber: 3, gravewardenSeal: 2 });
    await giveMaterials(db(), giver.hero.id, { soulShard: 30 });
    const sent = await t.send(giver, s, { give: { materials: { soulShard: 30 } } });
    expect(sent.statusCode).toBe(201);
    const offerId = sent.json().id as string;
    expect((await t.act(s, offerId, 'accept', { characterId: s.hero.id })).statusCode).toBe(200);
    const sword = await item(s.hero.id);
    const q = await quote(s, sword.id);
    expect(q.forge.awaken!.blockers).toEqual([
      { kind: 'material', materialId: 'soulShard', required: 30, held: 0 },
    ]);
    const res = await awaken(s, sword.id);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('insufficient_materials');
    expect(await stock(s.hero.id, 'soulShard')).toBe(30);
    expect((await row(sword.id)).awakening).toBeNull();
    // Once the hold is over the shards are the hero's own.
    clock = new Date(START.getTime() + 73 * HOUR);
    expect((await awaken(s, sword.id)).statusCode).toBe(200);
  });
});

describe('the Forge afterwards (docs/AWAKENING.md: rerolls and improvements stay allowed)', () => {
  it('rerolls and improves an awakened item, which stays awakened; upgrades stop at +10', async () => {
    const s = await smith();
    await giveMaterials(db(), s.hero.id, {
      timber: 10_000,
      rawHide: 10_000,
      ironOre: 10_000,
      soulShard: 10_000,
      ashwort: 10_000,
      abbeySilver: 10_000,
    });
    await db().update(characters).set({ gold: 5_000_000 }).where(eq(characters.id, s.hero.id));
    const sword = await item(s.hero.id);
    expect((await awaken(s, sword.id)).statusCode).toBe(200);
    const reroll = await forge(s, 'reroll', { itemId: sword.id, affixIndex: 0 });
    expect(reroll.statusCode).toBe(200);
    expect(reroll.json<ForgeActionResponse>().item.awakening).toEqual({
      option: 'effect',
      effectStrength: 1.1,
    });
    const improve = await forge(s, 'improve', { itemId: sword.id, affixIndex: 1 });
    expect([200, 422]).toContain(improve.statusCode); // 422 only if the affix is at its maximum
    expect((await row(sword.id)).awakening).toEqual({ option: 'effect', effectStrength: 1.1 });
    const up = await forge(s, 'upgrade', { itemId: sword.id });
    expect(up.json().error.code).toBe('max_upgrade');
  });
});

describe('binding, trading and the shelf', () => {
  it('an awakened item is never offered in a trade, whatever the switches', async () => {
    await setTradingSettings(app, db(), ALL_TRADING_ON);
    const s = await smith();
    const friend = await insertTrader(db(), clock);
    await befriendSince(db(), s, friend, clock);
    const sword = await item(s.hero.id);
    expect((await awaken(s, sword.id)).statusCode).toBe(200);
    const res = await t.send(s, friend, { give: { itemIds: [sword.id] } });
    expect(res.statusCode).toBe(409);
    const checks = res.json().error.details.reasons.map((r: { check: string }) => r.check);
    expect(checks).toContain('item_awakened');
    expect((await row(sword.id)).escrowOfferId).toBeNull();
  });

  it('moves between the account’s own heroes via the shelf and stays awakened', async () => {
    await setShelfSwitches(app, db(), ALL_SHELF_ON);
    await openWarehouse(app, db(), clock);
    const s = await smith();
    const second = await insertCharacter(db(), s.id, { level: 20 });
    const sword = await item(s.hero.id);
    expect((await awaken(s, sword.id)).statusCode).toBe(200);
    const shelf = shelfCalls(app);
    const dep = await shelf.move(s.token, s.hero.id, 'deposit', { itemIds: [sword.id] });
    expect(dep.statusCode).toBe(200);
    const wd = await shelf.move(s.token, second.id, 'withdraw', { itemIds: [sword.id] });
    expect(wd.statusCode).toBe(200);
    const moved = await row(sword.id);
    expect(moved.characterId).toBe(second.id);
    expect(moved.awakening).toEqual({ option: 'effect', effectStrength: 1.1 });
  });
});

describe('reconciliation', () => {
  it('every awakening’s gold and materials match the telemetry', async () => {
    const checks = await reconcileWithAudit(db());
    const awaken = checks.filter((c) => c.check.startsWith('forge: awaken'));
    expect(awaken.map((c) => c.check)).toEqual([
      'forge: awakens',
      'forge: awaken gold',
      'forge: awaken materials',
    ]);
    expect(awaken.every((c) => c.ok)).toBe(true);
    expect(awaken[0]!.audit).toBeGreaterThan(0);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  });
});
