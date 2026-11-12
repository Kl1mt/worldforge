// Captures ticket 8.2, the Hollow Reach's second area, the Hollow Deep, its region boss and the
// lanterns of the deep, at desktop (1440) and mobile (390):
// - `deep-sealed`: the world map with the Hollow Deep selected, sealed until the lanterns are lit;
// - `deep-works`: the town works with the lanterns of the deep open (the Forgeward done);
// - `deep-era`: the town in the Lantern Vigil once they are lit;
// - `deep-open`: the map with the Deep open;
// - `deep-area`: the hero farming the Deep (the Marches' kin in the Deep's tint);
// - `throne-door`: the Hollow Throne's door (the Sovereign, his mechanics, the week's modifier);
// - `throne-run`: a run under way, the log with his siphon and crown-blow;
// - `deep-forge`: the Forge's Crownforged Work at the lantern smithy's price;
// - `deep-progress`: the PvE Progress board.
// Auth, farming, runs and boards are real (the dev server on PostgreSQL, real time). The hero's
// level, progress, gear and materials are written straight into the database; the earlier world
// flags are set before the server starts (`--flags`), the lanterns' flag through the admin world
// tool (audited, invalidates the cache). Use a scratch database:
//   DATABASE_URL=postgres://…/wf_shots pnpm db:migrate && pnpm build
//   DATABASE_URL=postgres://…/wf_shots node tools/screenshots/hollow-deep.mjs --flags
//   DATABASE_URL=postgres://…/wf_shots SESSION_COOKIE_SECURE=false pnpm --filter @worldforge/server dev
//   pnpm --filter @worldforge/web dev
//   DATABASE_URL=postgres://…/wf_shots node tools/screenshots/hollow-deep.mjs [baseUrl] [outDir]
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const serverRequire = createRequire(resolve('apps/server/package.json'));
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require(process.env.PLAYWRIGHT_PATH ?? '/opt/node-tools/node_modules/playwright');
}
const pg = serverRequire('pg');
const core = await import(
  pathToFileURL(resolve(import.meta.dirname, '../../packages/game-core/dist/index.js')).href
);

const baseUrl = process.argv[2] ?? 'http://localhost:5173';
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-8');
const PASSWORD = 'lanterns-in-the-deep-42';
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

async function shoot(page, vp, name) {
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  if (overflow) console.warn(`! horizontal overflow on ${name} @ ${vp.name}`);
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: vp.width, height: Math.max(vp.height, height) });
  const file = `${outDir}/${name}-${vp.name}.png`;
  await page.screenshot({ path: file });
  await page.setViewportSize({ width: vp.width, height: vp.height });
  console.log(`saved ${file}`);
}

if (process.argv[2] === '--flags') {
  await db.query(
    `insert into world_flags (flag_id, set_at) values ('warehouseRestored', now()),
       ('ashenPassCleared', now()), ('forgewardRaised', now())
     on conflict do nothing`,
  );
  await db.end();
  process.exit(0);
}

async function insertItem(characterId, item, slot, upgradeLevel) {
  await db.query(
    `insert into item_instances (id, character_id, base_id, rarity_id, item_level, affixes,
       seed, equipped_slot, source, upgrade_level, effect_id, effect_roll)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'screenshot', $9, $10, $11)`,
    [
      randomUUID(),
      characterId,
      item.baseId,
      item.rarityId,
      item.itemLevel,
      JSON.stringify(item.affixes),
      item.seed,
      slot,
      upgradeLevel,
      item.effectId ?? null,
      item.effectRoll ?? null,
    ],
  );
}

/** A level-46 warrior who slew the Forge Tyrant, in the Marches' Legendaries +10 (item level 47). */
async function hero(browser, vp, displayName, name) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (err) => console.error(`! page error @ ${vp.name}: ${err.message}`));
  const email = `${displayName.replace(/\s/g, '').toLowerCase()}-${Date.now()}@graumark.test`;
  const reg = await ctx.request.post(`${baseUrl}/api/auth/register`, {
    data: { email, displayName, password: PASSWORD },
  });
  if (!reg.ok()) throw new Error(`register: ${reg.status()} ${await reg.text()}`);
  const created = await ctx.request.post(`${baseUrl}/api/characters`, {
    data: { name, classId: 'warrior', appearance: { banner: 'ember' } },
  });
  if (!created.ok()) throw new Error(`character: ${created.status()} ${await created.text()}`);
  const { character } = await created.json();
  await db.query(
    `update characters set level = 46, gold = 64000,
       progress = '{"gravewardenDefeated": true, "cryptTierCleared": 4, "ashenWardenDefeated": true, "forgeTyrantDefeated": true}'::jsonb
     where id = $1`,
    [character.id],
  );
  const bases = core.ITEM_BASES.filter(
    (b) => !b.unique && b.tier <= 5 && core.canClassUseItem(b, 'warrior') && b.minItemLevel <= 47,
  ).sort((a, b) => b.tier - a.tier || b.minItemLevel - a.minItemLevel);
  const taken = new Set();
  let seed = 8200;
  for (const base of bases) {
    if (taken.has(base.slot)) continue;
    taken.add(base.slot);
    for (const slot of core.equipmentSlotsForKind(base.slot)) {
      const item = core.generateItem({
        seed: seed++,
        itemLevel: 47,
        baseId: base.id,
        rarityId: 'legendary',
        classId: 'warrior',
      });
      await insertItem(character.id, item, slot, 10);
    }
  }
  // The Crownforged Work's inputs (a crown shard from a hoard, ore and shards from the Marches).
  for (const [materialId, quantity] of [
    ['crownShard', 1],
    ['ironOre', 160],
    ['soulShard', 40],
  ]) {
    await db.query(
      `insert into character_materials (character_id, material_id, quantity) values ($1, $2, $3)
       on conflict (character_id, material_id) do update set quantity = excluded.quantity`,
      [character.id, materialId, quantity],
    );
  }
  await page.goto(`${baseUrl}/#/hub`);
  await page.waitForLoadState('networkidle');
  const hide = page.getByRole('button', { name: 'Hide guide' });
  if (await hide.isVisible().catch(() => false)) await hide.click();
  return { ctx, page, characterId: character.id };
}

