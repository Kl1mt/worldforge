// `pnpm --filter @worldforge/server telemetry:simulate [-- --dir .telemetry-sample --days 3
//   --play realistic|crude --snapshots]`
// (ticket 3.8): plays a small simulated population through the real API on a PGlite database, so
// the telemetry report has something to show without a playtest. Ticket B.2 added the default
// `realistic` player (see `docs/TELEMETRY.md`): it tidies the pack, wears its best finds and
// spends its gold at the Forge every session, starting from a purse it could have earned. `crude`
// is 3.8's player (a fat starting purse, one tidy and one forged item a day). Ticket B.3 gives the
// realistic player the Phase 4 economy (`--social on`, the default; `off` is B.2's player): it moves
// up to the best open area as it levels (the Ashen Pass and the Warden's Watch once the town clears
// them), gives a daily share to the community projects, stores its keepsakes in the warehouse and
// buys shelves when it is full, founds or joins a guild, fights the weekly guild boss three times a
// week and claims its spoils. Ticket B.4: `--snapshots` writes every hero's scoring input at the
// start and the end of each game day (`<dir>/snapshots/`, for tools/balance/competitive.ts). Ticket
// T.7: `--trading on|all` opens trading and the account shelf (`simulate-trading.ts`): guildmates
// gift the Epic and better finds they would salvage, small gold and material gifts and swaps, and
// accept what they are sent; `--alts` (implied by `--trading`) gives the accounts of the level-21
// and level-23 heroes a second hero who farms the night and, with the shelf, feeds the main. Then:
//
//   PLAYTEST_DATA_DIR=.telemetry-sample pnpm report:telemetry
//
// Dev tool only (not run in CI). Seeds are server-random, so numbers vary a little between runs.
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { eq } from 'drizzle-orm';
import {
  CLASS_IDS,
  MATERIAL_IDS,
  equipmentSlotsForKind,
  getItemBase,
  isAreaUnlocked,
  isDungeonUnlocked,
  NO_WORLD_FLAGS,
  type AreaId,
  type ClassId,
  type RarityId,
} from '@worldforge/game-core';
import { guildMembers } from '../db/schema.js';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { characterMaterials, characterQuests, characters, itemInstances } from '../db/schema.js';
import { createPgliteDatabase } from '../test/db.js';
import { makeCryptReady } from '../test/dungeon.js';
import { scoringInput } from '../scores/routes.js';
import { createSimTrading, simTradingSettings, type TradingMode } from './simulate-trading.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const { values: args } = parseArgs({
  options: {
    dir: { type: 'string', default: '.telemetry-sample' },
    days: { type: 'string', default: '3' },
    play: { type: 'string', default: 'realistic' },
    social: { type: 'string', default: 'on' },
    // Ticket B.4: write every hero's 5.1 scoring input at the end of each game day
    // (`<dir>/snapshots/day-NN.json`) for `tools/balance/competitive.ts`.
    snapshots: { type: 'boolean', default: false },
    // Ticket T.7: trading and the shelf (`on`: the default categories; `all`: Mythic and Void
    // too), and a second hero on some accounts (`--alts`, implied by `--trading on|all`).
    trading: { type: 'string', default: 'off' },
    alts: { type: 'boolean', default: false },
  },
  args: process.argv.slice(2).filter((a) => a !== '--'),
});
const dir = resolve(process.env.INIT_CWD ?? REPO_ROOT, args.dir!);
const days = Math.max(1, Number(args.days) || 3);
const realistic = args.play !== 'crude';
/** Ticket B.3: the Phase 4 economy (projects, warehouse, guilds, guild boss, the Pass). */
const social = realistic && args.social !== 'off';
const tradingMode = (['on', 'all'].includes(args.trading!) ? args.trading : 'off') as TradingMode;
const trading = tradingMode !== 'off';
const alts = args.alts || trading;
if ((trading || alts) && !social) throw new Error('--trading and --alts need the social player.');
/** Rough worth of a piece for the realistic player: base value by level, rarity and upgrades. */
const IMPLICIT: Record<string, number> = {
  common: 1,
  uncommon: 1.1,
  rare: 1.2,
  epic: 1.35,
  legendary: 1.5,
  mythic: 1.7,
};
const power = (i: { itemLevel: number; rarityId: string; upgradeLevel: number }) =>
  (i.itemLevel + 5) * (IMPLICIT[i.rarityId] ?? 1) * (1 + 0.05 * i.upgradeLevel);
