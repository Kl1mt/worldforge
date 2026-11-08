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
  CONTRACT_TEMPLATES,
  GUILD_BOSS_ATTEMPTS_PER_WEEK,
  prestigeTierFor,
  GUILD_CREATE_COST,
  MATERIAL_IDS,
  RARITY_IDS,
  canClassUseItem,
  contractDay,
  dailyContracts,
  equipmentSlotsForKind,
  findItemBase,
  getArea,
  getDungeonTier,
  getLootTable,
  itemBinding,
  DEFAULT_TRADING_SETTINGS,
  worldFlagsFrom,
  type AreaId,
  type ClassId,
  type MaterialId,
} from '@worldforge/game-core';
import { SESSION_COOKIE } from '../auth/index.js';
import { tokenIn, type MemoryMailer } from '../mail/mailer.js';
import type { SettleResponse } from '../activity/routes.js';
import type { InventoryView, ItemView } from '../inventory/routes.js';
import type { WorldStateResponse } from '../world/routes.js';
import type { QuestBoardResponse } from '../quests/store.js';
import type { MerchantResponse } from '../merchant/routes.js';
import type { ForgeResponse } from '../forge/routes.js';
import type { DungeonClaimResponse, DungeonRunView } from '../dungeon/routes.js';
import {
  accountAchievements,
  accountShelfMaterials,
  accounts,
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
import { completeProject } from '../community/project-cli.js';
import type { WarehouseMoveResponse, WarehouseView } from '../warehouse/routes.js';
import type { ShelfMoveResponse, ShelfView } from '../shelf/routes.js';
import type {
  GuildBossAttemptResponse,
  GuildBossAttemptView,
  GuildBossClaimResponse,
  GuildBossStateResponse,
} from '../guild-boss/routes.js';
import type { TelemetryReport } from '../telemetry/report.js';
import { createInvite } from '../auth/invites.js';
import { checkLeaderboards } from '../leaderboards/check.js';
import { cliDeps } from '../leaderboards/leaderboard-cli.js';
import { runSeasonJobs, scheduleSeason } from '../seasons/model.js';

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

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

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
  /** Ticket 4.11: the invite code to register with (`REGISTRATION_MODE=invite`). */
  inviteCode?: string;
}

export type Journey = Awaited<ReturnType<typeof startJourney>>;

/**
 * Each player of a run comes from their own address (registration is limited to 5 an hour per
 * IP, ticket 1.2; the multi-player exit run registers more than that).
 */
let addresses = 0;
const nextAddress = () => `10.4.${Math.floor(++addresses / 250)}.${(addresses % 250) + 1}`;

export async function startJourney(options: JourneyOptions) {
  const { app, clock, classId } = options;
  const remoteAddress = nextAddress();
  // 1. Register (real account, session cookie) and create a character.
  const reg = await app.inject({
    remoteAddress,
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email: options.email,
      password: 'ashes-and-iron-42',
      displayName: options.displayName,
      ...(options.inviteCode ? { inviteCode: options.inviteCode } : {}),
    },
  });
  expect(reg.statusCode, reg.body).toBe(201);
  const token = reg.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  const api = (
    method: Method,
    url: string,
    payload?: object,
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> =>
    app.inject({
      remoteAddress,
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
    /** Ticket 4.8: runs of the Warden's Watch. */
    watch: [] as { level: number; outcome: string; bossDefeated: boolean }[],
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

  /**
   * Advances the clock by one visit and settles: the return summary. Ticket 4.11: with several
   * players on one clock, `advance: false` settles a visit the caller has already moved the clock
   * for (`townVisit`), so nobody's offline time runs past the cap.
   */
  const settle = async ({ advance = true } = {}): Promise<SettleResponse> => {
    if (advance) clock.set(clock.now() + STEP);
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
      const turnedIn = res.json<{
        reward: { item: ItemView | null };
        character: { level: number };
      }>();
      const item = turnedIn.reward.item;
      state.turnedIn.push({ kind: q.kind, questId: q.questId, item });
      // The reward's XP can level the hero (Ticket F.2: the Ashen Pass step then read a stale
      // level and expected the Warden's Watch still locked).
      state.level = turnedIn.character.level;
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
   * One dungeon run: enter (the crypt: tier 1–3; ticket 4.8: the Warden's Watch, tier 1), wait it
   * out on the server clock, settle, claim (and replay the claim). Returns the claim result.
   */
  const runCrypt = async (tier = 1) => runDungeon('namelessCrypt', tier);
  const runDungeon = async (dungeonId: 'namelessCrypt' | 'ashenWatch', tier = 1) => {
    const start = await api('POST', `${base}/dungeon`, { dungeonId, tier });
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
    expect(result.dungeonId).toBe(dungeonId);
    const record = {
      level: state.level,
      outcome: result.outcome,
      bossDefeated: result.bossDefeated,
    };
    if (dungeonId === 'namelessCrypt') state.crypt.push({ tier, ...record });
    else state.watch.push(record);
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
    runDungeon,
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
      // Ticket 4.6: contributions to a community project spend gold and materials.
      case 'community.contribute':
        gold -= d.gold!;
        addMaterials(d.materials, -1);
        break;
      // Ticket 4.7: warehouse upgrades spend gold; moves keep every item (no count change).
      case 'warehouse.upgrade':
        gold -= d.gold!;
        break;
      // Ticket T.3: the account shelf. A deposit leaves the hero, a withdrawal arrives (one row per
      // kind); what is on the shelf belongs to the account (`expectShelfMatchesAudit`).
      case 'shelf.deposit':
      case 'shelf.withdraw': {
        const sign = event === 'shelf.deposit' ? -1 : 1;
        if (d.kind === 'gold') gold += sign * d.gold!;
        else if (d.kind === 'items') items += sign * (d.items as unknown[]).length;
        else addMaterials(d.materials, sign);
        break;
      }
    }
  }
  const [row] = await database.db.select().from(characters).where(eq(characters.id, characterId));
  expect(row!.gold).toBe(gold);
  const owned = await database.db
    .select({ id: itemInstances.id })
    .from(itemInstances)
    .where(and(eq(itemInstances.characterId, characterId), eq(itemInstances.onShelf, false)));
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

/**
 * Ticket T.3: what the account's shelf holds (items, gold, materials) equals a replay of its
 * `shelf.deposit` / `shelf.withdraw` audit rows, and every item the log left on the shelf is there.
 */
export async function expectShelfMatchesAudit(database: DatabaseHandle, accountId: string) {
  const audit = await database.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.accountId, accountId), like(auditLog.event, 'shelf.%')));
  let gold = 0;
  // Per item, deposits minus withdrawals (1 = on the shelf). Order-free: audit ids and stamps of
  // racing transactions don't give the commit order, and an item's moves alternate anyway.
  const net = new Map<string, number>();
  const materials: Partial<Record<MaterialId, number>> = {};
  for (const { event, data } of audit) {
    const d = data as {
      kind: string;
      gold?: number;
      items?: { itemId: string }[];
      materials?: Record<string, number>;
    };
    const sign = event === 'shelf.deposit' ? 1 : -1;
    if (d.kind === 'gold') gold += sign * d.gold!;
    else if (d.kind === 'items') {
      for (const { itemId } of d.items!) net.set(itemId, (net.get(itemId) ?? 0) + sign);
    } else {
      for (const [id, n] of Object.entries(d.materials ?? {})) {
        materials[id as MaterialId] = (materials[id as MaterialId] ?? 0) + sign * n;
      }
    }
  }
  const [account] = await database.db.select().from(accounts).where(eq(accounts.id, accountId));
  expect(account!.shelfGold).toBe(gold);
  const onShelf = await database.db
    .select({ id: itemInstances.id })
    .from(itemInstances)
    .where(and(eq(itemInstances.shelfAccountId, accountId), eq(itemInstances.onShelf, true)));
  for (const [itemId, n] of net) expect([0, 1], itemId).toContain(n);
  const shelved = [...net].filter(([, n]) => n === 1).map(([id]) => id);
  expect(onShelf.map((r) => r.id).sort()).toEqual(shelved.sort());
  const held = await database.db
    .select()
    .from(accountShelfMaterials)
    .where(eq(accountShelfMaterials.accountId, accountId));
  for (const id of MATERIAL_IDS) {
    expect(held.find((h) => h.materialId === id)?.quantity ?? 0, id).toBe(materials[id] ?? 0);
  }
  return { gold, items: shelved.length, materials };
}

/**
 * A second account played through the API (register only), for the social steps. Ticket 4.11:
 * with `inviteCode` (invite-only registration).
 */
export async function newPlayer(
  app: FastifyInstance,
  email: string,
  displayName: string,
  inviteCode?: string,
) {
  const remoteAddress = nextAddress();
  const reg = await app.inject({
    remoteAddress,
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email,
      password: 'ashes-and-iron-42',
      displayName,
      ...(inviteCode ? { inviteCode } : {}),
    },
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
      remoteAddress,
      method,
      url,
      headers,
      ...(payload ? { payload } : {}),
      cookies: { [SESSION_COOKIE]: token },
    });
  return { account, api };
}

export type Player = Awaited<ReturnType<typeof newPlayer>>;

/** A journey's account as a `Player` for the social steps (ticket 4.11). */
export async function playerOf(hero: Journey): Promise<Player> {
  const { account } = (await hero.api('GET', '/api/account')).json<{
    account: { id: string; handle: string; displayName: string };
  }>();
  return { account, api: hero.api };
}

/**
 * Who a social step meets (ticket 4.11): the invite code new players register with, and players
 * the exit run brings along instead of the step registering its own.
 */
