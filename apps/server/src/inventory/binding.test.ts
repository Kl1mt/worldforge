import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import {
  RARITY_IDS,
  computeScores,
  generateItem,
  itemBinding,
  type RarityId,
} from '@worldforge/game-core';
import { heroDuelSnapshot } from '../arena/model.js';
import { scoringInput } from '../scores/routes.js';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import {
  accounts,
  activities,
  auditLog,
  characterMaterials,
  characters,
  dungeonRuns,
  itemInstances,
  type ItemInstance,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { createTestDatabase } from '../test/db.js';
import { insertCharacter } from '../test/heroes.js';
import { insertAccount, type TestAccount } from '../test/social.js';
import { makeCryptReady } from '../test/dungeon.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { itemBindingColumns } from './columns.js';
import type { InventoryView, ItemView } from './routes.js';

/** Ticket T.1: binding written by every source, equip and Forge work bind, provenance by id. */

const HOUR = 3_600_000;
const EPIC = RARITY_IDS.indexOf('epic');
let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.parse('2031-06-01T12:00:00Z');

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({
    database,
    auth: { accountRateLimit: { requests: 100_000, actions: 100_000, windowMs: 60_000 } },
    activity: { ...DEFAULT_ACTIVITY_OPTIONS, now: () => new Date(nowMs) },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.close();
});

const db = () => database.db;
const call = (
  who: TestAccount,
  method: 'GET' | 'POST',
  url: string,
  payload?: object,
  key?: string,
) =>
  app.inject({
    method,
    url: `/api${url}`,
    ...(payload ? { payload } : {}),
    headers: key ? { 'idempotency-key': key } : {},
    cookies: { [SESSION_COOKIE]: who.token },
  });

async function hero(level = 10, gold = 0) {
  const who = await insertAccount(db());
  const c = await insertCharacter(db(), who.id, { level });
  await db().update(accounts).set({ activeCharacterId: c.id }).where(eq(accounts.id, who.id));
  if (gold) await db().update(characters).set({ gold }).where(eq(characters.id, c.id));
  return { who, id: c.id };
}
const itemRows = (characterId: string) =>
  db().select().from(itemInstances).where(eq(itemInstances.characterId, characterId));
const row = async (id: string) =>
  (await db().select().from(itemInstances).where(eq(itemInstances.id, id)))[0]!;
const audits = (characterId: string, event: string) =>
  db()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.characterId, characterId), eq(auditLog.event, event)));
const notable = (r: ItemInstance) => RARITY_IDS.indexOf(r.rarityId) >= EPIC;

/** A generated item inserted as if it had dropped from `source` (fresh, written by T.1 code). */
async function grant(
  h: { who: TestAccount; id: string },
  { rarityId = 'epic' as RarityId, source = 'farming', baseId = 'barbute' } = {},
): Promise<string> {
  const item = generateItem({ seed: 7, itemLevel: 14, baseId, rarityId, classId: 'warrior' })!;
  const id = uuidv7();
  await db()
    .insert(itemInstances)
    .values({
      id,
      characterId: h.id,
      ...item,
      ...itemBindingColumns(item, source, h.who.id),
      source,
    });
  return id;
}

/** The binding every row must carry: game-core's answer, bound to the owner when bound. */
function expectConsistent(r: ItemInstance, accountId: string) {
  const b = itemBinding(r);
  expect(r.binding, r.id).toBe(b.binding);
  expect(r.boundAccountId, r.id).toBe(b.binding === 'account' ? accountId : null);
  expect(r.unprovenanced).toBe(false);
  expect(r.tradedCount).toBe(0);
  expect(r.holdUntil).toBeNull();
}

