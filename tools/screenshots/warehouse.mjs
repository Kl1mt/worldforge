// Captures the ticket 4.7 Warehouse at desktop (1440) and mobile (390):
// - `hub-warehouse-locked`: the hub before the town restores it (the Warehouse marked locked,
//   tapped: the notice with the link to the town works);
// - `warehouse-closed`: `#/warehouse` before the flag (locked, link to `#/works`);
// - `warehouse-open`: after the flag, a pack over capacity storing its three Legendaries (the
//   success line, the shelves, the extend offer);
// - `warehouse-full`: every shelf taken;
// - `pack-warehouse`: the full-pack banner pointing to the Warehouse.
// Heroes and items are seeded straight into the database, and the script sets and clears the
// `warehouseRestored` flag itself, so use a scratch database only (and a built game-core):
//   pnpm build
//   DATABASE_URL=postgres://…/wf_shots pnpm db:migrate
//   DATABASE_URL=postgres://…/wf_shots SESSION_COOKIE_SECURE=false pnpm --filter @worldforge/server dev
//   pnpm --filter @worldforge/web dev
//   DATABASE_URL=postgres://…/wf_shots node tools/screenshots/warehouse.mjs [baseUrl] [outDir]
// The server caches the world state for 60 s; the script waits that out after changing the flag.
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  ITEM_BASES,
  canClassUseItem,
  createRng,
  generateItem,
} from '../../packages/game-core/dist/index.js';

const require = createRequire(import.meta.url);
const serverRequire = createRequire(resolve('apps/server/package.json'));
const playwright = require('playwright');
const pg = serverRequire('pg');

const baseUrl = process.argv[2] ?? 'http://localhost:5173';
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-4');
const PASSWORD = 'ashes-and-iron-42';
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, hero: 'Hesper', classId: 'warrior' },
  { name: 'mobile', width: 390, height: 844, hero: 'Tamsin', classId: 'mage' },
];
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const CACHE_MS = 61_000;

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

const letters = (n) =>
  [...n.toString(26)].map((c) => String.fromCharCode(97 + (parseInt(c, 26) % 26))).join('');

async function hero(browser, vp, tag) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (err) => console.error(`! page error @ ${vp.name}: ${err.message}`));
  const email = `keeper-${tag}-${Date.now()}@graumark.test`;
  const reg = await ctx.request.post(`${baseUrl}/api/auth/register`, {
    data: {
      email,
      displayName: `${vp.hero} Keeper ${letters(Date.now() % 9999)}`,
      password: PASSWORD,
    },
  });
  if (!reg.ok()) throw new Error(`register: ${reg.status()} ${await reg.text()}`);
  const created = await ctx.request.post(`${baseUrl}/api/characters`, {
    data: {
      name: `${vp.hero}${letters(Date.now() % 99999)}`,
      classId: vp.classId,
      appearance: { banner: 'ember' },
    },
  });
  const { character } = await created.json();
  await ctx.request.post(`${baseUrl}/api/account/guide`, { data: { dismissed: true } });
  await db.query('update characters set gold = 4200, level = 14 where id = $1', [character.id]);
  return { ctx, page, id: character.id };
}

/** `count` items of the given rarities into the pack or the warehouse. */
async function seedItems(characterId, classId, rarities, { stored = false, offset = 0 } = {}) {
  const rng = createRng(`wh-shots:${classId}:${offset}`);
  const bases = ITEM_BASES.filter(
    (b) => !b.unique && b.minItemLevel <= 14 && canClassUseItem(b, classId),
  );
  for (let i = 0; i < rarities.length; i++) {
    const base = bases[rng.int(0, bases.length - 1)];
    const item = generateItem({
      seed: 900 + offset + i,
      baseId: base.id,
      rarityId: rarities[i],
      itemLevel: 9 + rng.int(0, 5),
      classId,
    });
    await db.query(
      `insert into item_instances (id, character_id, base_id, rarity_id, item_level, affixes, seed,
         effect_id, effect_roll, source, in_warehouse, locked, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'farming', $10, $11,
         now() - ($12 || ' minutes')::interval)`,
      [
        randomUUID(),
        characterId,
        item.baseId,
        item.rarityId,
        item.itemLevel,
        JSON.stringify(item.affixes),
        item.seed,
        item.effectId ?? null,
        item.effectRoll ?? null,
        stored,
        rarities[i] === 'epic',
        String(rarities.length - i + offset),
      ],
    );
  }
}