export interface StepCast {
  invite?: string;
  companion?: Player;
  recruit?: Player;
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
  cast: StepCast = {},
) {
  const heroAccount = (await hero.api('GET', '/api/account')).json<{
    account: { id: string; handle: string };
  }>().account;
  const offender = await newPlayer(app, 'heckler@graumark.test', 'Hedda Is Slow', cast.invite);
  const warden = await newPlayer(app, 'warden@graumark.test', 'Warden Brann', cast.invite);
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
  return { reportId, offender: offender.account, moderator: warden.account, warden };
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
  cast: StepCast = {},
) {
  type Entry = { handle: string; displayName: string | null; presence?: string | null };
  type Friends = { friends: Entry[]; incoming: Entry[]; outgoing: Entry[]; blocked: Entry[] };
  const heroAccount = (await hero.api('GET', '/api/account')).json<{
    account: { id: string; handle: string; displayName: string };
  }>().account;
  const companion =
    cast.companion ?? (await newPlayer(app, 'companion@graumark.test', 'Ysolde Ash', cast.invite));
  const pest = await newPlayer(app, 'pest@graumark.test', 'Pest Of Graumark', cast.invite);

  // The hero adds the companion by name; it waits in the companion's inbox.
  const asked = await hero.api('POST', '/api/friends/requests', {
    name: companion.account.displayName.toLowerCase(),
  });
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
    {
      handle: companion.account.handle,
      displayName: companion.account.displayName,
      presence: 'online',
    },
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
  return { companion: companion.account, pest: pest.account, pestPlayer: pest };
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
  cast: StepCast = {},
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

  const visitor = await newPlayer(app, 'visitor@graumark.test', 'Curious Visitor', cast.invite);
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
export async function playGuildStep(
  app: FastifyInstance,
  database: DatabaseHandle,
  hero: Journey,
  cast: StepCast = {},
) {
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
  // Founding settles the hero's farming first; settle now so the purse read is current.
  expect((await hero.api('POST', `${hero.base}/activity/settle`)).statusCode).toBe(200);
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
  const companion =
    cast.companion ?? (await newPlayer(app, 'warden@graumark.test', 'Wren Of Ash', cast.invite));
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
  const recruit =
    cast.recruit ?? (await newPlayer(app, 'recruit@graumark.test', 'Brannoc Vell', cast.invite));
  expect(
    (
      await hero.api('POST', '/api/guild/invites', {
        name: recruit.account.displayName.toLowerCase(),
      })
    ).statusCode,
  ).toBe(200);
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
  // A bucket, never a time; null for a member who hides it (the friends step's companion may).
  expect(roster.every((m) => m.presence === 'online' || m.presence === null)).toBe(true);
  expect(roster.find((m) => m.handle === me.handle)!.presence).toBe('online');
  expect((await recruit.api('POST', '/api/guild/leave')).statusCode).toBe(200);
  expect((await page(recruit)).guild).toBeNull();
  // The leader cannot simply walk away.
  expect((await hero.api('POST', '/api/guild/leave')).statusCode).toBe(409);

  // Others see the guild's profile and can report it; a player who blocks the hero cannot see it.
  const stranger = await newPlayer(app, 'stranger@graumark.test', 'Odo Marrow', cast.invite);
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
    boss: {
      name: string;
      minLevel: number;
      attemptDamageCap: number;
      stages: { stage: number; threshold: number }[];
    };
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

  // Monday 00:00 UTC: a new week, new attempts, a fresh total. A lone hero's three attempts
  // normally stay below the first stage, so nothing was earned to claim; a strong farm (the
  // hero's level and gear depend on the activity's random seed) can break it, and then the
  // stage's reward is claimed instead.
  const broken = first.boss.stages.filter((s) => counted >= s.threshold).length;
  clock.set(Date.parse(after.week.endsAt));
  const next = await state(hero);
  expect(next.week.key).not.toBe(after.week.key);
  expect(next.me).toMatchObject({ attemptsUsed: 0, attemptsLeft: GUILD_BOSS_ATTEMPTS_PER_WEEK });
  expect(next.guild).toMatchObject({ total: 0, attempts: 0, board: [] });
  const claim = await hero.keyed('/api/guild/boss/claim', { characterId: hero.characterId });
  if (broken === 0) {
    expect(claim.json<{ error: { code: string } }>().error.code).toBe('nothing_to_claim');
  } else {
    expect(claim.statusCode, claim.body).toBe(200);
    expect(claim.json<GuildBossClaimResponse>().claimed.rewards).toHaveLength(broken);
  }

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
  const events = audited.map((a) => a.event);
  expect(events.filter((e) => e === 'guild_boss.attempt')).toHaveLength(
    GUILD_BOSS_ATTEMPTS_PER_WEEK,
  );
  if (broken === 0) {
    expect(events).toEqual(
      Array.from({ length: GUILD_BOSS_ATTEMPTS_PER_WEEK }, () => 'guild_boss.attempt'),
    );
  } else {
    expect(events).toContain('guild_boss.claim');
  }
  return { counted };
}

/**
 * Phase 4 community step (ticket 4.6): the hero reads the project board (the Warehouse open, the
 * Ashen Pass waiting on it), farms until it holds gold and timber, and gives to the Warehouse's
 * current stage: more than the daily cap is offered, the cap is taken and the rest stays with the
 * hero; a retry with the same `Idempotency-Key` replays; a second gift the same day is refused
 * (`contribution_capped`). Gold and materials reconcile with the audit log, the contributions with
 * the telemetry rollups. 4.11 finishes the project with several players.
 */
export async function playCommunityStep(database: DatabaseHandle, hero: Journey) {
  type Need = {
    resource: string;
    required: number;
    delivered: number;
    cap: number;
    givenToday: number;
  };
  type Board = {
    projects: {
      id: string;
      status: string;
      stageIndex: number;
      stages: { id: string; status: string; needs: Need[] }[];
      yours: { resource: string; amount: number }[];
    }[];
  };
  const board = async () => (await hero.api('GET', '/api/community/projects')).json<Board>();
  const first = await board();
  expect(first.projects.map((p) => [p.id, p.status])).toEqual([
    ['restoreWarehouse', 'open'],
    ['clearAshenPass', 'locked'],
  ]);
  const stage = first.projects[0]!.stages[first.projects[0]!.stageIndex]!;
  const goldNeed = stage.needs.find((n) => n.resource === 'gold')!;
  const holdings = async () => {
    const gold = (await hero.api('GET', '/api/characters'))
      .json<{ characters: { id: string; gold: number }[] }>()
      .characters.find((c) => c.id === hero.characterId)!.gold;
    const mats = (await hero.api('GET', `/api/characters/${hero.characterId}/materials`)).json<{
      materials: { materialId: string; quantity: number }[];
    }>().materials;
    return { gold, mats: Object.fromEntries(mats.map((m) => [m.materialId, m.quantity])) };
  };
  await hero.farmBestArea();
  for (let i = 0; i < 120 && (await holdings()).gold < goldNeed.cap * 2; i++) {
    await hero.settle();
    await hero.sellJunk(await hero.inventory());
    await hero.farmBestArea();
  }
  const before = await holdings();
  expect(before.gold).toBeGreaterThanOrEqual(goldNeed.cap * 2);
  // Offer twice the cap of gold and whatever the stage's materials the hero holds.
  const offer = [
    { resource: 'gold', amount: goldNeed.cap * 2 },
    ...stage.needs
      .filter((n) => n.resource !== 'gold' && (before.mats[n.resource] ?? 0) > 0)
      .map((n) => ({ resource: n.resource, amount: before.mats[n.resource]! })),
  ];
  const body = { characterId: hero.characterId, stageId: stage.id, offer };
  const key = randomUUID();
  const url = '/api/community/projects/restoreWarehouse/contribute';
  const gave = await hero.keyed(url, body, key);
  expect(gave.statusCode, gave.body).toBe(200);
  const result = gave.json<{
    accepted: { resource: string; amount: number }[];
    limited: Record<string, string>;
  }>();
  const goldGiven = result.accepted.find((a) => a.resource === 'gold')!.amount;
  expect(goldGiven).toBe(goldNeed.cap);
  expect(result.limited.gold).toBe('cap');
  const replay = await hero.keyed(url, body, key);
  expect(replay.headers['idempotency-replayed']).toBe('true');
  const after = await holdings();
  expect(after.gold).toBe(before.gold - goldGiven);
  for (const a of result.accepted.filter((a) => a.resource !== 'gold')) {
    expect(after.mats[a.resource] ?? 0).toBe(before.mats[a.resource]! - a.amount);
  }
  const again = await hero.keyed(
    url,
    { ...body, offer: [{ resource: 'gold', amount: 1 }] },
    randomUUID(),
  );
  expect(again.statusCode).toBe(409);
  expect(again.json<{ error: { code: string } }>().error.code).toBe('contribution_capped');
  const now = (await board()).projects[0]!;
  expect(now.yours).toEqual(result.accepted);
  expect(now.stages[0]!.needs.find((n) => n.resource === 'gold')!.givenToday).toBe(goldNeed.cap);

  await expectHoldingsMatchAudit(database, hero.characterId);
  const checks = await reconcileWithAudit(database.db);
  for (const c of checks.filter((c) => c.check.startsWith('community:'))) {
    expect(c, c.check).toMatchObject({ ok: true });
  }
  return { accepted: result.accepted };
}

/**
 * Phase 4 Ashen Pass step (ticket 4.8): a hero of level 24+ who has slain the Gravewarden finds the
 * Ashen Pass sealed (the world map's blocker, and the server refuses to send it there); the owner
 * finishes the town's two projects with the 4.6 CLI (`completeProject`, the path of a last
 * contribution: world flag, achievements, audit); the pass opens and the hero farms it (its foes'
 * loot at its item levels, its materials); from level 26 it climbs the Warden's Watch once (won or
 * lost), otherwise the Watch shows only its level gate. Ticket F.1: the Tavern offers no Pass
 * contract while the pass is sealed; once it is open the hero takes one and finishes it there
 * (`passContract`). Everything held reconciles with the audit log. Running servers see a flag set by the CLI within the world-state TTL; the step invalidates
 * the cache instead of waiting.
 */
export async function playAshenPassStep(
  app: FastifyInstance,
  database: DatabaseHandle,
  hero: Journey,
  now: Date,
) {
  const { api, base, state } = hero;
  const passView = async () => (await hero.world()).areas.find((a) => a.id === 'ashenPass')!;
  expect(state.level).toBeGreaterThanOrEqual(getArea('ashenPass').unlock.level);
  const sealed = await passView();
  expect(sealed.unlocked).toBe(false);
  expect(sealed.blockers).toEqual([{ kind: 'worldFlag', flag: 'ashenPassCleared' }]);
  const refused = await api('POST', `${base}/activity`, { areaId: 'ashenPass' });
  expect(refused.statusCode).toBe(409);
  expect(refused.json<{ error: { code: string } }>().error.code).toBe('area_locked');
  const passContracts = new Set(
    CONTRACT_TEMPLATES.filter((t) => t.areaId === 'ashenPass').map((t) => t.id),
  );
  const sealedBoard = await hero.board();
  expect(sealedBoard.contracts.offers.some((o) => passContracts.has(o.templateId))).toBe(false);

  // The Warehouse project may already be done (the 4.7 step completes it too).
  expect(await completeProject(database.db, 'restoreWarehouse', now)).toMatch(
    /completed|already complete/,
  );
  expect(await completeProject(database.db, 'clearAshenPass', now)).toMatch(/completed/);
  app.worldState.invalidate();
  expect(await passView()).toEqual({ id: 'ashenPass', unlocked: true, blockers: [] });

  const go = await api('POST', `${base}/activity`, { areaId: 'ashenPass' });
  expect([200, 201]).toContain(go.statusCode);
  const table = getLootTable(getArea('ashenPass').lootTableId);
  let kills = 0;
  // Three visits. The first settlement can still finish a cycle that was in progress in the
  // previous area (area switches, ticket 2.2), with that area's drops and materials, so only the
  // later visits are checked against the Pass's loot table.
  for (let i = 0; i < 3; i++) {
    const { summary, activity } = await hero.settle();
    expect(activity!.areaId).toBe('ashenPass');
    kills += summary.kills;
    if (i > 0) {
      for (const item of summary.items) {
        expect(item.itemLevel).toBeGreaterThanOrEqual(table.itemLevel!.min);
        expect(item.itemLevel).toBeLessThanOrEqual(table.itemLevel!.max);
      }
      for (const id of Object.keys(summary.materials ?? {})) {
        expect(getArea('ashenPass').materials as readonly string[]).toContain(id);
      }
    }
    await hero.equipBetterDrops();
    await hero.sellJunk(await hero.inventory());
  }
  expect(kills).toBeGreaterThan(0);
  expect(state.areasFarmed.has('ashenPass')).toBe(true);

  // Ticket F.1: a Pass contract, taken at the Tavern and finished in the pass. The board is the
  // hero's own deterministic draw (random hero id), so the run finds the first day it holds one
  // with game-core's board (the same pool at every level from 24 once the pass is open), plays
  // Tavern visits until two days after it (room for the contracts already held to be finished),
  // and never assumes today's draw.
  const today = (await hero.board()).day;
  const open = worldFlagsFrom(['warehouseRestored', 'ashenPassCleared']);
  const passDay = Array.from({ length: 60 }, (_, i) =>
    contractDay(new Date(Date.parse(`${today}T00:00:00Z`) + i * 24 * HOUR)),
  ).find((day) =>
    dailyContracts(hero.characterId, day, state.level, { gravewardenDefeated: true }, open).some(
      (o) => passContracts.has(o.template.id),
    ),
  );
  expect(passDay).toBeDefined();
  const lastDay = contractDay(new Date(Date.parse(`${passDay}T00:00:00Z`) + 2 * 24 * HOUR));
  // Farms where a held contract can be done, the pass first (`farmBestArea` stops at the Abbey).
  const farmHeldContracts = async () => {
    const held = (await hero.board()).quests.filter((q) => q.kind === 'contract');
    const objectives = held.flatMap((q) =>
      q.objectives.filter((o, n) => 'count' in o && q.progress[n]! < o.count),
    );
    const target =
      (['ashenPass', ...[...AREA_ORDER].reverse()] as AreaId[]).find((id) =>
        objectives.some((o) =>
          o.kind === 'kill'
            ? getArea(id).enemies.some((e) => e.enemyId === o.enemyId)
            : o.kind === 'gather' && getArea(id).materials.includes(o.materialId),
        ),
      ) ?? 'ashenPass';
    const w = await hero.world();
    if ((w.current?.pendingAreaId ?? w.current?.areaId) === target) return;
    const res = await api('POST', `${base}/activity`, { areaId: target });
    expect([200, 201]).toContain(res.statusCode);
  };
  const passTurnedIn = () => state.turnedIn.filter((q) => passContracts.has(q.questId));
  while (passTurnedIn().length === 0 && (await hero.board()).day <= lastDay) {
    await hero.visitTavern();
    if (passTurnedIn().length > 0) break;
    await farmHeldContracts();
    await hero.settle();
    await hero.equipBetterDrops();
    await hero.sellJunk(await hero.inventory());
  }
  expect(passTurnedIn().length).toBeGreaterThanOrEqual(1);
  const passContract = passTurnedIn()[0]!.questId;
  const back = await api('POST', `${base}/activity`, { areaId: 'ashenPass' });
  expect([200, 201]).toContain(back.statusCode);

  // The level the server holds now (the contract's reward and the switch back can both add XP).
  state.level = (await api('GET', `${base}/activity`)).json<{
    character: { level: number };
  }>().character.level;
  const watch = (await hero.world()).dungeons.find((d) => d.id === 'ashenWatch')!;
  const watchLevel = getDungeonTier('ashenWatch', 1).unlock.level;
  if (state.level >= watchLevel) {
    expect(watch.unlocked).toBe(true);
    await hero.runDungeon('ashenWatch');
    expect(state.watch).toHaveLength(1);
    expect((await api('POST', `${base}/activity`, { areaId: 'ashenPass' })).statusCode).toBe(201);
  } else {
    expect(watch.blockers).toEqual([{ kind: 'level', required: watchLevel }]);
  }
  await expectHoldingsMatchAudit(database, hero.characterId);
  return { kills, level: state.level, watch: state.watch, passContract };
}

/**
 * Phase 4 warehouse step (ticket 4.7): before the town restores it, the hero's warehouse answers
 * `warehouse_closed`; the owner CLI then completes "Restore the Graumark Warehouse" (4.11 does it
 * with several players' contributions). The hero farms until it has gold and loot, stores a locked
 * item and a few others (bulk), finds them out of the merchant's reach, farms on (stored items are
 * untouched and take no pack slot), buys an upgrade (replayed with the same key), takes one item
 * back, and everything reconciles with the audit log and telemetry.
 */
export async function playWarehouseStep(
  app: FastifyInstance,
  database: DatabaseHandle,
  hero: Journey,
  now: () => Date,
  /** Ticket 4.11: `town` when the players' contributions already restored it (no CLI step). */
  restoredBy: 'cli' | 'town' = 'cli',
) {
  const url = `${hero.base}/warehouse`;
  if (restoredBy === 'cli') {
    const closed = await hero.api('GET', url);
    expect(closed.statusCode).toBe(409);
    expect(closed.json<{ error: { code: string } }>().error.code).toBe('warehouse_closed');
    const done = await completeProject(database.db, 'restoreWarehouse', now());
    expect(done).toContain('completed');
    app.worldState.invalidate();
  }
  const open = await hero.api('GET', url);
  expect(open.statusCode, open.body).toBe(200);
  expect(open.json<WarehouseView>()).toMatchObject({ level: 0, items: [] });

  const gold = async () =>
    (await hero.api('GET', '/api/characters'))
      .json<{ characters: { id: string; gold: number }[] }>()
      .characters.find((c) => c.id === hero.characterId)!.gold;
  const upgradeCost = open.json<WarehouseView>().nextUpgrade!.gold;
  await hero.farmBestArea();
  for (let i = 0; i < 120; i++) {
    const inv = await hero.inventory();
    if (inv.inventory.length >= 4 && (await gold()) >= upgradeCost) break;
    await hero.settle();
    await hero.farmBestArea();
  }
  const pack = (await hero.inventory()).inventory;
  expect(pack.length).toBeGreaterThanOrEqual(4);
  // Lock the first item (locked items may be stored), then store it with two more in one move.
  const [lockedItem, ...rest] = pack;
  const lock = await hero.api('POST', `${hero.base}/items/${lockedItem!.id}/lock`, {});
  expect(lock.statusCode, lock.body).toBe(200);
  const storing = [lockedItem!.id, ...rest.slice(0, 2).map((i) => i.id)];
  const dep = await hero.api('POST', `${url}/deposit`, { itemIds: storing });
  expect(dep.statusCode, dep.body).toBe(200);
  const moved = dep.json<WarehouseMoveResponse>();
  expect(moved.moved).toBe(3);
  expect(moved.inventory.inventory.map((i) => i.id)).not.toContain(lockedItem!.id);
  expect(moved.warehouse.items.find((i) => i.id === lockedItem!.id)!.locked).toBe(true);
  const sell = await hero.keyed(`${hero.base}/merchant/sell`, { itemIds: [storing[1]!] });
  expect(sell.json<{ error: { code: string } }>().error.code).toBe('item_in_warehouse');

  // Farming on never touches the stored items.
  const stored = moved.warehouse.items;
  await hero.settle();
  await hero.farmBestArea();
  await hero.settle();
  const after = (await hero.api('GET', url)).json<WarehouseView>();
  expect(after.items).toEqual(stored);

  // A gold sink: the upgrade is paid once per key.
  const key = randomUUID();
  const before = await gold();
  const up = await hero.keyed(`${url}/upgrade`, { level: 0 }, key);
  expect(up.statusCode, up.body).toBe(200);
  const replay = await hero.keyed(`${url}/upgrade`, { level: 0 }, key);
  expect(replay.headers['idempotency-replayed']).toBe('true');
  expect(await gold()).toBe(before - upgradeCost);

  // Taking it back needs a free pack slot: a pack that filled meanwhile refuses first.
  const withdraw = () => hero.api('POST', `${url}/withdraw`, { itemIds: [lockedItem!.id] });
  let back = await withdraw();
  if (back.statusCode === 422) {
    expect(back.json<{ error: { code: string } }>().error.code).toBe('inventory_full');
    await hero.sellJunk(await hero.inventory());
    back = await withdraw();
  }
  expect(back.statusCode, back.body).toBe(200);
  expect(back.json<WarehouseMoveResponse>().inventory.inventory.map((i) => i.id)).toContain(
    lockedItem!.id,
  );

  await expectHoldingsMatchAudit(database, hero.characterId);
  const checks = await reconcileWithAudit(database.db);
  for (const c of checks.filter((c) => c.check.startsWith('warehouse:'))) {
    expect(c, c.check).toMatchObject({ ok: true });
  }
  expect(checks.filter((c) => !c.ok)).toEqual([]);
  return { stored: stored.length - 1, level: 1 };
}

/**
 * Ticket T.3: the account shelf. Off by default (every deposit refused in plain words); the owner
 * opens it from the admin panel; the hero gives an item, gold and materials to a second hero of the
 * same account; the owner pauses gold again and the rest still comes out. Holdings of both heroes
 * and the shelf equal the audit log. Needs the Warehouse open (`playWarehouseStep` first).
 */
export async function playShelfStep(
  app: FastifyInstance,
  database: DatabaseHandle,
  hero: Journey,
  ownerEmail = 'shelf-owner@graumark.test',
) {
  const [me] = await database.db
    .select({ accountId: characters.accountId })
    .from(characters)
    .where(eq(characters.id, hero.characterId));
  const accountId = me!.accountId;
  const err = (r: LightMyRequestResponse) => r.json<{ error: { code: string } }>().error.code;

  // A second hero on the same account.
  const made = await hero.api('POST', '/api/characters', {
    name: 'Wren',
    classId: 'hunter',
    appearance: { banner: 'moss' },
  });
  expect(made.statusCode, made.body).toBe(201);
  const second = made.json<{ character: { id: string } }>().character.id;
  const shelfUrl = (id: string) => `/api/characters/${id}/shelf`;

  // Off by default: shown, but every deposit is refused, and nothing moves.
  const closed = await hero.api('GET', shelfUrl(hero.characterId));
  expect(closed.statusCode, closed.body).toBe(200);
  expect(closed.json<ShelfView>().deposits).toEqual({
    items: false,
    materials: false,
    gold: false,
  });
  const paused = await hero.keyed(`${shelfUrl(hero.characterId)}/deposit`, { gold: 1 });
  expect(paused.statusCode).toBe(409);
  expect(err(paused)).toBe('shelf_paused');

  // The owner opens all three kinds in the admin panel.
  const owner = await newPlayer(app, ownerEmail, 'Shelf Warden');
  expect(await setAccountRole(database.db, ownerEmail, 'admin')).toMatchObject({ to: 'admin' });
  const saveShelf = async (shelf: Record<'items' | 'materials' | 'gold', boolean>) => {
    const current = (await owner.api('GET', '/api/mod/settings/trading')).json<{
      settings: Record<string, unknown>;
      version: number;
    }>();
    const put = await owner.api(
      'PUT',
      '/api/admin/settings/trading',
      { expectedVersion: current.version, settings: { ...current.settings, shelf } },
      { 'idempotency-key': randomUUID() },
    );
    expect(put.statusCode, put.body).toBe(200);
  };
  await saveShelf({ items: true, materials: true, gold: true });

  // Something of each kind to give: farm until the pack, the purse and a stack have it.
  const materialsOf = async (id: string) =>
    (await hero.api('GET', `/api/characters/${id}/materials`)).json<{
      materials: { materialId: MaterialId; quantity: number }[];
    }>().materials;
  for (let i = 0; i < 60; i++) {
    const inv = await hero.inventory();
    const mats = await materialsOf(hero.characterId);
    const gold = (await hero.api('GET', shelfUrl(hero.characterId))).json<ShelfView>().hero.gold;
    if (inv.inventory.some((it) => !it.locked) && mats.length > 0 && gold >= 10) break;
    await hero.settle();
    await hero.farmBestArea();
  }
  const giftItem = (await hero.inventory()).inventory.find((it) => !it.locked)!;
  const stack = (await materialsOf(hero.characterId))[0]!;
  const purse = (await hero.api('GET', shelfUrl(hero.characterId))).json<ShelfView>().hero.gold;
  const gift = {
    itemIds: [giftItem.id],
    gold: Math.floor(purse / 2),
    materials: { [stack.materialId]: stack.quantity },
  };
  const key = randomUUID();
  const dep = await hero.keyed(`${shelfUrl(hero.characterId)}/deposit`, gift, key);
  expect(dep.statusCode, dep.body).toBe(200);
  const replay = await hero.keyed(`${shelfUrl(hero.characterId)}/deposit`, gift, key);
  expect(replay.headers['idempotency-replayed']).toBe('true');
  const onShelf = dep.json<ShelfMoveResponse>().shelf;
  expect(onShelf.items.map((it) => it.id)).toEqual([giftItem.id]);
  expect(onShelf.gold).toBe(gift.gold);
  // On the shelf it is out of reach of the merchant.
  const sell = await hero.keyed(`${hero.base}/merchant/sell`, { itemIds: [giftItem.id] });
  expect(err(sell)).toBe('item_on_shelf');

  // The second hero takes the item and the materials; then the owner pauses gold, and the gold
  // still comes out (withdrawals never read a switch).
  const out = await hero.keyed(`${shelfUrl(second)}/withdraw`, {
    itemIds: [giftItem.id],
    materials: gift.materials,
  });
  expect(out.statusCode, out.body).toBe(200);
  expect(out.json<ShelfMoveResponse>().inventory.inventory.map((it) => it.id)).toEqual([
    giftItem.id,
  ]);
  await saveShelf({ items: true, materials: true, gold: false });
  expect(err(await hero.keyed(`${shelfUrl(hero.characterId)}/deposit`, { gold: 1 }))).toBe(
    'shelf_paused',
  );
  const gold = await hero.keyed(`${shelfUrl(second)}/withdraw`, { gold: gift.gold });
  expect(gold.statusCode, gold.body).toBe(200);
  expect(gold.json<ShelfMoveResponse>()).toMatchObject({
    character: { id: second, gold: gift.gold },
    shelf: { items: [], gold: 0, materials: [] },
  });
  // The item kept its binding (moving it is not a trade and binds nothing).
  expect(out.json<ShelfMoveResponse>().inventory.inventory[0]!.binding).toBe(giftItem.binding);

  await expectHoldingsMatchAudit(database, hero.characterId);
  await expectHoldingsMatchAudit(database, second);
  const left = await expectShelfMatchesAudit(database, accountId);
  expect(left).toMatchObject({ gold: 0, items: 0 });
  expect(Object.values(left.materials).every((n) => n === 0)).toBe(true);
  const checks = await reconcileWithAudit(database.db);
  for (const c of checks.filter((c) => c.check.startsWith('shelf:'))) {
    expect(c, c.check).toMatchObject({ ok: true });
  }
  expect(checks.filter((c) => !c.ok)).toEqual([]);
  return { second, gift };
}

// ---------------------------------------------------------------------------------------------
// Ticket 4.11: the Phase 4 exit run with several players on one clock.
// ---------------------------------------------------------------------------------------------

/**
 * One visit for a whole town on one clock: the clock moves once and every hero settles that
 * visit, equips, tidies its pack and goes on farming (so nobody's offline time passes the cap).
 */
export async function townVisit(clock: Clock, heroes: Journey[]) {
  clock.set(clock.now() + STEP);
  for (const h of heroes) {
    await h.settle({ advance: false });
    await h.equipBetterDrops();
    await h.sellJunk(await h.inventory());
    await h.farmBestArea();
  }
}

/** A hero's gold and materials as the client sees them. */
export async function holdingsOf(hero: Journey) {
  const gold = (await hero.api('GET', '/api/characters'))
    .json<{ characters: { id: string; gold: number }[] }>()
    .characters.find((c) => c.id === hero.characterId)!.gold;
  const mats = (await hero.api('GET', `${hero.base}/materials`)).json<{
    materials: { materialId: string; quantity: number }[];
  }>().materials;
  return {
    gold,
    mats: Object.fromEntries(mats.map((m) => [m.materialId, m.quantity])) as Record<string, number>,
  };
}

export interface ProjectBoardView {
  projects: {
    id: string;
    status: string;
    stageIndex: number;
    stages: {
      id: string;
      status: string;
      needs: {
        resource: string;
        required: number;
        delivered: number;
        cap: number;
        givenToday: number;
      }[];
    }[];
    yours: { resource: string; amount: number }[];
  }[];
}

/**
 * The player's daily share (ticket 4.11): gives the open project's current stage what the hero
 * holds, up to what the stage still needs and what the account may still give today, keeping
 * `reserve` gold. The server takes exactly that (nothing is capped or over-filled because the
 * board said so). Returns what was given, or null when there was nothing to give.
 */
export async function contributeShare(hero: Journey, reserve = 0) {
  const board = (await hero.api('GET', '/api/community/projects')).json<ProjectBoardView>();
  const project = board.projects.find((p) => p.status === 'open');
  if (!project) return null;
  const stage = project.stages[project.stageIndex]!;
  const held = await holdingsOf(hero);
  const offer = stage.needs
    .map((n) => ({
      resource: n.resource,
      amount: Math.min(
        n.cap - n.givenToday,
        n.required - n.delivered,
        n.resource === 'gold' ? held.gold - reserve : (held.mats[n.resource] ?? 0),
      ),
    }))
    .filter((o) => o.amount > 0);
  if (offer.length === 0) return null;
  const res = await hero.keyed(`/api/community/projects/${project.id}/contribute`, {
    characterId: hero.characterId,
    stageId: stage.id,
    offer,
  });
  expect(res.statusCode, res.body).toBe(200);
  const { accepted } = res.json<{ accepted: { resource: string; amount: number }[] }>();
  const taken = Object.fromEntries(accepted.map((a) => [a.resource, a.amount]));
  for (const o of offer) expect(taken[o.resource], o.resource).toBe(o.amount);
  return { projectId: project.id, stageId: stage.id, accepted };
}

/**
 * Invite-only registration (ticket D.2) as the owner opens the live town: the config says
 * `invite`; registering without a code is refused; the owner creates a single-use code with the
 * CLI (`pnpm admin:invite`, here its `createInvite`), registers with it and makes themselves admin
 * with the CLI (`setAccountRole`); the code is spent. The admin then creates the players' invite in
 * the admin panel (shown once) and a second one they revoke, which no longer registers anyone.
 */
export async function openInviteOnlyTown(
  app: FastifyInstance,
  database: DatabaseHandle,
  now: Date,
) {
  expect((await app.inject({ method: 'GET', url: '/api/config' })).json()).toMatchObject({
    registration: { mode: 'invite' },
  });
  const register = (email: string, displayName: string, inviteCode?: string) =>
    app.inject({
      remoteAddress: nextAddress(),
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email,
        displayName,
        password: 'ashes-and-iron-42',
        ...(inviteCode ? { inviteCode } : {}),
      },
    });
  const uninvited = await register('drifter@graumark.test', 'Drifter');
  expect(uninvited.statusCode).toBe(400);
  expect(
    uninvited.json<{ error: { details: { fields: object } } }>().error.details.fields,
  ).toHaveProperty('inviteCode');

  const { code: ownerCode } = await createInvite(
    database.db,
    { maxUses: 1, expiresAt: null, note: 'the owner', via: 'cli' },
    now,
  );
  const admin = await newPlayer(app, 'castellan@graumark.test', 'Castellan Ysolde', ownerCode);
  expect(await setAccountRole(database.db, 'castellan@graumark.test', 'admin')).toMatchObject({
    changed: true,
  });
  const spent = await register('second@graumark.test', 'Second Comer', ownerCode);
  expect(spent.statusCode).toBe(403);
  expect(spent.json<{ error: { code: string } }>().error.code).toBe('invite_invalid');

  const created = await admin.api('POST', '/api/admin/invites', {
    maxUses: 20,
    expiresInHours: null,
    note: 'Graumark players',
  });
  expect(created.statusCode, created.body).toBe(201);
  const { code } = created.json<{ code: string; invite: { id: string } }>();
  const spare = await admin.api('POST', '/api/admin/invites', {
    maxUses: 1,
    expiresInHours: 24,
    note: 'spare',
  });
  const spareId = spare.json<{ invite: { id: string } }>().invite.id;
  const spareCode = spare.json<{ code: string }>().code;
  expect((await admin.api('POST', `/api/admin/invites/${spareId}/revoke`)).statusCode).toBe(200);
  const revoked = await register('third@graumark.test', 'Third Comer', spareCode);
  expect(revoked.statusCode).toBe(403);
  // The codes are shown once: the list carries ids only.
  const list = await admin.api('GET', '/api/admin/invites');
  expect(list.body).not.toContain(code);
  expect(list.body).not.toContain(spareCode);
  return { admin, invite: code, inviteId: created.json<{ invite: { id: string } }>().invite.id };
}