const RARITY_RANK: Record<string, number> = {
  common: 0,
  uncommon: 1,
  rare: 2,
  epic: 3,
  legendary: 4,
  mythic: 5,
};

rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const database = await createPgliteDatabase(join(dir, 'db'));
const HOUR = 60 * 60 * 1000;
let nowMs = Date.parse('2026-11-02T06:00:00Z');
const app = buildApp({
  database,
  auth: {
    registerRateLimit: { max: 10_000, timeWindowMs: 60_000 },
    // Ticket T.7: trades, holds and account age run on the game clock (the auth clock); the clock
    // stands still within a visit, so the per-account request limit is lifted.
    ...(alts
      ? {
          now: () => new Date(nowMs),
          sessionTtlMs: 365 * 24 * HOUR,
          accountRateLimit: { requests: 1e9, actions: 1e9, windowMs: 60_000 },
        }
      : {}),
  },
  activity: { ...DEFAULT_ACTIVITY_OPTIONS, now: () => new Date(nowMs) },
});
await app.ready();

interface Hero {
  token: string;
  id: string;
  classId: ClassId;
  level: number;
  area: string;
  tier: 0 | 1 | 2 | 3;
  filter: boolean;
  /** Ticket B.3: index in the population, and the guild this hero founded or joined. */
  n: number;
  guild: 'small' | 'large' | null;
  /** Ticket T.7 (`--alts`): the account's second hero, and on that alt, its main. */
  alt?: Hero;
  main?: Hero;
  handle?: string;
}

const send = (h: Hero, method: 'GET' | 'POST', path: string, payload?: object) =>
  app.inject({
    method,
    url: `/api/characters/${h.id}${path}`,
    ...(payload ? { payload } : {}),
    headers: method === 'POST' ? { 'idempotency-key': randomUUID() } : {},
    cookies: { [SESSION_COOKIE]: h.token },
  });

const AREAS: [number, string][] = [
  [24, 'ashenPass'],
  [17, 'sunkenAbbey'],
  [13, 'blackwater'],
  [9, 'oldBurialGrounds'],
  [5, 'crowwood'],
  [1, 'abandonedFields'],
];
// Level, crypt tier and gear rarity per hero slot: a spread from fresh heroes to tier III.
const PROFILES: [number, 0 | 1 | 2 | 3, RarityId][] = [
  [1, 0, 'common'],
  [7, 0, 'uncommon'],
  [12, 0, 'uncommon'],
  [16, 1, 'uncommon'],
  [21, 2, 'epic'],
  [23, 3, 'legendary'],
  // Ticket B.3: a hero at the Ashen Pass (it farms there once the town has cleared it).
  ...(social ? ([[25, 3, 'legendary']] as [number, 0 | 1 | 2 | 3, RarityId][]) : []),
];

let n = 0;
const heroes: Hero[] = [];
for (const classId of CLASS_IDS) {
  for (const [level, tier, rarityId] of PROFILES) {
    n += 1;
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: `sim${n}@graumark.test`,
        displayName: `Sim ${n}`,
        password: 'ashes-and-iron-42',
      },
    });
    const token = reg.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
    const created = await app.inject({
      method: 'POST',
      url: '/api/characters',
      payload: {
        name: `Sim${String.fromCharCode(97 + (n % 26))}${String.fromCharCode(97 + Math.floor(n / 26))}`,
        classId,
        appearance: { banner: 'ash' },
      },
      cookies: { [SESSION_COOKIE]: token },
    });
    const id = created.json<{ character: { id: string } }>().character.id;
    if (level > 1) await makeCryptReady(database.db, id, classId, level, { rarityId });
    await database.db
      .update(characters)
      .set({
        // Realistic: about what farming up to this level pays (Phase 2: 25–30k by level 17).
        gold: realistic ? 1_500 * level : 5_000 * level,
        progress: { gravewardenDefeated: level >= 17, cryptTierCleared: Math.max(0, tier - 1) },
      })
      .where(eq(characters.id, id));
    await database.db.insert(characterMaterials).values(
      MATERIAL_IDS.map((materialId) => ({
        characterId: id,
        materialId,
        quantity: realistic ? 10 * level : 200,
      })),
    );
    const area = AREAS.find(([min, a]) => level >= min && a !== 'ashenPass')![1];
    heroes.push({ token, id, classId, level, area, tier, filter: n % 2 === 0, n, guild: null });
  }
}

