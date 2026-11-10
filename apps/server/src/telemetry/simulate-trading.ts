// Ticket T.7: the realistic player of `telemetry:simulate` with trading switched on
// (`--trading on|all`, docs/TELEMETRY.md, docs/ECONOMY.md "Balance check: trading and the shelf").
// Every trade and shelf move goes through the real API; the simulation only reads the database
// to decide (what a guildmate wears and holds stands in for looking at their profile) and takes
// two shortcuts to make the town eligible from the start: accounts and guild memberships are
// dated 30 days back and emails are verified (like `e2e/journey.ts` `playTradeStep`).
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_TRADING_SETTINGS,
  MATERIAL_IDS,
  UNTRADEABLE_MATERIALS,
  checkEquip,
  equipmentSlotsForKind,
  getItemBase,
  itemBinding,
  tradingSwitchesOf,
  type ClassId,
  type MaterialId,
  type TradingSettings,
} from '@worldforge/game-core';
import { SESSION_COOKIE } from '../auth/index.js';
import {
  accounts,
  characterMaterials,
  characters,
  gameSettings,
  guildMembers,
  itemInstances,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';

export type TradingMode = 'off' | 'on' | 'all';

/** The switches a run opens: everything but Mythic and Void (`on`, the defaults), or all. */
export function simTradingSettings(mode: TradingMode): TradingSettings {
  const s = structuredClone(DEFAULT_TRADING_SETTINGS) as TradingSettings;
  s.trading = true;
  s.trade = { items: true, materials: true, gold: true };
  s.shelf = { items: true, materials: true, gold: true };
  if (mode === 'all') s.tradeable = { ...s.tradeable, mythic: true, void: true, prismatic: true };
  return s;
}

/** The hero fields this module reads (the simulator's `Hero`). */
export interface SimHero {
  token: string;
  id: string;
  classId: ClassId;
  level: number;
  n: number;
  guild: 'small' | 'large' | null;
  /** A second hero of the same account (`--alts`), and on the alt, its main. */
  alt?: SimHero;
  main?: SimHero;
  handle?: string;
}

type ItemRow = typeof itemInstances.$inferSelect;
type Res = { statusCode: number; body: string; json: <T>() => T };

const DAY = 86_400_000;
const RANK: Record<string, number> = {
  common: 0,
  uncommon: 1,
  rare: 2,
  epic: 3,
  legendary: 4,
  mythic: 5,
};
/** Gives of a material gift: [giver has at least, receiver has under, amount]. */
const MATERIAL_GIFT: Partial<Record<MaterialId, [number, number, number]>> = {
  soulShard: [200, 20, 20],
  abbeySilver: [30, 3, 3],
};
const COMMON_GIFT: [number, number, number] = [600, 60, 150];
/** Codes that are part of play (caps, limits, holds, a full shelf or pack), tallied, not errors. */
const PLAY_REFUSALS = new Set([
  'trade_refused',
  'trade_cap_reached',
  'open_offer_limit',
  'insufficient_gold',
  'insufficient_materials',
  'item_in_offer',
  'item_held',
  'offer_closed',
  'offer_expired',
  'inventory_full',
  'shelf_full',
  'shelf_paused',
  'warehouse_closed',
  'rate_limited',
  'conflict',
]);

export interface TradingContext {
  app: FastifyInstance;
  database: DatabaseHandle;
  now: () => number;
  /** The mains (alts are reached through `main.alt`). */
  heroes: readonly SimHero[];
  settings: TradingSettings;
  power: (i: { itemLevel: number; rarityId: string; upgradeLevel: number }) => number;
  unexpected: (what: string, status: number, body: string) => void;
}

export function createSimTrading(ctx: TradingContext) {
  const { app, database, settings, power } = ctx;
  const db = database.db;
  const switches = tradingSwitchesOf(settings);
  const tally = new Map<string, number>();
  const bump = (k: string, by = 1) => tally.set(k, (tally.get(k) ?? 0) + by);
  /** Items already offered to a hero's slot (by power), so one slot isn't offered twice. */
  const pending = new Map<string, number>();

  const api = (h: SimHero, method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({
      method,
      url,
      ...(payload ? { payload } : {}),
      headers: method === 'POST' ? { 'idempotency-key': randomUUID() } : {},
      cookies: { [SESSION_COOKIE]: h.token },
    }) as Promise<Res>;
  /** True on success; otherwise tallies the refusal (by code and check) or reports it. */
  const ok = (what: string, res: Res): boolean => {
    if (res.statusCode < 300) return true;
    let code = '';
    let checks = '';
    try {
      const e = (
        JSON.parse(res.body) as {
          error?: { code?: string; details?: { reasons?: { check: string }[] } };
        }
      ).error;
      code = e?.code ?? '';
      checks = (e?.details?.reasons ?? []).map((r) => r.check).join('+');
    } catch {
      /* not JSON */
    }
    if (PLAY_REFUSALS.has(code) && res.statusCode < 500) {
      bump(`refused ${what}: ${code}${checks ? ` (${checks})` : ''}`);
    } else {
      ctx.unexpected(what, res.statusCode, res.body);
    }
    return false;
  };
  const held = (i: ItemRow) => i.holdUntil !== null && i.holdUntil.getTime() > ctx.now();
  const away = (i: ItemRow) => i.inWarehouse || i.onShelf || i.escrowOfferId !== null;
  const wornOf = async (h: SimHero) =>
    new Map(
      (await db.select().from(itemInstances).where(eq(itemInstances.characterId, h.id)))
        .filter((i) => i.equippedSlot)
        .map((i) => [i.equippedSlot!, i]),
    );
  const stocks = async (h: SimHero) =>
    new Map(
      (
        await db.select().from(characterMaterials).where(eq(characterMaterials.characterId, h.id))
      ).map((m) => [m.materialId as MaterialId, m.quantity]),
    );
  const goldOf = async (h: SimHero) =>
    (await db.select({ gold: characters.gold }).from(characters).where(eq(characters.id, h.id)))[0]!
      .gold;
  const levelOf = async (h: SimHero) =>
    (
      await db.select({ level: characters.level }).from(characters).where(eq(characters.id, h.id))
    )[0]!.level;
  /** Guildmates' mains on other accounts that can trade (a hero at 15 or more). */
  const mates = async (h: SimHero) => {
    const out: SimHero[] = [];
    for (const m of ctx.heroes) {
      if (m === h || !m.guild || m.guild !== h.guild) continue;
      m.level = await levelOf(m);
      if (m.level >= 15) out.push(m);
    }
    return out;
  };
  const tradeable = MATERIAL_IDS.filter((m) => !UNTRADEABLE_MATERIALS.includes(m));

  /** Opens trading (the settings row), makes the town eligible and learns every handle. */
  async function open(): Promise<void> {
    const past = new Date(ctx.now() - 30 * DAY);
    const ids = ctx.heroes.map((h) => h.id);
    const owners = await db
      .select({ accountId: characters.accountId })
      .from(characters)
      .where(inArray(characters.id, ids));
    await db
      .update(accounts)
      .set({ createdAt: past, emailVerifiedAt: past })
      .where(
        inArray(
          accounts.id,
          owners.map((o) => o.accountId),
        ),
      );
    await db.update(guildMembers).set({ joinedAt: past });
    await db
      .insert(gameSettings)
      .values({ key: 'trading', value: settings as never, version: 1, updatedAt: new Date() })
      .onConflictDoUpdate({ target: gameSettings.key, set: { value: settings as never } });
    app.gameSettings.invalidate();
    for (const h of ctx.heroes) {
      const res = await api(h, 'GET', '/api/account');
      h.handle = res.json<{ account: { handle: string } }>().account.handle;
    }
  }

  /** The inbox: gifts are taken, swaps when what they ask leaves enough behind. */
  async function checkIn(h: SimHero): Promise<void> {
    const res = await api(h, 'GET', '/api/trading/offers');
    if (!ok('inbox', res)) return;
    const inbox = res.json<{
      received: {
        id: string;
        gift: boolean;
        ask: {
          gold: number;
          items: unknown[];
          materials: { materialId: MaterialId; quantity: number }[];
        };
      }[];
    }>();
    if (inbox.received.length === 0) return;
    const have = await stocks(h);
    for (const o of inbox.received) {
      const fine =
        o.gift ||
        (o.ask.gold === 0 &&
          o.ask.items.length === 0 &&
          o.ask.materials.every((m) => (have.get(m.materialId) ?? 0) - m.quantity >= 300));
      if (fine) {
        const r = await api(h, 'POST', `/api/trading/offers/${o.id}/accept`, { characterId: h.id });
        if (ok('accept', r)) bump(o.gift ? 'accepted gift' : 'accepted swap');
        // Over a weekly cap: a player says no rather than leave it open (the sender gets it back).
        else if (r.body.includes('"trade_cap_reached"')) {
          const d = await api(h, 'POST', `/api/trading/offers/${o.id}/decline`, {});
          if (ok('decline', d)) bump('declined over a cap');
        }
      } else {
        const r = await api(h, 'POST', `/api/trading/offers/${o.id}/decline`, {});
        if (ok('decline', r)) bump('declined swap');
      }
    }
  }

  /**
   * Gifts the loose Epic and better items `h` would salvage (or keepsakes its class can't wear)
   * to the guildmate whose slot they improve most (≥ 15 %). Returns the ids sent.
   */
  async function giftItems(h: SimHero, loose: readonly ItemRow[]): Promise<Set<string>> {
    const sent = new Set<string>();
    const candidates = loose.filter(
      (i) =>
        (RANK[i.rarityId] ?? 0) >= 3 &&
        !held(i) &&
        !away(i) &&
        !i.locked &&
        !i.unprovenanced &&
        itemBinding(i, switches).tradeable,
    );
    if (candidates.length === 0) return sent;
    const others = await mates(h);
    if (others.length === 0) return sent;
    const worn = new Map<string, Awaited<ReturnType<typeof wornOf>>>();
    for (const m of others) worn.set(m.id, await wornOf(m));
    const plan = new Map<SimHero, ItemRow[]>();
    for (const i of candidates) {
      const slots = equipmentSlotsForKind(getItemBase(i.baseId).slot);
      const salvageable = RANK[i.rarityId]! <= 4 && !i.setId && !i.mythicId && !i.variant;
      const ownUse = slots.some((s) => checkEquip(i.baseId, h.classId, s).ok);
      if (!salvageable && ownUse) continue; // a keepsake it may wear one day
      let best: { m: SimHero; slot: string; gain: number } | null = null;
      for (const m of others) {
        for (const s of slots) {
          if (!checkEquip(i.baseId, m.classId, s).ok) continue;
          const w = worn.get(m.id)!.get(s);
          const base = Math.max(w ? power(w) : 0, pending.get(`${m.id}:${s}`) ?? 0);
          const gain = power(i) / Math.max(base, 1);
          if (power(i) > base * 1.15 && (!best || gain > best.gain)) best = { m, slot: s, gain };
        }
      }
      if (!best) continue;
      const list = plan.get(best.m) ?? [];
      if (list.length >= settings.limits.itemsPerSide) continue;
      list.push(i);
      plan.set(best.m, list);
      pending.set(`${best.m.id}:${best.slot}`, power(i));
    }
    for (const [m, items] of plan) {
      const r = await api(h, 'POST', '/api/trading/offers', {
        to: m.handle,
        characterId: h.id,
        give: { itemIds: items.map((i) => i.id) },
      });
      if (ok('offer items', r)) {
        for (const i of items) sent.add(i.id);
        bump('sent item gift');
        bump('items offered', items.length);
      }
    }
    return sent;
  }

  /** Once a day: a small gold gift to a poorer, lower guildmate; a material gift or swap. */
  async function dailyGifts(h: SimHero, day: number): Promise<void> {
    h.level = await levelOf(h);
    if (h.level < 15) return;
    const others = await mates(h);
    if (others.length === 0) return;
    // Gold, every other day: 3,000 from a hero at 20+ with 20,000 or more.
    const gold = await goldOf(h);
    if ((day + h.n) % 2 === 0 && h.level >= 20 && gold >= 20_000) {
      const lower = others.filter((m) => m.level <= h.level - 4);
      let poorest: { m: SimHero; g: number } | null = null;
      for (const m of lower) {
        const g = await goldOf(m);
        if (!poorest || g < poorest.g) poorest = { m, g };
      }
      if (poorest && poorest.g < gold / 2) {
        const r = await api(h, 'POST', '/api/trading/offers', {
          to: poorest.m.handle,
          characterId: h.id,
          give: { gold: 3_000 },
        });
        if (ok('offer gold', r)) bump('sent gold gift');
      }
    }
    // Materials: what it has plenty of to a guildmate short of it; a swap if it is short too.
    const mine = await stocks(h);
    for (const m of others) {
      const theirs = await stocks(m);
      const give = tradeable.find((id) => {
        const [has, under] = MATERIAL_GIFT[id] ?? COMMON_GIFT;
        return (mine.get(id) ?? 0) >= has && (theirs.get(id) ?? 0) < under;
      });
      if (!give) continue;
      const ask = tradeable.find((id) => {
        const [has, under] = MATERIAL_GIFT[id] ?? COMMON_GIFT;
        return (theirs.get(id) ?? 0) >= has && (mine.get(id) ?? 0) < under;
      });
      const r = await api(h, 'POST', '/api/trading/offers', {
        to: m.handle,
        characterId: h.id,
        give: { materials: { [give]: (MATERIAL_GIFT[give] ?? COMMON_GIFT)[2] } },
        ...(ask ? { ask: { materials: { [ask]: (MATERIAL_GIFT[ask] ?? COMMON_GIFT)[2] } } } : {}),
      });
      if (ok('offer materials', r)) bump(ask ? 'sent material swap' : 'sent material gift');
      return;
    }
  }

  /**
   * The alt's morning (account shelf): items its main's class can wear and that beat the main's
   * piece, three quarters of its gold and half of each material stack over 20.
   */
  async function shelfDeposit(alt: SimHero, loose: readonly ItemRow[]): Promise<void> {
    const main = alt.main!;
    const view = await api(alt, 'GET', `/api/characters/${alt.id}/shelf`);
    if (!ok('shelf', view)) return;
    const shelf = view.json<{ capacity: number; items: unknown[] }>();
    const worn = await wornOf(main);
    const items = loose
      .filter((i) => {
        if ((RANK[i.rarityId] ?? 0) < 3 || held(i) || away(i) || i.locked) return false;
        return equipmentSlotsForKind(getItemBase(i.baseId).slot).some((s) => {
          if (!checkEquip(i.baseId, main.classId, s).ok) return false;
          const w = worn.get(s);
          return !w || power(i) > power(w) * 1.1;
        });
      })
      .slice(0, Math.max(0, shelf.capacity - shelf.items.length))
      .map((i) => i.id);
    const gold = Math.floor((await goldOf(alt)) * 0.75);
    const materials = Object.fromEntries(
      [...(await stocks(alt))]
        .filter(([id, q]) => q > 20 && !UNTRADEABLE_MATERIALS.includes(id))
        .map(([id, q]) => [id, Math.floor(q / 2)]),
    );
    if (items.length === 0 && gold === 0 && Object.keys(materials).length === 0) return;
    const r = await api(alt, 'POST', `/api/characters/${alt.id}/shelf/deposit`, {
      ...(items.length > 0 ? { itemIds: items } : {}),
      ...(gold > 0 ? { gold } : {}),
      ...(Object.keys(materials).length > 0 ? { materials } : {}),
    });
    if (ok('shelf deposit', r)) bump('shelf deposits');
  }

  /** The main takes everything on the shelf (items while its pack has room). */
  async function shelfWithdraw(main: SimHero): Promise<void> {
    const view = await api(main, 'GET', `/api/characters/${main.id}/shelf`);
    if (!ok('shelf', view)) return;
    const shelf = view.json<{
      items: { id: string }[];
      gold: number;
      materials: { materialId: MaterialId; quantity: number }[];
      hero: { pack: { count: number; capacity: number } };
    }>();
    const room = Math.max(0, shelf.hero.pack.capacity - shelf.hero.pack.count);
    const itemIds = shelf.items.slice(0, room).map((i) => i.id);
    const materials = Object.fromEntries(
      shelf.materials.filter((m) => m.quantity > 0).map((m) => [m.materialId, m.quantity]),
    );
    if (itemIds.length === 0 && shelf.gold === 0 && Object.keys(materials).length === 0) return;
    const r = await api(main, 'POST', `/api/characters/${main.id}/shelf/withdraw`, {
      ...(itemIds.length > 0 ? { itemIds } : {}),
      ...(shelf.gold > 0 ? { gold: shelf.gold } : {}),
      ...(Object.keys(materials).length > 0 ? { materials } : {}),
    });
    if (ok('shelf withdraw', r)) bump('shelf withdrawals');
  }

  const summary = () =>
    [...tally].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}: ${v}`);

  return { open, checkIn, giftItems, dailyGifts, shelfDeposit, shelfWithdraw, summary, held, away };
}
