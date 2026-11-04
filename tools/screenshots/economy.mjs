// Captures the ticket 2.6 screens (Merchant and Forge) at desktop (1440) and mobile (390).
// Seeds the hero straight in PostgreSQL (level, gold, materials, a pack of generated items), so it
// needs the normal server on a real database plus the web dev server and a built game-core:
//   pnpm build
//   DATABASE_URL=… pnpm --filter @worldforge/server dev      (after pnpm db:migrate)
//   pnpm --filter @worldforge/web dev
//   DATABASE_URL=… node tools/screenshots/economy.mjs [baseUrl] [outDir]
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { generateItem } from '../../packages/game-core/dist/index.js';

const require = createRequire(import.meta.url);
const playwright = require('playwright');
const pg = require('../../apps/server/node_modules/pg');

const baseUrl = process.argv[2] ?? 'http://localhost:5173';
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-2');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required (the server’s database)');

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, hero: 'Edric', className: 'Warrior' },
  { name: 'mobile', width: 390, height: 844, hero: 'Wynne', className: 'Mage' },
];
const PASSWORD = 'ashes-and-iron-42';
const PACK = {
  warrior: [
    ['longsword', 'common', 7],
    ['iron-helm', 'common', 5],
    ['leather-boots', 'uncommon', 8],
    ['chainmail', 'common', 9],
    ['brass-ring', 'rare', 11],
    ['barbute', 'uncommon', 12],
    ['round-shield', 'common', 4],
    ['bone-amulet', 'epic', 10],
  ],
  mage: [
    ['skull-staff', 'common', 6],
    ['iron-helm', 'uncommon', 7],
    ['leather-gloves', 'common', 5],
    ['brass-ring', 'rare', 9],
    ['brigandine', 'common', 12],
  ],
};
const step = (vp, text) => console.log(`[${vp.name}] ${text}`);

async function shoot(page, vp, name) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() =>
    Promise.all([...document.images].map((img) => img.decode().catch(() => undefined))),
  );
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

async function seed(db, characterId, classId) {
  await db.query('update characters set level = 12, gold = 1450 where id = $1', [characterId]);
  const mats = { timber: 34, ashwort: 12, rawHide: 6, soulShard: 3 };
  for (const [materialId, quantity] of Object.entries(mats)) {
    await db.query(
      'insert into character_materials (character_id, material_id, quantity) values ($1, $2, $3)',
      [characterId, materialId, quantity],
    );
  }
  let seed = 101;
  for (const [baseId, rarityId, itemLevel] of PACK[classId]) {
    const item = generateItem({ seed: seed++, baseId, rarityId, itemLevel });
    await db.query(
      `insert into item_instances (id, character_id, base_id, rarity_id, item_level, affixes, seed, source)
       values ($1, $2, $3, $4, $5, $6, $7, 'farming')`,
      [
        randomUUID(),
        characterId,
        item.baseId,
        item.rarityId,
        item.itemLevel,
        JSON.stringify(item.affixes),
        item.seed,
      ],
    );
  }
}

async function run(browser, db, vp) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  page.on('pageerror', (err) => console.error(`! page error @ ${vp.name}: ${err.message}`));
  const tag = `${Date.now().toString(36)}${vp.name[0]}`;

  step(vp, 'register and forge a hero');
  await page.goto(`${baseUrl}/#/register`, { waitUntil: 'networkidle' });
  await page.getByLabel('Email').fill(`trade-${tag}@graumark.test`);
  await page.getByLabel('Display name').fill(`Trader ${String(Date.now()).slice(-6)}`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('heading', { name: 'Forge your first hero' }).waitFor();
  await page.getByLabel('Name', { exact: true }).fill(vp.hero);
  await page.getByRole('radio', { name: new RegExp(`^${vp.className}`) }).check({ force: true });
  await page.getByRole('button', { name: 'Forge hero' }).click();
  await page.waitForURL(/#\/hub/);
  const id = await page.evaluate(
    async () => (await (await fetch('/api/characters')).json()).activeCharacterId,
  );

  step(vp, 'merchant, before any loot (empty pack)');
  await page.goto(`${baseUrl}/#/merchant`);
  await page.getByRole('heading', { name: 'Today’s wares' }).waitFor();
  await page.getByText('Your pack is empty.').waitFor();
  if (vp.name === 'desktop') await shoot(page, vp, 'merchant-empty');

  step(vp, 'seed level, gold, materials and a pack');
  await seed(db, id, vp.className.toLowerCase());
  await page.goto(`${baseUrl}/#/hub`);
  await page.reload({ waitUntil: 'networkidle' });

  step(vp, 'merchant: buy one, pick some to sell');
  await page.goto(`${baseUrl}/#/merchant`);
  await page.getByRole('button', { name: /^Buy / }).first().waitFor();
  await page.getByRole('button', { name: /^Buy / }).first().click();
  await page.getByText(/^Bought /).waitFor();
  await page.getByRole('button', { name: 'All common' }).click();
  await shoot(page, vp, 'merchant');

  step(vp, 'forge: pick salvage, then commission');
  await page.goto(`${baseUrl}/#/forge`);
  await page.getByRole('heading', { name: 'Commissions' }).waitFor();
  await page.getByRole('button', { name: 'Up to uncommon' }).click();
  await shoot(page, vp, 'forge');
  await page.getByRole('radio', { name: 'Chest' }).first().click();
  await page
    .getByRole('button', { name: /^Forge chest/ })
    .first()
    .click();
  await page.getByText(/^The smith hands you/).waitFor();
  await shoot(page, vp, 'forge-crafted');
  await context.close();
}

mkdirSync(outDir, { recursive: true });
const db = new pg.Client({ connectionString: databaseUrl });
await db.connect();
const browser = await playwright.chromium.launch();
try {
  for (const vp of VIEWPORTS) await run(browser, db, vp);
} finally {
  await browser.close();
  await db.end();
}
