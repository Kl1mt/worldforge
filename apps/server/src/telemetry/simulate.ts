// `pnpm --filter @worldforge/server telemetry:simulate [-- --dir .telemetry-sample --days 3
//   --play realistic|crude]`
// (ticket 3.8): plays a small simulated population through the real API on a PGlite database, so
// the telemetry report has something to show without a playtest. Ticket B.2 added the default
// `realistic` player (see `docs/TELEMETRY.md`): it tidies the pack, wears its best finds and
// spends its gold at the Forge every session, starting from a purse it could have earned. `crude`
// is 3.8's player (a fat starting purse, one tidy and one forged item a day). Then:
//
//   PLAYTEST_DATA_DIR=.telemetry-sample pnpm report:telemetry
//
// Dev tool only (not run in CI). Seeds are server-random, so numbers vary a little between runs.
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { eq } from 'drizzle-orm';
import {
  CLASS_IDS,
  MATERIAL_IDS,
  equipmentSlotsForKind,
  getItemBase,
  type ClassId,
  type RarityId,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { characterMaterials, characterQuests, characters, itemInstances } from '../db/schema.js';
import { createPgliteDatabase } from '../test/db.js';
import { makeCryptReady } from '../test/dungeon.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const { values: args } = parseArgs({
  options: {
    dir: { type: 'string', default: '.telemetry-sample' },
    days: { type: 'string', default: '3' },
    play: { type: 'string', default: 'realistic' },
  },
  args: process.argv.slice(2).filter((a) => a !== '--'),
});
const dir = resolve(process.env.INIT_CWD ?? REPO_ROOT, args.dir!);
const days = Math.max(1, Number(args.days) || 3);
const realistic = args.play !== 'crude';
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
  auth: { registerRateLimit: { max: 10_000, timeWindowMs: 60_000 } },
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
    const area = AREAS.find(([min]) => level >= min)![1];
    heroes.push({ token, id, classId, level, area, tier, filter: n % 2 === 0 });
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

/**
 * The realistic player's visit (ticket B.2), after every settlement: wear any find of a better
 * rarity than what the slot holds, sell commons and uncommons, salvage rares and epics (materials
 * for the Forge), then upgrade worn gear, lowest level first, until gold or materials run out.
 */
async function visit(h: Hero): Promise<void> {
  let inv = await packOf(h);
  const worn = new Map(inv.filter((i) => i.equippedSlot).map((i) => [i.equippedSlot!, i]));
  for (const item of inv.filter((i) => i.equippedSlot === null)) {
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
  const loose = inv.filter((i) => i.equippedSlot === null && !i.locked);
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
    .filter((i) => i.equippedSlot !== null)
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

for (let day = 0; day < days; day++) {
  // Realistic: five visits a day (morning, three in the day, late evening; the night is capped
  // at 3 h), so about 15 credited hours. Crude: a settle every 3 h around the clock (24 h).
  for (const gap of realistic ? [9, 4, 4, 4, 3] : [3, 3, 3, 3, 3, 3, 3, 3]) {
    nowMs += gap * HOUR;
    for (const h of heroes) {
      const r = await send(h, 'POST', '/activity/settle');
      expectOk('settle', r.statusCode, r.body);
      if (realistic) await visit(h);
    }
  }
  for (const h of heroes) {
    // Tidy the pack: sell the commons and uncommons, salvage the rares, keep the rest.
    const inv = await database.db
      .select()
      .from(itemInstances)
      .where(eq(itemInstances.characterId, h.id));
    const loose = inv.filter((i) => i.equippedSlot === null && !i.locked);
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
  }
}

await app.close();
await database.close();
console.log(`Simulated ${heroes.length} heroes for ${days} game days into ${dir}.`);
if (unexpected.length > 0) console.log(`Unexpected answers:\n  ${unexpected.join('\n  ')}`);
console.log(`Report: PLAYTEST_DATA_DIR=${args.dir} pnpm report:telemetry`);
