// Captures ticket 6.7 (the Forgeward Outpost and the eras of Graumark) at desktop (1440) and
// mobile (390):
// - `hub-era-<era>`: the town in each era (title, tint, banners, crier): the Long Dusk, the Ashen
//   Siege, the Rekindling (live today) and the Forgeward Age; mobile for the last two;
// - `tavern-era-<era>`: the Tavern's ambient line in the Rekindling and the Forgeward Age;
// - `works-forgeward`: the board with the Forgeward Outpost under way (stage 1 of 3);
// - `forge-bellows` (desktop): Tyrantforged Work at 2,400 gold once the outpost stands;
// - `admin-world-<era>` (desktop): the world folio's era and town works.
// Other contributors are seeded straight into the database. Resets the community tables first, so
// use a scratch database only:
//   DATABASE_URL=postgres://…/wf_shots pnpm db:migrate
//   DATABASE_URL=postgres://…/wf_shots SESSION_COOKIE_SECURE=false pnpm --filter @worldforge/server dev
//   pnpm --filter @worldforge/web dev
//   DATABASE_URL=postgres://…/wf_shots node tools/screenshots/world-progression.mjs [baseUrl] [outDir]
// The server caches the world state for a minute, so each era change waits 61 s (about 4 min).
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const serverRequire = createRequire(resolve('apps/server/package.json'));
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require(process.env.PLAYWRIGHT_PATH ?? '/opt/node-tools/node_modules/playwright');
}
const pg = serverRequire('pg');

const baseUrl = process.argv[2] ?? 'http://localhost:5173';
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-6');
const PASSWORD = 'ashes-and-iron-42';
const DESKTOP = { name: 'desktop', width: 1440, height: 900 };
const MOBILE = { name: 'mobile', width: 390, height: 844 };

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const today = new Date().toISOString().slice(0, 10);

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

async function hero(browser, vp, displayName, name, { admin = false } = {}) {
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
  const { account } = await reg.json();
  const created = await ctx.request.post(`${baseUrl}/api/characters`, {
    data: { name, classId: 'warrior', appearance: { banner: 'ember' } },
  });
  if (!created.ok()) throw new Error(`hero: ${created.status()} ${await created.text()}`);
  const { character } = await created.json();
  await db.query('update characters set gold = 48000, level = 36 where id = $1', [character.id]);
  for (const [m, q] of [
    ['ironOre', 640],
    ['soulShard', 210],
    ['abbeySilver', 12],
    ['tyrantsEmber', 2],
  ]) {
    await db.query(
      'insert into character_materials (character_id, material_id, quantity) values ($1, $2, $3)',
      [character.id, m, q],
    );
  }
  if (admin) await db.query(`update accounts set role = 'admin' where id = $1`, [account.id]);
  return { ctx, page, account, character };
}

async function seeded(displayName) {
  const id = randomUUID();
  await db.query(
    `insert into accounts (id, email, display_name, password_hash, handle)
     values ($1, $2, $3, 'seeded', substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))`,
    [id, `${id}@graumark.test`, displayName],
  );
  return id;
}

async function give(accountId, projectId, stageId, resource, amount, day = today) {
  await db.query(
    `insert into community_contributions (project_id, stage_id, account_id, day, resource, amount)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (project_id, stage_id, account_id, day, resource) do update set amount = community_contributions.amount + excluded.amount`,
    [projectId, stageId, accountId, day, resource, amount],
  );
  await db.query(
    `insert into community_project_progress (project_id, stage_id, resource, amount) values ($1, $2, $3, $4)
     on conflict (project_id, stage_id, resource) do update set amount = community_project_progress.amount + excluded.amount`,
    [projectId, stageId, resource, amount],
  );
}

async function resetWorld() {
  for (const t of [
    'community_contributions',
    'community_project_progress',
    'community_projects',
    'world_flags',
  ]) {
    await db.query(`delete from ${t}`);
  }
}

/** Finishes a project as its last contribution would (stage index past the end, the flag). */
async function finish(projectId, stages, flag, daysAgo) {
  const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  await db.query(
    `insert into community_projects (project_id, stage_index, updated_at, completed_at) values ($1, $2, $3, $3)
     on conflict (project_id) do update set stage_index = excluded.stage_index, completed_at = excluded.completed_at`,
    [projectId, stages, at],
  );
  await db.query(`insert into world_flags (flag_id, project_id, set_at) values ($1, $2, $3)`, [
    flag,
    projectId,
    at,
  ]);
}

const waitCache = () => new Promise((r) => setTimeout(r, 61_000));

