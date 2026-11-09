// Captures ticket 6.1, the Cinderwastes, at desktop (1440) and mobile (390):
// - `cinderwastes-sealed`: the world map with the Ashfall Verge selected, closed until the Ashen
//   Warden falls;
// - `cinderwastes-open`: the same map once the Warden is slain;
// - `cinderwastes-area`: the hero farming the Verge (its four foes and backdrop; until A.11's art
//   lands, the ember-tinted stand-ins);
// - `cinderwastes-gear`: the pack with a tier-4 drop beside the Pass's gear;
// - `cinderwastes-progress`: the PvE Progress board under version 2 (13 milestones).
// Auth, farming and boards are real (the dev server on PostgreSQL, real time). The hero's level,
// progress and gear (generated with game-core) are written straight into the database, and so are
// the town's world flags (set before the server starts, so no cache wait). Use a scratch database:
//   DATABASE_URL=postgres://…/wf_shots pnpm db:migrate && pnpm build
//   DATABASE_URL=postgres://…/wf_shots node tools/screenshots/cinderwastes.mjs --flags
//   DATABASE_URL=postgres://…/wf_shots SESSION_COOKIE_SECURE=false pnpm --filter @worldforge/server dev
//   pnpm --filter @worldforge/web dev
//   DATABASE_URL=postgres://…/wf_shots node tools/screenshots/cinderwastes.mjs [baseUrl] [outDir]
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

/** A level-30 hunter past the Pass, in its best plain drops (Legendary +10, item level 27). */
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
    data: { name, classId: 'hunter', appearance: { banner: 'ember' } },
  });
  if (!created.ok()) throw new Error(`character: ${created.status()} ${await created.text()}`);
  const { character } = await created.json();
  await db.query(
    `update characters set level = 30, gold = 52000,
       progress = '{"gravewardenDefeated": true, "cryptTierCleared": 3}'::jsonb where id = $1`,
    [character.id],
  );
  const bases = core.ITEM_BASES.filter(
    (b) => !b.unique && b.tier <= 3 && core.canClassUseItem(b, 'hunter'),
  ).sort((a, b) => b.tier - a.tier || b.minItemLevel - a.minItemLevel);
  const taken = new Set();
  let seed = 6100;
  for (const base of bases) {
    if (taken.has(base.slot)) continue;
    taken.add(base.slot);
    for (const slot of core.equipmentSlotsForKind(base.slot)) {
      const item = core.generateItem({
        seed: seed++,
        itemLevel: 27,
        baseId: base.id,
        rarityId: 'legendary',
        classId: 'hunter',
      });
      await insertItem(character.id, item, slot, 10);
    }
  }
  // Two Verge drops in the pack: a tier-4 bow (Epic, tier-5 affixes at item level 32) and a chest.
  for (const [baseId, rarityId, itemLevel] of [
    ['slagbone-bow', 'epic', 32],
    ['ashplate-hauberk', 'rare', 31],
  ]) {
    const item = core.generateItem({
      seed: seed++,
      itemLevel,
      baseId,
      rarityId,
      classId: 'hunter',
    });
    await insertItem(character.id, item, null, 0);
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
    vp.name === 'desktop' ? 'Emberwright' : 'Ashling',
    vp.name === 'desktop' ? 'Hale' : 'Wren',
  );
  heroes.push({ vp, ...h });
  await openMapAt(h.page, 'The Ashfall Verge');
  await shoot(h.page, vp, 'cinderwastes-sealed');
}
for (const { characterId } of heroes) {
  await db.query(
    `update characters set progress = progress || '{"ashenWardenDefeated": true}'::jsonb where id = $1`,
    [characterId],
  );
}
// Both heroes set out first: the farming start refreshes their board rows (written above).
for (const { ctx, characterId } of heroes) {
  const farm = await ctx.request.post(`${baseUrl}/api/characters/${characterId}/activity`, {
    data: { areaId: 'ashfallVerge' },
  });
  if (!farm.ok()) throw new Error(`farm: ${farm.status()} ${await farm.text()}`);
}
for (const { vp, page } of heroes) {
  await openMapAt(page, 'The Ashfall Verge');
  await shoot(page, vp, 'cinderwastes-open');
  await open(page, 'area');
  await sleep(6_000);
  await shoot(page, vp, 'cinderwastes-area');
  await open(page, 'inventory');
  await sleep(500);
  await page
    .getByRole('button', { name: /Slagbone Bow/ })
    .first()
    .click()
    .catch(() => console.warn('! no bow button'));
  await sleep(400);
  await shoot(page, vp, 'cinderwastes-gear');
  await open(page, 'boards/pveProgress');
  await sleep(800);
  await shoot(page, vp, 'cinderwastes-progress');
}

await browser.close();
await db.end();