/**
 * Guild chat moderation (ticket 4.11, after `playGuildStep`): a member taunts a guildmate in the
 * chronicle (it passes the text filter: words, not slurs); the leader reports the line, a moderator
 * mutes its author from the queue; the muted player is refused with the reason and sees it in
 * their standing, while play goes on. The officer reports the same line, and the moderator hides it:
 * every reader, the author included, sees a tombstone and never the words. Audited once each.
 */
export async function playChatModerationStep(
  database: DatabaseHandle,
  {
    leader,
    officer,
    offender,
    moderator,
  }: { leader: Player; officer: Player; offender: Player; moderator: Player },
) {
  type Line = { id: string; text: string | null; tombstone: string | null };
  const taunt = 'Brannoc fights like a drowned rat, the whole hall laughs at him.';
  const posted = await offender.api('POST', '/api/guild/chat', { text: taunt });
  expect(posted.statusCode, posted.body).toBe(201);
  const line = posted.json<{ message: Line }>().message;

  type Case = {
    reportId: string;
    target: { kind: string };
    subject: { handle: string };
    current: { value: string };
    reports: { note: string | null }[];
  };
  const queue = async () =>
    (await moderator.api('GET', '/api/mod/queue')).json<{ cases: Case[] }>().cases;
  const report = async (who: Player, note: string) => {
    const res = await who.api('POST', '/api/reports', {
      target: { kind: 'message', id: line.id },
      reason: 'harassment',
      note,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ report: { id: string } }>().report.id;
  };

  const first = await report(leader, 'Mocking a guildmate in the chronicle.');
  const c = (await queue()).find((x) => x.reportId === first)!;
  expect(c).toMatchObject({
    target: { kind: 'message' },
    subject: { handle: offender.account.handle },
    current: { value: taunt },
  });
  const muteReason = 'Taunting guildmates in the guild chronicle.';
  const muted = await moderator.api('POST', `/api/mod/reports/${first}/resolve`, {
    action: 'mute',
    reason: muteReason,
    durationHours: 24,
  });
  expect(muted.statusCode, muted.body).toBe(200);

  // The muted player sees why, in the refusal and in their standing.
  const refused = await offender.api('POST', '/api/guild/chat', { text: 'Why can I not post?' });
  expect(refused.statusCode).toBe(403);
  expect(refused.json()).toMatchObject({
    error: { code: 'muted', details: { sanction: { kind: 'mute', reason: muteReason } } },
  });
  const standing = (await offender.api('GET', '/api/account/standing')).json<{
    sanctions: { kind: string; reason: string; expiresAt: string }[];
  }>();
  expect(standing.sanctions).toEqual([
    expect.objectContaining({ kind: 'mute', reason: muteReason }),
  ]);
  // Reading goes on; reporting stays open to the muted (not used here).
  expect((await offender.api('GET', '/api/guild/chat')).statusCode).toBe(200);

  const second = await report(officer, 'Still up in the chronicle.');
  const hidden = await moderator.api('POST', `/api/mod/reports/${second}/resolve`, {
    action: 'hideContent',
    reason: 'Taunts are taken down.',
    durationHours: 7 * 24,
  });
  expect(hidden.statusCode, hidden.body).toBe(200);
  for (const who of [leader, officer, offender]) {
    const res = await who.api('GET', '/api/guild/chat');
    expect(res.body).not.toContain('drowned rat');
    const seen = res.json<{ messages: Line[] }>().messages.find((m) => m.id === line.id)!;
    expect(seen.text).toBeNull();
    expect(seen.tombstone).not.toBeNull();
  }
  expect((await queue()).filter((x) => [first, second].includes(x.reportId))).toEqual([]);

  const ids = [leader.account.id, officer.account.id, offender.account.id, moderator.account.id];
  const events = (
    await database.db
      .select({ event: auditLog.event, accountId: auditLog.accountId })
      .from(auditLog)
      .where(
        and(
          inArray(auditLog.accountId, ids),
          inArray(auditLog.event, ['report.create', 'report.resolve', 'sanction.issue']),
          // The sanctions are on the offender's history (their first ones); reports by id.
          sql`(${auditLog.data}->>'reportId' in (${first}, ${second}) or ${auditLog.event} = 'sanction.issue')`,
        ),
      )
  ).map((r) => `${r.event}:${ids.indexOf(r.accountId!)}`);
  expect(events.sort()).toEqual(
    [
      'report.create:0',
      'report.create:1',
      'report.resolve:3',
      'report.resolve:3',
      'sanction.issue:2',
      'sanction.issue:2',
    ].sort(),
  );
  return { messageId: line.id, muteReason };
}

/**
 * A guild boss week with several members (ticket 4.11): a member and the officer fight first, the
 * leader breaks a stage; a member who never fought only has it pending; the member who fought
 * leaves and still claims their reward (their damage stays on the guild's board as a former
 * member's); a player who joins after the stage fights and earns nothing for it; the leader and
 * officer claim. Totals, rewards and holdings reconcile with the audit log and the telemetry.
 */
export async function playGuildBossWeek(
  database: DatabaseHandle,
  {
    leader,
    officer,
    member,
    idle,
    late,
  }: { leader: Journey; officer: Journey; member: Journey; idle: Player; late: Journey },
) {
  type State = GuildBossStateResponse;
  const state = async (who: { api: Journey['api'] }) => {
    const res = await who.api('GET', '/api/guild/boss');
    expect(res.statusCode, res.body).toBe(200);
    return res.json<State>();
  };
  const fight = async (who: Journey) => {
    const res = await who.keyed('/api/guild/boss/attempts', { characterId: who.characterId });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<GuildBossAttemptResponse>().attempt;
  };
  const start = await state(leader);
  const week = start.week.key;
  expect(start.guild).toMatchObject({ total: 0, stage: 0 });
  const firstStage = start.boss.stages[0]!;
  for (const h of [leader, officer, member, late]) {
    expect(h.state.level, 'boss level').toBeGreaterThanOrEqual(start.boss.minLevel);
  }

  let counted: number;
  const attempts: GuildBossAttemptView[] = [];
  for (const who of [member, officer]) {
    for (let n = 0; n < GUILD_BOSS_ATTEMPTS_PER_WEEK; n++) attempts.push(await fight(who));
  }
  for (let n = 0; n < GUILD_BOSS_ATTEMPTS_PER_WEEK; n++) {
    attempts.push(await fight(leader));
    if ((await state(leader)).guild!.stage >= 1) break;
  }
  counted = attempts.reduce((s, a) => s + a.counted, 0);
  const broken = await state(leader);
  expect(broken.guild!.total).toBe(counted);
  expect(broken.guild!.stage).toBeGreaterThanOrEqual(1);
  expect(attempts.filter((a) => a.newStages.includes(1))).toHaveLength(1);
  expect(attempts.every((a) => a.week === week && a.counted <= start.boss.attemptDamageCap)).toBe(
    true,
  );
  const stages = broken.guild!.stage;
  const rewardGold = start.boss.stages.slice(0, stages).reduce((s, x) => s + x.reward.gold, 0);

  // The member who never fought has the stage pending, nothing to claim.
  const idleState = await state(idle);
  expect(idleState.me.pendingStages).toContain(1);
  expect(idleState.me.rewards).toEqual([]);

  // The member who fought leaves, keeps the reward and claims it to their hero.
  const before = (await state(member)).me.rewards;
  expect(before.map((r) => r.stage).sort()).toEqual(
    Array.from({ length: stages }, (_, n) => n + 1),
  );
  expect((await member.api('POST', '/api/guild/leave')).statusCode).toBe(200);
  const outside = await state(member);
  expect(outside.guild).toBeNull();
  expect(outside.me.rewards).toEqual(before);
  const memberGold = (await holdingsOf(member)).gold;
  const claim = await member.keyed('/api/guild/boss/claim', { characterId: member.characterId });
  expect(claim.statusCode, claim.body).toBe(200);
  expect(claim.json<GuildBossClaimResponse>().claimed.gold).toBe(rewardGold);
  expect((await holdingsOf(member)).gold).toBe(memberGold + rewardGold);
  expect((await state(member)).me.rewards).toEqual([]);

  // A player who joins after the stage fights for the guild but earns nothing for it.
  const lateHandle = (await playerOf(late)).account;
  expect(
    (await leader.api('POST', '/api/guild/invites', { handle: lateHandle.handle })).statusCode,
  ).toBe(200);
  expect(
    (await late.api('POST', `/api/guilds/${broken.guild!.handle}/invite/accept`)).statusCode,
  ).toBe(200);
  const lateAttempt = await fight(late);
  counted += lateAttempt.counted;
  expect(lateAttempt.earnedStages.filter((s) => s <= stages)).toEqual([]);
  const lateState = await state(late);
  expect(lateState.me.rewards.filter((r) => r.week === week && r.stage <= stages)).toEqual([]);

  // The leader and the officer claim.
  for (const who of [leader, officer]) {
    const res = await who.keyed('/api/guild/boss/claim', { characterId: who.characterId });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<GuildBossClaimResponse>().claimed.gold).toBeGreaterThanOrEqual(rewardGold);
  }

  // The board keeps the leaver's damage as a former member's; the total is every counted blow.
  const end = await state(leader);
  expect(end.guild!.total).toBe(counted);
  const former = end.guild!.board.filter((r) => r.former);
  expect(former).toHaveLength(1);
  expect(former[0]!.player).toBeNull();
  expect(end.guild!.board.reduce((s, r) => s + r.damage, 0)).toBe(counted);

  for (const h of [leader, officer, member, late]) {
    await expectHoldingsMatchAudit(database, h.characterId);
  }
  const checks = (await reconcileWithAudit(database.db)).filter((c) =>
    c.check.startsWith('guild boss:'),
  );
  for (const c of checks) expect(c, c.check).toMatchObject({ ok: true });
  return { week, stages, counted, attempts: attempts.length + 1, rewardGold, firstStage };
}