// Ticket T.7 (`--alts`): the accounts of the level-21 and level-23 heroes get a second hero of the
// next class at level 14. Only one hero of an account farms at a time: the alt takes the night.
const altHeroes: Hero[] = [];
if (alts) {
  for (const main of heroes.filter((h) => h.level === 21 || h.level === 23)) {
    n += 1;
    const classId = CLASS_IDS[(CLASS_IDS.indexOf(main.classId) + 1) % CLASS_IDS.length]!;
    const created = await app.inject({
      method: 'POST',
      url: '/api/characters',
      payload: {
        name: `Simalt${String.fromCharCode(97 + (n % 26))}${String.fromCharCode(97 + Math.floor(n / 26))}`,
        classId,
        appearance: { banner: 'ash' },
      },
      cookies: { [SESSION_COOKIE]: main.token },
    });
    const id = created.json<{ character: { id: string } }>().character.id;
    await makeCryptReady(database.db, id, classId, 14, { rarityId: 'uncommon' });
    await database.db
      .update(characters)
      .set({ gold: 1_500 * 14, progress: { gravewardenDefeated: false, cryptTierCleared: 0 } })
      .where(eq(characters.id, id));
    await database.db
      .insert(characterMaterials)
      .values(MATERIAL_IDS.map((materialId) => ({ characterId: id, materialId, quantity: 140 })));
    const alt: Hero = {
      ...main,
      id,
      classId,
      level: 14,
      area: 'blackwater',
      tier: 0,
      n,
      main,
    };
    main.alt = alt;
    altHeroes.push(alt);
    // Creating a hero selects it; the main plays the day.
    await app.inject({
      method: 'POST',
      url: `/api/characters/${main.id}/select`,
      cookies: { [SESSION_COOKIE]: main.token },
    });
    if (alt.filter) {
      await send(alt, 'POST', '/loot-filter', {
        rules: {
          action: 'salvage',
          belowRarity: 'rare',
          wantedAffixes: [],
          wantedEffects: [],
          include: [],
        },
      });
    }
  }
}

for (const [i, h] of heroes.entries()) {
  if (h.filter) {
    await send(h, 'POST', '/loot-filter', {
      rules: {
        action: i % 4 === 1 ? 'salvage' : 'sell',
        belowRarity: 'rare',
        wantedAffixes: [],
        wantedEffects: [],
        include: [],
      },
    });
  }
  if (h.level < 5) await send(h, 'POST', '/quests', { kind: 'story', questId: 'furrowsOfTheDead' });
  await send(h, 'POST', '/activity', { areaId: h.area });
}

const unexpected: string[] = [];
const expectOk = (what: string, status: number, body: string) => {
  if (status >= 300 && !unexpected.some((u) => u.startsWith(`${what}:`))) {
    unexpected.push(`${what}: ${status} ${body.slice(0, 160)}`);
  }
};

type ItemRow = typeof itemInstances.$inferSelect;
const packOf = async (h: Hero): Promise<ItemRow[]> =>
  database.db.select().from(itemInstances).where(eq(itemInstances.characterId, h.id));
/** Ticket T.7: out of the pack (warehouse, shelf, a trade's escrow), or held after a trade. */
const away = (i: ItemRow) => i.inWarehouse || i.onShelf || i.escrowOfferId !== null;
const held = (i: ItemRow) => i.holdUntil !== null && i.holdUntil.getTime() > nowMs;

/**
 * The realistic player's visit (ticket B.2), after every settlement: wear any find of a better
 * rarity than what the slot holds, sell commons and uncommons, salvage rares and epics (materials
 * for the Forge), then upgrade worn gear, lowest level first, until gold or materials run out.
 */