describe('binding at creation, provenance by id', () => {
  it('farming: every drop carries its binding, every Epic and better is listed by id', async () => {
    // Pinned seeds, searched in order: the first that drops an Epic or better within a day.
    let found = false;
    for (let attempt = 0; attempt < 12 && !found; attempt++) {
      const h = await hero(12);
      const start = await call(h.who, 'POST', `/characters/${h.id}/activity`, {
        areaId: 'abandonedFields',
      });
      expect(start.statusCode, start.body).toBe(201);
      await db()
        .update(activities)
        .set({ seedSecret: `t1-farm-${attempt}` })
        .where(eq(activities.characterId, h.id));
      for (let w = 0; w < 8; w++) {
        nowMs += 3 * HOUR;
        const s = await call(h.who, 'POST', `/characters/${h.id}/activity/settle`);
        expect(s.statusCode, s.body).toBe(200);
      }
      const rows = await itemRows(h.id);
      const listed = new Set(
        (await audits(h.id, 'activity.reward')).flatMap((a) =>
          ((a.data as { notableItems?: { id: string }[] }).notableItems ?? []).map((n) => n.id),
        ),
      );
      for (const r of rows) {
        expect(r.source).toBe('farming');
        expectConsistent(r, h.who.id);
        expect(r.binding).toBe(notable(r) ? 'equip' : 'account');
        expect(listed.has(r.id), r.id).toBe(notable(r));
      }
      found = rows.some(notable);
    }
    expect(found).toBe(true);
  });

  it('crypt: chamber drops follow the table, hoard drops are account-bound, all listed', async () => {
    let chamberEpic = false;
    for (let attempt = 0; attempt < 60 && !chamberEpic; attempt++) {
      const h = await hero();
      await makeCryptReady(db(), h.id, 'warrior', 16);
      const enter = await call(h.who, 'POST', `/characters/${h.id}/dungeon`, {
        dungeonId: 'namelessCrypt',
      });
      expect(enter.statusCode, enter.body).toBe(201);
      await db()
        .update(dungeonRuns)
        .set({ seedSecret: `t1-crypt-${attempt}` })
        .where(eq(dungeonRuns.characterId, h.id));
      nowMs += 2 * HOUR;
      const claim = await call(
        h.who,
        'POST',
        `/characters/${h.id}/dungeon/claim`,
        undefined,
        randomUUID(),
      );
      expect(claim.statusCode, claim.body).toBe(200);
      const rows = (await itemRows(h.id)).filter((r) => r.source !== 'test');
      const [audit] = await audits(h.id, 'dungeon.claim');
      const listed = (audit!.data as { notableItems: { id: string; hoard?: boolean }[] })
        .notableItems;
      for (const r of rows) {
        expect(['dungeon:namelessCrypt', 'hoard:namelessCrypt']).toContain(r.source);
        expectConsistent(r, h.who.id);
        const hoard = r.source.startsWith('hoard:');
        expect(r.binding).toBe(!hoard && notable(r) ? 'equip' : 'account');
        const entry = listed.find((n) => n.id === r.id);
        expect(entry !== undefined, r.id).toBe(notable(r));
        if (entry) expect(entry.hoard === true).toBe(hoard);
      }
      chamberEpic = rows.some((r) => notable(r) && r.source.startsWith('dungeon:'));
    }
    expect(chamberEpic).toBe(true);
  });

  it('crafting: every craft is listed by id and binds by its rarity', async () => {
    const h = await hero(10, 100_000);
    await db()
      .insert(characterMaterials)
      .values(
        (['timber', 'ashwort'] as const).map((materialId) => ({
          characterId: h.id,
          materialId,
          quantity: 10_000,
        })),
      );
    // The rarity is server-random; what holds for every outcome is checked on each craft.
    for (let i = 0; i < 12; i++) {
      const r = await call(
        h.who,
        'POST',
        `/characters/${h.id}/forge/craft`,
        { recipeId: 'fieldsmithWork', slot: 'head' },
        randomUUID(),
      );
      expect(r.statusCode, r.body).toBe(200);
    }
    const crafted = new Set(
      (await audits(h.id, 'forge.craft')).map((a) => (a.data as { itemId: string }).itemId),
    );
    const rows = await itemRows(h.id);
    expect(rows).toHaveLength(12);
    for (const r of rows) {
      expect(r.source).toBe('forge');
      expectConsistent(r, h.who.id);
      expect(r.binding).toBe(notable(r) ? 'equip' : 'account');
      expect(crafted.has(r.id)).toBe(true);
    }
  });

  it('merchant goods are account-bound', async () => {
    const h = await hero(10, 1_000_000);
    const stock = await call(h.who, 'GET', `/characters/${h.id}/merchant`);
    const [offer] = stock.json<{ offers: { offerId: string }[] }>().offers;
    const r = await call(
      h.who,
      'POST',
      `/characters/${h.id}/merchant/buy`,
      { offerId: offer!.offerId },
      randomUUID(),
    );
    expect(r.statusCode, r.body).toBe(200);
    const [bought] = await itemRows(h.id);
    expect(bought!.source).toBe('merchant');
    expect(bought!.binding).toBe('account');
    expect(bought!.boundAccountId).toBe(h.who.id);
  });

  it('quest, contract, hoard and unknown sources bind every rarity', () => {
    for (const rarityId of RARITY_IDS) {
      const item = generateItem({ seed: 3, itemLevel: 20, baseId: 'barbute', rarityId })!;
      for (const source of ['quest', 'contract', 'hoard:namelessCrypt', 'merchant', 'test']) {
        expect(itemBindingColumns(item, source, 'acc')).toEqual({
          binding: 'account',
          boundAccountId: 'acc',
        });
      }
    }
  });
});

