/**
 * The exit-criteria player (tickets 2.8 and 3.9): one hero played through the HTTP API the way a
 * player would, with a simulated server clock and no database shortcuts. The Phase 2 run
 * (`phase2-exit-criteria.test.ts`) plays `playPhase2` to the Sunken Abbey; the Phase 3 run
 * (`phase3-exit-criteria.test.ts`) continues from there into the loot-depth loop. Both reconcile
 * everything the hero holds with the audit log (`expectHoldingsMatchAudit`).
 *
 * Test-only (under `src/e2e/`, excluded from the production build).
 */
import { expect } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import {
  GUILD_BOSS_ATTEMPTS_PER_WEEK,
  GUILD_CREATE_COST,
  MATERIAL_IDS,
  RARITY_IDS,
  canClassUseItem,
  equipmentSlotsForKind,
  findItemBase,
  getArea,
  type AreaId,
  type ClassId,
  type MaterialId,
} from '@worldforge/game-core';
import { SESSION_COOKIE } from '../auth/index.js';
import type { SettleResponse } from '../activity/routes.js';
import type { InventoryView, ItemView } from '../inventory/routes.js';
import type { WorldStateResponse } from '../world/routes.js';
import type { QuestBoardResponse } from '../quests/store.js';
import type { MerchantResponse } from '../merchant/routes.js';
import type { ForgeResponse } from '../forge/routes.js';
import type { DungeonClaimResponse, DungeonRunView } from '../dungeon/routes.js';
import {
  accountAchievements,
  auditLog,
  characterMaterials,
  characters,
  guilds,
  itemInstances,
  reports,
  sanctions,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { setAccountRole } from '../social/roles.js';
import { reconcileWithAudit } from '../telemetry/report.js';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
/** Simulated time between two client visits (below the 3 h offline cap: nothing is forfeited). */
export const STEP = 2 * HOUR;
export const AREA_ORDER: AreaId[] = [
  'abandonedFields',
  'crowwood',
  'oldBurialGrounds',
  'blackwater',
  'sunkenAbbey',
];

/** The simulated server clock both tests drive. */
export interface Clock {
  now(): number;
  set(ms: number): void;
}

type Method = 'GET' | 'POST' | 'DELETE';

/**
 * Item strength for "is this a better drop?": rarity first, then item level, then upgrades (a
 * Legendary, Mythic or set piece outranks any lower rarity).
 */
export const score = (i: Pick<ItemView, 'rarityId' | 'itemLevel'> & { upgradeLevel?: number }) =>
  RARITY_IDS.indexOf(i.rarityId) * 6 + i.itemLevel + (i.upgradeLevel ?? 0) / 2;

/** Drops B.2 keeps beyond a full pack: Legendary, Mythic, set and Void items. */
export const isValuable = (i: ItemView) =>
  i.rarityId === 'legendary' || i.rarityId === 'mythic' || i.setId !== null || i.variant !== null;

/**
 * What the player never sells when tidying up (B.2's realistic player): locked items, set pieces,
 * Mythics and Void items. A plain Legendary it doesn't wear goes like any other spare drop.
 */
export const isKept = (i: ItemView) =>
  i.locked || i.setId !== null || i.mythicId !== null || i.variant !== null;

export interface JourneyOptions {
  app: FastifyInstance;
  clock: Clock;
  classId: ClassId;
  email: string;
  displayName: string;
  name: string;
  /**
   * Phase 3: the reward slot to choose for a targeted (Abbey) contract offer, or undefined to take
   * it without an item (the Phase 2 player).
   */
  rewardSlot?: (slots: string[]) => string | undefined;
}

export type Journey = Awaited<ReturnType<typeof startJourney>>;

export async function startJourney(options: JourneyOptions) {
  const { app, clock, classId } = options;
  // 1. Register (real account, session cookie) and create a character.
  const reg = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email: options.email,
      password: 'ashes-and-iron-42',
      displayName: options.displayName,
    },
  });
  expect(reg.statusCode).toBe(201);
  const token = reg.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  const api = (
    method: Method,
    url: string,
    payload?: object,
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> =>
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
    name: options.name,
    classId,
    appearance: { banner: 'ash' },
  });
  expect(created.statusCode).toBe(201);
  const characterId = created.json<{ character: { id: string } }>().character.id;
  const base = `/api/characters/${characterId}`;

  /** What the run saw, for the final assertions. */
  const state = {
    level: 1,
    farmedHours: 0,
    deaths: 0,
    areasFarmed: new Set<AreaId>(),
    turnedIn: [] as { kind: string; questId: string; item: ItemView | null }[],
    economy: { bought: false, sold: false, salvaged: false, crafted: false },
    crypt: [] as { tier: number; level: number; outcome: string; bossDefeated: boolean }[],
    abbeyLockedBeforeBoss: false,
    /** Pause the junk sale (Phase 3 lets the pack fill to see drops kept over capacity). */
    tidy: true,
    /**
     * Phase 3: also farm where a held contract's kill or gather objective can be done, so
     * contracts get finished (the Phase 2 player follows only the story).
     */
    followContracts: false,
  };

  const world = async () => (await api('GET', `${base}/world`)).json<WorldStateResponse>();
  const inventory = async () => (await api('GET', `${base}/inventory`)).json<InventoryView>();
  const board = async () => (await api('GET', `${base}/quests`)).json<QuestBoardResponse>();

  /** Advances the clock by one visit and settles: the return summary. */
  const settle = async (): Promise<SettleResponse> => {
    clock.set(clock.now() + STEP);
    state.farmedHours += STEP / HOUR;
    const res = await api('POST', `${base}/activity/settle`);
    expect(res.statusCode, res.body).toBe(200);
    const out = res.json<SettleResponse>();
    expect(out.summary.cappedMs).toBe(0);
    state.deaths += out.summary.deaths;
    state.areasFarmed.add(out.activity!.areaId);
    state.level = out.character.level;
    return out;
  };

  /**
   * Farms where an unfinished story kill objective's enemy lives, else the highest open area
   * (the client's choice; the server checks the unlock).
   */
  const farmBestArea = async () => {
    const w = await world();
    const open = AREA_ORDER.filter((id) => w.areas.find((a) => a.id === id)?.unlocked);
    const b = await board();
    const storyArea = b.quests
      .filter((q) => q.kind === 'story')
      .flatMap((q) => q.objectives.filter((o, n) => o.kind === 'kill' && q.progress[n]! < o.count))
      .map((o) =>
        open.find((id) =>
          getArea(id).enemies.some((e) => e.enemyId === (o as { enemyId: string }).enemyId),
        ),
      )
      .find((id) => id !== undefined);
    const contractArea = state.followContracts
      ? b.quests
          .filter((q) => q.kind === 'contract')
          .flatMap((q) => q.objectives.filter((o, n) => 'count' in o && q.progress[n]! < o.count))
          .map((o) =>
            [...open]
              .reverse()
              .find((id) =>
                o.kind === 'kill'
                  ? getArea(id).enemies.some((e) => e.enemyId === o.enemyId)
                  : o.kind === 'gather' && getArea(id).materials.includes(o.materialId),
              ),
          )
          .find((id) => id !== undefined)
      : undefined;
    const target = storyArea ?? contractArea ?? open[open.length - 1]!;
    const current = w.current?.pendingAreaId ?? w.current?.areaId;
    if (current === target) return;
    const res = await api('POST', `${base}/activity`, { areaId: target });
    expect([200, 201]).toContain(res.statusCode);
  };

  /** Equips every drop that beats what is worn (the player's "equip drops along the way"). */
  const equipBetterDrops = async () => {
    let inv = await inventory();
    const candidates = [...inv.inventory].sort((a, b) => score(b) - score(a));
    for (const item of candidates) {
      const def = findItemBase(item.baseId);
      if (!def || !canClassUseItem(def, classId) || def.minItemLevel > state.level) continue;
      const slots = equipmentSlotsForKind(def.slot);
      const worn = slots.map((s) => inv.equipped.find((e) => e.equippedSlot === s));
      const free = slots.find((_, n) => !worn[n]);
      const weakest = worn.filter((w): w is ItemView => !!w).sort((a, b) => score(a) - score(b))[0];
      const slot = free ?? (weakest && score(item) > score(weakest) ? weakest.equippedSlot : null);
      if (!slot) continue;
      const res = await api('POST', `${base}/items/${item.id}/equip`, { slot });
      if (res.statusCode === 200) inv = res.json<InventoryView>();
      else expect(res.statusCode).toBe(422);
    }
    return inv;
  };

  /** The Tavern: turn in what is ready, take the next story quest and today's contracts. */
  const visitTavern = async () => {
    let b = await board();
    for (const q of b.quests.filter((x) => x.status === 'ready')) {
      const key = randomUUID();
      const res = await keyed(`${base}/quests/${q.id}/turn-in`, undefined, key);
      if (
        res.statusCode === 422 &&
        res.json<{ error: { code: string } }>().error.code === 'inventory_full'
      ) {
        continue; // the reward item needs room; the next visit sells first
      }
      expect(res.statusCode, res.body).toBe(200);
      const item = res.json<{ reward: { item: ItemView | null } }>().reward.item;
      state.turnedIn.push({ kind: q.kind, questId: q.questId, item });
      // A retried turn-in replays the stored reward; a new key is refused by state.
      const replay = await keyed(`${base}/quests/${q.id}/turn-in`, undefined, key);
      expect(replay.headers['idempotency-replayed']).toBe('true');
      expect(replay.json()).toEqual(res.json());
      const again = await keyed(`${base}/quests/${q.id}/turn-in`);
      expect(again.statusCode).toBe(409);
    }
    b = await board();
    if (b.story.next && b.story.next.blockers.length === 0) {
      const res = await api('POST', `${base}/quests`, {
        kind: 'story',
        questId: b.story.next.questId,
      });
      expect(res.statusCode).toBe(201);
      b = res.json<QuestBoardResponse>();
    }
    for (const offer of b.contracts.offers) {
      if (offer.accepted || b.contracts.active >= b.contracts.maxActive) continue;
      const rewardSlot =
        offer.rewardSlots.length > 0 ? options.rewardSlot?.(offer.rewardSlots) : undefined;
      const res = await api('POST', `${base}/quests`, {
        kind: 'contract',
        slot: offer.slot,
        ...(rewardSlot ? { rewardSlot } : {}),
      });
      expect(res.statusCode, res.body).toBe(201);
      b = res.json<QuestBoardResponse>();
    }
  };

  /** Merchant and Forge, once each, when the character can afford it. */
  const visitTown = async (inv: InventoryView) => {
    const spare = inv.inventory.filter((i) => i.source !== 'quest' && !isKept(i));
    const { economy } = state;
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

  /**
   * Keeps the pack from overflowing into auto-salvage by selling what is not worn (never quest
   * rewards or what `isKept` protects).
   */
  const sellJunk = async (inv: InventoryView) => {
    if (!state.tidy) return;
    const junk = inv.inventory.filter((i) => i.source !== 'quest' && !isKept(i)).slice(0, -4);
    if (junk.length < 20) return;
    const res = await keyed(`${base}/merchant/sell`, { itemIds: junk.map((i) => i.id) });
    expect(res.statusCode).toBe(200);
  };

  /**
   * One crypt run: enter (tier 1–3), wait it out on the server clock, settle, claim (and replay the
   * claim). Returns the claim result.
   */
  const runCrypt = async (tier = 1) => {
    const start = await api('POST', `${base}/dungeon`, { dungeonId: 'namelessCrypt', tier });
    expect(start.statusCode, start.body).toBe(201);
    const { run } = start.json<{ run: DungeonRunView }>();
    expect(run.tier).toBe(tier);
    // The run never stacks with farming.
    expect((await api('GET', `${base}/activity`)).json<{ activity: unknown }>().activity).toBe(
      null,
    );
    const farm = await api('POST', `${base}/activity`, { areaId: 'abandonedFields' });
    expect(farm.statusCode).toBe(409);
    // Claiming early is refused.
    expect((await keyed(`${base}/dungeon/claim`)).statusCode).toBe(409);
    clock.set(Date.parse(run.endsAt));
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
    state.crypt.push({
      tier,
      level: state.level,
      outcome: result.outcome,
      bossDefeated: result.bossDefeated,
    });
    state.level = character.level;
    return result;
  };

  /** Back to farming after a crypt run (the area is chosen by `farmBestArea` next). */
  const resumeFarming = async () => {
    expect([200, 201]).toContain(
      (await api('POST', `${base}/activity`, { areaId: 'abandonedFields' })).statusCode,
    );
  };

  /**
   * The Phase 2 loop: farm, and at each visit equip better drops, visit the town and the Tavern,
   * and from level 13 try the crypt once per level until the Gravewarden falls; ends once the
   * Sunken Abbey has been farmed. Returns false if `maxHours` ran out first.
   */
  const playPhase2 = async (maxHours: number) => {
    expect((await api('POST', `${base}/activity`, { areaId: 'abandonedFields' })).statusCode).toBe(
      201,
    );
    let gravewarden = false;
    let lastCryptLevel = 0;
    while (state.farmedHours < maxHours) {
      await settle();
      const inv = await equipBetterDrops();
      await visitTown(inv);
      await sellJunk(await inventory());
      await visitTavern();

      if (!gravewarden && state.level >= 13) {
        const w = await world();
        state.abbeyLockedBeforeBoss ||= !w.areas.find((a) => a.id === 'sunkenAbbey')!.unlocked;
        const quests = await board();
        const cryptQuest = quests.quests.find((q) => q.questId === 'theNamelessCrypt');
        // One attempt per level gained: a failed run keeps the loot of the rooms it cleared.
        if (cryptQuest && state.level > lastCryptLevel) {
          lastCryptLevel = state.level;
          gravewarden = (await runCrypt(1)).bossDefeated;
          await visitTavern();
          await resumeFarming();
        }
      }
      await farmBestArea();
      if (gravewarden && state.areasFarmed.has('sunkenAbbey')) return true;
    }
    return false;
  };

  return {
    api,
    keyed,
    base,
    characterId,
    state,
    world,
    inventory,
    board,
    settle,
    farmBestArea,
    equipBetterDrops,
    visitTavern,
    visitTown,
    sellJunk,
    runCrypt,
    resumeFarming,
    playPhase2,
  };
}