async function visit(h: Hero): Promise<void> {
  let inv = await packOf(h);
  const worn = new Map(inv.filter((i) => i.equippedSlot).map((i) => [i.equippedSlot!, i]));
  for (const item of inv.filter((i) => i.equippedSlot === null && !away(i))) {
    if ((RARITY_RANK[item.rarityId] ?? 0) < 2) continue;
    const slots = equipmentSlotsForKind(getItemBase(item.baseId).slot);
    const slot = slots
      .map((s) => ({ s, w: worn.get(s) }))
      .sort((a, b) => (a.w ? power(a.w) : -1) - (b.w ? power(b.w) : -1))[0];
    if (!slot || (slot.w && power(slot.w) * 1.1 >= power(item))) continue;
    const res = await send(h, 'POST', `/items/${item.id}/equip`, { slot: slot.s });
    if (res.statusCode === 200) worn.set(slot.s, item);
  }
  inv = await packOf(h);
  let loose = inv.filter((i) => i.equippedSlot === null && !i.locked && !away(i) && !held(i));
  // Ticket T.7: an alt shelves what its main can use; a main gifts what a guildmate can use.
  if (h.main && trader) {
    await trader.shelfDeposit(h, loose);
    inv = await packOf(h);
    loose = inv.filter((i) => i.equippedSlot === null && !i.locked && !away(i) && !held(i));
  } else if (trader) {
    const given = await trader.giftItems(h, loose);
    loose = loose.filter((i) => !given.has(i.id));
  }
  const sell = loose.filter((i) => RARITY_RANK[i.rarityId]! <= 1).map((i) => i.id);
  // Rares, epics and plain Legendaries it does not wear; set pieces, Mythics and Void are kept.
  const salvage = loose
    .filter((i) => {
      const rank = RARITY_RANK[i.rarityId]!;
      return rank >= 2 && rank <= 4 && !i.setId && !i.mythicId && !i.variant;
    })
    .map((i) => i.id);
  if (sell.length > 0)
    expectOk('sell', (await send(h, 'POST', '/merchant/sell', { itemIds: sell })).statusCode, '');
  if (salvage.length > 0)
    expectOk(
      'salvage',
      (await send(h, 'POST', '/forge/salvage', { itemIds: salvage })).statusCode,
      '',
    );
  const gear = inv
    .filter((i) => i.equippedSlot !== null && !held(i))
    .sort((a, b) => a.upgradeLevel - b.upgradeLevel);
  const level = new Map(gear.map((g) => [g.id, g.upgradeLevel]));
  for (let attempts = 0; attempts < 60 && gear.length > 0; attempts++) {
    gear.sort((a, b) => level.get(a.id)! - level.get(b.id)!);
    const target = gear[0]!;
    if (level.get(target.id)! >= 10) break;
    const r = await send(h, 'POST', '/forge/upgrade', { itemId: target.id });
    if (r.statusCode !== 200) break;
    const after = r.json<{ outcome: { upgradeLevel: number } }>().outcome.upgradeLevel;
    level.set(target.id, after);
  }
}

// --- Ticket B.3: the Phase 4 economy for the realistic player (`--social on`).

const api = (h: Hero, method: 'GET' | 'POST', url: string, payload?: object) =>
  app.inject({
    method,
    url,
    ...(payload ? { payload } : {}),
    headers: method === 'POST' ? { 'idempotency-key': randomUUID() } : {},
    cookies: { [SESSION_COOKIE]: h.token },
  });
/** Answers that are part of normal play, not a sign the simulation is broken. */
const EXPECTED_REFUSALS = new Set([
  'contribution_capped',
  'nothing_to_claim',
  'no_attempts_left',
  'hero_too_low',
  'warehouse_closed',
  'stage_changed',
  'project_complete',
]);
const expectPlay = (what: string, res: { statusCode: number; body: string }) => {
  if (res.statusCode < 300) return;
  const code = (() => {
    try {
      return (JSON.parse(res.body) as { error?: { code?: string } }).error?.code ?? '';
    } catch {
      return '';
    }
  })();
  if (!EXPECTED_REFUSALS.has(code)) expectOk(what, res.statusCode, res.body);
};
/** What happened in the social economy, printed at the end (the report holds the gold flows). */
const log: string[] = [];
const dayOf = () => new Date(nowMs).toISOString().slice(0, 10);

async function worldFlags(
  h: Hero,
): Promise<{ warehouseRestored: boolean; ashenPassCleared: boolean }> {
  return (await api(h, 'GET', '/api/world')).json<{
    flags: { warehouseRestored: boolean; ashenPassCleared: boolean };
  }>().flags;
}