const mix = (n, tail = []) => [
  ...Array.from({ length: n - tail.length }, (_, i) =>
    i % 5 === 0 ? 'rare' : i % 3 === 0 ? 'uncommon' : 'common',
  ),
  ...tail,
];

const browser = await playwright.chromium.launch();
try {
  mkdirSync(outDir, { recursive: true });
  await db.query(`delete from world_flags where flag_id = 'warehouseRestored'`);
  await new Promise((r) => setTimeout(r, CACHE_MS));

  // Closed: the hub and the warehouse screen.
  const heroes = [];
  for (const vp of VIEWPORTS) {
    const h = await hero(browser, vp, `c${vp.name[0]}`);
    heroes.push(h);
    await h.page.goto(`${baseUrl}/#/hub`);
    await h.page.getByText('Town works').first().waitFor();
    await h.page.getByRole('button', { name: /^Warehouse, locked/ }).click({ force: true });
    await h.page.getByText('The Warehouse is locked until the town restores it.').waitFor();
    await h.page.waitForTimeout(300);
    await shoot(h.page, vp, 'hub-warehouse-locked');
    await h.page.goto(`${baseUrl}/#/warehouse`);
    await h.page.getByText('The doors are still off their hinges.').waitFor();
    await shoot(h.page, vp, 'warehouse-closed');
  }

  // Open: the town has restored it.
  await db.query(
    `insert into world_flags (flag_id, project_id, set_at) values ('warehouseRestored', 'restoreWarehouse', now())
     on conflict do nothing`,
  );
  await new Promise((r) => setTimeout(r, CACHE_MS));
  for (const [n, vp] of VIEWPORTS.entries()) {
    const h = heroes[n];
    // A full pack three Legendaries over capacity, a few things already stored.
    await seedItems(h.id, vp.classId, mix(63, ['epic', 'legendary', 'legendary', 'legendary']));
    await seedItems(h.id, vp.classId, mix(9, ['epic']), { stored: true, offset: 100 });
    await h.page.goto(`${baseUrl}/#/inventory`);
    await h.page.reload();
    await h.page.getByText(/Over capacity: 3 items/).waitFor();
    await h.page.waitForTimeout(300);
    await shoot(h.page, vp, 'pack-warehouse');

    await h.page.goto(`${baseUrl}/#/warehouse`);
    await h.page.getByRole('heading', { name: 'On the shelves' }).waitFor();
    // The three newest items are the Legendaries (the picker lists newest first).
    const picker = h.page.getByRole('list', { name: 'Items to store' }).getByRole('button');
    for (let i = 0; i < 3; i++) await picker.nth(i).click();
    await h.page.getByRole('button', { name: 'Store', exact: true }).click();
    await h.page.getByText(/^Stored 3 items/).waitFor();
    await h.page.waitForTimeout(300);
    await shoot(h.page, vp, 'warehouse-open');

    // Full: fill the rest of the shelves.
    const { rows } = await db.query(
      'select count(*)::int as n from item_instances where character_id = $1 and in_warehouse',
      [h.id],
    );
    await seedItems(h.id, vp.classId, mix(30 - rows[0].n), { stored: true, offset: 300 });
    await h.page.reload();
    await h.page.getByText('Every shelf is taken.', { exact: false }).waitFor();
    await h.page.waitForTimeout(300);
    await shoot(h.page, vp, 'warehouse-full');
  }
} finally {
  await browser.close();
  await db.end();
}