/**
 * Asserts that everything the character holds (gold, items, materials) is accounted for by the
 * audit log: every grant and every spend has exactly one entry.
 */
export async function expectHoldingsMatchAudit(database: DatabaseHandle, characterId: string) {
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
  const events: Record<string, number> = {};
  for (const { event, data } of audit) {
    events[event] = (events[event] ?? 0) + 1;
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
      // Ticket 3.4 (checked since 3.9): upgrades, rerolls and improvements spend gold and materials.
      case 'forge.upgrade':
      case 'forge.reroll':
      case 'forge.improve':
        gold -= d.gold!;
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
      // Ticket 4.4: founding a guild costs the chosen hero gold.
      case 'guild.create':
        gold -= d.gold!;
        break;
      // Ticket 4.9: guild boss stage rewards are paid to the hero chosen at the claim.
      case 'guild_boss.claim':
        gold += d.gold!;
        addMaterials(d.materials);
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
    expect(held.find((h) => h.materialId === id)?.quantity ?? 0, id).toBe(materials[id] ?? 0);
  }
  return { row: row!, events };
}

/** A second account played through the API (register only), for the social steps. */
async function newPlayer(app: FastifyInstance, email: string, displayName: string) {
  const reg = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'ashes-and-iron-42', displayName },
  });
  expect(reg.statusCode, reg.body).toBe(201);
  const token = reg.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  const { account } = reg.json<{ account: { id: string; handle: string; displayName: string } }>();
  const api = (
    method: Method,
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
  return { account, api };
}