/** Founds two guilds through the API (5,000 gold each); members are added directly (shortcut). */
async function formGuilds(): Promise<void> {
  // A small guild of four late-game heroes (one per class) and a large one of everyone from
  // level 7; the level-1 heroes stay guildless.
  const small = heroes.filter((h) => h.level === 21);
  const large = heroes.filter((h) => h.level >= 7 && h.level !== 21);
  for (const [name, tag, members, kind] of [
    ['Ash Company', 'ASH', small, 'small'],
    ['Graumark Wardens', 'GRW', large, 'large'],
  ] as const) {
    const leader = members[0]!;
    const res = await api(leader, 'POST', '/api/guilds', { characterId: leader.id, name, tag });
    expectPlay('guild', res);
    if (res.statusCode !== 201) continue;
    const accountOf = async (m: Hero) => {
      const [c] = await database.db
        .select({ accountId: characters.accountId })
        .from(characters)
        .where(eq(characters.id, m.id));
      return c!.accountId;
    };
    const [led] = await database.db
      .select({ guildId: guildMembers.guildId })
      .from(guildMembers)
      .where(eq(guildMembers.accountId, await accountOf(leader)));
    const guildId = led!.guildId;
    const accounts = await Promise.all(members.slice(1).map(accountOf));
    if (accounts.length > 0) {
      await database.db.insert(guildMembers).values(
        accounts.map((accountId) => ({
          accountId,
          guildId,
          role: 'member' as const,
          joinedAt: new Date(nowMs),
        })),
      );
    }
    for (const m of members) m.guild = kind;
    log.push(`${dayOf()}: ${name} founded (${members.length} members)`);
  }
}

async function heroState(h: Hero) {
  const [c] = await database.db.select().from(characters).where(eq(characters.id, h.id));
  return c!;
}

/** Moves to the best open area for the hero's level (the Pass once the town has cleared it). */
async function moveUp(
  h: Hero,
  flags: { warehouseRestored: boolean; ashenPassCleared: boolean },
): Promise<void> {
  const c = await heroState(h);
  h.level = c.level;
  const progress = { gravewardenDefeated: false, ...(c.progress as object) };
  const world = { ...NO_WORLD_FLAGS, ...flags };
  const best = AREAS.find(([, a]) =>
    isAreaUnlocked(a as AreaId, { level: c.level, world }, progress),
  )![1];
  // The deepest crypt tier open to it (a realistic player goes deeper as it can).
  for (const t of [3, 2, 1] as const) {
    if (isDungeonUnlocked('namelessCrypt', { level: c.level, world }, progress, t)) {
      h.tier = Math.max(h.tier, t) as Hero['tier'];
      break;
    }
  }
  if (best === h.area) return;
  const res = await send(h, 'POST', '/activity', { areaId: best });
  expectPlay('move', res);
  if (res.statusCode < 300) {
    if (best === 'ashenPass' && !log.some((l) => l.includes(`${h.n} reaches the Pass`))) {
      log.push(`${dayOf()}: hero ${h.n} (${h.classId} ${c.level}) reaches the Pass`);
    }
    h.area = best;
  }
}

/** A daily share to the open community project: up to the cap, a quarter of its gold at most. */
async function contribute(h: Hero): Promise<void> {
  for (let round = 0; round < 3; round++) {
    const board = (await api(h, 'GET', '/api/community/projects')).json<{
      projects: {
        id: string;
        status: string;
        stageIndex: number;
        stages: {
          id: string;
          needs: {
            resource: string;
            required: number;
            delivered: number;
            cap: number;
            givenToday: number;
          }[];
        }[];
      }[];
    }>();
    const project = board.projects.find((p) => p.status === 'open');
    if (!project) return;
    const stage = project.stages[project.stageIndex]!;
    const c = await heroState(h);
    const held = new Map<string, number>(
      (
        await database.db
          .select()
          .from(characterMaterials)
          .where(eq(characterMaterials.characterId, h.id))
      ).map((m) => [m.materialId, m.quantity]),
    );
    const offer = stage.needs
      .map((n) => {
        const left = Math.min(n.cap - n.givenToday, n.required - n.delivered);
        const have = n.resource === 'gold' ? Math.floor(c.gold / 4) : (held.get(n.resource) ?? 0);
        return { resource: n.resource, amount: Math.min(left, have) };
      })
      .filter((o) => o.amount > 0);
    if (offer.length === 0) return;
    const res = await api(h, 'POST', `/api/community/projects/${project.id}/contribute`, {
      characterId: h.id,
      stageId: stage.id,
      offer,
    });
    expectPlay('contribute', res);
    if (res.statusCode !== 200) return;
    const out = res.json<{ stagesCompleted: string[]; projectCompleted: boolean }>();
    for (const s of out.stagesCompleted) log.push(`${dayOf()}: ${project.id} · ${s} done`);
    if (out.stagesCompleted.length === 0) return;
  }
}

