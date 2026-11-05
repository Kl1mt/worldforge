/**
 * Phase 2 exit criteria, end to end through the HTTP API with a simulated server clock (ticket 2.8,
 * GDD §15 Phase 2): players can progress through several connected areas, complete quests, gather
 * resources, and clear the first dungeon and its boss.
 *
 * One warrior plays the way a player would, with B.1's pacing and no shortcuts (no level or gear
 * set in the database): farm the Abandoned Fields → move to the highest open area as levels come,
 * equipping better drops along the way → gather materials and level a profession → story quests and
 * contracts at the Tavern → buy, sell, salvage and craft once → run the Nameless Crypt until the
 * Gravewarden falls → the Sunken Abbey opens and is farmed.
 *
 * "Valid" is checked against the server's own records: every gold piece, item and material the
 * character holds at the end is accounted for by exactly one audit entry, and replays of the
 * value endpoints grant nothing. The browser version of this flow is `tools/e2e/phase2-exit.mjs`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  MATERIAL_IDS,
  RARITY_IDS,
  STORY_QUEST_IDS,
  canClassUseItem,
  equipmentSlotsForKind,
  findItemBase,
  getArea,
  type AreaId,
  type ClassId,
  type MaterialId,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import type { SettleResponse } from '../activity/routes.js';
import type { InventoryView, ItemView } from '../inventory/routes.js';
import type { WorldStateResponse } from '../world/routes.js';
import type { QuestBoardResponse } from '../quests/store.js';
import type { MaterialsResponse } from '../materials/store.js';
import type { MerchantResponse } from '../merchant/routes.js';
import type { ForgeResponse } from '../forge/routes.js';
import type { DungeonClaimResponse, DungeonRunView } from '../dungeon/routes.js';
import { auditLog, characterMaterials, characters, itemInstances } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';

/** `E2E_CLASS=mage` etc. plays another class (all four pass; the default is the CI run). */
const CLASS_ID = (process.env.E2E_CLASS ?? 'warrior') as ClassId;
const MIN = 60_000;
const HOUR = 60 * MIN;
const CAP = 3 * HOUR;
/** Simulated time between two client visits (below the offline cap, so nothing is forfeited). */
const STEP = 2 * HOUR;
/** Safety net: B.1 puts level 17 at ~33–38 h of farming; the run must finish well within this. */
const MAX_HOURS = 90;
const AREA_ORDER: AreaId[] = [
  'abandonedFields',
  'crowwood',
  'oldBurialGrounds',
  'blackwater',
  'sunkenAbbey',
];

let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.parse('2026-11-02T08:00:00Z');

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({
    database,
    activity: { ...DEFAULT_ACTIVITY_OPTIONS, offlineCapMs: CAP, now: () => new Date(nowMs) },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.close();
});

const cookieOf = (res: LightMyRequestResponse) =>
  res.cookies.find((c) => c.name === SESSION_COOKIE)?.value;

/** Item strength for "is this a better drop?": rarity first, then item level. */
const score = (i: Pick<ItemView, 'rarityId' | 'itemLevel'>) =>
  RARITY_IDS.indexOf(i.rarityId) * 6 + i.itemLevel;