/**
 * Phase 4 safety step (ticket 4.1): the hero meets a player whose name mocks the hero, finds them
 * by name and reports the name; a moderator (made one by the CLI's `setAccountRole`, as the owner
 * would) sees the case in the queue and forces a rename; the offender sees why, renames, and the
 * case is closed. Reconciled with the audit log. 4.11 extends this into the multi-player exit run.
 */
export async function playSafetyStep(
  app: FastifyInstance,
  database: DatabaseHandle,
  hero: Journey,
) {
  const heroAccount = (await hero.api('GET', '/api/account')).json<{
    account: { id: string; handle: string };
  }>().account;
  const offender = await newPlayer(app, 'heckler@graumark.test', 'Hedda Is Slow');
  const warden = await newPlayer(app, 'warden@graumark.test', 'Warden Brann');
  // Not a moderator yet: the queue does not exist for them.
  expect((await warden.api('GET', '/api/mod/queue')).statusCode).toBe(404);
  expect(await setAccountRole(database.db, 'warden@graumark.test', 'moderator')).toMatchObject({
    changed: true,
  });

  // The hero looks the name up and reports it.
  const found = await hero.api(
    'GET',
    `/api/players/lookup?name=${encodeURIComponent('hedda is slow')}`,
  );
  expect(found.statusCode).toBe(200);
  const { player } = found.json<{ player: { handle: string; displayName: string } }>();
  expect(player).toEqual({ handle: offender.account.handle, displayName: 'Hedda Is Slow' });
  const filed = await hero.api('POST', '/api/reports', {
    target: { kind: 'profileField', handle: player.handle, field: 'displayName' },
    reason: 'harassment',
    note: 'Named to mock my hero.',
  });
  expect(filed.statusCode, filed.body).toBe(201);
  const reportId = filed.json<{ report: { id: string } }>().report.id;

  // The moderator's queue shows the case with its context; they force a rename.
  const queue = (await warden.api('GET', '/api/mod/queue')).json<{
    cases: { reportId: string; current: { value: string }; reports: { note: string | null }[] }[];
  }>();
  const c = queue.cases.find((x) => x.reportId === reportId)!;
  expect(c.current.value).toBe('Hedda Is Slow');
  expect(c.reports.map((r) => r.note)).toEqual(['Named to mock my hero.']);
  const acted = await warden.api('POST', `/api/mod/reports/${reportId}/resolve`, {
    action: 'forceRename',
    reason: 'Names may not mock other players.',
    durationHours: 7 * 24,
  });
  expect(acted.statusCode, acted.body).toBe(200);

  // The offender sees why and chooses a new name; the old one is gone from lookups.
  const standing = (await offender.api('GET', '/api/account/standing')).json<{
    renameRequired: boolean;
    sanctions: { kind: string; reason: string }[];
  }>();
  expect(standing).toMatchObject({
    renameRequired: true,
    sanctions: [{ kind: 'rename', reason: 'Names may not mock other players.' }],
  });
  expect(
    (await offender.api('POST', '/api/account/display-name', { displayName: 'Quiet Ember' }))
      .statusCode,
  ).toBe(200);
  expect(
    (await hero.api('GET', `/api/players/lookup?name=${encodeURIComponent('Hedda Is Slow')}`))
      .statusCode,
  ).toBe(404);
  expect((await warden.api('GET', '/api/mod/queue')).json<{ cases: unknown[] }>().cases).toEqual(
    [],
  );

  // Every step left exactly one audit row.
  const ids = [heroAccount.id, offender.account.id, warden.account.id];
  const events = (
    await database.db
      .select({ event: auditLog.event, accountId: auditLog.accountId })
      .from(auditLog)
      .where(
        and(
          inArray(auditLog.accountId, ids),
          inArray(auditLog.event, [
            'role.grant',
            'report.create',
            'report.resolve',
            'sanction.issue',
            'account.rename',
          ]),
        ),
      )
  ).map((r) => `${r.event}:${ids.indexOf(r.accountId!)}`);
  expect(events.sort()).toEqual(
    [
      'role.grant:2',
      'report.create:0',
      'report.resolve:2',
      'sanction.issue:1',
      'account.rename:1',
    ].sort(),
  );
  const [row] = await database.db.select().from(reports).where(eq(reports.id, reportId));
  expect(row!.status).toBe('actioned');
  const [sanction] = await database.db
    .select()
    .from(sanctions)
    .where(eq(sanctions.id, row!.sanctionId!));
  expect(sanction).toMatchObject({ kind: 'rename', liftReason: 'renamed' });
  return { reportId, offender: offender.account, moderator: warden.account };
}