/**
 * The admin panel's read paths (ticket D.3) at the end of the exit run: everyone else gets the
 * not-found 404 on every route; the admin sees the invite with the accounts it created, the
 * telemetry report with every reconcile check matching, a player's file (sanctions and reports,
 * no email), the server status with both projects done, and the staff list. Every view audited.
 */
export async function playAdminPanelStep(
  app: FastifyInstance,
  database: DatabaseHandle,
  {
    admin,
    others,
    inviteId,
    registered,
    subject,
  }: {
    admin: Player;
    others: Player[];
    inviteId: string;
    registered: string[];
    subject: Player;
  },
) {
  // The not-found handler's own body for that method and path.
  const notFound = (method: string, url: string) => ({
    error: { code: 'not_found', message: `Route ${method} ${url} not found` },
  });
  expect((await app.inject({ method: 'GET', url: '/api/no-such-route' })).json()).toEqual(
    notFound('GET', '/api/no-such-route'),
  );
  const reads = [
    ['GET', '/api/admin/invites'],
    ['GET', '/api/admin/telemetry'],
    ['GET', '/api/admin/status'],
    ['GET', '/api/admin/roles'],
    ['GET', `/api/admin/players/${subject.account.handle}`],
    ['POST', '/api/admin/players/search'],
  ] as const;
  for (const who of others) {
    for (const [method, url] of reads) {
      const res = await who.api(method, url, method === 'POST' ? { query: 'x' } : undefined);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.json()).toEqual(notFound(method, url));
    }
  }

  const invites = (await admin.api('GET', '/api/admin/invites')).json<{
    invites: { id: string; uses: number; redeemedBy: { handle: string }[] }[];
  }>().invites;
  const invite = invites.find((i) => i.id === inviteId)!;
  expect(invite.uses).toBe(registered.length);
  expect(invite.redeemedBy.map((r) => r.handle).sort()).toEqual([...registered].sort());

  const telemetry = await admin.api('GET', '/api/admin/telemetry?reconcile=true');
  expect(telemetry.statusCode, telemetry.body).toBe(200);
  const { report } = telemetry.json<{ report: TelemetryReport }>();
  expect(report.reconcile!.length).toBeGreaterThan(0);
  expect(report.reconcile!.filter((c) => !c.ok)).toEqual([]);

  const search = await admin.api('POST', '/api/admin/players/search', {
    query: subject.account.displayName.slice(0, 6),
  });
  expect(search.json<{ players: { handle: string }[] }>().players.map((p) => p.handle)).toContain(
    subject.account.handle,
  );
  const file = await admin.api('GET', `/api/admin/players/${subject.account.handle}`);
  expect(file.statusCode, file.body).toBe(200);
  expect(file.body).not.toMatch(/@graumark\.test/);
  const player = file.json<{
    player: { sanctions: { kind: string }[]; reports: unknown[] };
  }>().player;
  expect(player.sanctions.map((s) => s.kind)).toContain('mute');
  expect(player.reports.length).toBeGreaterThan(0);

  const status = (await admin.api('GET', '/api/admin/status')).json<{
    registrationMode: string;
    projects: { id: string; status: string }[];
  }>();
  expect(status.registrationMode).toBe('invite');
  expect(status.projects.map((p) => [p.id, p.status])).toEqual([
    ['restoreWarehouse', 'complete'],
    ['clearAshenPass', 'complete'],
  ]);
  const roles = (await admin.api('GET', '/api/admin/roles')).json<{
    staff: { role: string }[];
  }>();
  expect(roles.staff.map((s) => s.role).sort()).toEqual(['admin', 'moderator']);

  // Ticket T.2: the whole exit run played on the launch defaults, never saved (nothing tradeable).
  const trading = await admin.api('GET', '/api/mod/settings/trading');
  expect(trading.statusCode, trading.body).toBe(200);
  expect(trading.json()).toMatchObject({
    settings: DEFAULT_TRADING_SETTINGS,
    version: 0,
    canEdit: true,
    history: [],
  });

  const audited = await database.db
    .select({ event: auditLog.event })
    .from(auditLog)
    .where(and(eq(auditLog.accountId, admin.account.id), like(auditLog.event, 'admin.%')));
  const events = new Set(audited.map((a) => a.event));
  for (const e of [
    'admin.view',
    'admin.player.search',
    'admin.player.view',
    'admin.telemetry.reconcile',
  ]) {
    expect(events.has(e), e).toBe(true);
  }
  return { checks: report.reconcile!.length };
}