describe('equip and Forge work bind (inside their transactions)', () => {
  it('equipping binds once and remembers the first time', async () => {
    const h = await hero(14);
    const id = await grant(h);
    const fresh = await call(h.who, 'GET', `/characters/${h.id}/inventory`);
    const view = fresh.json<InventoryView>().inventory.find((i) => i.id === id)!;
    expect(view).toMatchObject({ binding: 'equip', bindingReason: 'fresh', tradeable: false });

    const first = nowMs;
    const eq1 = await call(h.who, 'POST', `/characters/${h.id}/items/${id}/equip`);
    expect(eq1.statusCode, eq1.body).toBe(200);
    expect(eq1.json<InventoryView>().equipped.find((i) => i.id === id)).toMatchObject({
      binding: 'account',
      bindingReason: 'worn',
    });
    let r = await row(id);
    expect(r).toMatchObject({ binding: 'account', boundAccountId: h.who.id });
    expect(r.firstEquippedAt?.getTime()).toBe(first);

    nowMs += HOUR;
    expect((await call(h.who, 'POST', `/characters/${h.id}/items/${id}/unequip`)).statusCode).toBe(
      200,
    );
    expect((await call(h.who, 'POST', `/characters/${h.id}/items/${id}/equip`)).statusCode).toBe(
      200,
    );
    await call(h.who, 'POST', `/characters/${h.id}/items/${id}/unequip`);
    r = await row(id);
    // Taking it off never unbinds; the first time stays.
    expect(r.binding).toBe('account');
    expect(r.firstEquippedAt?.getTime()).toBe(first);
    const inv = await call(h.who, 'GET', `/characters/${h.id}/inventory`);
    expect(inv.json<InventoryView>().inventory.find((i) => i.id === id)).toMatchObject({
      binding: 'account',
      bindingReason: 'worn',
    });
  });

  it('a refused equip binds nothing', async () => {
    const h = await hero(14);
    const id = await grant(h, { baseId: 'hunting-bow' });
    const r = await call(h.who, 'POST', `/characters/${h.id}/items/${id}/equip`);
    expect(r.statusCode).toBe(422);
    expect(await row(id)).toMatchObject({ binding: 'equip', firstEquippedAt: null });
  });

  it('every Forge action binds, whatever its outcome', async () => {
    const h = await hero(14, 1_000_000);
    await db()
      .insert(characterMaterials)
      .values(
        (['timber', 'rawHide', 'ironOre', 'soulShard', 'ashwort'] as const).map((materialId) => ({
          characterId: h.id,
          materialId,
          quantity: 10_000,
        })),
      );
    const actions: [string, (id: string, item: ItemInstance) => object][] = [
      ['upgrade', (itemId) => ({ itemId })],
      ['reroll', (itemId) => ({ itemId, affixIndex: 0 })],
      ['improve', (itemId) => ({ itemId, affixIndex: 0 })],
    ];
    for (const [path, body] of actions) {
      const id = await grant(h);
      const before = await row(id);
      // An affix already at its tier's top can't be improved: take the first one that can.
      let res = await call(
        h.who,
        'POST',
        `/characters/${h.id}/forge/${path}`,
        body(id, before),
        randomUUID(),
      );
      for (let i = 1; res.statusCode === 422 && i < before.affixes.length; i++) {
        res = await call(
          h.who,
          'POST',
          `/characters/${h.id}/forge/${path}`,
          { itemId: id, affixIndex: i },
          randomUUID(),
        );
      }
      expect(res.statusCode, `${path}: ${res.body}`).toBe(200);
      const item = res.json<{ item: ItemView }>().item;
      expect(item, path).toMatchObject({ binding: 'account', bindingReason: 'forged' });
      expect(await row(id), path).toMatchObject({
        binding: 'account',
        boundAccountId: h.who.id,
        firstEquippedAt: null,
      });
    }
  });

  it('a refused Forge action binds nothing', async () => {
    const h = await hero(14, 0);
    const id = await grant(h);
    const res = await call(
      h.who,
      'POST',
      `/characters/${h.id}/forge/upgrade`,
      { itemId: id },
      randomUUID(),
    );
    expect(res.statusCode).toBe(422);
    expect((await row(id)).binding).toBe('equip');
  });

  it('equip racing a Forge action on the same item: bound once, both effects as committed', async () => {
    const h = await hero(14, 1_000_000);
    await db()
      .insert(characterMaterials)
      .values(
        (['timber', 'rawHide', 'ironOre', 'soulShard'] as const).map((materialId) => ({
          characterId: h.id,
          materialId,
          quantity: 10_000,
        })),
      );
    for (let round = 0; round < 3; round++) {
      const id = await grant(h);
      const equip = () => call(h.who, 'POST', `/characters/${h.id}/items/${id}/equip`);
      const forge = () =>
        call(h.who, 'POST', `/characters/${h.id}/forge/upgrade`, { itemId: id }, randomUUID());
      const [a, b] = await Promise.all(round === 1 ? [forge(), equip()] : [equip(), forge()]);
      const [eqRes, fgRes] = round === 1 ? [b, a] : [a, b];
      expect(eqRes.statusCode, eqRes.body).toBe(200);
      expect(fgRes.statusCode, fgRes.body).toBe(200);
      const r = await row(id);
      expect(r).toMatchObject({ binding: 'account', boundAccountId: h.who.id, forgeCounter: 1 });
      expect(r.firstEquippedAt).not.toBeNull();
      expect(itemBinding(r).binding).toBe('account');
      expect(
        (await audits(h.id, 'forge.upgrade')).filter(
          (x) => (x.data as { itemId: string }).itemId === id,
        ),
      ).toHaveLength(1);
      // Unequip for the next round's slot.
      await call(h.who, 'POST', `/characters/${h.id}/items/${id}/unequip`);
    }
  });
});