/**
 * Phase 4 friends step (ticket 4.3): the hero adds a companion by display name, the companion
 * accepts from the inbox, and the hero sees them online (a bucket, never a time); the companion
 * hides their presence. A pest's request is answered with a block: it vanishes and the pest can no
 * longer reach the hero. Reconciled with the audit log. 4.11 runs this in the multi-player exit run.
 */
export async function playFriendsStep(
  app: FastifyInstance,
  database: DatabaseHandle,
  hero: Journey,
) {
  type Entry = { handle: string; displayName: string | null; presence?: string | null };
  type Friends = { friends: Entry[]; incoming: Entry[]; outgoing: Entry[]; blocked: Entry[] };
  const heroAccount = (await hero.api('GET', '/api/account')).json<{
    account: { id: string; handle: string; displayName: string };
  }>().account;
  const companion = await newPlayer(app, 'companion@graumark.test', 'Ysolde Ash');
  const pest = await newPlayer(app, 'pest@graumark.test', 'Pest Of Graumark');

  // The hero adds the companion by name; it waits in the companion's inbox.
  const asked = await hero.api('POST', '/api/friends/requests', { name: 'ysolde ash' });
  expect(asked.statusCode, asked.body).toBe(200);
  expect(asked.json()).toEqual({ relation: 'requested-by-me' });
  const inbox = (await companion.api('GET', '/api/friends')).json<Friends>();
  expect(inbox.incoming).toEqual([
    { handle: heroAccount.handle, displayName: heroAccount.displayName },
  ]);
  const accepted = await companion.api(
    'POST',
    `/api/friends/requests/${heroAccount.handle}/accept`,
  );
  expect(accepted.json()).toEqual({ relation: 'friend' });

  // The hero sees the companion online; once hidden, no presence at all.
  const list = async () => (await hero.api('GET', '/api/friends')).json<Friends>();
  expect((await list()).friends).toEqual([
    { handle: companion.account.handle, displayName: 'Ysolde Ash', presence: 'online' },
  ]);
  expect((await companion.api('POST', '/api/account/presence', { hidden: true })).statusCode).toBe(
    200,
  );
  expect((await list()).friends[0]!.presence).toBeNull();

  // The pest asks; the hero blocks instead of answering.
  expect(
    (await pest.api('POST', '/api/friends/requests', { handle: heroAccount.handle })).statusCode,
  ).toBe(200);
  expect((await list()).incoming.map((e) => e.handle)).toEqual([pest.account.handle]);
  expect((await hero.api('POST', '/api/blocks', { handle: pest.account.handle })).json()).toEqual({
    relation: 'blocked-by-me',
  });
  const after = await list();
  expect(after.incoming).toEqual([]);
  expect(after.blocked.map((e) => e.handle)).toEqual([pest.account.handle]);
  // The pest sees nothing of the hero any more.
  expect((await pest.api('GET', '/api/friends')).json<Friends>().outgoing).toEqual([]);
  expect(
    (await pest.api('POST', '/api/friends/requests', { handle: heroAccount.handle })).statusCode,
  ).toBe(404);
  expect((await pest.api('GET', `/api/players/${heroAccount.handle}/relation`)).statusCode).toBe(
    404,
  );

  const ids = [heroAccount.id, companion.account.id, pest.account.id];
  const events = (
    await database.db
      .select({ event: auditLog.event, accountId: auditLog.accountId })
      .from(auditLog)
      .where(and(inArray(auditLog.accountId, ids), like(auditLog.event, 'friend.%')))
  ).map((r) => `${r.event}:${ids.indexOf(r.accountId!)}`);
  expect(events.sort()).toEqual(
    ['friend.request:0', 'friend.accept:1', 'friend.request:2', 'friend.block:0'].sort(),
  );
  return { companion: companion.account, pest: pest.account };
}

