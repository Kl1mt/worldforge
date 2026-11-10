// Captures ticket 6.2, the Cinder Depths and the Forge Tyrant, at desktop (1440) and mobile (390):
// - `depths-sealed`: the world map with the Cinder Depths selected, closed below level 34;
// - `depths-open`: the same map at level 36 (the Depths and the Tyrant's Forge open);
// - `depths-area`: the hero farming the Depths (the Verge's foes in their ember treatment);
// - `forge-door`, `forge-fight`, `forge-reckoning`: the Tyrant's Forge before, during and after a run;
// - `forge-recipe`: the town Forge with Tyrantforged Work (the Tyrant's Ember's sink);
// - `depths-progress`: the PvE Progress board under version 3 (17 milestones);
// - `forge-gallery` (desktop): the admin animation gallery listing the Forge Tyrant as placed.
// Auth, farming, the run and boards are real (the dev server on PostgreSQL, real time). The hero's
// level, progress and gear (generated with game-core) are written straight into the database, and
// so are the town's world flags (set before the server starts, so no cache wait). Use a scratch
// database:
//   DATABASE_URL=postgres://…/wf_shots pnpm db:migrate && pnpm build
//   DATABASE_URL=postgres://…/wf_shots node tools/screenshots/cinder-depths.mjs --flags
//   DATABASE_URL=postgres://…/wf_shots SESSION_COOKIE_SECURE=false pnpm --filter @worldforge/server dev
//   pnpm --filter @worldforge/web dev
//   DATABASE_URL=postgres://…/wf_shots node tools/screenshots/cinder-depths.mjs [baseUrl] [outDir]
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
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-6');
const PASSWORD = 'ashes-and-iron-42';
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
    `insert into world_flags (flag_id, set_at) values ('warehouseRestored', now()), ('ashenPassCleared', now())
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

/** A level-33 warrior who slew the Ashen Warden, in good Verge gear (Legendary +10, item level 33). */
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
    `update characters set level = 33, gold = 64000,
       progress = '{"gravewardenDefeated": true, "cryptTierCleared": 3, "ashenWardenDefeated": true}'::jsonb
     where id = $1`,
    [character.id],
  );
  const bases = core.ITEM_BASES.filter(
    (b) => !b.unique && core.canClassUseItem(b, 'warrior') && b.minItemLevel <= 33,
  ).sort((a, b) => b.tier - a.tier || b.minItemLevel - a.minItemLevel);
  const taken = new Set();
  let seed = 6200;
  for (const base of bases) {
    if (taken.has(base.slot)) continue;
    taken.add(base.slot);
    for (const slot of core.equipmentSlotsForKind(base.slot)) {
      const item = core.generateItem({
        seed: seed++,
        itemLevel: 33,
        baseId: base.id,
        rarityId: 'legendary',
        classId: 'warrior',
      });
      await insertItem(character.id, item, slot, 10);
    }
  }
  // The recipe's ore and soul shards; the ember comes from the Tyrant.
  await db.query(
    `insert into character_materials (character_id, material_id, quantity, updated_at)
     values ($1, 'ironOre', 140, now()), ($1, 'soulShard', 30, now())
     on conflict (character_id, material_id) do update set quantity = excluded.quantity`,
    [character.id],
  );
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
    vp.name === 'desktop' ? 'Slagwright' : 'Emberkin',
    vp.name === 'desktop' ? 'Brand' : 'Tamsin',
  );
  heroes.push({ vp, ...h });
  await openMapAt(h.page, 'The Cinder Depths');
  await shoot(h.page, vp, 'depths-sealed');
}
for (const { characterId } of heroes) {
  await db.query(`update characters set level = 36, experience = 0 where id = $1`, [characterId]);
}
for (const { ctx, characterId } of heroes) {
  const farm = await ctx.request.post(`${baseUrl}/api/characters/${characterId}/activity`, {
    data: { areaId: 'cinderDepths' },
  });
  if (!farm.ok()) throw new Error(`farm: ${farm.status()} ${await farm.text()}`);
}
for (const { vp, page } of heroes) {
  await openMapAt(page, 'The Cinder Depths');
  await shoot(page, vp, 'depths-open');
  await open(page, 'area');
  await sleep(6_000);
  await shoot(page, vp, 'depths-area');
  await open(page, 'tyrant');
  await sleep(500);
  await shoot(page, vp, 'forge-door');
}

// Both heroes descend at once; the fight starts after the 30 s descent.
for (const { page } of heroes) {
  await page.getByRole('button', { name: 'Descend to the anvil' }).click();
}
await sleep(52_000);
for (const { vp, page } of heroes) await shoot(page, vp, 'forge-fight');
for (const { vp, page } of heroes) {
  const claim = page.getByRole('button', { name: 'Claim the spoils' });
  await claim.waitFor({ timeout: 180_000 });
  await claim.click();
  await page.getByRole('heading', { name: /Forge Tyrant falls|keeps his forge/ }).waitFor();
  await sleep(500);
  await shoot(page, vp, 'forge-reckoning');
}
for (const { vp, page } of heroes) {
  await open(page, 'forge');
  await sleep(500);
  const recipe = page.getByText('Tyrantforged Work').first();
  await recipe.scrollIntoViewIfNeeded().catch(() => console.warn('! no recipe'));
  await recipe.click().catch(() => {});
  await sleep(400);
  await shoot(page, vp, 'forge-recipe');
  await open(page, 'boards/pveProgress');
  await sleep(800);
  await shoot(page, vp, 'depths-progress');
}

// The admin gallery (desktop): the Forge Tyrant is placed, under the Tyrant's Forge.
const desk = heroes.find((h) => h.vp.name === 'desktop');
await db.query(
  `update accounts set role = 'admin' where id = (select account_id from characters where id = $1)`,
  [desk.characterId],
);
await desk.page.goto(`${baseUrl}/#/admin/animations`);
await desk.page.reload();
await desk.page.waitForLoadState('networkidle');
await sleep(800);
await desk.page.getByPlaceholder(/wolf, warden/).fill('tyrant');
await sleep(600);
await shoot(desk.page, desk.vp, 'forge-gallery');

await browser.close();
await db.end();
