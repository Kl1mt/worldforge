// Captures ticket 8.1, the Hollow Reach's first area, the Pale Marches, at desktop (1440) and mobile
// (390):
// - `marches-sealed`: the world map with the Pale Marches selected, closed until the Forge Tyrant falls;
// - `marches-open`: the same map once he has (level 40);
// - `marches-area`: the hero farming the Marches (A.17's foes, or their pale stand-ins until it lands);
// - `marches-pack`: the pack with tier-5 drops and a tooltip (a tier-6 affix);
// - `marches-progress`: the PvE Progress board (version 5 once in force, 21 milestones);
// - `marches-gallery` (desktop): the admin animation gallery listing the Marches' foes.
// Auth, farming and boards are real (the dev server on PostgreSQL, real time). The hero's level,
// progress and gear (generated with game-core) are written straight into the database, and so are
// the town's world flags (set before the server starts, so no cache wait). Use a scratch database:
//   DATABASE_URL=postgres://…/wf_shots pnpm db:migrate && pnpm build
//   DATABASE_URL=postgres://…/wf_shots node tools/screenshots/pale-marches.mjs --flags
//   DATABASE_URL=postgres://…/wf_shots SESSION_COOKIE_SECURE=false pnpm --filter @worldforge/server dev
//   pnpm --filter @worldforge/web dev
//   DATABASE_URL=postgres://…/wf_shots node tools/screenshots/pale-marches.mjs [baseUrl] [outDir]
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
const PASSWORD = 'hollow-and-pale-42';
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

/** A level-39 warrior who slew the Ashen Warden, in the Depths' Legendaries +10 (item level 39). */
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
    `update characters set level = 39, gold = 64000,
       progress = '{"gravewardenDefeated": true, "cryptTierCleared": 3, "ashenWardenDefeated": true}'::jsonb
     where id = $1`,
    [character.id],
  );
  const bases = core.ITEM_BASES.filter(
    (b) => !b.unique && b.tier <= 4 && core.canClassUseItem(b, 'warrior') && b.minItemLevel <= 39,
  ).sort((a, b) => b.tier - a.tier || b.minItemLevel - a.minItemLevel);
  const taken = new Set();
  let seed = 8100;
  for (const base of bases) {
    if (taken.has(base.slot)) continue;
    taken.add(base.slot);
    for (const slot of core.equipmentSlotsForKind(base.slot)) {
      const item = core.generateItem({
        seed: seed++,
        itemLevel: 39,
        baseId: base.id,
        rarityId: 'legendary',
        classId: 'warrior',
      });
      await insertItem(character.id, item, slot, 10);
    }
  }
  // A few tier-5 drops in the pack (as the Marches drop them), one with a tier-6 affix.
  const table = core.getLootTable('paleMarches');
  let shown = 0;
  for (let s = 0; shown < 4 && s < 400; s++) {
    const item = core.generateItem({
      seed: 81000 + s,
      itemLevel: 45,
      lootTable: table,
      rarityId: shown === 0 ? 'legendary' : 'epic',
      classId: 'warrior',
    });
    if (!item || item.setId || item.mythicId) continue;
    if (shown === 0 && !item.affixes.some((a) => a.tier === 6)) continue;
    await insertItem(character.id, item, null, 0);
    shown++;
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
    vp.name === 'desktop' ? 'Palewright' : 'Hollowkin',
    vp.name === 'desktop' ? 'Aldric' : 'Wren',
  );
  heroes.push({ vp, ...h });
  await openMapAt(h.page, 'The Pale Marches');
  await shoot(h.page, vp, 'marches-sealed');
}
// The Forge Tyrant has fallen to them (as a Tyrant's Forge kill sets it) and they are level 40.
for (const { characterId } of heroes) {
  await db.query(
    `update characters set level = 40, experience = 0,
       progress = progress || '{"forgeTyrantDefeated": true}'::jsonb where id = $1`,
    [characterId],
  );
}
for (const { ctx, characterId } of heroes) {
  const farm = await ctx.request.post(`${baseUrl}/api/characters/${characterId}/activity`, {
    data: { areaId: 'paleMarches' },
  });
  if (!farm.ok()) throw new Error(`farm: ${farm.status()} ${await farm.text()}`);
}
for (const { vp, page } of heroes) {
  await openMapAt(page, 'The Pale Marches');
  await shoot(page, vp, 'marches-open');
  await open(page, 'area');
  await sleep(6_000);
  await shoot(page, vp, 'marches-area');
  await open(page, 'inventory');
  await sleep(600);
  const pack = page
    .getByRole('button', { name: /Hollow|Pale Choir|Reach|Titanhusk|Requiem|Palebone/ })
    .first();
  await pack.scrollIntoViewIfNeeded().catch(() => console.warn('! no tier-5 item in the pack'));
  await pack.click().catch(() => console.warn('! could not open a tier-5 item'));
  await sleep(500);
  await shoot(page, vp, 'marches-pack');
  await open(page, 'boards/pveProgress');
  await sleep(800);
  await shoot(page, vp, 'marches-progress');
}

// The admin gallery (desktop): the Marches' foes, placed, in their stand-in (or A.17) art.
const desk = heroes.find((h) => h.vp.name === 'desktop');
await db.query(
  `update accounts set role = 'admin' where id = (select account_id from characters where id = $1)`,
  [desk.characterId],
);
await open(desk.page, 'admin/animations');
await sleep(800);
await desk.page.getByPlaceholder(/wolf, warden/).fill('hollow');
await sleep(600);
await shoot(desk.page, desk.vp, 'marches-gallery');

await browser.close();
await db.end();