async function hub(h, vp, era) {
  await h.page.goto(`${baseUrl}/#/hub`);
  // A fresh load polls the world at once (the same hash would not reload).
  const world = h.page.waitForResponse((r) => r.url().endsWith('/api/world'));
  await h.page.reload();
  await world;
  await h.page.locator('.hub-era__title').waitFor();
  await h.page.waitForTimeout(500);
  await shoot(h.page, vp, `hub-era-${era}`);
}

async function tavern(h, vp, era) {
  await h.page.goto(`${baseUrl}/#/tavern`);
  await h.page.locator('.tavern__text').waitFor();
  await h.page.waitForTimeout(800);
  await shoot(h.page, vp, `tavern-era-${era}`);
}

async function adminWorld(h, era) {
  await h.page.goto(`${baseUrl}/#/admin/world`);
  await h.page.locator('.adt-era').waitFor();
  await h.page.waitForTimeout(400);
  await shoot(h.page, DESKTOP, `admin-world-${era}`);
}

const browser = await playwright.chromium.launch();
try {
  mkdirSync(outDir, { recursive: true });
  await resetWorld();
  const run = Date.now().toString(36).slice(-4);
  // Hero names are unique across the game: a few letters per run keep reruns apart.
  const tag = Array.from({ length: 3 }, () =>
    String.fromCharCode(97 + Math.floor(Math.random() * 26)),
  ).join('');
  const d = await hero(browser, DESKTOP, `Ysolde Fen ${run}`, `Ysolde${tag}`, { admin: true });
  const m = await hero(browser, MOBILE, `Corin Ash ${run}`, `Corin${tag}`);

  // The Long Dusk: a fresh world.
  await hub(d, DESKTOP, 'long-dusk');

  // The Ashen Siege: the Warehouse restored.
  await finish('restoreWarehouse', 3, 'warehouseRestored', 30);
  await waitCache();
  await hub(d, DESKTOP, 'ashen-siege');

  // The Rekindling (live today): the Ashen Pass cleared, the Forgeward Outpost under way.
  await finish('clearAshenPass', 3, 'ashenPassCleared', 12);
  const names = ['Odo Marrow', 'Wren Of Ash', 'Brannoc Vell', 'Tam Oakhand', 'Mira Coldwater'];
  const ids = [];
  for (const n of names) ids.push(await seeded(`${n} ${run}`));
  const day = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  for (const [i, g, ore, shards] of [
    [0, 12000, 200, 80],
    [1, 9000, 150, 40],
    [2, 7000, 120, 0],
    [3, 4000, 90, 60],
    [4, 2500, 0, 30],
  ]) {
    await give(ids[i], 'forgewardOutpost', 'slagRoad', 'gold', g, day(i % 2));
    if (ore) await give(ids[i], 'forgewardOutpost', 'slagRoad', 'ironOre', ore, day(i % 2));
    if (shards) await give(ids[i], 'forgewardOutpost', 'slagRoad', 'soulShard', shards, day(i % 2));
  }
  await db.query(
    `insert into community_projects (project_id, stage_index, updated_at) values ('forgewardOutpost', 0, now())`,
  );
  await waitCache();
  await hub(d, DESKTOP, 'rekindling');
  await hub(m, MOBILE, 'rekindling');
  await tavern(d, DESKTOP, 'rekindling');
  await d.page.goto(`${baseUrl}/#/works`);
  await d.page.getByText('Rebuild the Forgeward Outpost').first().waitFor();
  await d.page.waitForTimeout(500);
  await shoot(d.page, DESKTOP, 'works-forgeward');
  await m.page.goto(`${baseUrl}/#/works`);
  await m.page.getByText('Rebuild the Forgeward Outpost').first().waitFor();
  await m.page.waitForTimeout(500);
  await shoot(m.page, MOBILE, 'works-forgeward');
  await adminWorld(d, 'rekindling');

  // The Forgeward Age: the beacon lit.
  await finish('forgewardOutpost', 3, 'forgewardRaised', 0);
  await db.query(
    `insert into account_achievements (account_id, achievement_id, source, awarded_at) values ($1, 'forgewardBuilder', 'live', now()) on conflict do nothing`,
    [d.account.id],
  );
  await waitCache();
  await hub(d, DESKTOP, 'forgeward-age');
  await hub(m, MOBILE, 'forgeward-age');
  await tavern(d, DESKTOP, 'forgeward-age');
  await d.page.goto(`${baseUrl}/#/forge`);
  const bellows = d.page.locator('.recipe__town');
  await bellows.waitFor();
  await bellows.scrollIntoViewIfNeeded();
  await d.page.waitForTimeout(400);
  await shoot(d.page, DESKTOP, 'forge-bellows');
  await adminWorld(d, 'forgeward-age');
  await d.ctx.close();
  await m.ctx.close();
} finally {
  await browser.close();
  await db.end();
}
