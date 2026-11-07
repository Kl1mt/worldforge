// Captures the ticket 4.6 town works at desktop (1440) and mobile (390):
// - `works`: the project board mid-way through the Warehouse (stage 2 of 3), after the hero gave
//   through the form (the success line, "your share today", the cap);
// - `hub-works`: the hub with the town works slip;
// - `works-complete`: the Warehouse finished and the Ashen Pass under way, with the world notice;
// - `hub-warehouse-restored` (desktop): the hub's Warehouse line once restored.
// Other contributors are seeded straight into the database (they never log in). Resets the four
// community tables first, so use a scratch database only:
//   DATABASE_URL=postgres://…/wf_shots pnpm db:migrate
//   DATABASE_URL=postgres://…/wf_shots SESSION_COOKIE_SECURE=false pnpm --filter @worldforge/server dev
//   pnpm --filter @worldforge/web dev
//   DATABASE_URL=postgres://…/wf_shots node tools/screenshots/community.mjs [baseUrl] [outDir]
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
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-4');
const PASSWORD = 'ashes-and-iron-42';
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

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
  const { account } = await reg.json();
  const created = await ctx.request.post(`${baseUrl}/api/characters`, {
    data: { name, classId: 'hunter', appearance: { banner: 'moss' } },
  });
  const { character } = await created.json();
  await db.query('update characters set gold = 6400, level = 11 where id = $1', [character.id]);
  for (const [m, q] of [
    ['timber', 140],
    ['rawHide', 95],
    ['ironOre', 12],
  ]) {
    await db.query(
      'insert into character_materials (character_id, material_id, quantity) values ($1, $2, $3)',
      [character.id, m, q],
    );
  }
  return { ctx, page, account, character };
}

/** An account that never logs in. */
async function seeded(displayName) {
  const id = randomUUID();
  await db.query(
    `insert into accounts (id, email, display_name, password_hash, handle)
     values ($1, $2, $3, 'seeded', substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))`,
    [id, `${id}@graumark.test`, displayName],
  );
  return id;
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

/** The Warehouse at stage 2 (roof), stage 1 done by seven players over three days. */
async function seedMidWarehouse(tag) {
  await resetWorld();
  const names = [
    'Odo Marrow',
    'Wren Of Ash',
    'Brannoc Vell',
    'Tam Oakhand',
    'Mira Coldwater',
    'Ilse Tanner',
    'Garrow',
  ];
  const ids = [];
  for (const n of names) ids.push(await seeded(`${n} ${tag}`));
  const day = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  for (let i = 0; i < 5; i++) {
    await give(ids[i], 'restoreWarehouse', 'clearRubble', 'gold', 800, day(2 + (i % 2)));
    await give(ids[i], 'restoreWarehouse', 'clearRubble', 'timber', 80, day(2 + (i % 2)));
  }
  await db.query(
    `insert into community_projects (project_id, stage_index, updated_at) values ('restoreWarehouse', 1, now())`,
  );
  for (const [i, gold, timber, hide] of [
    [0, 1600, 60, 40],
    [1, 1200, 60, 60],
    [5, 900, 25, 60],
    [6, 1600, 0, 35],
  ]) {
    await give(ids[i], 'restoreWarehouse', 'raiseRoof', 'gold', gold, day(i === 6 ? 0 : 1));
    if (timber) await give(ids[i], 'restoreWarehouse', 'raiseRoof', 'timber', timber, day(1));
    await give(ids[i], 'restoreWarehouse', 'raiseRoof', 'rawHide', hide, day(1));
  }
  return ids;
}

const browser = await playwright.chromium.launch();
try {
  mkdirSync(outDir, { recursive: true });
  for (const [i, vp] of VIEWPORTS.entries()) {
    await seedMidWarehouse(vp.name === 'desktop' ? 'A' : 'B');
    // This script edits the tables directly; let the server's world-state cache (60 s) expire.
    if (i > 0) await new Promise((r) => setTimeout(r, 61_000));
    const h = await hero(
      browser,
      vp,
      vp.name === 'desktop' ? 'Ysolde Fen' : 'Corin Ash',
      vp.name === 'desktop' ? 'Ysolde' : 'Corin',
    );
    await h.page.goto(`${baseUrl}/#/hub`);
    await h.page.getByText('Town works').first().waitFor();
    await h.page.waitForTimeout(400);
    await shoot(h.page, vp, 'hub-works');

    await h.page.goto(`${baseUrl}/#/works`);
    await h.page.getByRole('button', { name: /Give from/ }).waitFor();
    await h.page.getByLabel('Give Gold').fill('1000');
    await h.page.getByRole('button', { name: /Give from/ }).click();
    await h.page.getByText(/^Given:/).waitFor();
    await h.page.waitForTimeout(400);
    await shoot(h.page, vp, 'works');

    // The Warehouse finished (as the last contribution would), the Ashen Pass begun.
    await db.query(
      `update community_projects set stage_index = 3, completed_at = now() where project_id = 'restoreWarehouse'`,
    );
    for (const [stage, resource, amount] of [
      ['raiseRoof', 'gold', 2700],
      ['raiseRoof', 'timber', 155],
      ['raiseRoof', 'rawHide', 105],
      ['ironDoors', 'gold', 12000],
      ['ironDoors', 'ironOre', 250],
    ]) {
      await give(h.account.id, 'restoreWarehouse', stage, resource, amount);
    }
    await db.query(
      `insert into world_flags (flag_id, project_id, set_at) values ('warehouseRestored', 'restoreWarehouse', now())`,
    );
    await db.query(
      `insert into account_achievements (account_id, achievement_id, source, awarded_at) values ($1, 'warehouseRestorer', 'live', now()) on conflict do nothing`,
      [h.account.id],
    );
    const pass = await seeded(`Ilka Rhee ${vp.name === 'desktop' ? 'A' : 'B'}`);
    await give(pass, 'clearAshenPass', 'scoutPass', 'gold', 3000);
    await give(pass, 'clearAshenPass', 'scoutPass', 'soulShard', 60);
    await db.query(
      `insert into community_projects (project_id, stage_index, updated_at) values ('clearAshenPass', 0, now())`,
    );
    // The server caches the world state for up to a minute; a fresh page load after that sees it.
    await h.page.waitForTimeout(61_000);
    const world = h.page.waitForResponse((r) => r.url().endsWith('/api/world'));
    await h.page.reload();
    await world;
    await h.page.locator('.notice--world').waitFor({ timeout: 15_000 });
    await h.page.waitForTimeout(400);
    await shoot(h.page, vp, 'works-complete');
    if (vp.name === 'desktop') {
      await h.page.goto(`${baseUrl}/#/hub`);
      await h.page.getByText('Town works').first().waitFor();
      await h.page.locator('.hotspot', { hasText: 'Warehouse' }).hover();
      await h.page.waitForTimeout(300);
      await shoot(h.page, vp, 'hub-warehouse-restored');
    }
    await h.ctx.close();
  }
} finally {
  await browser.close();
  await db.end();
}
