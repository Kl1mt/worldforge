// `pnpm --filter @worldforge/server telemetry:simulate [-- --dir .telemetry-sample --days 3]`
// (ticket 3.8): plays a small simulated population through the real API on a PGlite database, so
// the telemetry report has something to show without a playtest. Then:
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
import { CLASS_IDS, MATERIAL_IDS, type ClassId, type RarityId } from '@worldforge/game-core';
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
  },
  args: process.argv.slice(2).filter((a) => a !== '--'),
});
const dir = resolve(process.env.INIT_CWD ?? REPO_ROOT, args.dir!);
const days = Math.max(1, Number(args.days) || 3);

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
        gold: 5_000 * level,
        progress: { gravewardenDefeated: level >= 17, cryptTierCleared: Math.max(0, tier - 1) },
      })
      .where(eq(characters.id, id));
    await database.db
      .insert(characterMaterials)
      .values(MATERIAL_IDS.map((materialId) => ({ characterId: id, materialId, quantity: 200 })));
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

for (let day = 0; day < days; day++) {
  for (let slot = 0; slot < 8; slot++) {
    nowMs += 3 * HOUR;
    for (const h of heroes) {
      const r = await send(h, 'POST', '/activity/settle');
      expectOk('settle', r.statusCode, r.body);
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
    if (target) {
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