describe('Phase 2 exit criteria', () => {
  it('fields → several areas → professions → quests and a contract → economy → crypt and Gravewarden → Sunken Abbey', async () => {
    // 1. Register (real account, session cookie) and create a character.
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'pilgrim@graumark.test',
        password: 'ashes-and-iron-42',
        displayName: 'Pilgrim',
      },
    });
    expect(reg.statusCode).toBe(201);
    const token = cookieOf(reg)!;
    const api = (
      method: 'GET' | 'POST',
      url: string,
      payload?: object,
      headers: Record<string, string> = {},
    ) =>
      app.inject({
        method,
        url,
        headers,
        ...(payload ? { payload } : {}),
        cookies: { [SESSION_COOKIE]: token },
      });
    const keyed = (url: string, payload?: object, key = randomUUID()) =>
      api('POST', url, payload, { 'idempotency-key': key });

    const created = await api('POST', '/api/characters', {
      name: 'Hedda',
      classId: CLASS_ID,
      appearance: { banner: 'ash' },
    });
    expect(created.statusCode).toBe(201);
    const characterId = created.json<{ character: { id: string } }>().character.id;
    const base = `/api/characters/${characterId}`;

    // What the run saw, for the final assertions.
    const areasFarmed = new Set<AreaId>();
    const turnedIn: { kind: string; questId: string }[] = [];
    let level = 1;
    let farmedHours = 0;
    let deaths = 0;
    const economy = { bought: false, sold: false, salvaged: false, crafted: false };
    const crypt: { level: number; outcome: string; bossDefeated: boolean }[] = [];
    let abbeyLockedBeforeBoss = false;

    const world = async () => (await api('GET', `${base}/world`)).json<WorldStateResponse>();

    /**
     * Farms where an unfinished story kill objective's enemy lives, else the highest open area
     * (the client's choice; the server checks the unlock).
     */
    const farmBestArea = async () => {
      const w = await world();
      const open = AREA_ORDER.filter((id) => w.areas.find((a) => a.id === id)?.unlocked);
      const board = (await api('GET', `${base}/quests`)).json<QuestBoardResponse>();
      const storyArea = board.quests
        .filter((q) => q.kind === 'story')
        .flatMap((q) =>
          q.objectives.filter((o, n) => o.kind === 'kill' && q.progress[n]! < o.count),
        )
        .map((o) =>
          open.find((id) =>
            getArea(id).enemies.some((e) => e.enemyId === (o as { enemyId: string }).enemyId),
          ),
        )
        .find((id) => id !== undefined);
      const target = storyArea ?? open[open.length - 1]!;
      const current = w.current?.pendingAreaId ?? w.current?.areaId;
      if (current === target) return;
      const res = await api('POST', `${base}/activity`, { areaId: target });
      expect([200, 201]).toContain(res.statusCode);
    };

    /** Equips every drop that beats what is worn (the player's "equip drops along the way"). */
    const equipBetterDrops = async () => {
      let inv = (await api('GET', `${base}/inventory`)).json<InventoryView>();
      const candidates = [...inv.inventory].sort((a, b) => score(b) - score(a));
      for (const item of candidates) {
        const def = findItemBase(item.baseId);
        if (!def || !canClassUseItem(def, CLASS_ID) || def.minItemLevel > level) continue;
        const slots = equipmentSlotsForKind(def.slot);
        const worn = slots.map((s) => inv.equipped.find((e) => e.equippedSlot === s));
        const free = slots.find((_, n) => !worn[n]);
        const weakest = worn
          .filter((w): w is ItemView => !!w)
          .sort((a, b) => score(a) - score(b))[0];
        const slot =
          free ?? (weakest && score(item) > score(weakest) ? weakest.equippedSlot : null);
        if (!slot) continue;
        const res = await api('POST', `${base}/items/${item.id}/equip`, { slot });
        if (res.statusCode === 200) inv = res.json<InventoryView>();
        else expect(res.statusCode).toBe(422);
      }
      return inv;
    };

    /** The Tavern: turn in what is ready, take the next story quest and today's contracts. */
    const visitTavern = async () => {
      let board = (await api('GET', `${base}/quests`)).json<QuestBoardResponse>();
      for (const q of board.quests.filter((x) => x.status === 'ready')) {
        const key = randomUUID();
        const res = await keyed(`${base}/quests/${q.id}/turn-in`, undefined, key);
        if (
          res.statusCode === 422 &&
          res.json<{ error: { code: string } }>().error.code === 'inventory_full'
        ) {
          continue; // the reward item needs room; the next visit sells first
        }
        expect(res.statusCode, res.body).toBe(200);
        turnedIn.push({ kind: q.kind, questId: q.questId });
        // A retried turn-in replays the stored reward; a new key is refused by state.
        const replay = await keyed(`${base}/quests/${q.id}/turn-in`, undefined, key);
        expect(replay.headers['idempotency-replayed']).toBe('true');
        expect(replay.json()).toEqual(res.json());
        const again = await keyed(`${base}/quests/${q.id}/turn-in`);
        expect(again.statusCode).toBe(409);
      }
      board = (await api('GET', `${base}/quests`)).json<QuestBoardResponse>();
      if (board.story.next && board.story.next.blockers.length === 0) {
        const res = await api('POST', `${base}/quests`, {
          kind: 'story',
          questId: board.story.next.questId,
        });
        expect(res.statusCode).toBe(201);
        board = res.json<QuestBoardResponse>();
      }
      for (const offer of board.contracts.offers) {
        if (offer.accepted || board.contracts.active >= board.contracts.maxActive) continue;
        const res = await api('POST', `${base}/quests`, { kind: 'contract', slot: offer.slot });
        expect(res.statusCode).toBe(201);
        board = res.json<QuestBoardResponse>();
      }
    };

    /** Merchant and Forge, once each, when the character can afford it. */
    const visitTown = async (inv: InventoryView) => {
      const spare = inv.inventory.filter((i) => i.source !== 'quest');
      if (!economy.sold && spare.length >= 2) {
        const item = spare[0]!;
        const key = randomUUID();
        const res = await keyed(`${base}/merchant/sell`, { itemIds: [item.id] }, key);
        expect(res.statusCode).toBe(200);
        const replay = await keyed(`${base}/merchant/sell`, { itemIds: [item.id] }, key);
        expect(replay.headers['idempotency-replayed']).toBe('true');
        expect(replay.json<{ character: { gold: number } }>().character.gold).toBe(
          res.json<{ character: { gold: number } }>().character.gold,
        );
        economy.sold = true;
      }
      if (!economy.salvaged && spare.length >= 2) {
        const res = await keyed(`${base}/forge/salvage`, { itemIds: [spare[1]!.id] });
        expect(res.statusCode).toBe(200);
        economy.salvaged = true;
      }
      if (!economy.bought) {
        const m = (await api('GET', `${base}/merchant`)).json<MerchantResponse>();
        const offer = m.offers
          .filter((o) => !o.soldOut && o.price <= m.gold)
          .sort((a, b) => a.price - b.price)[0];
        if (offer) {
          const key = randomUUID();
          const res = await keyed(`${base}/merchant/buy`, { offerId: offer.offerId }, key);
          expect(res.statusCode).toBe(200);
          const replay = await keyed(`${base}/merchant/buy`, { offerId: offer.offerId }, key);
          expect(replay.json()).toEqual(res.json());
          const twice = await keyed(`${base}/merchant/buy`, { offerId: offer.offerId });
          expect(twice.statusCode).toBe(409);
          economy.bought = true;
        }
      }
      if (!economy.crafted) {
        const f = (await api('GET', `${base}/forge`)).json<ForgeResponse>();
        const recipe = f.recipes.find((r) => r.blockers.length === 0 && r.slots.length > 0);
        if (recipe) {
          const res = await keyed(`${base}/forge/craft`, {
            recipeId: recipe.recipeId,
            slot: recipe.slots[0],
          });
          expect(res.statusCode).toBe(200);
          economy.crafted = true;
        }
      }
    };

    /** Keeps the pack from overflowing into auto-salvage by selling what is not worn. */
    const sellJunk = async (inv: InventoryView) => {
      const junk = inv.inventory.filter((i) => i.source !== 'quest').slice(0, -4);
      if (junk.length < 20) return;
      const res = await keyed(`${base}/merchant/sell`, { itemIds: junk.map((i) => i.id) });
      expect(res.statusCode).toBe(200);
    };

    /** One crypt run: enter, wait it out on the server clock, settle, claim (and replay the claim). */
    const runCrypt = async () => {
      const start = await api('POST', `${base}/dungeon`, { dungeonId: 'namelessCrypt' });
      expect(start.statusCode).toBe(201);
      const { run } = start.json<{ run: DungeonRunView }>();
      // The run never stacks with farming.
      expect((await api('GET', `${base}/activity`)).json<{ activity: unknown }>().activity).toBe(
        null,
      );
      const farm = await api('POST', `${base}/activity`, { areaId: 'abandonedFields' });
      expect(farm.statusCode).toBe(409);
      // Claiming early is refused.
      expect((await keyed(`${base}/dungeon/claim`)).statusCode).toBe(409);
      nowMs = Date.parse(run.endsAt);
      const settled = await api('POST', `${base}/dungeon/settle`);
      expect(settled.statusCode).toBe(200);
      const key = randomUUID();
      const claim = await keyed(`${base}/dungeon/claim`, undefined, key);
      expect(claim.statusCode).toBe(200);
      const { result, character } = claim.json<DungeonClaimResponse>();
      const replay = await keyed(`${base}/dungeon/claim`, undefined, key);
      expect(replay.headers['idempotency-replayed']).toBe('true');
      expect(replay.json()).toEqual(claim.json());
      expect((await keyed(`${base}/dungeon/claim`)).statusCode).toBe(409);
      crypt.push({ level, outcome: result.outcome, bossDefeated: result.bossDefeated });
      level = character.level;
      return result.bossDefeated;
    };

    // 2. Farm. Each visit: settle (the return summary), equip better drops, Tavern, town, move on.
    expect((await api('POST', `${base}/activity`, { areaId: 'abandonedFields' })).statusCode).toBe(
      201,
    );
    let gravewarden = false;
    let lastCryptLevel = 0;
    while (farmedHours < MAX_HOURS) {
      nowMs += STEP;
      farmedHours += STEP / HOUR;
      const res = await api('POST', `${base}/activity/settle`);
      expect(res.statusCode).toBe(200);
      const { summary, activity, character } = res.json<SettleResponse>();
      expect(summary.cappedMs).toBe(0);
      deaths += summary.deaths;
      areasFarmed.add(activity!.areaId);
      level = character.level;

      const inv = await equipBetterDrops();
      await visitTown(inv);
      await sellJunk((await api('GET', `${base}/inventory`)).json<InventoryView>());
      await visitTavern();

      if (!gravewarden && level >= 13) {
        const w = await world();
        abbeyLockedBeforeBoss ||= !w.areas.find((a) => a.id === 'sunkenAbbey')!.unlocked;
        const quests = (await api('GET', `${base}/quests`)).json<QuestBoardResponse>();
        const cryptQuest = quests.quests.find((q) => q.questId === 'theNamelessCrypt');
        // One attempt per level gained: a failed run keeps the loot of the rooms it cleared.
        if (cryptQuest && level > lastCryptLevel) {
          lastCryptLevel = level;
          gravewarden = await runCrypt();
          await visitTavern();
          expect([200, 201]).toContain(
            (await api('POST', `${base}/activity`, { areaId: 'abandonedFields' })).statusCode,
          );
        }
      }
      await farmBestArea();
      if (gravewarden && areasFarmed.has('sunkenAbbey')) break;
    }

    // 3. The whole Phase 2 loop happened within the time budget.
    expect(farmedHours).toBeLessThan(MAX_HOURS);
    expect([...areasFarmed]).toEqual(AREA_ORDER);
    expect(Object.values(economy)).toEqual([true, true, true, true]);
    expect(crypt.some((c) => c.bossDefeated)).toBe(true);
    expect(abbeyLockedBeforeBoss).toBe(true);
    const story = turnedIn.filter((q) => q.kind === 'story').map((q) => q.questId);
    expect(story).toEqual([...STORY_QUEST_IDS]);
    expect(turnedIn.filter((q) => q.kind === 'contract').length).toBeGreaterThan(0);

    // 4. Gathering: materials in storage and a profession above level 1.
    const mats = (await api('GET', `${base}/materials`)).json<MaterialsResponse>();
    expect(mats.materials.length).toBeGreaterThan(2);
    expect(Math.max(...mats.professions.map((p) => p.level))).toBeGreaterThan(1);

    // 5. Sunken Abbey: unlocked by level 17 + the Gravewarden, and farmed (its enemies were met).
    const w = await world();
    expect(w.progress.gravewardenDefeated).toBe(true);
    expect(w.areas.every((a) => a.unlocked)).toBe(true);
    nowMs += STEP;
    const abbey = (await api('POST', `${base}/activity/settle`)).json<SettleResponse>();
    expect(abbey.activity?.areaId).toBe('sunkenAbbey');
    expect(abbey.summary.kills).toBeGreaterThan(0);

    // 6. Everything held is accounted for by exactly one audit entry.
    const audit = await database.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.characterId, characterId));
    let gold = 0;
    let items = 0;
    const materials: Partial<Record<MaterialId, number>> = {};
    const addMaterials = (bundle: unknown, sign = 1) => {
      for (const [id, n] of Object.entries((bundle ?? {}) as Record<string, number>)) {
        materials[id as MaterialId] = (materials[id as MaterialId] ?? 0) + sign * n;
      }
    };
    for (const { event, data } of audit) {
      const d = data as Record<string, unknown> & { gold?: number; items?: unknown };
      switch (event) {
        case 'activity.reward':
          gold += d.gold!;
          items += d.items as number;
          addMaterials(d.materials);
          break;
        case 'merchant.buy':
          gold -= d.price as number;
          items += 1;
          break;
        case 'merchant.sell':
          gold += d.gold!;
          items -= (d.items as unknown[]).length;
          break;
        case 'forge.salvage':
          gold += d.gold!;
          items -= (d.items as unknown[]).length;
          addMaterials(d.materials);
          break;
        case 'forge.craft':
          gold -= d.gold!;
          items += 1;
          addMaterials(d.materials, -1);
          break;
        case 'quest.turn_in':
          gold += d.gold!;
          items += d.item ? 1 : 0;
          addMaterials(d.materials);
          break;
        case 'dungeon.claim':
          gold += d.gold!;
          items += d.items as number;
          addMaterials(d.materials);
          break;
        case 'item.discard':
          items -= 1;
          break;
      }
    }
    const [row] = await database.db.select().from(characters).where(eq(characters.id, characterId));
    expect(row!.gold).toBe(gold);
    const owned = await database.db
      .select({ id: itemInstances.id })
      .from(itemInstances)
      .where(eq(itemInstances.characterId, characterId));
    expect(owned).toHaveLength(items);
    const held = await database.db
      .select()
      .from(characterMaterials)
      .where(eq(characterMaterials.characterId, characterId));
    for (const id of MATERIAL_IDS) {
      expect(held.find((h) => h.materialId === id)?.quantity ?? 0).toBe(materials[id] ?? 0);
    }

    // For the record (docs/ROADMAP.md, Phase 2 retrospective).
    console.info(
      JSON.stringify({ farmedHours, level: row!.level, deaths, crypt, turnedIn: turnedIn.length }),
    );
  }, 300_000);
});
