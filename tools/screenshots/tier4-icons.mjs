// Captures art ticket A.15, the tier-4 item icons, at desktop (1440) and mobile (390):
// - `tier4-icons-pack`: the pack with all ten tier-4 bases (mixed rarities, one Void);
// - `tier4-icons-tooltip`: the same pack with one tier-4 item's tooltip open.
// Auth is real (the dev server on PostgreSQL); the hero and its items (generated with game-core)
// are written straight into the database. Use a scratch database, set up like cinderwastes.mjs:
//   DATABASE_URL=postgres://…/wf_shots pnpm db:migrate && pnpm build
//   DATABASE_URL=postgres://…/wf_shots node tools/screenshots/cinderwastes.mjs --flags
//   DATABASE_URL=postgres://…/wf_shots SESSION_COOKIE_SECURE=false pnpm --filter @worldforge/server dev
//   pnpm --filter @worldforge/web dev
//   DATABASE_URL=postgres://…/wf_shots node tools/screenshots/tier4-icons.mjs [baseUrl] [outDir]
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
const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];

/** Three lowercase letters, so a rerun on the same scratch database doesn't hit a taken name. */
const tag = () =>
  Array.from(
    { length: 3 },
    () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)],
  ).join('');

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

async function shoot(page, vp, name) {
  await page.evaluate(() => document.fonts.ready);
  const file = `${outDir}/${name}-${vp.name}.png`;
  await page.screenshot({ path: file });
  console.log(`saved ${file}`);
}

/** A level-34 warrior with every tier-4 base in the pack. */
async function hero(browser, vp, displayName, name) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (err) => console.error(`! page error @ ${vp.name}: ${err.message}`));
  const email = `${displayName.replace(/\s/g, '').toLowerCase()}-${Date.now()}@graumark.test`;
  const reg = await ctx.request.post(`${baseUrl}/api/auth/register`, {
    data: { email, displayName: `${displayName}${tag()}`, password: PASSWORD },
  });
  if (!reg.ok()) throw new Error(`register: ${reg.status()} ${await reg.text()}`);
  const created = await ctx.request.post(`${baseUrl}/api/characters`, {
    data: { name: `${name}${tag()}`, classId: 'warrior', appearance: { banner: 'ember' } },
  });
  if (!created.ok()) throw new Error(`character: ${created.status()} ${await created.text()}`);
  const { character } = await created.json();
  await db.query(
    `update characters set level = 34, gold = 52000,
       progress = '{"gravewardenDefeated": true, "ashenWardenDefeated": true}'::jsonb where id = $1`,
    [character.id],
  );
  const tier4 = core.ITEM_BASES.filter((b) => b.tier === 4);
  let seed = 1500;
  for (const [i, base] of tier4.entries()) {
    const rarityId = RARITIES[i % RARITIES.length];
    const item = core.generateItem({
      seed: seed++,
      itemLevel: 30 + (i % 5),
      baseId: base.id,
      rarityId,
      classId: 'warrior',
    });
    // One Void piece (a Legendary), to show the icon under the Void treatment.
    const variant = base.id === 'ashplate-hauberk' ? 'void' : null;
    await db.query(
      `insert into item_instances (id, character_id, base_id, rarity_id, item_level, affixes,
         seed, equipped_slot, source, upgrade_level, variant)
       values ($1, $2, $3, $4, $5, $6, $7, null, 'screenshot', 0, $8)`,
      [
        randomUUID(),
        character.id,
        item.baseId,
        variant ? 'legendary' : item.rarityId,
        item.itemLevel,
        JSON.stringify(item.affixes),
        item.seed,
        variant,
      ],
    );
  }
  await page.goto(`${baseUrl}/#/hub`);
  await page.waitForLoadState('networkidle');
  const hide = page.getByRole('button', { name: 'Hide guide' });
  if (await hide.isVisible().catch(() => false)) await hide.click();
  return { ctx, page };
}

mkdirSync(outDir, { recursive: true });
const browser = await playwright.chromium.launch();
for (const vp of VIEWPORTS) {
  const { page } = await hero(
    browser,
    vp,
    vp.name === 'desktop' ? 'Slagwright' : 'Cinderling',
    vp.name === 'desktop' ? 'Brand' : 'Soot',
  );
  await page.goto(`${baseUrl}/#/inventory`);
  await page.reload();
  await page.waitForLoadState('networkidle');
  await page
    .getByRole('button', { name: /Cinderforged Blade/ })
    .first()
    .waitFor();
  await shoot(page, vp, 'tier4-icons-pack');
  await page
    .getByRole('button', { name: /Emberheart Scepter/ })
    .first()
    .click();
  await page.getByText('Emberheart Scepter', { exact: true }).first().waitFor();
  await shoot(page, vp, 'tier4-icons-tooltip');
}
await browser.close();
await db.end();