/**
 * Phase 5 leaderboard step (ticket 5.2, docs/LEADERBOARDS.md "Boards"): the hero's scores are on
 * every board, equal to its own breakdown (`GET …/scores`); a better item moves Gear Score on the
 * board at once; another player finds the hero listed by display name, with a profile link only
 * where the hero's profile settings allow it, and reports the display name from the entry. The
 * recompute check finds no stored value that differs from its formula.
 */
export async function playLeaderboardStep(
  app: FastifyInstance,
  database: DatabaseHandle,
  hero: Journey,
  cast: StepCast = {},
) {
  type Entry = {
    rank: number;
    you: boolean;
    value: number;
    player: { handle: string; displayName: string | null; profile: boolean };
    hero: { name: string | null; classId: string; level: number };
  };
  type Board = { total: number; entries: Entry[]; yours: Entry[]; nextCursor: string | null };
  const boardOf = async (who: { api: Journey['api'] }, path: string) => {
    const res = await who.api('GET', `/api/leaderboards/${path}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ board: Board }>().board;
  };
  const me = (await hero.api('GET', '/api/account')).json<{
    account: { handle: string; displayName: string };
  }>().account;
  const scores = async () =>
    (await hero.api('GET', `/api/characters/${hero.characterId}/scores`)).json<{
      scores: Record<'level' | 'gearScore' | 'power' | 'pveProgress', { value: number }>;
    }>().scores;
  const own = await scores();
  for (const metric of ['level', 'gearScore', 'power', 'pveProgress'] as const) {
    const board = await boardOf(hero, metric);
    const mine = board.yours.find((e) => e.hero.level === hero.state.level);
    expect(mine, metric).toBeDefined();
    expect(mine!.value, metric).toBe(own[metric].value);
    expect(mine!.rank).toBeGreaterThanOrEqual(1);
  }

  // A better item shows on the board as soon as it is worn.
  await hero.settle();
  await hero.equipBetterDrops();
  const gear = (await boardOf(hero, 'gearScore')).yours[0]!;
  expect(gear.value).toBe((await scores()).gearScore.value);

  // Another player sees the hero by name; the link follows the hero's profile settings.
  const visitor =
    cast.companion ?? (await newPlayer(app, 'ranker@graumark.test', 'Board Watcher', cast.invite));
  const { visibility } = (await hero.api('GET', '/api/account/profile')).json<{
    visibility: string;
  }>();
  let entry: Entry | undefined;
  for (let cursor: string | null = ''; entry === undefined && cursor !== null;) {
    const page: Board = await boardOf(
      visitor,
      `level?limit=100${cursor ? `&cursor=${cursor}` : ''}`,
    );
    entry = page.entries.find((e) => e.player.handle === me.handle);
    cursor = page.nextCursor;
  }
  expect(entry).toBeDefined();
  expect(entry!.player.displayName).toBe(me.displayName);
  if (visibility === 'public') expect(entry!.player.profile).toBe(true);
  if (visibility === 'hidden') {
    expect(entry!.player.profile).toBe(false);
    expect(entry!.hero.name).toBeNull();
  }
  const filed = await visitor.api('POST', '/api/reports', {
    target: { kind: 'profileField', handle: me.handle, field: 'displayName' },
    reason: 'other',
    note: 'Reported from the leaderboard.',
  });
  expect([201, 409], filed.body).toContain(filed.statusCode);

  // Every stored value equals its formula (nothing wrong; other heroes may wait for the sweep).
  const report = await checkLeaderboards(cliDeps(database.db));
  expect(report.problems.filter((p) => p.kind === 'wrong')).toEqual([]);
  expect(report.problems.filter((p) => p.characterId === hero.characterId)).toEqual([]);
  return { entry: entry!, visibility };
}

/**
 * Phase 5 season step (ticket 5.3, docs/LEADERBOARDS.md "Seasons"): the owner (an admin, the role
 * granted by the CLI) schedules a one-day season in the admin panel; the hero farms inside it and
 * is on the season board with its score at that moment; past the end the server archives the
 * standings and awards prestige by place, once; the hero shows the earned title and frame, which
 * another player sees on the board and the hero's profile. Awards change no score.
 */
export async function playSeasonStep(
  app: FastifyInstance,
  database: DatabaseHandle,
  hero: Journey,
  clock: Clock,
  cast: StepCast & { ownerEmail?: string } = {},
) {
  type Entry = {
    rank: number;
    value: number;
    you: boolean;
    player: {
      handle: string;
      prestige: { title: { tier: string } | null; frame: { tier: string } | null };
    };
  };
  type Board = {
    total: number;
    entries: Entry[];
    yours: Entry[];
    season: { number: number; status: string } | null;
  };
  const boardOf = async (who: { api: Journey['api'] }, path: string) => {
    const res = await who.api('GET', `/api/leaderboards/${path}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ board: Board }>().board;
  };
  const ownerEmail = cast.ownerEmail ?? 'season-keeper@graumark.test';
  const owner = await newPlayer(app, ownerEmail, 'Season Keeper', cast.invite);
  expect(await setAccountRole(database.db, ownerEmail, 'admin')).toMatchObject({ to: 'admin' });

  // The owner schedules a season from now for one day (the shortest allowed).
  const startsAt = new Date(clock.now()).toISOString();
  const endsAt = new Date(clock.now() + 24 * HOUR).toISOString();
  const planned = await owner.api('POST', '/api/admin/seasons', { startsAt, endsAt });
  expect(planned.statusCode, planned.body).toBe(200);
  const number = planned.json<{ current: { number: number } | null }>().current!.number;

  // The hero plays in the season and is on its board with its score at that moment.
  await hero.farmBestArea();
  await hero.settle();
  const seasons = (await hero.api('GET', '/api/seasons')).json<{
    current: { number: number } | null;
  }>();
  expect(seasons.current?.number).toBe(number);
  const live = await boardOf(hero, `level?scope=season&season=${number}`);
  expect(live.season).toMatchObject({ number, status: 'active' });
  const scores = (await hero.api('GET', `/api/characters/${hero.characterId}/scores`)).json<{
    scores: Record<'level' | 'gearScore' | 'power' | 'pveProgress', { value: number }>;
  }>().scores;
  const mine = live.yours.find((e) => e.value === scores.level.value);
  expect(mine, 'the hero on the season board').toBeDefined();

  // Past the end (and the grace), the server takes the standings and awards prestige once.
  clock.set(Date.parse(endsAt) + 10 * MIN);
  const jobs = await runSeasonJobs(database.db, new Date(clock.now()), new Date(clock.now()));
  expect(jobs.archived).toContain(number);
  expect(
    (await runSeasonJobs(database.db, new Date(clock.now()), new Date(clock.now()))).archived,
  ).toEqual([]);
  const final = await boardOf(hero, `level?scope=season&season=${number}`);
  expect(final.season).toMatchObject({ number, status: 'closed' });
  const place = final.yours[0]!;
  expect(place.rank).toBe(mine!.rank);
  const tier = prestigeTierFor(place.rank, hero.state.level, final.total);
  const prestige = (await hero.api('GET', '/api/account/prestige')).json<{
    earned: { season: number; metric: string; tier: string; rank: number }[];
    shown: { title: { metric: string; tier: string } | null };
  }>();
  if (tier) {
    expect(prestige.earned).toContainEqual(
      expect.objectContaining({ season: number, metric: 'level', tier }),
    );
  }
  expect(prestige.earned.length).toBeGreaterThan(0);
  expect(prestige.shown.title).not.toBeNull();

  // The hero chooses a title and frame; another player sees them on the board and the profile.
  const pick = prestige.earned[0]!;
  const chose = await hero.api('POST', '/api/account/prestige', {
    title: { season: pick.season, metric: pick.metric },
    frame: { season: pick.season, metric: pick.metric },
  });
  expect(chose.statusCode, chose.body).toBe(200);
  const visitor = cast.companion ?? owner;
  const seen = await boardOf(visitor, `level?scope=season&season=${number}&limit=100`);
  const entry = seen.entries.find((e) => e.rank === place.rank)!;
  expect(entry.player.prestige.title).toMatchObject({ tier: pick.tier });
  expect(entry.player.prestige.frame).toMatchObject({ tier: pick.tier });

  // Prestige is cosmetic: the hero's scores are what they were.
  const after = (await hero.api('GET', `/api/characters/${hero.characterId}/scores`)).json<{
    scores: typeof scores;
  }>().scores;
  expect(after.power.value).toBe(scores.power.value);
  expect(after.gearScore.value).toBe(scores.gearScore.value);
  return { season: number, rank: place.rank, tier: pick.tier };
}

