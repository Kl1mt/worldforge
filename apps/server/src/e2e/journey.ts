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
import { and, eq, inArray, like, or, sql } from 'drizzle-orm';
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
  bossModifierOfWeek,
  guildBossWeek,
  itemBinding,
  DEFAULT_TRADING_SETTINGS,
  tradeEndText,
  worldFlagsFrom,
  type AreaId,
  type ClassId,
  type MaterialId,
} from '@worldforge/game-core';
import { SESSION_COOKIE } from '../auth/index.js';
import { tokenIn, type MemoryMailer } from '../mail/mailer.js';
import type { SettleResponse } from '../activity/routes.js';
import type { InventoryView, ItemView } from '../inventory/routes.js';
import type { BossModifierResponse, WorldStateResponse } from '../world/routes.js';
import type { QuestBoardResponse } from '../quests/store.js';
import type { MerchantResponse } from '../merchant/routes.js';
import type { ForgeResponse } from '../forge/routes.js';
import type {
  DungeonClaimResponse,
  DungeonRunView,
  DungeonStateResponse,
} from '../dungeon/routes.js';
import {
  accountAchievements,
  accountShelfMaterials,
  accounts,
  auditLog,
  characterMaterials,
  characters,
  eventParticipants,
  gameSettings,
  guilds,
  itemInstances,
  reports,
  sanctions,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { setAccountRole } from '../social/roles.js';
import { loadRollups, reconcileWithAudit, sumRollups } from '../telemetry/report.js';
import { setTestAccount } from '../admin/test-accounts.js';
import { giveMaterials } from '../test/trading.js';
import { advanceStage, completeProject } from '../community/project-cli.js';
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
import { runEventJobs } from '../events/model.js';

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
    /** Ticket 6.2: runs of the Tyrant's Forge. */
    forge: [] as { level: number; outcome: string; bossDefeated: boolean }[],
    /** Ticket 8.2: runs of the Hollow Throne. */
    throne: [] as { level: number; outcome: string; bossDefeated: boolean }[],
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

  /**
   * A buy or a craft adds an item, so a pack the last settlement filled refuses it
   * (`422 inventory_full`; the town visit comes before `sellJunk`). That is the right answer,
   * not a failure: check that the pack really is at the capacity it names, and try again on a
   * later visit (ticket F.6, Flake hunt on PR #117).
   */
  const packWasFull = async (res: { statusCode: number; body: string; json: <T>() => T }) => {
    if (res.statusCode !== 422) return false;
    const { error } = res.json<{ error: { code: string; details: { capacity: number } } }>();
    expect(error.code, res.body).toBe('inventory_full');
    expect((await inventory()).inventory.length).toBeGreaterThanOrEqual(error.details.capacity);
    return true;
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
        if (await packWasFull(res)) return;
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
        if (await packWasFull(res)) return;
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
  const runDungeon = async (
    dungeonId: 'namelessCrypt' | 'ashenWatch' | 'tyrantsForge' | 'hollowThrone',
    tier = 1,
  ) => {
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
    else if (dungeonId === 'ashenWatch') state.watch.push(record);
    else if (dungeonId === 'hollowThrone') state.throne.push(record);
    else state.forge.push(record);
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
 * Ticket T.6: the gift is reported by the hero who received it, a moderator finds it in the queue,
 * opens the trade's case (both sides, the trail, the dry run), reverses it with a reason (a
 * retry replays) and reads the pattern report. Both heroes' holdings still equal the audit log
 * and the rollups reconcile; both players read the reason in their history.
 */
export async function playTradeModerationStep(
  app: FastifyInstance,
  database: DatabaseHandle,
  offerId: string,
  hero: Journey,
  friend: Journey,
) {
  const reported = await friend.api('POST', '/api/reports', {
    target: { kind: 'trade', id: offerId },
    reason: 'scam',
    note: 'They asked for it back outside the game.',
  });
  expect(reported.statusCode, reported.body).toBe(201);
  const warden = await newPlayer(app, 'trade-reverser@graumark.test', 'Warden Ilse');
  await setAccountRole(database.db, 'trade-reverser@graumark.test', 'moderator');
  const queue = (await warden.api('GET', '/api/mod/queue')).json<{
    cases: { target: { kind: string; id?: string } }[];
  }>();
  expect(queue.cases.some((c) => c.target.kind === 'trade' && c.target.id === offerId)).toBe(true);
  const view = await warden.api('GET', `/api/mod/trades/${offerId}`);
  expect(view.statusCode, view.body).toBe(200);
  const theCase = view.json<{
    reversible: { possible: boolean; canAct: boolean };
    reports: { open: number };
    trail: { event: string }[];
  }>();
  expect(theCase.reports.open).toBe(1);
  expect(theCase.trail.map((e) => e.event)).toEqual([
    'trade.offer',
    'trade.accept',
    'trade.release',
  ]);
  // The friend may have spent the gift since it was released; the reversal says so if so.
  const key = randomUUID();
  const reverse = () =>
    warden.api(
      'POST',
      `/api/mod/trades/${offerId}/reverse`,
      { reason: 'Reported as a scam; reversed in the journey.' },
      { 'idempotency-key': key },
    );
  const res = await reverse();
  if (theCase.reversible.possible) {
    expect(res.statusCode, res.body).toBe(200);
    const replay = await reverse();
    expect(replay.headers['idempotency-replayed']).toBe('true');
    for (const j of [hero, friend]) {
      const history = (await j.api('GET', '/api/trading/offers/history')).json<{
        offers: { id: string; reversal: { reason: string } | null }[];
      }>();
      expect(history.offers.find((o) => o.id === offerId)?.reversal?.reason).toBe(
        'Reported as a scam; reversed in the journey.',
      );
    }
  } else {
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('trade_not_reversible');
  }
  const patterns = await warden.api('GET', '/api/mod/trading/patterns');
  expect(patterns.statusCode, patterns.body).toBe(200);
  expect(patterns.body).not.toContain('@');
  expect((await hero.api('GET', '/api/mod/trading/patterns')).statusCode).toBe(404);
  await expectHoldingsMatchAudit(database, hero.characterId);
  await expectHoldingsMatchAudit(database, friend.characterId);
  const checks = await reconcileWithAudit(database.db);
  expect(checks.filter((c) => !c.ok)).toEqual([]);
}

/**
 * Asserts that everything the character holds (gold, items, materials) is accounted for by the
 * audit log: every grant and every spend has exactly one entry.
 */
/**
 * What a run gave a hero outside the API (6.10: heroes seeded at a level and in a kit, like the
 * Phase 6 journeys): the holdings at seeding minus the audit replay then. The replay below adds it,
 * so a seeded hero's holdings still equal its audit log from the seeding on.
 */
export interface HoldingsBaseline {
  gold: number;
  items: number;
  materials: Partial<Record<MaterialId, number>>;
}

/** Measures `HoldingsBaseline` for a hero right after a seeding write (adds to `prior`). */
export async function holdingsBaseline(
  database: DatabaseHandle,
  characterId: string,
  prior?: HoldingsBaseline,
): Promise<HoldingsBaseline> {
  const replay = await replayHoldings(database, characterId, prior);
  const actual = await actualHoldings(database, characterId);
  const materials: Partial<Record<MaterialId, number>> = { ...prior?.materials };
  for (const id of MATERIAL_IDS) {
    const d = (actual.materials[id] ?? 0) - (replay.materials[id] ?? 0);
    if (d !== 0) materials[id] = (materials[id] ?? 0) + d;
  }
  return {
    gold: (prior?.gold ?? 0) + actual.gold - replay.gold,
    items: (prior?.items ?? 0) + actual.items - replay.items,
    materials,
  };
}

async function actualHoldings(database: DatabaseHandle, characterId: string) {
  const [row] = await database.db.select().from(characters).where(eq(characters.id, characterId));
  const owned = await database.db
    .select({ id: itemInstances.id })
    .from(itemInstances)
    .where(and(eq(itemInstances.characterId, characterId), eq(itemInstances.onShelf, false)));
  const held = await database.db
    .select()
    .from(characterMaterials)
    .where(eq(characterMaterials.characterId, characterId));
  const materials: Partial<Record<MaterialId, number>> = {};
  for (const h of held) materials[h.materialId as MaterialId] = h.quantity;
  return { row: row!, gold: row!.gold, items: owned.length, materials };
}

export async function expectHoldingsMatchAudit(
  database: DatabaseHandle,
  characterId: string,
  baseline?: HoldingsBaseline,
) {
  const { gold, items, materials, events } = await replayHoldings(database, characterId, baseline);
  const actual = await actualHoldings(database, characterId);
  expect(actual.gold).toBe(gold);
  expect(actual.items).toBe(items);
  for (const id of MATERIAL_IDS) {
    expect(actual.materials[id] ?? 0, id).toBe(materials[id] ?? 0);
  }
  return { row: actual.row, events };
}

/** The hero's holdings as its audit log (plus a seeding baseline) says they should be. */
async function replayHoldings(
  database: DatabaseHandle,
  characterId: string,
  baseline?: HoldingsBaseline,
) {
  // Ticket T.5: a `trade.accept` row sits on the receiving hero but moves the sender's too.
  const audit = await database.db
    .select()
    .from(auditLog)
    .where(
      or(
        eq(auditLog.characterId, characterId),
        and(
          // Ticket T.6: a `trade.reverse` row likewise moves both heroes.
          or(eq(auditLog.event, 'trade.accept'), eq(auditLog.event, 'trade.reverse')),
          sql`${auditLog.data}->>'senderCharacterId' = ${characterId}`,
        ),
      ),
    );
  let gold = baseline?.gold ?? 0;
  let items = baseline?.items ?? 0;
  const materials: Partial<Record<MaterialId, number>> = { ...baseline?.materials };
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
      // Ticket 3.4 (checked since 3.9): upgrades, rerolls and improvements spend gold and materials;
      // ticket 6.5b (checked since 6.10): so does an awakening (gold, Embers, Seals and shards);
      // ticket 6.11: an engraving and the exchange spend Seals or Abbey silver (gold 0).
      case 'forge.upgrade':
      case 'forge.reroll':
      case 'forge.improve':
      case 'forge.awaken':
      case 'forge.engrave':
      case 'cosmetic.exchange':
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
      // Ticket 6.6 (checked since 6.10): the event's world modifier pays its bonus materials.
      case 'event.progress':
        addMaterials(d.bonus);
        break;
      // Ticket D.4 (checked since 6.10): admin grants, refunds and removals.
      case 'admin.gold':
        gold += (d.mode === 'remove' ? -1 : 1) * (d.amount as number);
        break;
      case 'admin.materials':
        addMaterials(d.materials, d.mode === 'remove' ? -1 : 1);
        break;
      case 'admin.item.grant':
        items += 1;
        break;
      case 'admin.item.remove':
        if (d.location !== 'shelf') items -= 1;
        break;
      // Ticket T.5: an offer takes the sender's gold and materials into escrow (its items stay
      // the hero's rows, in escrow); an offer ending without a trade gives them back.
      case 'trade.offer': {
        const give = d.give as { gold: number; materials: Record<string, number> };
        gold -= give.gold;
        addMaterials(give.materials, -1);
        break;
      }
      case 'trade.cancel':
      case 'trade.decline':
      case 'trade.expire':
      case 'trade.void': {
        const back = d.returned as { gold: number; materials: Record<string, number> };
        gold += back.gold;
        addMaterials(back.materials);
        break;
      }
      // The swap: the receiver gets the give side and pays the ask side; the sender the reverse
      // (the sender's gold and materials left at the offer, so only the ask side arrives).
      case 'trade.accept': {
        type Side = { items: unknown[]; gold: number; materials: Record<string, number> };
        const give = d.give as Side;
        const ask = d.ask as Side;
        if (d.receiverCharacterId === characterId) {
          gold += give.gold - ask.gold;
          items += give.items.length - ask.items.length;
          addMaterials(give.materials);
          addMaterials(ask.materials, -1);
        } else {
          gold += ask.gold;
          items += ask.items.length - give.items.length;
          addMaterials(ask.materials);
        }
        break;
      }
      // Ticket T.6: a reversal undoes the swap: the receiver gives back the give side and gets
      // the ask side back; the sender gets its give side back and returns the ask side.
      case 'trade.reverse': {
        type Side = { items: unknown[]; gold: number; materials: Record<string, number> };
        const give = d.give as Side;
        const ask = d.ask as Side;
        if (d.receiverCharacterId === characterId) {
          gold += ask.gold - give.gold;
          items += ask.items.length - give.items.length;
          addMaterials(ask.materials);
          addMaterials(give.materials, -1);
        } else {
          gold += give.gold - ask.gold;
          items += give.items.length - ask.items.length;
          addMaterials(give.materials);
          addMaterials(ask.materials, -1);
        }
        break;
      }
    }
  }
  return { gold, items, materials, events };
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
    ['forgewardOutpost', 'locked'],
    ['deepLanterns', 'locked'],
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
  const open = worldFlagsFrom(['warehouseRestored', 'ashenPassCleared']);
  /** The first day from `from` on whose board this hero draws a Pass contract. */
  const nextPassDay = (from: string) =>
    Array.from({ length: 60 }, (_, i) =>
      contractDay(new Date(Date.parse(`${from}T00:00:00Z`) + i * 24 * HOUR)),
    ).find((day) =>
      dailyContracts(hero.characterId, day, state.level, { gravewardenDefeated: true }, open).some(
        (o) => passContracts.has(o.template.id),
      ),
    );
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
  // Capacity (CLAUDE.md): a hero holds at most three contracts, and the three it holds on a Pass
  // day may take longer than the window to finish, so the Pass offer can't be taken that day.
  // Then the next Pass day gets its own window (bounded), instead of assuming the first fits.
  for (let window = 0; window < 4 && passTurnedIn().length === 0; window++) {
    const passDay = nextPassDay((await hero.board()).day);
    expect(passDay).toBeDefined();
    const lastDay = contractDay(new Date(Date.parse(`${passDay}T00:00:00Z`) + 2 * 24 * HOUR));
    while (passTurnedIn().length === 0 && (await hero.board()).day <= lastDay) {
      await hero.visitTavern();
      if (passTurnedIn().length > 0) break;
      await farmHeldContracts();
      await hero.settle();
      await hero.equipBetterDrops();
      await hero.sellJunk(await hero.inventory());
    }
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
 * Phase 6 Cinderwastes step (ticket 6.1): a hero of level 28 or more at the open Ashen Pass finds
 * the Ashfall Verge closed until the Ashen Warden falls (map and farming start agree), fights the
 * Warden's Watch until it does (the boss is a gear check, so the run counts attempts, bounded),
 * then farms the Verge: tier-4 regular drops at its item levels and only its materials, from the
 * second visit (the first can finish the previous area's cycle). The boards then count the Verge
 * under the PvE Progress version in force (13 milestones from version 2, 10 before), and every
 * stored row matches its formula. Returns what a composing run (6.10's exit run) reports.
 */
export async function playCinderwastesStep(
  app: FastifyInstance,
  database: DatabaseHandle,
  hero: Journey,
  now: () => Date,
) {
  const { api, base, state } = hero;
  const vergeView = async () => (await hero.world()).areas.find((a) => a.id === 'ashfallVerge')!;
  expect(state.level).toBeGreaterThanOrEqual(getArea('ashfallVerge').unlock.level);
  const before = await vergeView();
  let watchRuns = 0;
  if (!before.unlocked) {
    expect(before.blockers).toEqual([{ kind: 'ashenWardenDefeated' }]);
    const refused = await api('POST', `${base}/activity`, { areaId: 'ashfallVerge' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe('area_locked');
    while (!state.watch.some((w) => w.bossDefeated)) {
      expect(watchRuns, 'the Warden should fall within a few runs').toBeLessThan(8);
      await hero.runDungeon('ashenWatch');
      watchRuns++;
    }
  }
  expect(await vergeView()).toEqual({ id: 'ashfallVerge', unlocked: true, blockers: [] });
  const go = await api('POST', `${base}/activity`, { areaId: 'ashfallVerge' });
  expect([200, 201]).toContain(go.statusCode);
  const area = getArea('ashfallVerge');
  const table = getLootTable(area.lootTableId);
  let kills = 0;
  let tier4 = 0;
  for (let i = 0; i < 3; i++) {
    const { summary, activity } = await hero.settle();
    expect(activity!.areaId).toBe('ashfallVerge');
    kills += summary.kills;
    if (i > 0) {
      for (const item of summary.items) {
        expect(item.itemLevel).toBeGreaterThanOrEqual(table.itemLevel!.min);
        expect(item.itemLevel).toBeLessThanOrEqual(table.itemLevel!.max);
        const b = findItemBase(item.baseId)!;
        if (!item.setId && !item.mythicId) {
          expect(b.tier, item.baseId).toBe(4);
          tier4++;
        }
      }
      for (const id of Object.keys(summary.materials ?? {})) {
        expect(area.materials as readonly string[]).toContain(id);
      }
    }
    await hero.equipBetterDrops();
    await hero.sellJunk(await hero.inventory());
  }
  expect(kills).toBeGreaterThan(0);
  expect(state.areasFarmed.has('ashfallVerge')).toBe(true);

  // The boards: PvE Progress counts the Verge under the version in force.
  const versions = await app.formulaVersions.at(now());
  const read = await api('GET', '/api/leaderboards/pveProgress');
  expect(read.statusCode).toBe(200);
  const board = read.json<{
    board: { formulaVersion: number; yours: { value: number; hero: { level: number } }[] };
  }>().board;
  expect(board.formulaVersion).toBe(versions.pveProgress);
  const mine = board.yours.find((e) => e.hero.level === state.level)!;
  expect(mine.value).toBeGreaterThanOrEqual(versions.pveProgress >= 2 ? 11 : 10);
  const report = await checkLeaderboards(cliDeps(database.db), 200, now());
  expect(report.problems.filter((p) => p.kind === 'wrong')).toEqual([]);
  return { watchRuns, kills, tier4, level: state.level, pveProgress: mine.value };
}

/**
 * Phase 6 Cinder Depths step (ticket 6.2): from a hero of level 36 that slew the Ashen Warden, in
 * good Verge gear. The Depths are open (the Verge's top milestone), farmed for a few visits (tier-4
 * drops at 35–41, existing materials); the Tyrant's Forge is fought until the Forge Tyrant falls
 * (bounded); his hoard is bound to the account and his ember is spent on Tyrantforged Work; PvE
 * Progress counts the Depths and the Tyrant under the version in force.
 */
export async function playCinderDepthsStep(
  app: FastifyInstance,
  database: DatabaseHandle,
  hero: Journey,
  now: () => Date,
) {
  const { api, base, state, keyed } = hero;
  const area = getArea('cinderDepths');
  const depthsView = async () => (await hero.world()).areas.find((a) => a.id === area.id)!;
  expect(state.level).toBeGreaterThanOrEqual(getDungeonTier('tyrantsForge', 1).unlock.level);
  expect(await depthsView()).toEqual({ id: 'cinderDepths', unlocked: true, blockers: [] });
  const go = await api('POST', `${base}/activity`, { areaId: area.id });
  expect([200, 201]).toContain(go.statusCode);
  const table = getLootTable(area.lootTableId);
  let kills = 0;
  for (let i = 0; i < 3; i++) {
    const { summary, activity } = await hero.settle();
    expect(activity!.areaId).toBe(area.id);
    kills += summary.kills;
    // The first settlement can still finish the previous area's cycle (CLAUDE.md).
    if (i > 0) {
      for (const item of summary.items) {
        expect(item.itemLevel).toBeGreaterThanOrEqual(table.itemLevel!.min);
        expect(item.itemLevel).toBeLessThanOrEqual(table.itemLevel!.max);
        if (!item.setId && !item.mythicId) expect(findItemBase(item.baseId)!.tier).toBe(4);
      }
      for (const id of Object.keys(summary.materials ?? {}))
        expect(area.materials as readonly string[]).toContain(id);
    }
    await hero.sellJunk(await hero.inventory());
  }
  expect(kills).toBeGreaterThan(0);
  await api('POST', `${base}/activity/stop`);

  // The Forge, until the Tyrant falls (bounded: balance.test.ts measures this kit's odds).
  let hoard: DungeonClaimResponse['result'] | null = null;
  while (!state.forge.some((f) => f.bossDefeated)) {
    expect(state.forge.length, 'the Tyrant should fall within a few runs').toBeLessThan(20);
    await hero.sellJunk(await hero.inventory());
    const result = await hero.runDungeon('tyrantsForge');
    if (result.bossLoot) hoard = result;
  }
  const runs = state.forge.length;
  // The first kill took the hoard unless an earlier loss had (a loss never starts the cooldown).
  expect(hoard).not.toBeNull();
  expect(hoard!.materials).toEqual({ tyrantsEmber: 1 });
  const inv = await hero.inventory();
  const fromHoard = [...inv.inventory, ...Object.values(inv.equipped)].filter(
    (i) => i && i.source === 'hoard:tyrantsForge',
  );
  for (const item of fromHoard) expect(item!.binding, item!.rarityId).toBe('account');
  const ember = async () =>
    (await api('GET', `${base}/materials`))
      .json<{
        materials: { materialId: string; quantity: number }[];
      }>()
      .materials.find((m) => m.materialId === 'tyrantsEmber')?.quantity ?? 0;
  expect(await ember()).toBe(1);

  // The ember's sink: one Tyrantforged Work (gold and ore topped up by the run's farming, or not).
  const forge = (await api('GET', `${base}/forge`)).json<ForgeResponse>();
  const recipe = forge.recipes.find((r) => r.recipeId === 'tyrantforgedWork')!;
  expect(
    recipe.blockers.some((b) => b.kind === 'material' && b.materialId === 'tyrantsEmber'),
  ).toBe(false);
  let crafted = false;
  if (recipe.blockers.length === 0) {
    const res = await keyed(`${base}/forge/craft`, { recipeId: recipe.recipeId, slot: 'chest' });
    expect(res.statusCode, res.body).toBe(200);
    expect(findItemBase(res.json<{ item: { baseId: string } }>().item.baseId)!.tier).toBe(4);
    expect(await ember()).toBe(0);
    crafted = true;
  }

  // The boards: PvE Progress counts the Depths and the Tyrant under the version in force.
  const versions = await app.formulaVersions.at(now());
  const read = await api('GET', '/api/leaderboards/pveProgress');
  const board = read.json<{
    board: { formulaVersion: number; yours: { value: number; hero: { level: number } }[] };
  }>().board;
  expect(board.formulaVersion).toBe(versions.pveProgress);
  const mine = board.yours.find((e) => e.hero.level === state.level)!;
  // Version 1 has ten milestones (all reached), 2 the Verge's three more, 3+ the Depths' four
  // (6.10: a season under way keeps version 1 until it ends).
  const least = versions.pveProgress >= 3 ? 15 : versions.pveProgress === 2 ? 13 : 10;
  expect(mine.value).toBeGreaterThanOrEqual(least);
  const report = await checkLeaderboards(cliDeps(database.db), 200, now());
  expect(report.problems.filter((p) => p.kind === 'wrong')).toEqual([]);
  return { kills, runs, crafted, level: state.level, pveProgress: mine.value };
}

/**
 * Phase 8 Hollow Reach step (ticket 8.1): from a hero of level 40 in today's best gear (the
 * Depths' Legendaries). The Pale Marches wait for the Forge Tyrant (the farming start is refused
 * until he falls); the Tyrant's Forge is fought until he does (bounded), then the Marches open and
 * are farmed for a few visits: tier-5 drops at 41–47 and only existing materials, from the second
 * visit (the first can finish the previous area's cycle). The merchant stocks the Marches in full,
 * and PvE Progress counts them under the version in force (version 5: 18 of 21 at 40 without Heroic). Returns
 * what a composing run reports.
 */
export async function playHollowReachStep(
  app: FastifyInstance,
  database: DatabaseHandle,
  hero: Journey,
  now: () => Date,
) {
  const { api, base, state } = hero;
  const area = getArea('paleMarches');
  const view = async () => (await hero.world()).areas.find((a) => a.id === area.id)!;
  expect(state.level).toBeGreaterThanOrEqual(area.unlock.level);
  const before = await view();
  if (!before.unlocked) {
    expect(before.blockers).toEqual([{ kind: 'forgeTyrantDefeated' }]);
    const refused = await api('POST', `${base}/activity`, { areaId: area.id });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe('area_locked');
    while (!state.forge.some((f) => f.bossDefeated)) {
      expect(state.forge.length, 'the Tyrant should fall within a few runs').toBeLessThan(20);
      await hero.sellJunk(await hero.inventory());
      await hero.runDungeon('tyrantsForge');
    }
  }
  expect(await view()).toEqual({ id: area.id, unlocked: true, blockers: [] });
  const go = await api('POST', `${base}/activity`, { areaId: area.id });
  expect([200, 201]).toContain(go.statusCode);
  const table = getLootTable(area.lootTableId);
  let kills = 0;
  let deaths = 0;
  let tier5 = 0;
  for (let i = 0; i < 3; i++) {
    const { summary, activity } = await hero.settle();
    expect(activity!.areaId).toBe(area.id);
    kills += summary.kills;
    deaths += summary.deaths;
    // The first settlement can still finish the previous area's cycle (CLAUDE.md).
    if (i > 0) {
      for (const item of summary.items) {
        expect(item.itemLevel).toBeGreaterThanOrEqual(table.itemLevel!.min);
        expect(item.itemLevel).toBeLessThanOrEqual(table.itemLevel!.max);
        if (!item.setId && !item.mythicId) {
          expect(findItemBase(item.baseId)!.tier, item.baseId).toBe(5);
          tier5++;
        }
      }
      for (const id of Object.keys(summary.materials ?? {}))
        expect(area.materials as readonly string[]).toContain(id);
    }
    await hero.sellJunk(await hero.inventory());
  }
  expect(kills).toBeGreaterThan(0);
  expect(state.areasFarmed.has(area.id)).toBe(true);

  // The merchant stocks the Marches in full (F.7), tier 5 at 41 or above.
  const stock = (await api('GET', `${base}/merchant`)).json<{
    offers: { areaId: string; item: { baseId: string; itemLevel: number } }[];
  }>();
  const offers = stock.offers.filter((o) => o.areaId === area.id);
  expect(offers).toHaveLength(2);
  for (const o of offers) {
    expect(findItemBase(o.item.baseId)!.tier).toBe(5);
    expect(o.item.itemLevel).toBeGreaterThanOrEqual(table.itemLevel!.min);
  }

  // The boards: PvE Progress counts the Marches under the version in force (a season under way
  // keeps the older version until it ends).
  const versions = await app.formulaVersions.at(now());
  const read = await api('GET', '/api/leaderboards/pveProgress');
  const board = read.json<{
    board: { formulaVersion: number; yours: { value: number; hero: { level: number } }[] };
  }>().board;
  expect(board.formulaVersion).toBe(versions.pveProgress);
  const mine = board.yours.find((e) => e.hero.level === state.level)!;
  expect(mine.value).toBeGreaterThanOrEqual(versions.pveProgress >= 5 ? 18 : 10);
  const report = await checkLeaderboards(cliDeps(database.db), 200, now());
  expect(report.problems.filter((p) => p.kind === 'wrong')).toEqual([]);
  return {
    kills,
    deaths,
    tier5,
    tyrantRuns: state.forge.length,
    level: state.level,
    pveProgress: mine.value,
  };
}

/**
 * Phase 8 Hollow Deep step (ticket 8.2): with the Forgeward Outpost standing (the owner's CLI) the
 * Hollow Deep waits for the lanterns of the deep: the farming start and the Throne's door are
 * refused. The hero gives its share of gold to the first stage; the owner's test-setup `stage`
 * command finishes the three stages (refused as production first); the flag opens the Deep and the
 * Throne, the era moves to the Lantern Vigil. The Deep is farmed (tier-5 drops at 47–53 from the
 * second visit), the Throne fought until the Sovereign falls (bounded: the best Marches gear wins
 * about 85 % at 48–50, `hollow-deep-balance.test.ts`), the hoard is bound and carries a crown
 * shard, which a Crownforged Work spends (at the lantern smithy's price), and PvE Progress counts it
 * all under the version in force.
 */
export async function playHollowDeepStep(
  app: FastifyInstance,
  database: DatabaseHandle,
  hero: Journey,
  now: () => Date,
) {
  const { api, base, keyed, state } = hero;
  type Board = {
    projects: {
      id: string;
      status: string;
      stageIndex: number;
      stages: { id: string; needs: { resource: string; cap: number }[] }[];
    }[];
  };
  const area = getArea('hollowDeep');
  const view = async () => (await hero.world()).areas.find((a) => a.id === area.id)!;
  const throneView = async () =>
    (await hero.world()).dungeons.find((d) => d.id === 'hollowThrone')!;
  expect(state.level).toBeGreaterThanOrEqual(getDungeonTier('hollowThrone', 1).unlock.level);
  expect((await view()).blockers).toEqual([{ kind: 'worldFlag', flag: 'deepLanternsLit' }]);
  const refused = await api('POST', `${base}/activity`, { areaId: area.id });
  expect(refused.statusCode).toBe(409);
  expect((await throneView()).unlocked).toBe(false);

  // The town lights the lanterns: the hero's share of gold, then the owner's test-setup command.
  const board = (await api('GET', '/api/community/projects')).json<Board>();
  const lanterns = board.projects.find((p) => p.id === 'deepLanterns')!;
  expect(lanterns).toMatchObject({ status: 'open', stageIndex: 0 });
  const posts = lanterns.stages[0]!;
  const heroGold = async () =>
    (await api('GET', '/api/characters'))
      .json<{ characters: { id: string; gold: number }[] }>()
      .characters.find((c) => c.id === hero.characterId)!.gold;
  const held = await heroGold();
  expect(held).toBeGreaterThanOrEqual(100);
  const offer = Math.min(held - 50, posts.needs.find((n) => n.resource === 'gold')!.cap);
  const gave = await keyed('/api/community/projects/deepLanterns/contribute', {
    characterId: hero.characterId,
    stageId: posts.id,
    offer: [{ resource: 'gold', amount: offer }],
  });
  expect(gave.statusCode, gave.body).toBe(200);
  expect(await advanceStage(database.db, 'deepLanterns', now(), { production: true })).toMatch(
    /^Refused/,
  );
  for (let i = 0; i < 3; i++)
    await advanceStage(database.db, 'deepLanterns', now(), { production: false });
  app.worldState.invalidate();
  const after = (await api('GET', '/api/world')).json<{
    flags: Record<string, boolean>;
    era: { id: string; title: string };
  }>();
  expect(after.flags.deepLanternsLit).toBe(true);
  expect(after.era).toMatchObject({ id: 'lanternVigil', title: 'Era of the Lantern Vigil' });
  expect(await view()).toEqual({ id: area.id, unlocked: true, blockers: [] });

  // The Deep, farmed for a few visits.
  const go = await api('POST', `${base}/activity`, { areaId: area.id });
  expect([200, 201]).toContain(go.statusCode);
  const table = getLootTable(area.lootTableId);
  let kills = 0;
  let deaths = 0;
  for (let i = 0; i < 3; i++) {
    const { summary, activity } = await hero.settle();
    expect(activity!.areaId).toBe(area.id);
    kills += summary.kills;
    deaths += summary.deaths;
    // The first settlement can still finish the previous area's cycle (CLAUDE.md).
    if (i > 0) {
      for (const item of summary.items) {
        expect(item.itemLevel).toBeGreaterThanOrEqual(table.itemLevel!.min);
        expect(item.itemLevel).toBeLessThanOrEqual(table.itemLevel!.max);
        if (!item.setId && !item.mythicId) expect(findItemBase(item.baseId)!.tier).toBe(5);
      }
      for (const id of Object.keys(summary.materials ?? {}))
        expect(area.materials as readonly string[]).toContain(id);
    }
    await hero.sellJunk(await hero.inventory());
  }
  expect(kills).toBeGreaterThan(0);
  await api('POST', `${base}/activity/stop`);

  // The Throne, until the Sovereign falls.
  let hoard: DungeonClaimResponse['result'] | null = null;
  while (!state.throne.some((f) => f.bossDefeated)) {
    expect(state.throne.length, 'the Sovereign should fall within a few runs').toBeLessThan(20);
    await hero.sellJunk(await hero.inventory());
    const result = await hero.runDungeon('hollowThrone');
    if (result.bossLoot) hoard = result;
  }
  expect(hoard).not.toBeNull();
  expect(hoard!.materials).toEqual({ crownShard: 1 });
  const inv = await hero.inventory();
  const fromHoard = [...inv.inventory, ...Object.values(inv.equipped)].filter(
    (i) => i && i.source === 'hoard:hollowThrone',
  );
  for (const item of fromHoard) expect(item!.binding, item!.rarityId).toBe('account');

  // The shard's sink: one Crownforged Work at the lantern smithy's price.
  const forge = (await api('GET', `${base}/forge`)).json<ForgeResponse>();
  const recipe = forge.recipes.find((r) => r.recipeId === 'crownforgedWork')!;
  expect(recipe.blockers.some((b) => b.kind === 'material' && b.materialId === 'crownShard')).toBe(
    false,
  );
  let crafted = false;
  if (recipe.blockers.length === 0) {
    const res = await keyed(`${base}/forge/craft`, { recipeId: recipe.recipeId, slot: 'ring' });
    expect(res.statusCode, res.body).toBe(200);
    crafted = true;
  }

  // The boards: PvE Progress under the version in force.
  const versions = await app.formulaVersions.at(now());
  const read = (await api('GET', '/api/leaderboards/pveProgress')).json<{
    board: { formulaVersion: number; yours: { value: number; hero: { level: number } }[] };
  }>().board;
  expect(read.formulaVersion).toBe(versions.pveProgress);
  const mine = read.yours.find((e) => e.hero.level === state.level)!;
  expect(mine.value).toBeGreaterThanOrEqual(versions.pveProgress >= 6 ? 23 : 10);
  // The town's books (the hero's own were seeded outside the audit, so only these are checked).
  const checks = await reconcileWithAudit(database.db);
  for (const c of checks.filter(
    (c) => c.check.startsWith('community:') || c.check.startsWith('world:'),
  )) {
    expect(c, c.check).toMatchObject({ ok: true });
  }
  return {
    kills,
    deaths,
    throneRuns: state.throne.length,
    crafted,
    era: after.era.id,
    pveProgress: mine.value,
  };
}

/**
 * Phase 6 world progression step (ticket 6.7): with the town's first two projects done (the
 * owner's 4.6 CLI) the world is in the Rekindling and the Forgeward Outpost opens on the board; the
 * hero farms and gives its share of gold to the slag road; the owner's test-setup `stage` command
 * finishes the three stages (refused as production first); the flag is set, the era moves to the
 * Forgeward Age, the hero's account earns the Forgeward mark, and everything reconciles.
 */
export async function playForgewardStep(
  app: FastifyInstance,
  database: DatabaseHandle,
  hero: Journey,
  now: () => Date,
) {
  type World = { flags: Record<string, boolean>; era: { id: string; title: string } };
  type Board = {
    projects: {
      id: string;
      status: string;
      stageIndex: number;
      stages: { id: string; needs: { resource: string; cap: number }[] }[];
    }[];
  };
  for (const id of ['restoreWarehouse', 'clearAshenPass'])
    await completeProject(database.db, id, now());
  // The CLI writes from outside the request path: drop the cached world state like a restart.
  app.worldState.invalidate();
  const world = async () => (await hero.api('GET', '/api/world')).json<World>();
  expect((await world()).era).toMatchObject({ id: 'rekindling', title: 'Era of the Rekindling' });
  const board = (await hero.api('GET', '/api/community/projects')).json<Board>();
  const fw = board.projects.find((p) => p.id === 'forgewardOutpost')!;
  expect(fw).toMatchObject({ status: 'open', stageIndex: 0 });
  const road = fw.stages[0]!;
  const heroGold = async () =>
    (await hero.api('GET', '/api/characters'))
      .json<{ characters: { id: string; gold: number }[] }>()
      .characters.find((c) => c.id === hero.characterId)!.gold;
  await hero.farmBestArea();
  for (let i = 0; i < 60 && (await heroGold()) < 100; i++) {
    await hero.settle();
    await hero.sellJunk(await hero.inventory());
    await hero.farmBestArea();
  }
  const held = await heroGold();
  expect(held).toBeGreaterThanOrEqual(100);
  const offer = Math.min(held, road.needs.find((n) => n.resource === 'gold')!.cap);
  const gave = await hero.keyed('/api/community/projects/forgewardOutpost/contribute', {
    characterId: hero.characterId,
    stageId: road.id,
    offer: [{ resource: 'gold', amount: offer }],
  });
  expect(gave.statusCode, gave.body).toBe(200);
  expect(await heroGold()).toBe(held - offer);
  expect(await advanceStage(database.db, 'forgewardOutpost', now(), { production: true })).toMatch(
    /^Refused/,
  );
  for (let i = 0; i < 3; i++)
    await advanceStage(database.db, 'forgewardOutpost', now(), { production: false });
  app.worldState.invalidate();
  const after = await world();
  expect(after.flags.forgewardRaised).toBe(true);
  expect(after.era).toMatchObject({ id: 'forgewardAge', title: 'Era of the Forgeward Age' });
  const marks = (await hero.api('GET', '/api/community/projects'))
    .json<{ projects: { id: string; status: string; reward: { earned: boolean } }[] }>()
    .projects.find((p) => p.id === 'forgewardOutpost')!;
  expect(marks).toMatchObject({ status: 'complete', reward: { earned: true } });
  await expectHoldingsMatchAudit(database, hero.characterId);
  const checks = await reconcileWithAudit(database.db);
  for (const c of checks.filter(
    (c) => c.check.startsWith('community:') || c.check.startsWith('world:'),
  )) {
    expect(c, c.check).toMatchObject({ ok: true });
  }
  return { gave: offer, era: after.era.id };
}

/**
 * Phase 6 Heroic step (ticket 6.3): the Tavern announces this week's boss modifier, the crypt's
 * door shows it and opens its Heroic tier (level 32 and tier III cleared); the hero runs Heroic
 * until the Gravewarden falls, each run fighting the modifier of the week it started in (the last
 * one starts a millisecond before Monday and ends after it), the hoard stays within today's item
 * levels and is bound, the clear sets "Heroic cleared", and PvE Progress counts it under the
 * version in force.
 */
export async function playHeroicStep(
  app: FastifyInstance,
  database: DatabaseHandle,
  hero: Journey,
  clock: Clock,
  now: () => Date,
) {
  const { api, base, state } = hero;
  const heroic = getDungeonTier('namelessCrypt', 4);
  expect(state.level).toBeGreaterThanOrEqual(heroic.unlock.level);
  // The Tavern's notice and the crypt door agree with the week's modifier.
  const notice = (await api('GET', '/api/world/boss-modifier')).json<BossModifierResponse>();
  expect(notice.modifier.id).toBe(bossModifierOfWeek(now().getTime()).id);
  expect(notice.modifier.effect.length).toBeGreaterThan(20);
  const door = (await api('GET', `${base}/dungeon`)).json<DungeonStateResponse>();
  expect(door.bossModifier.modifier.id).toBe(notice.modifier.id);
  const crypt = door.dungeons.find((d) => d.id === 'namelessCrypt')!;
  expect(crypt.tiers[3]).toMatchObject({ tier: 4, name: 'Heroic', heroic: true, unlocked: true });

  const table = getLootTable(heroic.lootTableId);
  const boss = getLootTable(heroic.bossLoot.lootTableId);
  const top = Math.max(table.itemLevel!.max, boss.itemLevel!.max);
  const modifiers: string[] = [];
  let hoard: DungeonClaimResponse['result'] | null = null;
  let crossed = false;
  const heroicRuns = () => state.crypt.filter((r) => r.tier === 4);
  while (!heroicRuns().some((r) => r.bossDefeated) || !crossed) {
    expect(heroicRuns().length, 'Heroic should fall within a few runs').toBeLessThan(20);
    await hero.sellJunk(await hero.inventory());
    // Once the boss has fallen, one more run across Monday 00:00 (the window rule).
    if (heroicRuns().some((r) => r.bossDefeated)) {
      clock.set(guildBossWeek(clock.now()).endMs - 1);
      crossed = true;
    }
    const startedAt = clock.now();
    const result = await hero.runDungeon('namelessCrypt', 4);
    expect(result.bossModifier).toBe(bossModifierOfWeek(startedAt).id);
    modifiers.push(result.bossModifier!);
    if (result.bossLoot) hoard = result;
    for (const item of result.items) expect(item.itemLevel).toBeLessThanOrEqual(top);
  }
  // The crossing run ended in the next week, with the week it started in.
  expect(guildBossWeek(clock.now()).key).not.toBe(guildBossWeek(clock.now() - 2 * HOUR).key);
  expect(hoard).not.toBeNull();
  const inv = await hero.inventory();
  for (const item of [...inv.inventory, ...Object.values(inv.equipped)])
    if (item && item.source === 'hoard:namelessCrypt') expect(item.binding).toBe('account');
  const [row] = await database.db
    .select({ progress: characters.progress })
    .from(characters)
    .where(eq(characters.id, hero.characterId));
  expect(row!.progress.cryptTierCleared).toBe(4);

  const versions = await app.formulaVersions.at(now());
  const read = await api('GET', '/api/leaderboards/pveProgress');
  const board = read.json<{
    board: { formulaVersion: number; yours: { value: number; hero: { level: number } }[] };
  }>().board;
  expect(board.formulaVersion).toBe(versions.pveProgress);
  const mine = board.yours.find((e) => e.hero.level === state.level)!;
  const report = await checkLeaderboards(cliDeps(database.db), 200, now());
  expect(report.problems.filter((p) => p.kind === 'wrong')).toEqual([]);
  return { runs: heroicRuns().length, modifiers, pveProgress: mine.value, level: state.level };
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
    // Ticket 6.7: the third project opens once the Pass is clear.
    ['forgewardOutpost', 'open'],
    // Ticket 8.2: the lanterns wait for the Forgeward.
    ['deepLanterns', 'locked'],
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
 * Phase 6 event step (ticket 6.6, docs/EVENTS.md): the owner schedules the Harvest of Bones in the
 * admin panel; the hero sees the banner, joins in the Tavern, farms the risen dead of the Fields
 * until the first task is done and the reward track's first tier (a banner style) is granted, once.
 * The owner ends the event early: unfinished tasks lapse, nothing earned is lost, later farming
 * changes nothing, the close runs once, and the audit log and telemetry reconcile.
 */
export async function playEventStep(
  app: FastifyInstance,
  database: DatabaseHandle,
  hero: Journey,
  clock: Clock,
  cast: StepCast & { ownerEmail?: string } = {},
) {
  type HeroEvent = {
    current: { number: number; name: string } | null;
    hero: {
      quests: { id: string; progress: number; done: boolean }[];
      bonus: Record<string, number>;
    } | null;
    track: { tallies: number; granted: { tier: number; cosmeticId: string }[] } | null;
  };
  const ownerEmail = cast.ownerEmail ?? 'harvest-keeper@graumark.test';
  const owner = await newPlayer(app, ownerEmail, 'Harvest Keeper', cast.invite);
  expect(await setAccountRole(database.db, ownerEmail, 'admin')).toMatchObject({ to: 'admin' });
  const startsAt = new Date(clock.now()).toISOString();
  const endsAt = new Date(clock.now() + 2 * 24 * HOUR).toISOString();
  const planned = await owner.api('POST', '/api/admin/events', {
    definitionId: 'harvestOfBones',
    startsAt,
    endsAt,
  });
  expect(planned.statusCode, planned.body).toBe(200);
  const number = planned.json<{ current: { number: number } }>().current.number;

  // The banner and the Tavern notice; the hero joins (settled first).
  const banner = (await hero.api('GET', '/api/events')).json<{
    current: { name: string } | null;
  }>();
  expect(banner.current?.name).toBe('Harvest of Bones');
  const event = () =>
    hero.api('GET', `${hero.base}/event`).then((r) => {
      expect(r.statusCode, r.body).toBe(200);
      return r.json<HeroEvent>();
    });
  expect((await event()).hero).toBeNull();
  const joined = await hero.api('POST', `${hero.base}/event/join`);
  expect(joined.statusCode, joined.body).toBe(201);

  // Farm the Fields until the first task is done (60 of the risen dead).
  const start = await hero.api('POST', `${hero.base}/activity`, { areaId: 'abandonedFields' });
  expect([200, 201]).toContain(start.statusCode);
  let mine = await event();
  for (let i = 0; i < 20 && !mine.hero?.quests[0]?.done; i++) {
    await hero.settle();
    mine = await event();
  }
  expect(mine.hero?.quests[0]?.done, 'Turn the Furrows done').toBe(true);
  expect(mine.track?.tallies).toBeGreaterThanOrEqual(10);
  expect(mine.track?.granted).toContainEqual(
    expect.objectContaining({ tier: 1, cosmeticId: 'banner.harvest-sheaf' }),
  );
  const cosmetics = (await hero.api('GET', '/api/account/cosmetics')).json<{
    unlocks: { id: string; shownToday: boolean; source: string }[];
  }>().unlocks;
  // Ticket 6.8: shown in the collection book since it opened.
  expect(cosmetics).toContainEqual(
    expect.objectContaining({ id: 'banner.harvest-sheaf', shownToday: true }),
  );

  // The owner ends it early; unfinished tasks lapse, nothing earned is lost.
  const ended = await owner.api('POST', `/api/admin/events/${number}/end`, {});
  expect(ended.statusCode, ended.body).toBe(200);
  const after = await event();
  expect(after.current).toBeNull();
  await hero.settle();
  const [row] = await database.db
    .select()
    .from(eventParticipants)
    .where(
      and(eq(eventParticipants.event, number), eq(eventParticipants.characterId, hero.characterId)),
    );
  expect(row!.progress).toEqual(mine.hero!.quests.map((q) => q.progress));
  clock.set(clock.now() + 10 * MIN);
  expect((await runEventJobs(database.db, new Date(clock.now()))).closed).toEqual([number]);
  expect((await runEventJobs(database.db, new Date(clock.now()))).closed).toEqual([]);
  const again = (await hero.api('GET', '/api/account/cosmetics')).json<{
    unlocks: { id: string; source: string }[];
  }>().unlocks;
  // The event's keepsakes are unchanged after its end. Ticket 6.8: the farming after it may earn
  // other cosmetics (a deed such as a Legendary find), so only event-sourced ones are compared.
  const fromEvent = (list: { id: string; source?: string }[]) =>
    list.filter((u) => u.source?.startsWith('event:')).map((u) => u.id);
  expect(fromEvent(again)).toEqual(fromEvent(cosmetics));
  const bad = (await reconcileWithAudit(database.db)).filter((c) => !c.ok);
  expect(bad).toEqual([]);
  return { event: number, tallies: mine.track!.tallies, bonus: mine.hero!.bonus };
}

/**
 * Ticket 8.3's calendar step (docs/EVENTS.md "The calendar"): the owner finds the calendar paused,
 * sets the rotation (the Lantern Procession, then the Harvest) and a two-day gap in the admin
 * panel and turns it on; the scheduler's step puts the Procession on the calendar at the next full
 * hour (or the gap after the last event, if later), once. The hero joins, farms the Fields until the first week's gathering task is done (the
 * first keepsake granted once, the lantern-frame ore with it); week 2 opens on its boundary. The
 * owner ends the Procession early; once it closes, the calendar puts the Harvest on, two days
 * after the end. The owner pauses the calendar again. Audit and telemetry reconcile.
 */
export async function playCalendarStep(
  app: FastifyInstance,
  database: DatabaseHandle,
  hero: Journey,
  clock: Clock,
  cast: StepCast & { ownerEmail?: string } = {},
) {
  type Calendar = {
    calendar: { paused: boolean; planned: { definitionId: string; kind: string }[] };
    current: { number: number; definitionId: string; source: string } | null;
    next: { number: number; definitionId: string; source: string; startsAt: string } | null;
  };
  type HeroEvent = {
    current: { number: number; name: string; week: number; weeks: number } | null;
    hero: {
      quests: { id: string; done: boolean; open: boolean }[];
      bonus: Record<string, number>;
    } | null;
    track: { tallies: number; granted: { tier: number; cosmeticId: string }[] } | null;
  };
  const ownerEmail = cast.ownerEmail ?? 'lantern-keeper@graumark.test';
  const owner = await newPlayer(app, ownerEmail, 'Lantern Keeper', cast.invite);
  expect(await setAccountRole(database.db, ownerEmail, 'admin')).toMatchObject({ to: 'admin' });
  const admin = async (method: 'GET' | 'POST', url: string, body?: object) => {
    const res = await owner.api(method, url, body);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Calendar>();
  };
  // Paused until the owner turns it on (also in production).
  expect((await admin('GET', '/api/admin/events')).calendar.paused).toBe(true);
  await admin('POST', '/api/admin/events/calendar', {
    rotation: [
      { definitionId: 'lanternProcession', days: 28 },
      { definitionId: 'harvestOfBones', days: 7 },
    ],
    gapDays: 2,
  });
  const on = await admin('POST', '/api/admin/events/calendar', { paused: false });
  expect(on.calendar.planned[0]?.definitionId).toBe('lanternProcession');

  // The scheduler's step (the leader's `eventJobs`) creates it once.
  const tick = () => runEventJobs(database.db, new Date(clock.now()));
  const made = await tick();
  expect(made.created).not.toBeNull();
  expect((await tick()).created).toBeNull();
  const planned = await admin('GET', '/api/admin/events');
  expect(planned.next).toMatchObject({ definitionId: 'lanternProcession', source: 'calendar' });
  const number = planned.next!.number;
  const startsAt = Date.parse(planned.next!.startsAt);
  // Never in the past: the gap after the last event's end, or the next full hour.
  expect(startsAt).toBeGreaterThanOrEqual(clock.now());
  // The hero rests until then (no settlement spans the offline cap).
  await hero.api('POST', `${hero.base}/activity/stop`);
  clock.set(startsAt);

  const event = () =>
    hero.api('GET', `${hero.base}/event`).then((r) => {
      expect(r.statusCode, r.body).toBe(200);
      return r.json<HeroEvent>();
    });
  expect((await event()).current).toMatchObject({ number, week: 1, weeks: 4 });
  const joined = await hero.api('POST', `${hero.base}/event/join`);
  expect(joined.statusCode, joined.body).toBe(201);
  const start = await hero.api('POST', `${hero.base}/activity`, { areaId: 'abandonedFields' });
  expect(start.statusCode, start.body).toBe(201);
  const wick = 1; // "Wick and Frame": 150 Timber, Ashwort, Raw Hide or Iron Ore.
  let mine = await event();
  for (let i = 0; i < 20 && !mine.hero?.quests[wick]?.done; i++) {
    await hero.settle();
    mine = await event();
  }
  expect(mine.hero?.quests[wick]?.done, 'Wick and Frame done').toBe(true);
  expect(mine.track?.granted).toContainEqual(
    expect.objectContaining({ tier: 1, cosmeticId: 'title-colour.wick-amber' }),
  );
  // The lantern-frame ore: one per 25 gathered (≥ 150 gathered with the bonus: at least 5).
  expect(mine.hero!.bonus.ironOre ?? 0).toBeGreaterThanOrEqual(5);
  // Week 2's tasks are shut until its first moment (1 ms before it, too), then open.
  expect(mine.hero!.quests.slice(3, 5).map((q) => q.open)).toEqual([false, false]);
  await hero.api('POST', `${hero.base}/activity/stop`);
  clock.set(startsAt + 7 * 24 * HOUR - 1);
  expect((await event()).hero!.quests.slice(3, 5).map((q) => q.open)).toEqual([false, false]);
  clock.set(startsAt + 7 * 24 * HOUR);
  const week2 = await event();
  expect(week2.current?.week).toBe(2);
  expect(week2.hero!.quests.slice(3, 5).map((q) => q.open)).toEqual([true, true]);

  // The owner ends it early; once it closes the calendar puts the next one on, the gap after.
  const endAt = clock.now();
  await admin('POST', `/api/admin/events/${number}/end`, {});
  clock.set(endAt + 10 * MIN);
  const closed = await tick();
  expect(closed.closed).toEqual([number]);
  expect(closed.created).not.toBeNull();
  const after = await admin('GET', '/api/admin/events');
  expect(after.next).toMatchObject({ definitionId: 'harvestOfBones', source: 'calendar' });
  // Ended at `endAt`: the gap (two days) after it.
  expect(Date.parse(after.next!.startsAt)).toBe(endAt + 2 * 24 * HOUR);
  // Nothing earned is lost; the keepsake stays.
  const unlocks = (await hero.api('GET', '/api/account/cosmetics')).json<{
    unlocks: { id: string }[];
  }>().unlocks;
  expect(unlocks.map((u) => u.id)).toContain('title-colour.wick-amber');
  expect(
    (await admin('POST', '/api/admin/events/calendar', { paused: true })).calendar.paused,
  ).toBe(true);
  const bad = (await reconcileWithAudit(database.db)).filter((c) => !c.ok);
  expect(bad).toEqual([]);
  return { event: number, next: after.next!.number, tallies: mine.track!.tallies };
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

interface TradeEligibilityBody {
  trading: { open: boolean };
  you: { eligible: boolean; requirements: { id: string; met: boolean; metAt?: string }[] };
  with: {
    relation: string;
    allowed: boolean;
    reasons: { party: string; check: string; metAt?: string }[];
  } | null;
}

/**
 * Ticket T.4: trade eligibility after real play. While trading is closed the hero sees where
 * they stand (a new account, no level-15 hero, an unverified email), verifies the email through
 * the captured mail, makes a friend and asks whether they could trade with them: closed, the
 * friendship too new, their own rules, and nothing about the friend until the friendship is a
 * week old, then only one bit. A moderator restricts the hero's trading from a report and lifts
 * it; social writes keep working throughout. Reading eligibility writes no audit row.
 */
export async function playTradeEligibilityStep(
  app: FastifyInstance,
  database: DatabaseHandle,
  mailer: MemoryMailer,
  clock: Clock,
  hero: Journey,
  email: string,
) {
  const reasonsOf = (b: TradeEligibilityBody) =>
    b.with!.reasons.map((r) => `${r.party}:${r.check}`);
  const mine = async (handle?: string) => {
    const res = await hero.api(
      'GET',
      `/api/trading/eligibility${handle ? `?handle=${encodeURIComponent(handle)}` : ''}`,
    );
    expect(res.statusCode, res.body).toBe(200);
    return res.json<TradeEligibilityBody>();
  };
  const met = (b: TradeEligibilityBody) =>
    Object.fromEntries(b.you.requirements.map((r) => [r.id, r.met]));

  // 1. A fresh account: trading closed, not eligible, every reason listed.
  const first = await mine();
  expect(first.trading.open).toBe(false);
  expect(met(first)).toEqual({ accountAge: false, heroLevel: false, email: false, standing: true });

  // 2. The verification letter from registration.
  const verifyMail = mailer.last(email, 'verify_email');
  expect(verifyMail, 'a verification mail on registration').toBeDefined();
  const verified = await app.inject({
    remoteAddress: nextAddress(),
    method: 'POST',
    url: '/api/auth/verify-email',
    payload: { token: tokenIn(verifyMail!) },
  });
  expect(verified.statusCode, verified.body).toBe(200);
  expect(met(await mine()).email).toBe(true);

  // 3. A friend; asking about them says nothing about their standing yet.
  const friend = await newPlayer(app, 'trader-friend@graumark.test', 'Merel of the Fens');
  const { account: me } = (await hero.api('GET', '/api/account')).json<{
    account: { handle: string };
  }>();
  expect(
    (await hero.api('POST', '/api/friends/requests', { handle: friend.account.handle })).statusCode,
  ).toBe(200);
  expect((await friend.api('POST', `/api/friends/requests/${me.handle}/accept`)).statusCode).toBe(
    200,
  );
  const auditBefore = await database.db.select({ n: sql<number>`count(*)::int` }).from(auditLog);
  const fresh = await mine(friend.account.handle);
  expect(fresh.with!.relation).toBe('friend');
  expect(reasonsOf(fresh)).toEqual([
    'game:trading_off',
    'pair:relation_too_new',
    'you:account_too_new',
    'you:hero_too_low',
  ]);

  // 4. A week and more later (the account is 14 days old too): the friend is told as one bit.
  const waitUntil = Math.max(
    ...[...fresh.with!.reasons.map((r) => r.metAt), ...first.you.requirements.map((r) => r.metAt)]
      .filter((x): x is string => Boolean(x))
      .map((x) => Date.parse(x)),
  );
  clock.set(Math.max(clock.now(), waitUntil) + 1_000);
  const later = await mine(friend.account.handle);
  expect(reasonsOf(later)).toEqual([
    'game:trading_off',
    'you:hero_too_low',
    'them:them_not_eligible',
  ]);
  const auditAfter = await database.db.select({ n: sql<number>`count(*)::int` }).from(auditLog);
  expect(auditAfter[0]!.n, 'reading eligibility writes no audit row').toBe(auditBefore[0]!.n);

  // 5. A moderator restricts the hero's trading from a report, then lifts it.
  const warden = await newPlayer(app, 'trade-warden@graumark.test', 'Warden Osk');
  await setAccountRole(database.db, 'trade-warden@graumark.test', 'moderator');
  const filed = await friend.api('POST', '/api/reports', {
    target: { kind: 'player', handle: me.handle },
    reason: 'other',
    note: 'Asked me for gold outside the game.',
  });
  expect(filed.statusCode, filed.body).toBe(201);
  const reportId = filed.json<{ report: { id: string } }>().report.id;
  const restricted = await warden.api('POST', `/api/mod/reports/${reportId}/resolve`, {
    action: 'restrictTrade',
    reason: 'Trading for real money is not allowed.',
    durationHours: 7 * 24,
  });
  expect(restricted.statusCode, restricted.body).toBe(200);
  const sanction = restricted.json<{ sanction: { id: string; kind: string } }>().sanction;
  expect(sanction.kind).toBe('trade');
  expect(met(await mine()).standing).toBe(false);
  // Only trading: social writes and play go on.
  expect((await hero.api('POST', '/api/account/presence', { hidden: false })).statusCode).toBe(200);
  expect((await hero.api('GET', '/api/characters')).statusCode).toBe(200);
  const lifted = await warden.api('POST', `/api/mod/sanctions/${sanction.id}/lift`, {
    reason: 'Settled after a talk.',
  });
  expect(lifted.statusCode, lifted.body).toBe(200);
  expect(met(await mine()).standing).toBe(true);
}

/**
 * Ticket T.5: two players trade (the switches are turned on by the test, as the owner would in
 * the admin panel). Both are made eligible the quick way (a shortcut, like B.3's guild members:
 * levels and verified emails written directly; the clock moves past the 14-day account age and the
 * 7-day friendship). The hero offers gold and materials it farmed; the friend accepts; everything
 * received is held for 72 hours (it can't be sent on), then released exactly once. A second offer
 * is declined and a third cancelled: escrow comes back. Both heroes' holdings equal a replay of
 * the audit log, and the rollups reconcile.
 */
export async function playTradeStep(
  app: FastifyInstance,
  database: DatabaseHandle,
  clock: Clock,
  hero: Journey,
  friend: Journey,
) {
  const DAY = 86_400_000;
  const meOf = async (j: Journey) =>
    (await j.api('GET', '/api/account')).json<{ account: { id: string; handle: string } }>()
      .account;
  const [me, them] = [await meOf(hero), await meOf(friend)];
  // Eligibility, the quick way: a level-15 hero and a verified email for both.
  for (const [j, a] of [
    [hero, me],
    [friend, them],
  ] as const) {
    await database.db.update(characters).set({ level: 15 }).where(eq(characters.id, j.characterId));
    await database.db
      .update(accounts)
      .set({ emailVerifiedAt: new Date(clock.now()) })
      .where(eq(accounts.id, a.id));
  }
  expect(
    (await hero.api('POST', '/api/friends/requests', { handle: them.handle })).statusCode,
  ).toBe(200);
  expect((await friend.api('POST', `/api/friends/requests/${me.handle}/accept`)).statusCode).toBe(
    200,
  );
  clock.set(clock.now() + 15 * DAY);

  // Closed until the owner opens it.
  const closed = (await hero.api('GET', '/api/trading/offers')).json<{ open: boolean }>();
  expect(closed.open).toBe(false);
  const open = {
    ...structuredClone(DEFAULT_TRADING_SETTINGS),
    trading: true,
    trade: { items: true, materials: true, gold: true },
  };
  await database.db
    .insert(gameSettings)
    .values({ key: 'trading', value: open as never, version: 1, updatedAt: new Date(clock.now()) })
    .onConflictDoUpdate({ target: gameSettings.key, set: { value: open as never } });
  app.gameSettings.invalidate();

  // What the hero can give: some of its gold and of its most plentiful material.
  const mine = await holdingsOf(hero);
  const gold = Math.min(500, mine.gold);
  const [material, stock] = Object.entries(mine.mats).sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  const units = material && material !== 'gravewardenSeal' ? Math.min(10, stock) : 0;
  const give = {
    ...(gold > 0 ? { gold } : {}),
    ...(units > 0 ? { materials: { [material!]: units } } : {}),
  };
  if (gold === 0 && units === 0) return; // nothing farmed to give (never with the journey's farming)
  const sent = await hero.keyed('/api/trading/offers', {
    to: them.handle,
    characterId: hero.characterId,
    give,
  });
  expect(sent.statusCode, sent.body).toBe(201);
  const offer = sent.json<{ id: string; gift: boolean }>();
  expect(offer.gift).toBe(true);
  const inbox = (await friend.api('GET', '/api/trading/offers')).json<{
    received: { id: string }[];
  }>();
  expect(inbox.received.map((o) => o.id)).toContain(offer.id);
  const accepted = await friend.keyed(`/api/trading/offers/${offer.id}/accept`, {
    characterId: friend.characterId,
  });
  expect(accepted.statusCode, accepted.body).toBe(200);
  // The accept settled the friend's farming first; what arrived is exactly the gift.
  const got = accepted.json<{ give: { gold: number }; heldUntil: string }>();
  expect(got.give.gold).toBe(gold);
  expect(Date.parse(got.heldUntil)).toBe(clock.now() + 72 * 3_600_000);
  const after = await holdingsOf(friend);

  // Held: the friend can't send on more than its own (unheld) gold.
  const spendable = after.gold - gold;
  if (gold > 0 && spendable + 1 <= 5_000) {
    const onward = await friend.keyed('/api/trading/offers', {
      to: me.handle,
      characterId: friend.characterId,
      give: { gold: spendable + 1 },
    });
    expect(onward.statusCode, onward.body).toBe(422);
    expect(onward.json<{ error: { details: { onHold: number } } }>().error.details.onHold).toBe(
      gold,
    );
  }

  // A second offer declined, a third cancelled: escrow back each time.
  const second = await hero.keyed('/api/trading/offers', {
    to: them.handle,
    characterId: hero.characterId,
    give,
  });
  if (second.statusCode === 201) {
    const id = second.json<{ id: string }>().id;
    expect((await friend.keyed(`/api/trading/offers/${id}/decline`, {})).statusCode).toBe(200);
  }
  const third = await hero.keyed('/api/trading/offers', {
    to: them.handle,
    characterId: hero.characterId,
    give,
  });
  if (third.statusCode === 201) {
    const id = third.json<{ id: string }>().id;
    expect((await hero.keyed(`/api/trading/offers/${id}/cancel`, {})).statusCode).toBe(200);
  }

  // 72 hours on: the hold is released once, however often the inbox is read.
  clock.set(clock.now() + 72 * 3_600_000);
  await friend.api('GET', '/api/trading/offers');
  await friend.api('GET', '/api/trading/offers');
  const releases = await database.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.event, 'trade.release'), eq(auditLog.accountId, them.id)));
  expect(releases).toHaveLength(1);
  const holds = (await friend.api('GET', '/api/trading/offers')).json<{ holds: unknown[] }>().holds;
  expect(holds).toEqual([]);

  await expectHoldingsMatchAudit(database, hero.characterId);
  await expectHoldingsMatchAudit(database, friend.characterId);
  const checks = await reconcileWithAudit(database.db);
  expect(checks.filter((c) => !c.ok)).toEqual([]);

  await playTradeModerationStep(app, database, offer.id, hero, friend);
  // Back to closed, as the owner leaves it by default.
  await database.db.delete(gameSettings).where(eq(gameSettings.key, 'trading'));
  app.gameSettings.invalidate();
}

/** An offer as both players read it (`GET /api/trading/offers`, the history). */
interface OfferView {
  id: string;
  status: string;
  gift: boolean;
  endText: string | null;
  heldUntil: string | null;
}

/**
 * Ticket T.7 (trading hardening): three players trade under every switch the owner controls, and
 * nothing is created or lost on the way. A and B are friends, B and C are friends; all three are
 * made eligible the quick way (`playTradeStep`'s shortcut: a level-15 hero and a verified email
 * written directly; the clock moves past the 14-day account age and the 7-day friendships). The
 * owner opens trading through the admin route. In order:
 * 1. a gold↔material swap (B → C), a gold and material gift (A → B) and an item swap (A ↔ B; one
 *    farmed pack item of each is made a fresh Epic in place, so the item count of the audit replay
 *    is unchanged and its provenance is the drop's own `activity.reward` row);
 * 2. the hold: a held item can't be sold or shelved (`409 item_held`), held gold can't be shelved
 *    or sent on (`422 insufficient_gold` with what is held);
 * 3. C reports the swap, a moderator finds it in the queue and reverses it within the hold;
 * 4. the owner pauses "Trade: gold": A's open gold offer is voided, the gold back, a `trade.void`
 *    row, and both players read the same withdrawn line;
 * 5. B reports C, a moderator restricts C's trading from the queue: C's open offer is voided, C's
 *    next send is refused (`trade_restricted`), C's shelf still works;
 * 6. 72 hours on, the holds are released and the same spends go through; B's received item and
 *    gold cross the shelf to a second hero of B's account.
 * Every hero's holdings and every shelf equal a replay of the audit log, the rollups reconcile
 * and the trade telemetry counts what the audit rows say. The switches go back to the defaults.
 *
 * Ticket 5.8 (`played`): the Phase 5 exit run's players earned eligibility by playing (level 15
 * farmed, the email verified through the mailed link), so nothing is written directly: the step
 * checks each is eligible through the API, and the traded items are farmed Epics (or better) in
 * the pack, tradeable under the switches, instead of pack items made Epic in place. `owner` and
 * `warden` are the run's admin and moderator (roles from the CLI).
 */
export interface TradingStepOptions {
  played?: boolean;
  owner?: Player;
  warden?: Player;
}

export async function playTradingHardeningStep(
  app: FastifyInstance,
  database: DatabaseHandle,
  clock: Clock,
  a: Journey,
  b: Journey,
  c: Journey,
  options: TradingStepOptions = {},
) {
  const DAY = 86_400_000;
  const heroes = [a, b, c];
  const err = (r: LightMyRequestResponse) =>
    r.json<{ error: { code: string; details?: Record<string, unknown> } }>().error;
  const meOf = async (j: Journey) =>
    (await j.api('GET', '/api/account')).json<{ account: { id: string; handle: string } }>()
      .account;
  const [ma, mb, mc] = [await meOf(a), await meOf(b), await meOf(c)];
  /** Settles at the current clock (catches up after a jump; a second call adds nothing). */
  const settleNow = async (j: Journey) => {
    const res = await j.api('POST', `${j.base}/activity/settle`);
    expect(res.statusCode, res.body).toBe(200);
  };
  const minutes = async (n: number) => {
    clock.set(clock.now() + n * MIN);
    for (const j of heroes) await settleNow(j);
  };
  const historyOf = async (j: Journey) =>
    (await j.api('GET', '/api/trading/offers/history')).json<{
      offers: (OfferView & { reversal: { reason: string } | null })[];
    }>().offers;
  const inboxOf = async (j: Journey) =>
    (await j.api('GET', '/api/trading/offers')).json<{
      open: boolean;
      received: OfferView[];
      sent: OfferView[];
      holds: unknown[];
    }>();
  const auditOf = async (event: string, offerId?: string) =>
    database.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.event, event),
          offerId ? sql`${auditLog.data}->>'offerId' = ${offerId}` : undefined,
        ),
      );
  const tradeableMaterial = (mats: Record<string, number>, min: number) =>
    Object.entries(mats)
      .filter(([id, n]) => id !== 'gravewardenSeal' && n >= min)
      .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]?.[0];
  const packItem = async (j: Journey) => (await j.inventory()).inventory.find((it) => !it.locked);

  // Eligibility, the quick way (unless the players earned it), and two friendships (A–B, C–B) a
  // week and more old.
  for (const [j, m] of options.played
    ? []
    : ([
        [a, ma],
        [b, mb],
        [c, mc],
      ] as const)) {
    await database.db.update(characters).set({ level: 15 }).where(eq(characters.id, j.characterId));
    await database.db
      .update(accounts)
      .set({ emailVerifiedAt: new Date(clock.now()) })
      .where(eq(accounts.id, m.id));
  }
  for (const [from, fromMe] of [
    [a, ma],
    [c, mc],
  ] as const) {
    expect(
      (await from.api('POST', '/api/friends/requests', { handle: mb.handle })).statusCode,
    ).toBe(200);
    expect((await b.api('POST', `/api/friends/requests/${fromMe.handle}/accept`)).statusCode).toBe(
      200,
    );
  }
  clock.set(clock.now() + 15 * DAY);
  for (const j of heroes) await settleNow(j);
  if (options.played) {
    for (const j of heroes) {
      const seen = (await j.api('GET', '/api/trading/eligibility')).json<{
        you: { eligible: boolean; requirements: { id: string; met: boolean }[] };
      }>().you;
      expect(
        seen.requirements.filter((r) => !r.met && r.id !== 'trading_open'),
        'earned by playing',
      ).toEqual([]);
    }
  }

  // Something to trade: farm on one clock until A has gold, a stack and a pack item, B gold and a
  // pack item, C a stack (bounded; the farming rolls decide how long it takes, not whether).
  const ready = async () => {
    const [ha, hb, hc] = [await holdingsOf(a), await holdingsOf(b), await holdingsOf(c)];
    return (
      ha.gold >= 20 &&
      tradeableMaterial(ha.mats, 2) !== undefined &&
      (await packItem(a)) !== undefined &&
      hb.gold >= 10 &&
      (await packItem(b)) !== undefined &&
      tradeableMaterial(hc.mats, 3) !== undefined
    );
  };
  for (let i = 0; i < 80 && !(await ready()); i++) {
    clock.set(clock.now() + STEP);
    for (const j of heroes) {
      await j.settle({ advance: false });
      await j.farmBestArea();
    }
  }
  expect(await ready(), 'farming gave each player something to trade').toBe(true);

  // The owner (an admin) opens trading and the shelf through the admin route; the Warehouse
  // (the shelf's building) is restored.
  const owner =
    options.owner ?? (await newPlayer(app, 'hardening-owner@graumark.test', 'Owner Thessaly'));
  if (!options.owner) await setAccountRole(database.db, 'hardening-owner@graumark.test', 'admin');
  type Settings = typeof DEFAULT_TRADING_SETTINGS;
  const saveTrading = async (change: (s: Settings) => Settings) => {
    const current = (await owner.api('GET', '/api/mod/settings/trading')).json<{
      settings: Settings;
      version: number;
    }>();
    const put = await owner.api(
      'PUT',
      '/api/admin/settings/trading',
      { expectedVersion: current.version, settings: change(structuredClone(current.settings)) },
      { 'idempotency-key': randomUUID() },
    );
    expect(put.statusCode, put.body).toBe(200);
  };
  expect((await inboxOf(a)).open).toBe(false);
  await saveTrading((s) => ({
    ...s,
    trading: true,
    trade: { items: true, materials: true, gold: true },
    shelf: { items: true, materials: true, gold: true },
  }));
  expect(await completeProject(database.db, 'restoreWarehouse', new Date(clock.now()))).toContain(
    'completed',
  );
  app.worldState.invalidate();
  const warden =
    options.warden ?? (await newPlayer(app, 'hardening-warden@graumark.test', 'Warden Corvin'));
  if (!options.warden) {
    await setAccountRole(database.db, 'hardening-warden@graumark.test', 'moderator');
  }

  // One farmed pack item each of A and B becomes a fresh, tradeable Epic in place (the row and
  // its drop's audit row stay; `insertTradeItem`'s shape), so the item swap doesn't hang on a drop.
  const freshEpic = async (j: Journey) => {
    const it = (await packItem(j))!;
    await database.db
      .update(itemInstances)
      .set({
        baseId: 'longsword',
        rarityId: 'epic',
        itemLevel: 20,
        affixes: [],
        variant: null,
        effectId: null,
        effectRoll: null,
        setId: null,
        mythicId: null,
        source: 'farming',
        binding: 'equip',
        boundAccountId: null,
        unprovenanced: false,
        upgradeLevel: 0,
      })
      .where(eq(itemInstances.id, it.id));
    const view = (await j.inventory()).inventory.find((x) => x.id === it.id)!;
    expect(view).toMatchObject({ rarityId: 'epic', tradeable: true });
    return it.id;
  };
  /**
   * Ticket 5.8: a farmed item the switches make tradeable (an Epic, Legendary or set piece never
   * worn). Farms on (without wearing anything new) until A and B each hold one, selling what can't
   * be traded so drops always find room. Epics are 3.5 % of item drops; the bound is far beyond
   * what the run needs (`docs/ROADMAP.md` 5.8 records the odds).
   */
  const farmedTradeable = async () => {
    const found = new Map<Journey, string>();
    for (let visit = 0; visit < 60 && found.size < 2; visit++) {
      for (const j of [a, b]) {
        if (found.has(j)) continue;
        const pack = (await j.inventory()).inventory;
        const pick = pack.find((it) => it.tradeable && !it.locked);
        if (pick) {
          found.set(j, pick.id);
          continue;
        }
        const junk = pack.filter((it) => !it.tradeable && !it.locked && it.source !== 'quest');
        if (junk.length > 0) {
          const sold = await j.keyed(`${j.base}/merchant/sell`, { itemIds: junk.map((i) => i.id) });
          expect(sold.statusCode, sold.body).toBe(200);
        }
      }
      if (found.size === 2) break;
      clock.set(clock.now() + STEP);
      for (const j of heroes) await j.settle({ advance: false });
      tradeableVisits = visit + 1;
    }
    expect(found.size, 'farming gave A and B a tradeable item').toBe(2);
    return [found.get(a)!, found.get(b)!] as const;
  };
  let tradeableVisits = 0;
  const [itemA, itemB] = options.played
    ? await farmedTradeable()
    : [await freshEpic(a), await freshEpic(b)];

  // 1a. B → C: a swap, B's gold for C's material. C receives with its hero.
  await minutes(1);
  const [hb0, hc0] = [await holdingsOf(b), await holdingsOf(c)];
  const goldB = 5;
  const matC = tradeableMaterial(hc0.mats, 3)!;
  const swap = await b.keyed('/api/trading/offers', {
    to: mc.handle,
    characterId: b.characterId,
    give: { gold: goldB },
    ask: { materials: { [matC]: 2 } },
  });
  expect(swap.statusCode, swap.body).toBe(201);
  const swapId = swap.json<OfferView>().id;
  expect(swap.json<OfferView>().gift).toBe(false);
  expect((await holdingsOf(b)).gold, 'the gold is in escrow').toBe(hb0.gold - goldB);
  const swapped = await c.keyed(`/api/trading/offers/${swapId}/accept`, {
    characterId: c.characterId,
  });
  expect(swapped.statusCode, swapped.body).toBe(200);
  const [hb1, hc1] = [await holdingsOf(b), await holdingsOf(c)];
  expect(hb1.mats[matC] ?? 0).toBe((hb0.mats[matC] ?? 0) + 2);
  expect(hc1.gold).toBe(hc0.gold + goldB);
  expect(hc1.mats[matC] ?? 0).toBe(hc0.mats[matC]! - 2);

  // 1b. A → B: a gift of gold and a material; B receives with its hero.
  const ha0 = await holdingsOf(a);
  const goldA = 10;
  const matA = tradeableMaterial(ha0.mats, 2)!;
  const gift = await a.keyed('/api/trading/offers', {
    to: mb.handle,
    characterId: a.characterId,
    give: { gold: goldA, materials: { [matA]: 1 } },
  });
  expect(gift.statusCode, gift.body).toBe(201);
  const giftId = gift.json<OfferView>().id;
  expect(gift.json<OfferView>().gift).toBe(true);
  expect((await inboxOf(b)).received.map((o) => o.id)).toContain(giftId);
  const gifted = await b.keyed(`/api/trading/offers/${giftId}/accept`, {
    characterId: b.characterId,
  });
  expect(gifted.statusCode, gifted.body).toBe(200);
  expect(Date.parse(gifted.json<OfferView>().heldUntil!)).toBe(clock.now() + 72 * HOUR);

  // 1c. A ↔ B: an item swap, A's Epic for B's.
  const items = await a.keyed('/api/trading/offers', {
    to: mb.handle,
    characterId: a.characterId,
    receiverCharacterId: b.characterId,
    give: { itemIds: [itemA] },
    ask: { itemIds: [itemB] },
  });
  expect(items.statusCode, items.body).toBe(201);
  const itemsId = items.json<OfferView>().id;
  expect(
    (await a.inventory()).inventory.map((i) => i.id),
    'in escrow',
  ).not.toContain(itemA);
  const itemsDone = await b.keyed(`/api/trading/offers/${itemsId}/accept`, {});
  expect(itemsDone.statusCode, itemsDone.body).toBe(200);
  const packA = (await a.inventory()).inventory;
  const packB = (await b.inventory()).inventory;
  expect(packA.map((i) => i.id)).toContain(itemB);
  expect(packB.map((i) => i.id)).toContain(itemA);
  for (const it of [packA.find((i) => i.id === itemB)!, packB.find((i) => i.id === itemA)!]) {
    expect(it).toMatchObject({ binding: 'account', bindingReason: 'traded', tradeable: false });
  }

  // 2. The hold: received items can't be sold or shelved, received gold can't be shelved or sent
  // on. B settles at this clock first, so nothing more arrives between the read and the spend.
  await settleNow(b);
  const sellHeld = await b.keyed(`${b.base}/merchant/sell`, { itemIds: [itemA] });
  expect(sellHeld.statusCode, sellHeld.body).toBe(409);
  expect(err(sellHeld).code).toBe('item_held');
  expect(err(await a.keyed(`${a.base}/merchant/sell`, { itemIds: [itemB] })).code).toBe(
    'item_held',
  );
  const shelfB = `/api/characters/${b.characterId}/shelf`;
  const shelveHeld = await b.keyed(`${shelfB}/deposit`, { itemIds: [itemA] });
  expect(shelveHeld.statusCode, shelveHeld.body).toBe(409);
  expect(err(shelveHeld).code).toBe('item_held');
  // Ticket 5.8: a player who earned their gold by playing may hold more than one offer may carry;
  // they put all but one piece of their own (unheld) gold on the shelf first, so the refusals below
  // are about the hold and nothing else. `parked` stays on the shelf to the end.
  let parked = 0;
  const own0 = (await holdingsOf(b)).gold - goldA;
  if (own0 + 1 > DEFAULT_TRADING_SETTINGS.limits.goldPerOffer) {
    parked = own0 - 1;
    const park = await b.keyed(`${shelfB}/deposit`, { gold: parked });
    expect(park.statusCode, park.body).toBe(200);
  }
  const hb2 = await holdingsOf(b);
  const ownGold = hb2.gold - goldA;
  const heldDeposit = await b.keyed(`${shelfB}/deposit`, { gold: ownGold + 1 });
  expect(heldDeposit.statusCode, heldDeposit.body).toBe(422);
  expect(err(heldDeposit)).toMatchObject({ code: 'insufficient_gold', details: { held: goldA } });
  const heldSend = await b.keyed('/api/trading/offers', {
    to: ma.handle,
    characterId: b.characterId,
    give: { gold: ownGold + 1 },
  });
  expect(heldSend.statusCode, heldSend.body).toBe(422);
  expect(err(heldSend)).toMatchObject({ code: 'insufficient_gold', details: { onHold: goldA } });
  expect((await holdingsOf(b)).gold, 'refusals move nothing').toBe(hb2.gold);

  // 3. C reports the swap; a moderator finds it in the queue and reverses it within the hold.
  await minutes(1);
  const reported = await c.api('POST', '/api/reports', {
    target: { kind: 'trade', id: swapId },
    reason: 'scam',
    note: 'They promised more than they gave.',
  });
  expect(reported.statusCode, reported.body).toBe(201);
  const queue = (await warden.api('GET', '/api/mod/queue')).json<{
    cases: { target: { kind: string; id?: string } }[];
  }>();
  expect(queue.cases.some((x) => x.target.kind === 'trade' && x.target.id === swapId)).toBe(true);
  const theCase = (await warden.api('GET', `/api/mod/trades/${swapId}`)).json<{
    reversible: { possible: boolean; canAct: boolean };
    reports: { open: number };
  }>();
  expect(theCase).toMatchObject({
    reversible: { possible: true, canAct: true },
    reports: { open: 1 },
  });
  const [hb3, hc3] = [await holdingsOf(b), await holdingsOf(c)];
  const reason = 'Reported as a scam; reversed in the hardening journey.';
  const reverse = () =>
    warden.api(
      'POST',
      `/api/mod/trades/${swapId}/reverse`,
      { reason },
      { 'idempotency-key': randomUUID() },
    );
  const reversed = await reverse();
  expect(reversed.statusCode, reversed.body).toBe(200);
  const [hb4, hc4] = [await holdingsOf(b), await holdingsOf(c)];
  expect(hb4.gold).toBe(hb3.gold + goldB);
  expect(hb4.mats[matC] ?? 0).toBe(hb3.mats[matC]! - 2);
  expect(hc4.gold).toBe(hc3.gold - goldB);
  expect(hc4.mats[matC] ?? 0).toBe((hc3.mats[matC] ?? 0) + 2);
  for (const j of [b, c]) {
    expect((await historyOf(j)).find((o) => o.id === swapId)?.reversal?.reason).toBe(reason);
  }
  const again = await reverse();
  expect(again.statusCode, again.body).toBe(409);

  // 4. The owner pauses "Trade: gold": A's open gold offer is voided and the gold comes back.
  await minutes(1);
  const ha1 = await holdingsOf(a);
  const doomed = await a.keyed('/api/trading/offers', {
    to: mb.handle,
    characterId: a.characterId,
    give: { gold: 5 },
  });
  expect(doomed.statusCode, doomed.body).toBe(201);
  const doomedId = doomed.json<OfferView>().id;
  expect((await holdingsOf(a)).gold).toBe(ha1.gold - 5);
  await saveTrading((s) => ({ ...s, trade: { ...s.trade, gold: false } }));
  expect((await holdingsOf(a)).gold, 'escrow back').toBe(ha1.gold);
  const paused = tradeEndText('void', { cause: 'switch', switches: ['trade.gold'] });
  for (const j of [a, b]) {
    const seen = (await historyOf(j)).find((o) => o.id === doomedId);
    expect(seen).toMatchObject({ status: 'void', endText: paused });
  }
  const voidRows = await auditOf('trade.void', doomedId);
  expect(voidRows).toHaveLength(1);
  expect(voidRows[0]!.data).toMatchObject({
    reason: 'switch',
    switches: ['trade.gold'],
    returned: { gold: 5 },
  });
  const goldOff = await a.keyed('/api/trading/offers', {
    to: mb.handle,
    characterId: a.characterId,
    give: { gold: 5 },
  });
  expect(goldOff.statusCode, goldOff.body).toBe(409);
  expect(err(goldOff).code).toBe('trade_refused');
  await saveTrading((s) => ({ ...s, trade: { ...s.trade, gold: true } }));

  // 5. B reports C; a moderator restricts C's trading from the queue. C's open offer is voided,
  // C's next send refused, and C's shelf still works ("it reaches no one").
  await minutes(1);
  const hc5 = await holdingsOf(c);
  const matC2 = tradeableMaterial(hc5.mats, 2)!;
  const open = await c.keyed('/api/trading/offers', {
    to: mb.handle,
    characterId: c.characterId,
    give: { materials: { [matC2]: 1 } },
  });
  expect(open.statusCode, open.body).toBe(201);
  const openId = open.json<OfferView>().id;
  const filed = await b.api('POST', '/api/reports', {
    target: { kind: 'player', handle: mc.handle },
    reason: 'other',
    note: 'Keeps asking for gold outside the game.',
  });
  expect(filed.statusCode, filed.body).toBe(201);
  const reportId = filed.json<{ report: { id: string } }>().report.id;
  const restricted = await warden.api('POST', `/api/mod/reports/${reportId}/resolve`, {
    action: 'restrictTrade',
    reason: 'Trading for real money is not allowed.',
    durationHours: 30 * 24,
  });
  expect(restricted.statusCode, restricted.body).toBe(200);
  expect(restricted.json<{ sanction: { kind: string } }>().sanction.kind).toBe('trade');
  const cannot = tradeEndText('void', { cause: 'sanction' });
  for (const j of [b, c]) {
    expect((await historyOf(j)).find((o) => o.id === openId)).toMatchObject({
      status: 'void',
      endText: cannot,
    });
  }
  expect((await auditOf('trade.void', openId))[0]!.data).toMatchObject({
    reason: 'sanction',
    sanction: 'trade',
  });
  expect((await holdingsOf(c)).mats[matC2]).toBe(hc5.mats[matC2]);
  const refused = await c.keyed('/api/trading/offers', {
    to: mb.handle,
    characterId: c.characterId,
    give: { materials: { [matC2]: 1 } },
  });
  expect(refused.statusCode, refused.body).toBe(409);
  expect(err(refused).details!.reasons as { check: string; party: string }[]).toContainEqual(
    expect.objectContaining({ check: 'trade_restricted', party: 'you' }),
  );
  const shelfC = `/api/characters/${c.characterId}/shelf`;
  const cDeposit = await c.keyed(`${shelfC}/deposit`, { materials: { [matC2]: 1 } });
  expect(cDeposit.statusCode, cDeposit.body).toBe(200);
  const cWithdraw = await c.keyed(`${shelfC}/withdraw`, { materials: { [matC2]: 1 } });
  expect(cWithdraw.statusCode, cWithdraw.body).toBe(200);

  // 6. 72 hours on: every hold is released, and the spends refused above go through. B's
  // received item and gold cross the shelf to a second hero of B's account.
  clock.set(clock.now() + 72 * HOUR + 1_000);
  for (const j of heroes) await settleNow(j);
  for (const j of heroes) {
    await inboxOf(j);
    expect((await inboxOf(j)).holds, 'released').toEqual([]);
  }
  const sold = await a.keyed(`${a.base}/merchant/sell`, { itemIds: [itemB] });
  expect(sold.statusCode, sold.body).toBe(200);
  const shelved = await b.keyed(`${shelfB}/deposit`, { itemIds: [itemA], gold: ownGold + 1 });
  expect(shelved.statusCode, shelved.body).toBe(200);
  const made = await b.api('POST', '/api/characters', {
    name: 'Tamsin',
    classId: 'hunter',
    appearance: { banner: 'moss' },
  });
  expect(made.statusCode, made.body).toBe(201);
  const b2 = made.json<{ character: { id: string } }>().character.id;
  const taken = await b.keyed(`/api/characters/${b2}/shelf/withdraw`, {
    itemIds: [itemA],
    gold: ownGold + 1,
  });
  expect(taken.statusCode, taken.body).toBe(200);
  expect(taken.json<ShelfMoveResponse>()).toMatchObject({
    character: { id: b2, gold: ownGold + 1 },
    shelf: { items: [], gold: parked },
  });
  expect(taken.json<ShelfMoveResponse>().inventory.inventory.map((i) => i.id)).toEqual([itemA]);

  // Back to the defaults (trading closed): nothing is left open to void.
  await saveTrading(() => structuredClone(DEFAULT_TRADING_SETTINGS) as Settings);
  for (const j of heroes) {
    expect(await inboxOf(j)).toMatchObject({ open: false, received: [], sent: [] });
  }

  // 7. Everything adds up: holdings and shelves = the audit log, the rollups reconcile, and the
  // trade telemetry counts exactly what the audit rows say.
  for (const id of [a.characterId, b.characterId, b2, c.characterId]) {
    await expectHoldingsMatchAudit(database, id);
  }
  for (const m of [ma, mb, mc]) await expectShelfMatchesAudit(database, m.id);
  const checks = await reconcileWithAudit(database.db);
  expect(checks.filter((x) => !x.ok)).toEqual([]);
  const count = async (event: string) => (await auditOf(event)).length;
  expect(await count('trade.offer')).toBe(5);
  expect(await count('trade.accept')).toBe(3);
  expect(await count('trade.void')).toBe(2);
  expect(await count('trade.reverse')).toBe(1);
  const { rows } = await loadRollups(database.db, { from: null, to: null });
  expect(sumRollups(rows, 'trade.complete')).toBe(3);
  expect(sumRollups(rows, 'trade.reverse')).toBe(1);
  expect(sumRollups(rows, 'trade.items')).toBe(2);
  const check = (name: string) => checks.find((x) => x.check === name);
  expect(check('trades: completed')).toMatchObject({ audit: 3, rollup: 3, ok: true });
  expect(check('trades: reversed')).toMatchObject({ audit: 1, rollup: 1, ok: true });
  return { b2, tradeableVisits, items: [itemA, itemB] };
}

/**
 * Ticket D.4: the admin tools step. A test account's hero (marked by the CLI's function) is
 * inspected, given an item (preview, then the same seed), gold and an hour of farming through the
 * normal settlement, has the item removed again, is soft-deleted (hidden from its player) and
 * restored. A normal player's hero refuses every cheat tool. Everything reconciles with the
 * audit log, and no admin answer carries the player's email.
 */
export async function playAdminToolsStep(
  app: FastifyInstance,
  database: DatabaseHandle,
  {
    admin,
    hero,
    email,
    bystander,
  }: { admin: Player; hero: Journey; email: string; bystander: Journey },
) {
  const me = await playerOf(hero);
  const handle = me.account.handle;
  const heroUrl = `/api/admin/accounts/${handle}/heroes/${hero.characterId}`;
  const post = (url: string, payload: object) =>
    admin.api('POST', url, payload, { 'idempotency-key': randomUUID() });
  const answers: string[] = [];
  const keep = <T extends { body: string }>(r: T) => (answers.push(r.body), r);

  // Not a test account yet: cheat tools refuse, support tools work.
  const refused = keep(
    await post(`${heroUrl}/gold`, { mode: 'grant', amount: 50, reason: 'journey' }),
  );
  expect(refused.statusCode).toBe(403);
  await setTestAccount(database.db, handle, true);

  const file = keep(await admin.api('GET', `/api/admin/accounts/${handle}`));
  expect(file.statusCode, file.body).toBe(200);
  expect(file.json()).toMatchObject({
    account: { testAccount: true, heroes: [{ id: hero.characterId }] },
  });

  const spec = {
    baseId: 'longsword',
    rarityId: 'epic',
    itemLevel: 10,
    variant: null,
    upgradeLevel: 2,
  };
  const preview = keep(await post(`${heroUrl}/items/preview`, spec));
  expect(preview.statusCode, preview.body).toBe(200);
  const granted = keep(
    await post(`${heroUrl}/items/grant`, { ...spec, seed: preview.json().seed, reason: 'journey' }),
  );
  expect(granted.statusCode, granted.body).toBe(200);
  const itemId = granted.json<{ item: { id: string; affixes: unknown } }>().item.id;
  expect(granted.json().item.affixes).toEqual(preview.json().item.affixes);
  expect(
    (await hero.inventory()).inventory.some((i) => i.id === itemId),
    'the granted item is in the pack',
  ).toBe(true);

  expect(
    keep(await post(`${heroUrl}/gold`, { mode: 'grant', amount: 1000, reason: 'journey' }))
      .statusCode,
  ).toBe(200);
  await hero.farmBestArea();
  const ff = keep(await post(`${heroUrl}/fast-forward`, { minutes: 60, reason: 'journey' }));
  expect(ff.statusCode, ff.body).toBe(200);
  expect(ff.json().creditedMs).toBe(3_600_000);
  await hero.settle();

  const removed = keep(
    await post(`/api/admin/accounts/${handle}/items/${itemId}/remove`, {
      confirm: (await hero.api('GET', '/api/characters'))
        .json<{ characters: { id: string; name: string }[] }>()
        .characters.find((c) => c.id === hero.characterId)!.name,
      reason: 'journey',
    }),
  );
  expect(removed.statusCode, removed.body).toBe(200);

  // Soft delete and restore (the player sees the hero vanish and come back).
  const name = (await hero.api('GET', '/api/characters'))
    .json<{ characters: { id: string; name: string }[] }>()
    .characters.find((c) => c.id === hero.characterId)!.name;
  expect(
    keep(await post(`${heroUrl}/delete`, { confirm: name, reason: 'journey' })).statusCode,
  ).toBe(200);
  expect((await hero.api('GET', '/api/characters')).json().characters).toEqual([]);
  expect((await hero.api('GET', `${hero.base}/inventory`)).statusCode).toBe(404);
  expect(keep(await post(`${heroUrl}/restore`, { reason: 'journey' })).statusCode).toBe(200);
  expect((await hero.api('GET', '/api/characters')).json().characters).toHaveLength(1);

  // A normal player's hero refuses cheat tools.
  const other = await playerOf(bystander);
  const otherUrl = `/api/admin/accounts/${other.account.handle}/heroes/${bystander.characterId}`;
  for (const [path, payload] of [
    ['level', { level: 9, reason: 'journey' }],
    ['xp', { xp: 99, reason: 'journey' }],
    ['items/grant', { ...spec, seed: 1, reason: 'journey' }],
  ] as const) {
    const res = keep(await post(`${otherUrl}/${path}`, payload));
    expect(res.statusCode, path).toBe(403);
  }

  expect((await reconcileWithAudit(database.db)).filter((c) => !c.ok)).toEqual([]);
  for (const body of answers)
    expect(body.includes(email), 'no email in an admin answer').toBe(false);
}

/**
 * Phase 6 collection book step (ticket 6.8, docs/COSMETICS.md): after the event step, the hero's
 * account owns the Sheaf-and-Bone banner. It opens the book (every cosmetic, owned or locked with
 * its source), cannot equip a locked crest or another kind in the banner slot, equips the banner
 * (Idempotency-Key, replayed safely) and sees it on its own profile; the hero keeps its class's own
 * colours (no appearance owned) and its scores are unchanged.
 */
export async function playCollectionStep(hero: Journey) {
  type Book = {
    entries: { id: string; kind: string; owned: boolean; source: { kind: string } }[];
    equipped: { banner: string | null; crest: string | null; titleColour: string | null };
    heroes: { id: string; palette: string | null }[];
  };
  const scores = async () => {
    const r = await hero.api('GET', `${hero.base}/scores`);
    expect(r.statusCode, r.body).toBe(200);
    return r.json();
  };
  const before = await scores();
  const opened = await hero.api('GET', '/api/account/collection');
  expect(opened.statusCode, opened.body).toBe(200);
  const book = opened.json<Book>();
  const owned = book.entries.filter((e) => e.owned).map((e) => e.id);
  expect(owned).toEqual(expect.arrayContaining(['appearance.default', 'banner.harvest-sheaf']));
  expect(book.entries.find((e) => e.id === 'crest.gilt')).toMatchObject({
    owned: false,
    source: { kind: 'season' },
  });
  expect(book.heroes).toEqual([expect.objectContaining({ id: hero.characterId, palette: null })]);

  const locked = await hero.keyed('/api/account/cosmetics/equip', { crest: 'crest.gilt' });
  expect(locked.statusCode).toBe(422);
  const wrong = await hero.keyed('/api/account/cosmetics/equip', {
    banner: 'title-colour.bone-white',
  });
  expect(wrong.statusCode).toBe(422);
  const key = randomUUID();
  const worn = await hero.keyed(
    '/api/account/cosmetics/equip',
    { banner: 'banner.harvest-sheaf' },
    key,
  );
  expect(worn.statusCode, worn.body).toBe(200);
  const replay = await hero.keyed(
    '/api/account/cosmetics/equip',
    { banner: 'banner.harvest-sheaf' },
    key,
  );
  expect(replay.headers['idempotency-replayed']).toBe('true');
  expect(worn.json<Book>().equipped.banner).toBe('banner.harvest-sheaf');
  // Shown wherever honours are (boards, profile, rosters): the prestige display carries it.
  const me = await hero.api('GET', '/api/account/prestige');
  expect(me.statusCode, me.body).toBe(200);
  expect(me.json<{ shown: { banner: string | null } }>().shown.banner).toBe('banner.harvest-sheaf');
  const palette = await hero.keyed(`${hero.base}/appearance`, { appearance: 'appearance.ember' });
  expect(palette.statusCode).toBe(422);
  // Cosmetics carry no power.
  expect(await scores()).toEqual(before);
  return { owned };
}

/**
 * Ticket 6.11: the Seal and Abbey silver sinks at the Forge (docs/COSMETICS.md "The exchange and
 * engravings"). The hero is given Seals and silver (a measured seeding, like the Phase 6 journeys),
 * buys one Seal and one silver offer at the exchange (a replay pays nothing, a second purchase is
 * refused), wears the bought crest, engraves an item in seal-wax and re-engraves it in silver
 * (each pays), and nothing anyone's scores read moves; the holdings and telemetry reconcile.
 */
export async function playSealSinkStep(database: DatabaseHandle, hero: Journey) {
  const scores = async () => {
    const r = await hero.api('GET', `${hero.base}/scores`);
    expect(r.statusCode, r.body).toBe(200);
    return r.json();
  };
  // Settle what is farmed up to now (the clock stands still in this step), so the scores before
  // and after read the same experience: only the sinks could move them.
  const settled = await hero.api('POST', `${hero.base}/activity/settle`);
  expect([200, 409], settled.body).toContain(settled.statusCode);
  const before = await scores();
  // A measured seeding (the test helper; the hold guard keeps material writes out of src).
  await giveMaterials(database.db, hero.characterId, { gravewardenSeal: 9, abbeySilver: 40 });
  const baseline = await holdingsBaseline(database, hero.characterId);
  const held = async (m: MaterialId) =>
    (
      await database.db
        .select()
        .from(characterMaterials)
        .where(
          and(
            eq(characterMaterials.characterId, hero.characterId),
            eq(characterMaterials.materialId, m),
          ),
        )
    )[0]?.quantity ?? 0;
  const startSeals = await held('gravewardenSeal');
  const startSilver = await held('abbeySilver');

  type Offers = { offers: { cosmeticId: string; owned: boolean; blockers: unknown[] }[] };
  const shop = await hero.api('GET', `${hero.base}/exchange`);
  expect(shop.statusCode, shop.body).toBe(200);
  expect(shop.json<Offers>().offers.map((o) => o.cosmeticId)).toContain('crest.seal-wax');
  const key = randomUUID();
  const bought = await hero.keyed(`${hero.base}/exchange`, { cosmeticId: 'crest.seal-wax' }, key);
  expect(bought.statusCode, bought.body).toBe(200);
  const replay = await hero.keyed(`${hero.base}/exchange`, { cosmeticId: 'crest.seal-wax' }, key);
  expect(replay.headers['idempotency-replayed']).toBe('true');
  const twice = await hero.keyed(`${hero.base}/exchange`, { cosmeticId: 'crest.seal-wax' });
  expect(twice.statusCode).toBe(409);
  const silver = await hero.keyed(`${hero.base}/exchange`, {
    cosmeticId: 'title-colour.abbey-silver',
  });
  expect(silver.statusCode, silver.body).toBe(200);
  const worn = await hero.keyed('/api/account/cosmetics/equip', { crest: 'crest.seal-wax' });
  expect(worn.statusCode, worn.body).toBe(200);

  const inv = await hero.api('GET', `${hero.base}/inventory`);
  expect(inv.statusCode, inv.body).toBe(200);
  const view = inv.json<InventoryView>();
  const target = view.equipped[0] ?? view.inventory[0];
  expect(target, 'an item to engrave').toBeDefined();
  const sealed = await hero.keyed(`${hero.base}/forge/engrave`, {
    itemId: target!.id,
    finish: 'seal',
    engravingId: 'oathworn',
  });
  expect(sealed.statusCode, sealed.body).toBe(200);
  const inlaid = await hero.keyed(`${hero.base}/forge/engrave`, {
    itemId: target!.id,
    finish: 'silver',
    engravingId: 'oathworn',
  });
  expect(inlaid.statusCode, inlaid.body).toBe(200);
  expect(inlaid.json<{ item: ItemView }>().item.engraving).toBe('silver:oathworn');
  // 4 Seals (the crest) + 2 (the seal-wax engraving); 25 silver (the colour) + 15 (the inlay).
  expect(await held('gravewardenSeal')).toBe(startSeals - 6);
  expect(await held('abbeySilver')).toBe(startSilver - 40);
  expect(await scores()).toEqual(before);
  await expectHoldingsMatchAudit(database, hero.characterId, baseline);
  const checks = await reconcileWithAudit(database.db);
  expect(checks.filter((c) => !c.ok)).toEqual([]);
  return { bought: ['crest.seal-wax', 'title-colour.abbey-silver'], engraving: 'silver:oathworn' };
}