/** Stores keepsakes (set pieces, Mythics, Void) in the warehouse; buys shelves when it is full. */
async function store(h: Hero): Promise<void> {
  const res = await send(h, 'GET', '/warehouse');
  if (res.statusCode !== 200) return expectPlay('warehouse', res);
  const wh = res.json<{
    level: number;
    capacity: number;
    items: unknown[];
    nextUpgrade: { gold: number } | null;
    gold: number;
  }>();
  let keep = (await packOf(h)).filter(
    (i) => i.equippedSlot === null && !away(i) && !held(i) && (i.setId || i.mythicId || i.variant),
  );
  // Ticket T.7: keepsakes its class can't wear go to a guildmate who can, before they're stored.
  if (trader && !h.main && keep.length > 0) {
    const given = await trader.giftItems(h, keep);
    keep = keep.filter((i) => !given.has(i.id));
  }
  if (keep.length === 0) return;
  let free = wh.capacity - wh.items.length;
  if (free < keep.length && wh.nextUpgrade && wh.gold >= wh.nextUpgrade.gold) {
    const up = await send(h, 'POST', '/warehouse/upgrade', { level: wh.level });
    expectPlay('warehouse upgrade', up);
    if (up.statusCode === 200) {
      const after = up.json<{ warehouse: { capacity: number; level: number } }>().warehouse;
      free = after.capacity - wh.items.length;
      log.push(`${dayOf()}: hero ${h.n} warehouse level ${after.level}`);
    }
  }
  const ids = keep.slice(0, Math.max(0, free)).map((i) => i.id);
  if (ids.length > 0)
    expectPlay('deposit', await send(h, 'POST', '/warehouse/deposit', { itemIds: ids }));
}

const bossStages = new Map<string, number>();
async function fightGuildBoss(h: Hero): Promise<void> {
  if (!h.guild || h.level < 10) return;
  const res = await api(h, 'POST', '/api/guild/boss/attempts', { characterId: h.id });
  expectPlay('guild boss', res);
  if (res.statusCode !== 201) return;
  const a = res.json<{ attempt: { week: string; newStages: number[] } }>().attempt;
  for (const s of a.newStages) {
    const key = `${a.week} ${h.guild}`;
    bossStages.set(key, Math.max(bossStages.get(key) ?? 0, s));
    log.push(`${dayOf()}: ${h.guild} guild breaks boss stage ${s}`);
  }
}

/** The Warden's Watch once the town has cleared the Pass: one run a day (its own hoard cooldown). */
async function watch(
  h: Hero,
  flags: { warehouseRestored: boolean; ashenPassCleared: boolean },
): Promise<void> {
  const c = await heroState(h);
  const progress = { gravewardenDefeated: false, ...(c.progress as object) };
  const world = { ...NO_WORLD_FLAGS, ...flags };
  if (!isDungeonUnlocked('ashenWatch', { level: c.level, world }, progress, 1)) return;
  const entered = await send(h, 'POST', '/dungeon', { dungeonId: 'ashenWatch', tier: 1 });
  expectPlay('watch', entered);
  if (entered.statusCode !== 201) return;
  const endsAt = Date.parse(entered.json<{ run: { endsAt: string } }>().run.endsAt);
  nowMs = Math.max(nowMs, endsAt);
  expectOk('watch claim', (await send(h, 'POST', '/dungeon/claim')).statusCode, '');
  await send(h, 'POST', '/activity', { areaId: h.area });
}

