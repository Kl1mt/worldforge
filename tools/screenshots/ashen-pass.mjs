// Captures the ticket 4.8 top end at desktop (1440) and mobile (390):
// - `ashen-pass-sealed`: the world map with the Ashen Pass selected, sealed until the town clears
//   it (the world flag), with the link to the town works;
// - `ashen-pass-open`: the same map once the flag is set;
// - `ashen-pass-area`: the hero farming the pass (its four foes, its backdrop);
// - `ashen-watch-door`: the Warden's Watch with the Ashen Warden waiting;
// - `ashen-watch-fight`: a run under way, the hero at the warden;
// - `ashen-watch-reckoning`: the claimed run.
// Auth, runs and fights are real (the dev server on PostgreSQL, real time). The hero's level,
// Gravewarden progress and Legendary +10 gear (generated with game-core) are written straight into
// the database, and so is the world flag (what the owner's `admin:project complete` would set).
// The server caches world flags for 60 s, so the script waits that long once. Use a scratch
// database only (it sets the world flag for everyone):
//   DATABASE_URL=postgres://…/wf_shots pnpm db:migrate && pnpm build
//   DATABASE_URL=postgres://…/wf_shots SESSION_COOKIE_SECURE=false pnpm --filter @worldforge/server dev
//   pnpm --filter @worldforge/web dev
//   DATABASE_URL=postgres://…/wf_shots node tools/screenshots/ashen-pass.mjs [baseUrl] [outDir]
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
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-4');
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

/** A registered hunter of level 27 who has slain the Gravewarden, in Legendary +10 gear. */
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
  const level = 27;
  await db.query(
    `update characters set level = $2, gold = 48000,
       progress = '{"gravewardenDefeated": true, "cryptTierCleared": 3}'::jsonb where id = $1`,
    [character.id, level],
  );
  // The class's best regular base per slot, as a Legendary with a class effect, at +10.
  const bases = core.ITEM_BASES.filter(
    (b) => !b.unique && b.minItemLevel <= level && core.canClassUseItem(b, 'hunter'),
  ).sort((a, b) => b.tier - a.tier || b.minItemLevel - a.minItemLevel);
  const taken = new Set();
  let seed = 4800;
  for (const base of bases) {
    if (taken.has(base.slot)) continue;
    taken.add(base.slot);
    for (const slot of core.equipmentSlotsForKind(base.slot)) {
      const item = core.generateItem({
        seed: seed++,
        itemLevel: level - 1,
        baseId: base.id,
        rarityId: 'legendary',
        classId: 'hunter',
      });
      await db.query(
        `insert into item_instances (id, character_id, base_id, rarity_id, item_level, affixes,
           seed, equipped_slot, source, upgrade_level, effect_id, effect_roll)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'screenshot', 10, $9, $10)`,
        [
          randomUUID(),
          character.id,
          item.baseId,
          item.rarityId,
          item.itemLevel,
          JSON.stringify(item.affixes),
          item.seed,
          slot,
          item.effectId ?? null,
          item.effectRoll ?? null,
        ],
      );
    }
  }
  await page.goto(`${baseUrl}/#/hub`);
  await page.waitForLoadState('networkidle');
  // The first-steps guide is for new players; these shots are of a veteran.
  const hide = page.getByRole('button', { name: 'Hide guide' });
  if (await hide.isVisible().catch(() => false)) await hide.click();
  return { ctx, page, characterId: character.id };
}

/** Opens a screen with a fresh load (a hash change alone keeps the client's cached state). */
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
// A scratch database: start with the pass closed.
await db.query(`delete from world_flags where flag_id = 'ashenPassCleared'`);
const browser = await playwright.chromium.launch();
const heroes = [];
for (const vp of VIEWPORTS) {
  const h = await hero(
    browser,
    vp,
    vp.name === 'desktop' ? 'Ashwalker' : 'Cinderfoot',
    vp.name === 'desktop' ? 'Brannoc' : 'Ysmay',
  );
  heroes.push({ vp, ...h });
  await openMapAt(h.page, 'The Ashen Pass');
  await shoot(h.page, vp, 'ashen-pass-sealed');
}

// The town clears the pass (what the owner's CLI or the last contribution writes).
await db.query(
  `insert into world_flags (flag_id, set_at) values ('warehouseRestored', now()), ('ashenPassCleared', now())
   on conflict do nothing`,
);
console.log('flag set; waiting for the server’s world-state cache (60 s)…');
await sleep(62_000);

for (const { vp, page, ctx } of heroes) {
  await openMapAt(page, 'The Ashen Pass');
  await shoot(page, vp, 'ashen-pass-open');
  const farm = await ctx.request.post(
    `${baseUrl}/api/characters/${heroes.find((x) => x.page === page).characterId}/activity`,
    {
      data: { areaId: 'ashenPass' },
    },
  );
  if (!farm.ok()) throw new Error(`farm: ${farm.status()} ${await farm.text()}`);
  await open(page, 'area');
  await sleep(6_000);
  await shoot(page, vp, 'ashen-pass-area');
  await open(page, 'watch');
  await sleep(500);
  await shoot(page, vp, 'ashen-watch-door');
}

// Both heroes climb at once; the fight starts after the 30 s climb.
for (const { page } of heroes) {
  await page.getByRole('button', { name: 'Climb to the warden' }).click();
}
await sleep(44_000);
for (const { vp, page } of heroes) await shoot(page, vp, 'ashen-watch-fight');
for (const { vp, page } of heroes) {
  const claim = page.getByRole('button', { name: 'Claim the spoils' });
  await claim.waitFor({ timeout: 120_000 });
  await claim.click();
  await page.getByRole('heading', { name: /Ashen Warden falls|keeps his watch/ }).waitFor();
  await sleep(500);
  await shoot(page, vp, 'ashen-watch-reckoning');
}

await browser.close();
await db.end();