/**
 * Phase 4 profile step (ticket 4.2): the hero farms to level 10 (the settlement awards `level10`
 * live, once), shows it and showcases the hero; another player finds the profile by name and sees
 * exactly what was chosen, then reports the hero's name from it. Hiding the profile makes it a 404
 * like an unknown player. Achievement rows reconcile with their audit rows.
 */
export async function playProfileStep(
  app: FastifyInstance,
  database: DatabaseHandle,
  hero: Journey,
) {
  const me = (await hero.api('GET', '/api/account')).json<{
    account: { id: string; handle: string; displayName: string };
  }>().account;
  await hero.farmBestArea();
  for (let i = 0; i < 60 && hero.state.level < 10; i++) {
    await hero.settle();
    await hero.equipBetterDrops();
    await hero.farmBestArea();
  }
  expect(hero.state.level).toBeGreaterThanOrEqual(10);

  const settings = (await hero.api('GET', '/api/account/profile')).json<{
    earned: { id: string }[];
    characters: { id: string; name: string }[];
  }>();
  expect(settings.earned.map((e) => e.id)).toContain('level10');
  const saved = await hero.api('POST', '/api/account/profile', {
    visibility: 'public',
    shown: ['level10'],
    showcaseCharacterId: hero.characterId,
  });
  expect(saved.statusCode, saved.body).toBe(200);

  const visitor = await newPlayer(app, 'visitor@graumark.test', 'Curious Visitor');
  const found = await visitor.api(
    'GET',
    `/api/players/lookup?name=${encodeURIComponent(me.displayName)}`,
  );
  expect(found.statusCode).toBe(200);
  const view = (await visitor.api('GET', `/api/players/${me.handle}/profile`)).json<{
    profile: {
      displayName: string;
      characters: { name: string; level: number }[];
      achievements: { id: string }[];
      showcase: { name: string; equipped: unknown[] } | null;
    };
  }>().profile;
  expect(view.displayName).toBe(me.displayName);
  expect(view.characters).toHaveLength(1);
  expect(view.characters[0]!.level).toBe(hero.state.level);
  expect(view.achievements.map((a) => a.id)).toEqual(['level10']);
  expect(view.showcase?.name).toBe(view.characters[0]!.name);
  expect(view.showcase!.equipped.length).toBeGreaterThan(0);

  const filed = await visitor.api('POST', '/api/reports', {
    target: { kind: 'characterName', handle: me.handle, name: view.characters[0]!.name },
    reason: 'other',
  });
  expect(filed.statusCode, filed.body).toBe(201);

  await hero.api('POST', '/api/account/profile', {
    visibility: 'hidden',
    shown: ['level10'],
    showcaseCharacterId: hero.characterId,
  });
  expect((await visitor.api('GET', `/api/players/${me.handle}/profile`)).statusCode).toBe(404);
  expect((await hero.api('GET', `/api/players/${me.handle}/profile`)).statusCode).toBe(200);

  // Every award is one row and one audit row.
  const rows = await database.db
    .select()
    .from(accountAchievements)
    .where(eq(accountAchievements.accountId, me.id));
  const audits = await database.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.accountId, me.id), eq(auditLog.event, 'achievement.award')));
  expect(audits.map((a) => a.data.achievementId).sort()).toEqual(
    rows.map((r) => r.achievementId).sort(),
  );
  expect(rows.every((r) => r.source === 'live')).toBe(true);
  return { handle: me.handle, achievements: rows.map((r) => r.achievementId) };
}