/** One social visit: before the Forge spends the purse (visit()). */
async function socialVisit(h: Hero, day: number, visitNo: number): Promise<void> {
  const flags = await worldFlags(h);
  await moveUp(h, flags);
  if (flags.warehouseRestored) await store(h);
  if (visitNo === 0) await contribute(h);
  // Three attempts a week: Monday, Wednesday and Friday mornings.
  if (visitNo === 0 && [0, 2, 4].includes(day % 7)) await fightGuildBoss(h);
  if (visitNo === 4 && h.guild) {
    expectPlay('boss claim', await api(h, 'POST', '/api/guild/boss/claim', { characterId: h.id }));
  }
}
if (social) await formGuilds();
/** Ticket T.7 (`--trading on|all`): trading and the shelf through the real API. */
const trader = trading
  ? createSimTrading({
      app,
      database,
      now: () => nowMs,
      heroes,
      settings: simTradingSettings(tradingMode),
      power,
      unexpected: (what, status, body) => expectOk(what, status, body),
    })
  : null;
if (trader) {
  await trader.open();
  for (const code of ['insufficient_gold', 'insufficient_materials']) EXPECTED_REFUSALS.add(code);
}

/** Ticket B.4 (`--snapshots`): every hero's 5.1 scoring input at the end of game day `day`. */
async function snapshot(day: number): Promise<void> {
  const snapDir = join(dir, 'snapshots');
  mkdirSync(snapDir, { recursive: true });
  const rows = await database.db.select().from(characters);
  const out = [];
  for (const c of rows) {
    const h = heroes.find((x) => x.id === c.id);
    if (h) out.push({ n: h.n, guild: h.guild, input: await scoringInput(app, database.db, c) });
  }
  writeFileSync(join(snapDir, `day-${String(day).padStart(2, '0')}.json`), JSON.stringify(out));
}
// Day 0: the heroes as they start (the base of a season board: only heroes that rose are listed).
if (args.snapshots) await snapshot(0);