async function open(page, route) {
  await page.goto(`${baseUrl}/#/${route}`);
  await page.reload();
  await page.waitForLoadState('networkidle');
  // The "while you were away" summary can open over any screen; close it for the shot.
  const away = page.locator('dialog.return[open]');
  if (await away.isVisible().catch(() => false)) {
    await page.keyboard.press('Escape');
    await away.waitFor({ state: 'hidden' }).catch(() => {});
  }
}

async function openMapAt(page, placeName) {
  await open(page, 'map');
  await page
    .getByRole('button', { name: new RegExp(placeName) })
    .first()
    .click();
  await sleep(400);
}

mkdirSync(outDir, { recursive: true });
const browser = await playwright.chromium.launch();
const heroes = [];
for (const vp of VIEWPORTS) {
  const h = await hero(
    browser,
    vp,
    vp.name === 'desktop' ? 'Lanternwright' : 'Deepkin',
    vp.name === 'desktop' ? 'Isolde' : 'Bram',
  );
  heroes.push({ vp, ...h });
  await openMapAt(h.page, 'The Hollow Deep');
  await shoot(h.page, vp, 'deep-sealed');
  await open(h.page, 'works');
  await sleep(800);
  await shoot(h.page, vp, 'deep-works');
}

// The lanterns are lit (the admin world tool, as the owner would on a test setup).
const desk = heroes.find((h) => h.vp.name === 'desktop');
await db.query(
  `update accounts set role = 'admin' where id = (select account_id from characters where id = $1)`,
  [desk.characterId],
);
const lit = await desk.ctx.request.post(`${baseUrl}/api/admin/world/flags/deepLanternsLit`, {
  data: { set: true, confirm: 'deepLanternsLit', reason: 'screenshots of the Hollow Deep' },
  headers: { 'idempotency-key': randomUUID() },
});
if (!lit.ok()) throw new Error(`flag: ${lit.status()} ${await lit.text()}`);

for (const { vp, page } of heroes) {
  await open(page, 'hub');
  await sleep(800);
  await shoot(page, vp, 'deep-era');
  await openMapAt(page, 'The Hollow Deep');
  await shoot(page, vp, 'deep-open');
}
for (const { ctx, characterId } of heroes) {
  const farm = await ctx.request.post(`${baseUrl}/api/characters/${characterId}/activity`, {
    data: { areaId: 'hollowDeep' },
  });
  if (!farm.ok()) throw new Error(`farm: ${farm.status()} ${await farm.text()}`);
}
for (const { vp, page } of heroes) {
  await open(page, 'area');
  await sleep(6_000);
  await shoot(page, vp, 'deep-area');
}
// Level 50 for the Throne (its door opens at 48).
for (const { characterId } of heroes) {
  await db.query(`update characters set level = 50, experience = 0 where id = $1`, [characterId]);
}
for (const { vp, page, ctx, characterId } of heroes) {
  await ctx.request.post(`${baseUrl}/api/characters/${characterId}/activity/stop`);
  await open(page, 'throne');
  await sleep(800);
  await shoot(page, vp, 'throne-door');
  const run = await ctx.request.post(`${baseUrl}/api/characters/${characterId}/dungeon`, {
    data: { dungeonId: 'hollowThrone', tier: 1 },
  });
  if (!run.ok()) throw new Error(`run: ${run.status()} ${await run.text()}`);
}
// The descent (30 s), then into the fight: the siphon and a crown-blow are logged by then.
await sleep(52_000);
for (const { vp, page } of heroes) {
  await open(page, 'throne');
  await sleep(1_500);
  await shoot(page, vp, 'throne-run');
}
for (const { vp, page } of heroes) {
  await open(page, 'forge');
  await sleep(800);
  const recipe = page.getByText('Crownforged Work').first();
  await recipe.scrollIntoViewIfNeeded().catch(() => console.warn('! no Crownforged Work'));
  await sleep(300);
  await shoot(page, vp, 'deep-forge');
  await open(page, 'boards/pveProgress');
  await sleep(800);
  await shoot(page, vp, 'deep-progress');
}

await browser.close();
await db.end();