/**
 * Phase 4 guild step (ticket 4.4): the hero farms until the purse covers the founding cost and
 * founds a guild (an `Idempotency-Key` value operation: a retry replays, gold leaves once). A
 * companion finds it and applies, the hero accepts; a recruit is invited by name and accepts; the
 * hero names the companion an officer and sees guildmates' presence (a bucket, never a time); the
 * recruit leaves. A stranger views and reports the guild; a player who blocks the hero cannot find
 * it. Gold reconciles with the audit log and the telemetry rollups.
 */
export async function playGuildStep(app: FastifyInstance, database: DatabaseHandle, hero: Journey) {
  const me = (await hero.api('GET', '/api/account')).json<{
    account: { id: string; handle: string; displayName: string };
  }>().account;
  const gold = async () =>
    (await hero.api('GET', '/api/characters'))
      .json<{ characters: { id: string; gold: number }[] }>()
      .characters.find((c) => c.id === hero.characterId)!.gold;
  await hero.farmBestArea();
  for (let i = 0; i < 120 && (await gold()) < GUILD_CREATE_COST; i++) {
    await hero.settle();
    await hero.equipBetterDrops();
    await hero.sellJunk(await hero.inventory());
    await hero.farmBestArea();
  }
  const before = await gold();
  expect(before).toBeGreaterThanOrEqual(GUILD_CREATE_COST);

  const key = randomUUID();
  const body = {
    characterId: hero.characterId,
    name: 'The Ashen Wardens',
    tag: 'ash',
    emblem: 'flame',
  };
  const founded = await hero.keyed('/api/guilds', body, key);
  expect(founded.statusCode, founded.body).toBe(201);
  const replay = await hero.keyed('/api/guilds', body, key);
  expect(replay.headers['idempotency-replayed']).toBe('true');
  expect(await gold()).toBe(before - GUILD_CREATE_COST);
  const guild = founded.json<{ guild: { handle: string; tag: string } }>().guild;
  expect(guild.tag).toBe('ASH');

  type Page = {
    guild: {
      members: { handle: string; role: string; presence: string | null }[];
      applications: { player: { handle: string } }[];
    } | null;
  };
  const page = async (who: { api: Journey['api'] }) =>
    (await who.api('GET', '/api/guild')).json<Page>();

  // A companion finds the guild and applies; the hero takes them in.
  const companion = await newPlayer(app, 'warden@graumark.test', 'Wren Of Ash');
  const search = (await companion.api('GET', '/api/guilds?q=ashen')).json<{
    guilds: { handle: string }[];
  }>();
  expect(search.guilds.map((g) => g.handle)).toContain(guild.handle);
  expect((await companion.api('POST', `/api/guilds/${guild.handle}/apply`)).statusCode).toBe(200);
  expect((await page(hero)).guild!.applications.map((a) => a.player.handle)).toEqual([
    companion.account.handle,
  ]);
  expect(
    (await hero.api('POST', `/api/guild/applications/${companion.account.handle}/accept`))
      .statusCode,
  ).toBe(200);

  // A recruit is invited by name and accepts, then leaves again.
  const recruit = await newPlayer(app, 'recruit@graumark.test', 'Brannoc Vell');
  expect((await hero.api('POST', '/api/guild/invites', { name: 'brannoc vell' })).statusCode).toBe(
    200,
  );
  expect((await recruit.api('POST', `/api/guilds/${guild.handle}/invite/accept`)).statusCode).toBe(
    200,
  );
  expect(
    (await hero.api('POST', `/api/guild/members/${companion.account.handle}/promote`)).statusCode,
  ).toBe(200);
  const roster = (await page(hero)).guild!.members;
  expect(roster.map((m) => [m.handle, m.role])).toEqual([
    [me.handle, 'leader'],
    [companion.account.handle, 'officer'],
    [recruit.account.handle, 'member'],
  ]);
  expect(roster.every((m) => m.presence === 'online')).toBe(true);
  expect((await recruit.api('POST', '/api/guild/leave')).statusCode).toBe(200);
  expect((await page(recruit)).guild).toBeNull();
  // The leader cannot simply walk away.
  expect((await hero.api('POST', '/api/guild/leave')).statusCode).toBe(409);

  // Others see the guild's profile and can report it; a player who blocks the hero cannot see it.
  const stranger = await newPlayer(app, 'stranger@graumark.test', 'Odo Marrow');
  const profile = await stranger.api('GET', `/api/guilds/${guild.handle}`);
  expect(profile.statusCode).toBe(200);
  expect(profile.json<{ members: unknown[] }>().members).toHaveLength(2);
  const report = await stranger.api('POST', '/api/reports', {
    target: { kind: 'guild', handle: guild.handle },
    reason: 'other',
  });
  expect(report.statusCode, report.body).toBe(201);
  expect((await stranger.api('POST', '/api/blocks', { handle: me.handle })).statusCode).toBe(200);
  expect((await stranger.api('GET', `/api/guilds/${guild.handle}`)).statusCode).toBe(404);

  // Gold, audit and telemetry agree.
  await expectHoldingsMatchAudit(database, hero.characterId);
  const checks = await reconcileWithAudit(database.db);
  for (const c of checks.filter((c) => c.check.startsWith('guilds:'))) {
    expect(c, c.check).toMatchObject({ ok: true });
  }
  const events = await database.db
    .select({ event: auditLog.event })
    .from(auditLog)
    .where(
      and(
        like(auditLog.event, 'guild.%'),
        sql`${auditLog.data}->>'guildId' = ${(await database.db.select({ id: guilds.id }).from(guilds).where(eq(guilds.handle, guild.handle)))[0]!.id}`,
      ),
    );
  expect(events.map((e) => e.event).sort()).toEqual(
    [
      'guild.create',
      'guild.apply',
      'guild.join',
      'guild.invite',
      'guild.join',
      'guild.promote',
      'guild.leave',
    ].sort(),
  );
  return { guildHandle: guild.handle, companion, recruit };
}