/**
 * Phase 5 duel step (ticket 5.5, docs/PVP.md "The arena"): two players. Fresh heroes cannot fight
 * rated duels yet, but friends may challenge each other at once (a friendly challenge against the
 * friend's saved defence). Both farm to level 10, set their defences, and the hero fights the rival
 * from the server's opponent list; a retry with the same key replays the stored duel. The rival
 * sees it in their history as the defender. A duel changes nothing either player owns, and the
 * audit log and telemetry reconcile.
 */
export async function playDuelStep(
  database: DatabaseHandle,
  hero: Journey,
  rival: Journey,
  clock: Clock,
) {
  type Arena = {
    hero: { level: number; ratedOpen: boolean; bracket: { id: string } };
    defence: { defenceId: string; setAt: string } | null;
    rated: { used: number; left: number; offer: { opponents: { defenceId: string }[] } | null };
    ladder: { you: { games: number; standing: string }; rank: number | null };
  };
  type Duel = {
    id: string;
    kind: string;
    you: string;
    result: string;
    bracketId: string;
    events: { type: string }[];
    rating: { before: number; after: number; factor: number } | null;
  };
  const arena = async (j: Journey) => {
    const res = await j.api('GET', `/api/arena?characterId=${j.characterId}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Arena>();
  };
  const setDefence = async (j: Journey) => {
    const res = await j.api('POST', '/api/arena/defence', { characterId: j.characterId });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Arena>().defence!;
  };
  const challenge = (
    j: Journey,
    defenceId: string,
    kind: 'rated' | 'friendly',
    key = randomUUID(),
  ) => j.keyed('/api/arena/duels', { characterId: j.characterId, defenceId, kind }, key);
  const heroPlayer = await playerOf(hero);
  const rivalPlayer = await playerOf(rival);

  // Friends first (by name; the rival accepts).
  expect(
    (
      await hero.api('POST', '/api/friends/requests', { handle: rivalPlayer.account.handle })
    ).json(),
  ).toEqual({ relation: 'requested-by-me' });
  expect(
    (await rival.api('POST', `/api/friends/requests/${heroPlayer.account.handle}/accept`)).json(),
  ).toEqual({ relation: 'friend' });

  // A fresh hero: no rated duels yet, but a friendly challenge at once.
  const fresh = await arena(hero);
  if (!fresh.hero.ratedOpen) {
    const refused = await hero.api('POST', '/api/arena/opponents', {
      characterId: hero.characterId,
    });
    expect(refused.json<{ error: { code: string } }>().error.code).toBe('level_too_low');
  }
  const rivalDefence = await setDefence(rival);
  const friendlyList = (await hero.api('GET', '/api/arena/friendly')).json<{
    opponents: { player: { handle: string }; defences: { defenceId: string }[] }[];
  }>().opponents;
  expect(friendlyList.map((o) => o.player.handle)).toEqual([rivalPlayer.account.handle]);
  expect(friendlyList[0]!.defences.map((d) => d.defenceId)).toEqual([rivalDefence.defenceId]);
  const before = { hero: await holdingsOf(hero), rival: await holdingsOf(rival) };
  const friendly = await challenge(hero, rivalDefence.defenceId, 'friendly');
  expect(friendly.statusCode, friendly.body).toBe(201);
  const friendlyDuel = friendly.json<{ duel: Duel }>().duel;
  expect(friendlyDuel).toMatchObject({ kind: 'friendly', you: 'challenger' });
  expect(friendlyDuel.events.at(-1)!.type).toBe('end');
  expect({ hero: await holdingsOf(hero), rival: await holdingsOf(rival) }).toEqual(before);

  // Both reach level 10 (farming), then set their defences.
  for (const j of [hero, rival]) {
    for (let i = 0; i < 80 && j.state.level < 10; i++) {
      await j.farmBestArea();
      await j.settle();
      await j.equipBetterDrops();
    }
    expect(j.state.level).toBeGreaterThanOrEqual(10);
  }
  // Ticket 5.6: friends never meet in a rated duel, so the server does not offer the rival.
  await setDefence(hero);
  await setDefence(rival);
  const asFriends = await hero.api('POST', '/api/arena/opponents', {
    characterId: hero.characterId,
  });
  expect(asFriends.statusCode, asFriends.body).toBe(200);
  expect(asFriends.json<Arena>().rated.offer!.opponents).toEqual([]);
  // They part as friends; for a fair first rated bout both take their gear off (same class, so
  // equal bracket Power: matchmaking's range cannot leave the rival out).
  const removed = await hero.api('POST', `/api/friends/${rivalPlayer.account.handle}/remove`);
  expect(removed.statusCode, removed.body).toBe(200);
  for (const j of [hero, rival]) {
    const inv = await j.api('GET', `/api/characters/${j.characterId}/inventory`);
    for (const item of inv.json<{ equipped: { id: string }[] }>().equipped) {
      const res = await j.api('POST', `/api/characters/${j.characterId}/items/${item.id}/unequip`);
      expect(res.statusCode, res.body).toBe(200);
    }
  }
  const heroDefence = await setDefence(hero);
  const rivalNow = await setDefence(rival);
  expect(rivalNow.defenceId).toBe(rivalDefence.defenceId);
  const [mine, theirs] = [await arena(hero), await arena(rival)];
  expect(mine.hero.ratedOpen).toBe(true);
  // Each stopped farming on reaching 10, so both are in 10–19.
  expect(mine.hero.bracket.id).toBe('10-19');
  expect(theirs.hero.bracket.id).toBe('10-19');

  // The owner opens the first season (the CLI's path), so rated duels move ratings.
  const opensAt = clock.now() + 60_000;
  await scheduleSeason(
    database.db,
    { startsAt: new Date(opensAt), endsAt: new Date(opensAt + 8 * 7 * 86_400_000) },
    new Date(clock.now()),
    { accountId: null, via: 'cli' },
  );
  clock.set(opensAt + 1000);

  // The server's list (the rival is the only other defence in this town).
  const drawn = await hero.api('POST', '/api/arena/opponents', { characterId: hero.characterId });
  expect(drawn.statusCode, drawn.body).toBe(200);
  const offered = drawn.json<Arena>().rated.offer!.opponents.map((o) => o.defenceId);
  expect(offered).toEqual([rivalDefence.defenceId]);
  expect(offered).not.toContain(heroDefence.defenceId);

  const held = { hero: await holdingsOf(hero), rival: await holdingsOf(rival) };
  const key = randomUUID();
  const rated = await challenge(hero, rivalDefence.defenceId, 'rated', key);
  expect(rated.statusCode, rated.body).toBe(201);
  const replay = await challenge(hero, rivalDefence.defenceId, 'rated', key);
  expect(replay.headers['idempotency-replayed']).toBe('true');
  expect(replay.json<{ duel: Duel }>().duel).toEqual(rated.json<{ duel: Duel }>().duel);
  const ratedDuel = rated.json<{ duel: Duel }>().duel;
  expect((await arena(hero)).rated).toMatchObject({ used: 1, left: 9 });
  // Both ratings moved (once, despite the replay): provisional, not on the ladder yet.
  expect(ratedDuel.rating).toMatchObject({ before: 1500, factor: 1 });
  for (const j of [hero, rival]) {
    const ladder = (await arena(j)).ladder;
    expect(ladder).toMatchObject({ you: { games: 1, standing: 'provisional' }, rank: null });
    const board = (await j.api('GET', '/api/arena/ladder')).json<{
      ladder: { entries: unknown[]; yours: { rank: number | null }[] };
    }>().ladder;
    expect(board.entries).toEqual([]);
    expect(board.yours).toEqual([expect.objectContaining({ rank: null })]);
  }

  // The rival sees it as the defender, with the same log.
  const history = (await rival.api('GET', '/api/arena/duels')).json<{
    duels: { id: string; you: string; kind: string }[];
  }>().duels;
  expect(history[0]).toMatchObject({ id: ratedDuel.id, you: 'defender', kind: 'rated' });
  const seen = (await rival.api('GET', `/api/arena/duels/${ratedDuel.id}`)).json<{ duel: Duel }>()
    .duel;
  expect(seen.events).toEqual(ratedDuel.events);
  expect(seen.rating!.before).toBe(1500);
  expect(seen.you).toBe('defender');

  // Nothing either owns changed; holdings reconcile with the audit log, as do the rollups.
  expect({ hero: await holdingsOf(hero), rival: await holdingsOf(rival) }).toEqual(held);
  await expectHoldingsMatchAudit(database, hero.characterId);
  await expectHoldingsMatchAudit(database, rival.characterId);
  const checks = await reconcileWithAudit(database.db);
  expect(checks.filter((c) => !c.ok)).toEqual([]);
  const fights = await database.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.event, 'duel.fight'), eq(auditLog.accountId, heroPlayer.account.id)));
  expect(fights).toHaveLength(2);
  return { rated: ratedDuel, friendlyDuel };
}

/**
 * Ticket 5.7: the account security step. The hero's email is unverified after registration; the
 * captured verification mail verifies it; a second device logs in and is logged out from the first;
 * "forgot password" mails a reset link, the new password ends every session (the hero's too) and
 * the hero logs in again with progress intact. Mail goes to the in-memory `mailer`, never anywhere.
 * Returns the new session's `api` (the hero's own `api` is logged out afterwards).
 */
export async function playAccountSecurityStep(
  app: FastifyInstance,
  mailer: MemoryMailer,
  hero: Journey,
  email: string,
) {
  const remoteAddress = nextAddress();
  const anon = (url: string, payload: object) =>
    app.inject({ remoteAddress, method: 'POST', url, payload });

  // 1. Unverified after registration; the letter from registration verifies it.
  const before = (await hero.api('GET', '/api/account/security')).json<{
    security: { emailVerified: boolean; verificationPending: boolean; otherSessions: number };
  }>().security;
  expect(before).toMatchObject({
    emailVerified: false,
    verificationPending: true,
    otherSessions: 0,
  });
  const verifyMail = mailer.last(email, 'verify_email');
  expect(verifyMail, 'a verification mail on registration').toBeDefined();
  const verified = await anon('/api/auth/verify-email', { token: tokenIn(verifyMail!) });
  expect(verified.statusCode, verified.body).toBe(200);
  expect((await hero.api('GET', '/api/account')).json()).toMatchObject({
    account: { emailVerified: true },
  });

  // 2. A second device, logged out from the first.
  const other = await anon('/api/auth/login', { email, password: 'ashes-and-iron-42' });
  expect(other.statusCode).toBe(200);
  const otherToken = other.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  const revoked = await hero.api('POST', '/api/account/sessions/revoke-others');
  expect(revoked.json()).toEqual({ revoked: 1 });
  const stale = await app.inject({
    method: 'GET',
    url: '/api/account',
    cookies: { [SESSION_COOKIE]: otherToken },
  });
  expect(stale.statusCode).toBe(401);

  // 3. Forgot password → the mailed link → a new password; every session ends.
  type Roster = { characters: { id: string; gold: number; level: number }[] };
  const roster = async (call: (m: Method, u: string) => Promise<LightMyRequestResponse>) =>
    (await call('GET', '/api/characters')).json<Roster>().characters;
  const heroBefore = (await roster(hero.api)).find((c) => c.id === hero.characterId)!;
  const forgot = await anon('/api/auth/forgot-password', { email });
  expect(forgot.statusCode).toBe(202);
  const resetMail = mailer.last(email, 'reset_password');
  expect(resetMail, 'a reset mail').toBeDefined();
  const reset = await anon('/api/auth/reset-password', {
    token: tokenIn(resetMail!),
    password: 'embers-and-salt-77',
  });
  expect(reset.statusCode, reset.body).toBe(200);
  expect(mailer.last(email, 'password_changed')).toBeDefined();
  expect((await hero.api('GET', '/api/account')).statusCode).toBe(401);
  const old = await anon('/api/auth/login', { email, password: 'ashes-and-iron-42' });
  expect(old.statusCode).toBe(401);
  const back = await anon('/api/auth/login', { email, password: 'embers-and-salt-77' });
  expect(back.statusCode).toBe(200);
  const token = back.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  const api = (method: Method, url: string, payload?: object) =>
    app.inject({
      remoteAddress,
      method,
      url,
      ...(payload ? { payload } : {}),
      cookies: { [SESSION_COOKIE]: token },
    });
  // Progress is untouched: the same hero with the same level and gold.
  expect((await roster(api)).find((c) => c.id === hero.characterId)).toEqual(heroBefore);
  return { api };
}

/**
 * Ticket T.1: item binding after real play. Every item the hero holds carries game-core's binding,
 * worn items are account-bound, nothing is tradeable while trading is off, and every bind-on-equip
 * item's creation is in the audit log by id. Then a fresh pack item, if there is one the hero can
 * wear, is worn and binds.
 */
export async function playBindingStep(database: DatabaseHandle, hero: Journey) {
  const [character] = await database.db
    .select()
    .from(characters)
    .where(eq(characters.id, hero.characterId));
  const accountId = character!.accountId;
  const rows = await database.db
    .select()
    .from(itemInstances)
    .where(eq(itemInstances.characterId, hero.characterId));
  expect(rows.length).toBeGreaterThan(0);
  const created = new Set(
    (
      await database.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.characterId, hero.characterId),
            inArray(auditLog.event, ['activity.reward', 'dungeon.claim', 'forge.craft']),
          ),
        )
    ).flatMap(({ data }) => {
      const d = data as { notableItems?: { id: string }[]; itemId?: string };
      return [...(d.notableItems ?? []).map((n) => n.id), ...(d.itemId ? [d.itemId] : [])];
    }),
  );
  for (const r of rows) {
    const b = itemBinding(r);
    expect(r.binding, r.id).toBe(b.binding);
    expect(r.boundAccountId, r.id).toBe(b.binding === 'account' ? accountId : null);
    expect(r.unprovenanced).toBe(false);
    if (r.equippedSlot !== null) expect(r.binding).toBe('account');
    if (r.binding === 'equip') expect(created.has(r.id), r.id).toBe(true);
  }
  const inv = await hero.inventory();
  for (const v of [...inv.equipped, ...inv.inventory]) {
    expect(v.tradeable).toBe(false);
    expect(v.binding).toBe(rows.find((r) => r.id === v.id)!.binding);
  }
  const fresh = inv.inventory.find((v) => {
    const def = findItemBase(v.baseId);
    return (
      v.binding === 'equip' &&
      def !== undefined &&
      canClassUseItem(def, character!.classId) &&
      def.minItemLevel <= character!.level
    );
  });
  if (fresh) {
    const res = await hero.api('POST', `${hero.base}/items/${fresh.id}/equip`);
    expect(res.statusCode, res.body).toBe(200);
    const worn = res.json<InventoryView>().equipped.find((e) => e.id === fresh.id)!;
    expect(worn).toMatchObject({ binding: 'account', bindingReason: 'worn', tradeable: false });
  }
}
