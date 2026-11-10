// Captures ticket 6.3, the Heroic crypt and the weekly boss modifier, at desktop (1440) and mobile (390):
// - `tavern-boss-week`: the Tavern keeper's notice of this week's boss modifier;
// - `heroic-door`: the crypt door with Heroic chosen (the Heroic treatment, the week's modifier);
// - `heroic-fight`: a Heroic run under way (the run panel names the run's modifier);
// - `heroic-reckoning`: its reckoning;
// - `guild-boss-modifier`: the guild boss's siege plate with the week's modifier, after an attempt;
// - `admin-world-modifiers` (desktop): the admin world folio with this week's and next week's modifier;
// - `heroic-gallery` (desktop): the admin animation gallery's Heroic crypt group.
// Auth, the run, the attempt and every screen are real (the dev server on PostgreSQL, real time).
// The hero's level, progress and gear (generated with game-core) are written straight into the
// database. Use a scratch database:
//   DATABASE_URL=postgres://…/wf_shots pnpm db:migrate && pnpm build
//   DATABASE_URL=postgres://…/wf_shots SESSION_COOKIE_SECURE=false pnpm --filter @worldforge/server dev
//   pnpm --filter @worldforge/web dev
//   DATABASE_URL=postgres://…/wf_shots node tools/screenshots/heroic.mjs [baseUrl] [outDir]
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
  { name: 'desktop', width: 1440, height: 900, tag: 'D' },
  { name: 'mobile', width: 390, height: 844, tag: 'M' },
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

/** A level-36 hunter with tier III cleared, in the Depths' top Legendaries +10 (item level 39). */
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
    data: { name, classId: 'hunter', appearance: { banner: 'ash' } },
  });
  if (!created.ok()) throw new Error(`character: ${created.status()} ${await created.text()}`);
  const { character } = await created.json();
  await db.query(
    `update characters set level = 36, gold = 64000,
       progress = '{"gravewardenDefeated": true, "cryptTierCleared": 3, "ashenWardenDefeated": true}'::jsonb
     where id = $1`,
    [character.id],
  );
  const bases = core.ITEM_BASES.filter(
    (b) => !b.unique && core.canClassUseItem(b, 'hunter') && b.minItemLevel <= 39,
  ).sort((a, b) => b.tier - a.tier || b.minItemLevel - a.minItemLevel);
  const taken = new Set();
  let seed = 6300;
  for (const base of bases) {
    if (taken.has(base.slot)) continue;
    taken.add(base.slot);
    for (const slot of core.equipmentSlotsForKind(base.slot)) {
      const item = core.generateItem({
        seed: seed++,
        itemLevel: 39,
        baseId: base.id,
        rarityId: 'legendary',
        classId: 'hunter',
      });
      await insertItem(character.id, item, slot, 10);
    }
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

mkdirSync(outDir, { recursive: true });
const browser = await playwright.chromium.launch();
const heroes = [];
for (const vp of VIEWPORTS) {
  const h = await hero(
    browser,
    vp,
    vp.name === 'desktop' ? 'Gravebell' : 'Coldlamp',
    vp.name === 'desktop' ? 'Tolla' : 'Wyn',
  );
  heroes.push({ vp, ...h });
  await open(h.page, 'tavern');
  await h.page.getByText('Word from the keeper').waitFor();
  await shoot(h.page, vp, 'tavern-boss-week');
  await open(h.page, 'crypt');
  await h.page.getByRole('radio', { name: /Heroic/ }).click();
  await sleep(400);
  await shoot(h.page, vp, 'heroic-door');
}

for (const { page } of heroes) {
  await page.getByRole('button', { name: 'Enter the Heroic crypt' }).click();
}
await sleep(40_000);
for (const { vp, page } of heroes) await shoot(page, vp, 'heroic-fight');
for (const { vp, page } of heroes) {
  const claim = page.getByRole('button', { name: 'Claim the spoils' });
  await claim.waitFor({ timeout: 300_000 });
  await claim.click();
  await page.getByRole('heading', { name: /Gravewarden falls|keeps its warden/ }).waitFor();
  await sleep(500);
  await shoot(page, vp, 'heroic-reckoning');
}

// The guild boss: each hero founds a guild and makes one attempt (the siege plate's notice).
for (const { vp, ctx, page, characterId } of heroes) {
  const res = await ctx.request.post(`${baseUrl}/api/guilds`, {
    data: { characterId, name: `Bell Wardens ${vp.tag}`, tag: `BEL${vp.tag}`, emblem: 'moon' },
    headers: { 'idempotency-key': randomUUID() },
  });
  if (res.status() !== 201) {
    console.warn(`! guild: ${res.status()} ${await res.text()}`);
    continue;
  }
  await open(page, 'guild');
  const face = page.getByRole('button', { name: 'Face the boss' });
  await face.waitFor({ timeout: 20_000 });
  await face.click();
  await page.getByText(/damage\s+for the guild/).waitFor({ timeout: 20_000 });
  await sleep(500);
  await shoot(page, vp, 'guild-boss-modifier');
}

// The admin folios (desktop): the world with the modifiers, the gallery's Heroic crypt.
const desk = heroes.find((h) => h.vp.name === 'desktop');
await db.query(
  `update accounts set role = 'admin' where id = (select account_id from characters where id = $1)`,
  [desk.characterId],
);
await open(desk.page, 'admin/world');
await desk.page.getByRole('heading', { name: 'Boss modifiers' }).waitFor();
await sleep(400);
await shoot(desk.page, desk.vp, 'admin-world-modifiers');
await open(desk.page, 'admin/animations');
await sleep(800);
const heading = desk.page.getByRole('heading', { name: /Nameless Crypt · Heroic/ });
await heading.scrollIntoViewIfNeeded().catch(() => console.warn('! no Heroic group'));
await sleep(400);
const box = await heading.boundingBox().catch(() => null);
if (box) {
  await desk.page.screenshot({
    path: `${outDir}/heroic-gallery-desktop.png`,
    clip: { x: 0, y: Math.max(0, box.y - 20), width: desk.vp.width, height: 640 },
  });
  console.log(`saved ${outDir}/heroic-gallery-desktop.png`);
}

await browser.close();
await db.end();