/**
 * Phase 4 guild chat step (ticket 4.5), after `playGuildStep`: the leader pins a notice; the
 * officer reads it, posts, and is refused a link; the leader's poll picks the line up (and an
 * unchanged poll is a `304`), then strikes a line from the record, which every reader sees as a
 * tombstone; the officer reports the leader's line; the recruit who left has no chat.
 */
export async function playGuildChatStep(
  database: DatabaseHandle,
  hero: Journey,
  { guildHandle, companion, recruit }: Awaited<ReturnType<typeof playGuildStep>>,
) {
  type Line = {
    id: string;
    seq: number;
    kind: string;
    text: string | null;
    tombstone: string | null;
  };
  type Chat = { notice: Line | null; messages: Line[]; revised: Line[]; next: number };
  const read = async (who: { api: Journey['api'] }, query = '') => {
    const res = await who.api('GET', `/api/guild/chat${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return { body: res.json<Chat>() };
  };

  const notice = await hero.api('POST', '/api/guild/notice', {
    text: 'Muster at the Ashen Pass at dusk.\nBring torches.',
  });
  expect(notice.statusCode, notice.body).toBe(200);
  const first = (await read(companion)).body;
  expect(first.notice?.text).toBe('Muster at the Ashen Pass at dusk.\nBring torches.');

  const posted = await companion.api('POST', '/api/guild/chat', { text: 'Torches are ready.' });
  expect(posted.statusCode, posted.body).toBe(201);
  const line = posted.json<{ message: Line }>().message;
  const link = await companion.api('POST', '/api/guild/chat', { text: 'see www.example.com' });
  expect(link.statusCode).toBe(400);

  const lead = (await read(hero)).body;
  const poll = await read(hero, `?since=${first.next}&from=${lead.messages[0]!.seq}`);
  expect(poll.body.messages.map((m) => m.id)).toEqual([line.id]);
  const quiet = await hero.api('GET', `/api/guild/chat?since=${poll.body.next}`);
  const unchanged = await hero.api('GET', `/api/guild/chat?since=${poll.body.next}`, undefined, {
    'if-none-match': quiet.headers.etag as string,
  });
  expect(unchanged.statusCode).toBe(304);

  const own = await hero.api('POST', '/api/guild/chat', { text: 'Well met, warden.' });
  expect(own.statusCode).toBe(201);
  const ownLine = own.json<{ message: Line }>().message;
  expect((await hero.api('POST', `/api/guild/chat/${line.id}/remove`)).statusCode).toBe(200);
  const after = (await read(companion)).body;
  const struck = after.messages.find((m) => m.id === line.id)!;
  expect(struck).toMatchObject({ text: null, tombstone: 'removed' });
  expect(JSON.stringify(after)).not.toContain('Torches are ready');

  const report = await companion.api('POST', '/api/reports', {
    target: { kind: 'message', id: ownLine.id },
    reason: 'other',
  });
  expect(report.statusCode, report.body).toBe(201);
  expect((await recruit.api('GET', '/api/guild/chat')).statusCode).toBe(404);

  const [g] = await database.db
    .select({ id: guilds.id })
    .from(guilds)
    .where(eq(guilds.handle, guildHandle));
  const events = await database.db
    .select({ event: auditLog.event })
    .from(auditLog)
    .where(
      and(
        inArray(auditLog.event, ['guild.notice', 'guild.chat_remove']),
        sql`${auditLog.data}->>'guildId' = ${g!.id}`,
      ),
    );
  expect(events.map((e) => e.event).sort()).toEqual(['guild.chat_remove', 'guild.notice']);
}

/**
 * Phase 4 guild boss step (ticket 4.9), after `playGuildStep`: the hero (farmed to the boss's
 * minimum level if needed) spends the week's attempts on the guild boss: a retried attempt replays
 * without spending another, the fourth is refused, the board and the guild's total add up, and
 * the companion's untrained hero is turned away. The recruit who left the guild cannot fight for
 * it; a stranger sees only their own (empty) side. On Monday (UTC) the attempts are back and the
 * total starts over. Holdings and telemetry reconcile with the audit log.
 */
export async function playGuildBossStep(
  database: DatabaseHandle,
  hero: Journey,
  clock: Clock,
  { guildHandle, companion, recruit }: Awaited<ReturnType<typeof playGuildStep>>,
) {
  type State = {
    week: { key: string; endsAt: string };
    boss: { name: string; minLevel: number; attemptDamageCap: number };
    me: { attemptsUsed: number; attemptsLeft: number; rewards: unknown[] };
    guild: {
      handle: string;
      total: number;
      attempts: number;
      board: { you: boolean; damage: number; attempts: number }[];
    } | null;
  };
  const state = async (who: { api: Journey['api'] }) => {
    const res = await who.api('GET', '/api/guild/boss');
    expect(res.statusCode, res.body).toBe(200);
    return res.json<State>();
  };
  const first = await state(hero);
  expect(first.guild!.handle).toBe(guildHandle);
  for (let i = 0; i < 60 && hero.state.level < first.boss.minLevel; i++) {
    await hero.settle();
    await hero.equipBetterDrops();
    await hero.farmBestArea();
  }
  expect(hero.state.level).toBeGreaterThanOrEqual(first.boss.minLevel);

  const fight = (key = randomUUID()) =>
    hero.keyed('/api/guild/boss/attempts', { characterId: hero.characterId }, key);
  const key = randomUUID();
  const opened = await fight(key);
  expect(opened.statusCode, opened.body).toBe(201);
  const replay = await fight(key);
  expect(replay.headers['idempotency-replayed']).toBe('true');
  expect(replay.json<{ attempt: unknown }>().attempt).toEqual(
    opened.json<{ attempt: unknown }>().attempt,
  );
  let counted = opened.json<{ attempt: { counted: number } }>().attempt.counted;
  for (let n = 2; n <= GUILD_BOSS_ATTEMPTS_PER_WEEK; n++) {
    const res = await fight();
    expect(res.statusCode, res.body).toBe(201);
    counted += res.json<{ attempt: { counted: number } }>().attempt.counted;
  }
  expect((await fight()).json<{ error: { code: string } }>().error.code).toBe('no_attempts_left');
  const after = await state(hero);
  expect(after.me).toMatchObject({ attemptsUsed: GUILD_BOSS_ATTEMPTS_PER_WEEK, attemptsLeft: 0 });
  expect(after.guild).toMatchObject({ total: counted, attempts: GUILD_BOSS_ATTEMPTS_PER_WEEK });
  expect(after.guild!.board).toEqual([
    expect.objectContaining({ you: true, damage: counted, attempts: GUILD_BOSS_ATTEMPTS_PER_WEEK }),
  ]);

  // The companion's fresh hero is not ready; the recruit who left has no guild to fight for.
  const companionHero = await companion.api('POST', '/api/characters', {
    name: 'Wrenna',
    classId: 'hunter',
    appearance: { banner: 'ash' },
  });
  expect(companionHero.statusCode, companionHero.body).toBe(201);
  const companionHeroId = companionHero.json<{ character: { id: string } }>().character.id;
  const refused = await companion.api(
    'POST',
    '/api/guild/boss/attempts',
    { characterId: companionHeroId },
    { 'idempotency-key': randomUUID() },
  );
  expect(refused.json<{ error: { code: string } }>().error.code).toBe('hero_too_low');
  const outside = await state(recruit);
  expect(outside.guild).toBeNull();
  expect(outside.me.attemptsUsed).toBe(0);

  // Monday 00:00 UTC: a new week, new attempts, a fresh total; nothing was earned to claim.
  clock.set(Date.parse(after.week.endsAt));
  const next = await state(hero);
  expect(next.week.key).not.toBe(after.week.key);
  expect(next.me).toMatchObject({ attemptsUsed: 0, attemptsLeft: GUILD_BOSS_ATTEMPTS_PER_WEEK });
  expect(next.guild).toMatchObject({ total: 0, attempts: 0, board: [] });
  const claim = await hero.keyed('/api/guild/boss/claim', { characterId: hero.characterId });
  expect(claim.json<{ error: { code: string } }>().error.code).toBe('nothing_to_claim');

  const { row } = await expectHoldingsMatchAudit(database, hero.characterId);
  expect(row.level).toBeGreaterThanOrEqual(first.boss.minLevel);
  const checks = (await reconcileWithAudit(database.db)).filter((c) =>
    c.check.startsWith('guild boss:'),
  );
  expect(checks.length).toBe(5);
  for (const c of checks) expect(c, c.check).toMatchObject({ ok: true });
  const audited = await database.db
    .select({ event: auditLog.event })
    .from(auditLog)
    .where(and(eq(auditLog.characterId, hero.characterId), like(auditLog.event, 'guild_boss.%')));
  expect(audited.map((a) => a.event)).toEqual(
    Array.from({ length: GUILD_BOSS_ATTEMPTS_PER_WEEK }, () => 'guild_boss.attempt'),
  );
  return { counted };
}