describe('API view', () => {
  it('every listed item carries its binding, never tradeable while trading is off', async () => {
    const h = await hero(14);
    const ids = [
      await grant(h, { rarityId: 'common' }),
      await grant(h, { rarityId: 'legendary' }),
      await grant(h, { rarityId: 'epic', source: 'quest' }),
    ];
    const inv = (await call(h.who, 'GET', `/characters/${h.id}/inventory`)).json<InventoryView>();
    const views = inv.inventory.filter((i) => ids.includes(i.id));
    expect(views.map((v) => [v.binding, v.bindingReason, v.tradeable])).toEqual([
      ['account', 'rarity', false],
      ['equip', 'fresh', false],
      ['account', 'source', false],
    ]);
    // Server-only columns stay server-side.
    for (const v of views) {
      expect(v).not.toHaveProperty('boundAccountId');
      expect(v).not.toHaveProperty('unprovenanced');
    }
    const rows = await db().select().from(itemInstances).where(inArray(itemInstances.id, ids));
    expect(rows).toHaveLength(3);
  });
});

describe('invariance: binding changes no number', () => {
  it('scores and the duel snapshot read the same with any binding state', async () => {
    const h = await hero(16);
    await makeCryptReady(db(), h.id, 'warrior', 16, { rarityId: 'legendary' });
    const [c] = await db().select().from(characters).where(eq(characters.id, h.id));
    const measure = async () => ({
      scores: computeScores(await scoringInput(app, db(), c!)),
      snapshot: await heroDuelSnapshot(db(), c!),
    });
    const before = await measure();
    expect(before.snapshot.equipment.length).toBeGreaterThan(0);
    await db()
      .update(itemInstances)
      .set({
        binding: 'account',
        boundAccountId: h.who.id,
        tradedCount: 1,
        holdUntil: new Date(nowMs + HOUR),
        firstEquippedAt: new Date(nowMs),
        unprovenanced: true,
      })
      .where(eq(itemInstances.characterId, h.id));
    expect(await measure()).toEqual(before);
    await db()
      .update(itemInstances)
      .set({ binding: null, boundAccountId: null, tradedCount: 0, holdUntil: null })
      .where(eq(itemInstances.characterId, h.id));
    expect(await measure()).toEqual(before);
  });
});