for (let day = 0; day < days; day++) {
  // Realistic: five visits a day (morning, three in the day, late evening; the night is capped
  // at 3 h), so about 15 credited hours. Crude: a settle every 3 h around the clock (24 h).
  for (const [visitNo, gap] of (realistic ? [9, 4, 4, 4, 3] : [3, 3, 3, 3, 3, 3, 3, 3]).entries()) {
    nowMs += gap * HOUR;
    // Ticket T.7: in the morning each alt comes back from its night (and fills the shelf), then
    // its main is sent out again.
    if (visitNo === 0 && day > 0) {
      for (const alt of altHeroes) {
        const r = await send(alt, 'POST', '/activity/settle');
        expectOk('settle', r.statusCode, r.body);
        await visit(alt);
        await api(alt.main!, 'POST', `/api/characters/${alt.main!.id}/select`);
        expectOk(
          'main out',
          (await send(alt.main!, 'POST', '/activity', { areaId: alt.main!.area })).statusCode,
          '',
        );
      }
    }
    for (const h of heroes) {
      const r = await send(h, 'POST', '/activity/settle');
      expectOk('settle', r.statusCode, r.body);
      if (social) await socialVisit(h, day, visitNo);
      if (trader) {
        await trader.checkIn(h);
        if (visitNo === 0) await trader.dailyGifts(h, day);
        if (visitNo === 0 && h.alt) await trader.shelfWithdraw(h);
      }
      if (realistic) await visit(h);
    }
  }
  for (const h of heroes) {
    // Tidy the pack: sell the commons and uncommons, salvage the rares, keep the rest.
    const inv = await database.db
      .select()
      .from(itemInstances)
      .where(eq(itemInstances.characterId, h.id));
    const loose = inv.filter((i) => i.equippedSlot === null && !i.locked && !away(i) && !held(i));
    const sell = loose
      .filter((i) => i.rarityId === 'common' || i.rarityId === 'uncommon')
      .map((i) => i.id);
    const salvage = loose
      .filter((i) => i.rarityId === 'rare')
      .slice(0, 10)
      .map((i) => i.id);
    if (sell.length > 0)
      expectOk('sell', (await send(h, 'POST', '/merchant/sell', { itemIds: sell })).statusCode, '');
    if (salvage.length > 0)
      expectOk(
        'salvage',
        (await send(h, 'POST', '/forge/salvage', { itemIds: salvage })).statusCode,
        '',
      );

    // Forge an epic or better from the pack.
    const target = loose.find((i) => ['epic', 'legendary', 'mythic'].includes(i.rarityId));
    if (target && !realistic) {
      for (let k = 0; k < 4; k++) await send(h, 'POST', '/forge/upgrade', { itemId: target.id });
      await send(h, 'POST', '/forge/reroll', { itemId: target.id, affixIndex: 0 });
      await send(h, 'POST', '/forge/improve', { itemId: target.id, affixIndex: 0 });
    }
    if (h.level >= 5 && day === 0)
      await send(h, 'POST', '/forge/craft', { recipeId: 'fieldsmithWork', slot: 'weapon' });

    // One merchant purchase a day.
    const stock = (await send(h, 'GET', '/merchant')).json<{ offers: { offerId: string }[] }>();
    if (stock.offers[0])
      await send(h, 'POST', '/merchant/buy', { offerId: stock.offers[0].offerId });

    // Quests: turn in what is ready; take and finish a contract.
    const board = (await send(h, 'GET', '/quests')).json<{
      quests: { id: string; status: string; objectives: object[] }[];
      contracts: { offers: { slot: number; rewardSlots: string[] }[] };
    }>();
    for (const q of board.quests.filter((x) => x.status === 'ready')) {
      await send(h, 'POST', `/quests/${q.id}/turn-in`);
    }
    const offer = board.contracts.offers[0];
    if (offer) {
      const accepted = await send(h, 'POST', '/quests', {
        kind: 'contract',
        slot: offer.slot,
        ...(offer.rewardSlots[0] ? { rewardSlot: offer.rewardSlots[0] } : {}),
      });
      if (accepted.statusCode === 201) {
        const q = accepted
          .json<{ quests: { id: string; status: string; objectives: { count?: number }[] }[] }>()
          .quests.find((x) => x.status === 'active');
        if (q) {
          // Test shortcut: the contract's objectives count as done.
          await database.db
            .update(characterQuests)
            .set({ progress: q.objectives.map((o) => o.count ?? 1) })
            .where(eq(characterQuests.id, q.id));
          await send(h, 'POST', `/quests/${q.id}/turn-in`);
        }
      }
    }

    // The crypt (entering stops farming); claim, then go back to the fields.
    if (h.tier > 0) {
      const entered = await send(h, 'POST', '/dungeon', {
        dungeonId: 'namelessCrypt',
        tier: h.tier,
      });
      expectOk('crypt', entered.statusCode, entered.body);
      if (entered.statusCode === 201) {
        const endsAt = Date.parse(entered.json<{ run: { endsAt: string } }>().run.endsAt);
        // The clock only moves forward: the run's few minutes pass for everyone.
        nowMs = Math.max(nowMs, endsAt);
        expectOk('claim', (await send(h, 'POST', '/dungeon/claim')).statusCode, '');
      }
      await send(h, 'POST', '/activity', { areaId: h.area });
    }
    if (social) await watch(h, await worldFlags(h));
  }
  if (args.snapshots) await snapshot(day + 1);
  // Ticket T.7: the alts farm the night (the account's one activity moves to them).
  for (const alt of altHeroes) {
    const flags = await worldFlags(alt);
    const c = await heroState(alt);
    alt.level = c.level;
    const world = { ...NO_WORLD_FLAGS, ...flags };
    const progress = { gravewardenDefeated: false, ...(c.progress as object) };
    alt.area = AREAS.find(([, a]) =>
      isAreaUnlocked(a as AreaId, { level: c.level, world }, progress),
    )![1];
    await api(alt, 'POST', `/api/characters/${alt.id}/select`);
    expectOk(
      'alt out',
      (await send(alt, 'POST', '/activity', { areaId: alt.area })).statusCode,
      '',
    );
  }
}

await app.close();
await database.close();
console.log(`Simulated ${heroes.length} heroes for ${days} game days into ${dir}.`);
if (social) {
  console.log(`Social economy (ticket B.3):\n  ${log.join('\n  ')}`);
  for (const [k, v] of bossStages) console.log(`  guild boss week ${k}: stage ${v}`);
}
if (alts) console.log(`Alts (ticket T.7): ${altHeroes.length} accounts with a second hero.`);
if (trader)
  console.log(
    `Trading (ticket T.7, --trading ${tradingMode}):\n  ${trader.summary().join('\n  ')}`,
  );
if (unexpected.length > 0) console.log(`Unexpected answers:\n  ${unexpected.join('\n  ')}`);
console.log(`Report: PLAYTEST_DATA_DIR=${args.dir} pnpm report:telemetry`);
