import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import type { MaterialId } from '@worldforge/game-core';
import { buildApp } from '../app.js';
import {
  accounts,
  auditLog,
  characterMaterials,
  cosmeticUnlocks,
  itemInstances,
  telemetryDaily,
  telemetryDailyTest,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
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
import { insertCharacter, insertItem } from '../test/heroes.js';
import { reconcileWithAudit } from '../telemetry/report.js';
import type { ExchangeBuyResponse, ExchangeResponse } from '../cosmetics/exchange.js';
import type { ForgeActionResponse, ForgeItemResponse } from './work.js';

/**
 * Ticket 6.11: the Seal and Abbey silver sinks (docs/ECONOMY.md "Seal and silver sinks",
 * docs/COSMETICS.md "The exchange and engravings"): the exchange's prices and its exactly-once
 * grants, the engraver's prices and repeatability, the hold rule (value received in a trade isn't
 * spendable), invariance (no score moves) and reconciliation. Neither sink draws anything, so no
 * outcome depends on a seed; the clock is injected and derived from the wall clock (CLAUDE.md
 * "Dates").
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

function post(s: Trader, url: string, payload: object, key: string | null = randomUUID()) {
  return app.inject({
    method: 'POST',
    url,
    payload,
    headers: key ? { 'idempotency-key': key } : {},
    cookies: { wf_session: s.token },
  });
}
const get = (s: Trader, url: string) =>
  app.inject({ method: 'GET', url, cookies: { wf_session: s.token } });

const buy = (s: Trader, cosmeticId: string, key?: string | null, heroId = s.hero.id) =>
  post(s, `/api/characters/${heroId}/exchange`, { cosmeticId }, key);
const engrave = (
  s: Trader,
  itemId: string,
  finish: string,
  engravingId: string,
  key?: string | null,
) => post(s, `/api/characters/${s.hero.id}/forge/engrave`, { itemId, finish, engravingId }, key);

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
const audits = async (accountId: string, event: string) =>
  db()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.accountId, accountId), eq(auditLog.event, event)));
const unlocks = async (accountId: string) =>
  db().select().from(cosmeticUnlocks).where(eq(cosmeticUnlocks.accountId, accountId));
const itemRow = async (id: string) =>
  (await db().select().from(itemInstances).where(eq(itemInstances.id, id)))[0]!;

async function rich(seals = 20, silver = 200) {
  const s = await insertTrader(db(), clock);
  await giveMaterials(db(), s.hero.id, { gravewardenSeal: seals, abbeySilver: silver });
  return s;
}

describe('the exchange', () => {
  it('lists the offers with their prices, what the hero lacks and what the account owns', async () => {
    const s = await rich(3, 10);
    const r = await get(s, `/api/characters/${s.hero.id}/exchange`);
    expect(r.statusCode, r.body).toBe(200);
    const view = r.json<ExchangeResponse>();
    expect(view.offers.map((o) => [o.cosmeticId, o.price])).toEqual([
      ['title-colour.seal-wax', [{ materialId: 'gravewardenSeal', quantity: 3 }]],
      ['title-colour.abbey-silver', [{ materialId: 'abbeySilver', quantity: 25 }]],
      [
        'banner.silvered-seal',
        [
          { materialId: 'abbeySilver', quantity: 20 },
          { materialId: 'gravewardenSeal', quantity: 2 },
        ],
      ],
      ['crest.abbey-silver', [{ materialId: 'abbeySilver', quantity: 30 }]],
      ['crest.seal-wax', [{ materialId: 'gravewardenSeal', quantity: 4 }]],
    ]);
    expect(view.offers.every((o) => !o.owned)).toBe(true);
    expect(view.offers[0]!.blockers).toEqual([]);
    expect(view.offers[1]!.blockers).toEqual([
      { kind: 'material', materialId: 'abbeySilver', required: 25, held: 10 },
    ]);
  });

  it('pays exactly once and grants exactly once; a replay and a second key change nothing', async () => {
    const s = await rich();
    const key = randomUUID();
    const first = await buy(s, 'banner.silvered-seal', key);
    expect(first.statusCode, first.body).toBe(200);
    const body = first.json<ExchangeBuyResponse>();
    expect(body.bought).toBe('banner.silvered-seal');
    expect(body.paid).toEqual([
      { materialId: 'abbeySilver', quantity: 20 },
      { materialId: 'gravewardenSeal', quantity: 2 },
    ]);
    expect(body.offers.find((o) => o.cosmeticId === 'banner.silvered-seal')!.owned).toBe(true);
    expect(await stock(s.hero.id, 'gravewardenSeal')).toBe(18);
    expect(await stock(s.hero.id, 'abbeySilver')).toBe(180);

    const replay = await buy(s, 'banner.silvered-seal', key);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers[IDEMPOTENCY_REPLAYED_HEADER]).toBe('true');
    const again = await buy(s, 'banner.silvered-seal');
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('already_owned');
    // A second hero of the same account is refused too, before paying.
    const second = await insertCharacter(db(), s.id, { level: 20 });
    await giveMaterials(db(), second.id, { gravewardenSeal: 5, abbeySilver: 50 });
    const other = await buy(s, 'banner.silvered-seal', undefined, second.id);
    expect(other.statusCode).toBe(409);
    expect(await stock(second.id, 'gravewardenSeal')).toBe(5);
    expect(await stock(s.hero.id, 'gravewardenSeal')).toBe(18);

    const u = await unlocks(s.id);
    expect(u.map((r) => [r.cosmeticId, r.source])).toEqual([
      ['banner.silvered-seal', `exchange:${s.hero.id}`],
    ]);
    expect(await audits(s.id, 'cosmetic.grant')).toHaveLength(1);
    const ex = await audits(s.id, 'cosmetic.exchange');
    expect(ex).toHaveLength(1);
    expect(ex[0]!.data).toMatchObject({
      cosmeticId: 'banner.silvered-seal',
      kind: 'banner',
      gold: 0,
      materials: { gravewardenSeal: 2, abbeySilver: 20 },
    });
    // It is an ordinary collection-book entry: owned, and it can be worn.
    const worn = await post(s, '/api/account/cosmetics/equip', { banner: 'banner.silvered-seal' });
    expect(worn.statusCode, worn.body).toBe(200);
  });

  it('two heroes of one account racing for the same offer: one pays, one row', async () => {
    const s = await rich();
    const second = await insertCharacter(db(), s.id, { level: 20 });
    await giveMaterials(db(), second.id, { gravewardenSeal: 20 });
    const results = await Promise.all([
      buy(s, 'crest.seal-wax'),
      buy(s, 'crest.seal-wax', undefined, second.id),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const paid =
      40 -
      (await stock(s.hero.id, 'gravewardenSeal')) -
      (await stock(second.id, 'gravewardenSeal'));
    expect(paid).toBe(4);
    expect(await unlocks(s.id)).toHaveLength(1);
    expect(await audits(s.id, 'cosmetic.exchange')).toHaveLength(1);
  });

  it('refuses unknown offers, catalogue entries earned elsewhere, short holdings, no key, another hero', async () => {
    const s = await rich(1, 5);
    const stranger = await rich();
    for (const id of [
      'banner.crypt-seal',
      'appearance.ember',
      'title.reaper-of-the-harvest',
      'x',
    ]) {
      const r = await buy(s, id);
      expect(r.statusCode, id).toBe(422);
      expect(r.json().error.code).toBe('unknown_offer');
    }
    const short = await buy(s, 'crest.seal-wax');
    expect(short.statusCode).toBe(422);
    expect(short.json().error.code).toBe('insufficient_materials');
    expect(short.json().error.details.blockers).toEqual([
      { kind: 'material', materialId: 'gravewardenSeal', required: 4, held: 1 },
    ]);
    expect((await buy(s, 'crest.seal-wax', null)).statusCode).toBe(400);
    expect((await buy(stranger, 'crest.seal-wax', undefined, s.hero.id)).statusCode).toBe(404);
    expect(await stock(s.hero.id, 'gravewardenSeal')).toBe(1);
    expect(await unlocks(s.id)).toEqual([]);
  });

  it('can’t spend Abbey silver on hold after a trade', async () => {
    await setTradingSettings(app, db(), ALL_TRADING_ON);
    const giver = await insertTrader(db(), clock);
    const s = await insertTrader(db(), clock);
    await befriendSince(db(), giver, s, clock);
    // The week's silver cap for trades is 10: the hero holds 5 of its own and receives 10.
    await giveMaterials(db(), s.hero.id, { abbeySilver: 5 });
    await giveMaterials(db(), giver.hero.id, { abbeySilver: 10 });
    const sent = await t.send(giver, s, { give: { materials: { abbeySilver: 10 } } });
    expect(sent.statusCode, sent.body).toBe(201);
    const accepted = await t.act(s, sent.json().id as string, 'accept', { characterId: s.hero.id });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(await stock(s.hero.id, 'abbeySilver')).toBe(15);
    // The engraver: 15 silver held, 5 spendable.
    const ring = await insertItem(db(), s.hero.id, { rarityId: 'rare' });
    const e = await engrave(s, ring.id, 'silver', 'ashbound');
    expect(e.statusCode).toBe(422);
    expect(e.json().error.code).toBe('insufficient_materials');
    expect((await itemRow(ring.id)).engraving).toBeNull();
    // The exchange: 25 held, 15 spendable.
    await giveMaterials(db(), s.hero.id, { abbeySilver: 10 });
    const view = (await get(s, `/api/characters/${s.hero.id}/exchange`)).json<ExchangeResponse>();
    expect(view.offers.find((o) => o.cosmeticId === 'title-colour.abbey-silver')!.blockers).toEqual(
      [{ kind: 'material', materialId: 'abbeySilver', required: 25, held: 15 }],
    );
    const r = await buy(s, 'title-colour.abbey-silver');
    expect(r.statusCode).toBe(422);
    expect(await stock(s.hero.id, 'abbeySilver')).toBe(25);
    expect(await unlocks(s.id)).toEqual([]);
    // Once the hold is over the silver is the hero's own.
    clock = new Date(START.getTime() + 73 * HOUR);
    expect((await buy(s, 'title-colour.abbey-silver')).statusCode).toBe(200);
    expect(await stock(s.hero.id, 'abbeySilver')).toBe(0);
  });

  it('a test account may buy; its telemetry goes to the test rollups (D.4)', async () => {
    const s = await rich();
    await db().update(accounts).set({ isTest: true }).where(eq(accounts.id, s.id));
    const before = await db()
      .select()
      .from(telemetryDaily)
      .where(eq(telemetryDaily.metric, 'cosmetic.exchange'));
    expect((await buy(s, 'title-colour.abbey-silver')).statusCode).toBe(200);
    const after = await db()
      .select()
      .from(telemetryDaily)
      .where(eq(telemetryDaily.metric, 'cosmetic.exchange'));
    expect(after).toEqual(before);
    const test = await db()
      .select()
      .from(telemetryDailyTest)
      .where(eq(telemetryDailyTest.metric, 'cosmetic.exchange'));
    expect(test.length).toBeGreaterThan(0);
  });
});

describe('the engraver', () => {
  it('quotes both finishes with what is missing (held value excluded)', async () => {
    const s = await rich(1, 100);
    const ring = await insertItem(db(), s.hero.id, { rarityId: 'rare' });
    const q = (
      await get(s, `/api/characters/${s.hero.id}/forge/items/${ring.id}`)
    ).json<ForgeItemResponse>();
    expect(q.forge.engrave).toEqual({
      current: null,
      finishes: [
        {
          finish: 'seal',
          cost: { gold: 0, materials: [{ materialId: 'gravewardenSeal', quantity: 2 }] },
          blockers: [{ kind: 'material', materialId: 'gravewardenSeal', required: 2, held: 1 }],
        },
        {
          finish: 'silver',
          cost: { gold: 0, materials: [{ materialId: 'abbeySilver', quantity: 15 }] },
          blockers: [],
        },
      ],
    });
  });

  it('engraves for its price, again and again (each pays); a replay and the same engraving pay nothing', async () => {
    const s = await rich(10, 100);
    const sword = await insertItem(db(), s.hero.id, { rarityId: 'epic' });
    const before = await itemRow(sword.id);
    const key = randomUUID();
    const first = await engrave(s, sword.id, 'seal', 'grave-kept', key);
    expect(first.statusCode, first.body).toBe(200);
    const res = first.json<ForgeActionResponse>();
    expect(res.outcome).toEqual({
      action: 'engrave',
      engraving: 'seal:grave-kept',
      previous: null,
    });
    expect(res.item.engraving).toBe('seal:grave-kept');
    expect(res.forge.engrave.current).toBe('seal:grave-kept');
    expect(res.paid).toEqual({
      gold: 0,
      materials: [{ materialId: 'gravewardenSeal', quantity: 2 }],
    });
    expect(await stock(s.hero.id, 'gravewardenSeal')).toBe(8);
    const replay = await engrave(s, sword.id, 'seal', 'grave-kept', key);
    expect(replay.headers[IDEMPOTENCY_REPLAYED_HEADER]).toBe('true');
    const same = await engrave(s, sword.id, 'seal', 'grave-kept');
    expect(same.statusCode).toBe(409);
    expect(same.json().error.code).toBe('same_engraving');
    expect(await stock(s.hero.id, 'gravewardenSeal')).toBe(8);
    // Repeatable: the same words in silver, then other words, each pay again.
    expect((await engrave(s, sword.id, 'silver', 'grave-kept')).statusCode).toBe(200);
    const third = await engrave(s, sword.id, 'seal', 'unbowed');
    expect(third.json<ForgeActionResponse>().outcome).toEqual({
      action: 'engrave',
      engraving: 'seal:unbowed',
      previous: 'silver:grave-kept',
    });
    expect(await stock(s.hero.id, 'gravewardenSeal')).toBe(6);
    expect(await stock(s.hero.id, 'abbeySilver')).toBe(85);
    const after = await itemRow(sword.id);
    // Cosmetic only: no gold, the binding and every rule column as they were.
    expect(res.character.gold).toBe(10_000);
    const rules = (r: typeof before) => ({
      baseId: r.baseId,
      rarityId: r.rarityId,
      itemLevel: r.itemLevel,
      affixes: r.affixes,
      upgradeLevel: r.upgradeLevel,
      upgradePity: r.upgradePity,
      rerollCount: r.rerollCount,
      effectId: r.effectId,
      effectRoll: r.effectRoll,
      setId: r.setId,
      mythicId: r.mythicId,
      variant: r.variant,
      awakening: r.awakening,
      binding: r.binding,
      boundAccountId: r.boundAccountId,
      locked: r.locked,
    });
    expect(rules(after)).toEqual(rules(before));
    const rows = await audits(s.id, 'forge.engrave');
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.data.materials)).toEqual([
      { gravewardenSeal: 2 },
      { abbeySilver: 15 },
      { gravewardenSeal: 2 },
    ]);
  });

  it('refuses words off the list, free text, unknown finishes, held and stored items, before paying', async () => {
    const s = await rich(10, 100);
    const sword = await insertItem(db(), s.hero.id, { rarityId: 'epic' });
    const off = await engrave(s, sword.id, 'seal', 'kingslayer');
    expect(off.statusCode).toBe(422);
    expect(off.json().error.code).toBe('unknown_engraving');
    expect((await engrave(s, sword.id, 'seal', 'Free text of any kind')).statusCode).toBe(422);
    expect((await engrave(s, sword.id, 'gold', 'ashbound')).statusCode).toBe(400);
    expect((await engrave(s, sword.id, 'seal', 'ashbound', null)).statusCode).toBe(400);
    const stored = await insertItem(db(), s.hero.id, { inWarehouse: true });
    expect((await engrave(s, stored.id, 'seal', 'ashbound')).statusCode).toBeGreaterThanOrEqual(
      400,
    );
    await db()
      .update(itemInstances)
      .set({ holdUntil: new Date(clock.getTime() + 10 * HOUR) })
      .where(eq(itemInstances.id, sword.id));
    expect((await engrave(s, sword.id, 'seal', 'ashbound')).statusCode).toBeGreaterThanOrEqual(400);
    const stranger = await rich();
    const r = await post(stranger, `/api/characters/${s.hero.id}/forge/engrave`, {
      itemId: sword.id,
      finish: 'seal',
      engravingId: 'ashbound',
    });
    expect(r.statusCode).toBe(404);
    expect(await stock(s.hero.id, 'gravewardenSeal')).toBe(10);
    expect((await itemRow(sword.id)).engraving).toBeNull();
  });

  it('invariance: engraving every worn item and buying every offer moves no score', async () => {
    const s = await rich(40, 400);
    const sword = await insertItem(db(), s.hero.id, { rarityId: 'epic', equippedSlot: 'weapon' });
    const scores = async () => {
      const r = await get(s, `/api/characters/${s.hero.id}/scores`);
      expect(r.statusCode, r.body).toBe(200);
      return r.json();
    };
    const before = await scores();
    expect((await engrave(s, sword.id, 'seal', 'last-light')).statusCode).toBe(200);
    for (const id of [
      'title-colour.seal-wax',
      'title-colour.abbey-silver',
      'banner.silvered-seal',
      'crest.abbey-silver',
      'crest.seal-wax',
    ]) {
      expect((await buy(s, id)).statusCode, id).toBe(200);
    }
    await post(s, '/api/account/cosmetics/equip', {
      banner: 'banner.silvered-seal',
      crest: 'crest.seal-wax',
      titleColour: 'title-colour.abbey-silver',
    });
    expect(await scores()).toEqual(before);
    // Exchange and engraving totals: 9 + 2 Seals, 75 silver.
    expect(await stock(s.hero.id, 'gravewardenSeal')).toBe(40 - 11);
    expect(await stock(s.hero.id, 'abbeySilver')).toBe(400 - 75);
  });
});

describe('reconciliation', () => {
  it('every exchange and engraving matches the telemetry', async () => {
    const checks = await reconcileWithAudit(db());
    const mine = checks.filter(
      (c) => c.check.startsWith('forge: engrave') || c.check.startsWith('cosmetics: exchange'),
    );
    expect(mine.map((c) => c.check)).toEqual([
      'forge: engraves',
      'forge: engrave gold',
      'forge: engrave materials',
      'cosmetics: exchanged',
      'cosmetics: exchange materials',
    ]);
    expect(mine.filter((c) => c.check !== 'forge: engrave gold').every((c) => c.audit > 0)).toBe(
      true,
    );
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  });
});
