// Captures the ticket T.3 account shelf (the Warehouse's second tab) at desktop (1440) and mobile
// (390), into docs/screenshots/phase-5/:
// - `shelf-off`: the default, every "Shelf: …" switch off, with things already on the shelf (the
//   plain "not open yet" line; taking out still works);
// - `shelf-open`: the switches on, the first hero placing two items and gold (the success line);
// - `shelf-other-hero`: the account's second hero, the items labelled with who left them, taking
//   them out (the success line);
// - `shelf-paused`: gold paused while items and materials stay open;
// - `shelf-full`: every item place taken.
// Heroes, items and the trading settings are written straight into the database, so use a scratch
// database only (and a built game-core):
//   pnpm build
//   DATABASE_URL=postgres://…/wf_shots pnpm db:migrate
//   DATABASE_URL=postgres://…/wf_shots SESSION_COOKIE_SECURE=false pnpm --filter @worldforge/server dev
//   pnpm --filter @worldforge/web dev
//   DATABASE_URL=postgres://…/wf_shots node tools/screenshots/shelf.mjs [baseUrl] [outDir]
// The server caches the world state and the settings for 60 s; the script waits that out after
// changing either.
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  DEFAULT_TRADING_SETTINGS,
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
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-5');
const PASSWORD = 'ashes-and-iron-42';
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, heroes: ['Hesper', 'Corwin'], classId: 'warrior' },
  { name: 'mobile', width: 390, height: 844, heroes: ['Tamsin', 'Ilse'], classId: 'mage' },
];
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const CACHE_MS = 61_000;
const wait = () => new Promise((r) => setTimeout(r, CACHE_MS));

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

async function setShelf(shelf) {
  const value = { ...structuredClone(DEFAULT_TRADING_SETTINGS), shelf };
  await db.query(
    `insert into game_settings (key, value, version, updated_at) values ('trading', $1, 1, now())
     on conflict (key) do update set value = excluded.value`,
    [JSON.stringify(value)],
  );
}

/** An account with two heroes; the first is active. */
async function account(browser, vp, tag) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (err) => console.error(`! page error @ ${vp.name}: ${err.message}`));
  const reg = await ctx.request.post(`${baseUrl}/api/auth/register`, {
    data: {
      email: `shelf-${tag}-${Date.now()}@graumark.test`,
      displayName: `${vp.heroes[0]} House ${letters(Date.now() % 9999)}`,
      password: PASSWORD,
    },
  });
  if (!reg.ok()) throw new Error(`register: ${reg.status()} ${await reg.text()}`);
  // The patch-notes herald slip is not part of the shelf: mark the notes read for this account.
  const { account: me } = await reg.json();
  await page.addInitScript(
    ([k]) => window.localStorage.setItem(k, '99.0.0'),
    [`wf.seen.notes.${me.id}`],
  );
  const ids = [];
  for (const [n, name] of vp.heroes.entries()) {
    const created = await ctx.request.post(`${baseUrl}/api/characters`, {
      data: {
        name,
        classId: n === 0 ? vp.classId : 'hunter',
        appearance: { banner: n === 0 ? 'ember' : 'moss' },
      },
    });
    if (!created.ok()) throw new Error(`character: ${created.status()} ${await created.text()}`);
    ids.push((await created.json()).character.id);
  }
  await ctx.request.post(`${baseUrl}/api/characters/${ids[0]}/select`);
  await ctx.request.post(`${baseUrl}/api/account/guide`, { data: { dismissed: true } });
  await db.query('update characters set gold = 6400, level = 14 where id = $1', [ids[0]]);
  await db.query('update characters set gold = 180, level = 9 where id = $1', [ids[1]]);
  for (const [m, q] of [
    ['timber', 42],
    ['ironOre', 17],
    ['soulShard', 3],
  ]) {
    await db.query(
      'insert into character_materials (character_id, material_id, quantity) values ($1, $2, $3)',
      [ids[0], m, q],
    );
  }
  const { rows } = await db.query('select account_id from characters where id = $1', [ids[0]]);
  return { ctx, page, ids, accountId: rows[0].account_id };
}

/** Items of the given rarities into a hero's pack, or onto the account shelf. */
async function seedItems(characterId, classId, rarities, { shelf = null, offset = 0 } = {}) {
  const rng = createRng(`shelf-shots:${classId}:${offset}`);
  const bases = ITEM_BASES.filter(
    (b) => !b.unique && b.minItemLevel <= 14 && canClassUseItem(b, classId),
  );
  for (let i = 0; i < rarities.length; i++) {
    const base = bases[rng.int(0, bases.length - 1)];
    const item = generateItem({
      seed: 1900 + offset + i,
      baseId: base.id,
      rarityId: rarities[i],
      itemLevel: 9 + rng.int(0, 5),
      classId,
    });
    await db.query(
      `insert into item_instances (id, character_id, base_id, rarity_id, item_level, affixes, seed,
         effect_id, effect_roll, source, binding, on_shelf, shelf_account_id, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'farming', $10, $11, $12,
         now() - ($13 || ' minutes')::interval)`,
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
        ['epic', 'legendary'].includes(rarities[i]) ? 'equip' : 'account',
        shelf !== null,
        shelf,
        String(rarities.length - i + offset),
      ],
    );
  }
}

async function shelfTab(page) {
  await page.goto(`${baseUrl}/#/warehouse`);
  await page.reload();
  await page.getByRole('tab', { name: 'Account shelf' }).click();
  await page.getByRole('heading', { name: 'On the account shelf' }).waitFor();
  await page.waitForTimeout(300);
}

const browser = await playwright.chromium.launch();
try {
  mkdirSync(outDir, { recursive: true });
  await db.query(
    `insert into world_flags (flag_id, project_id, set_at) values ('warehouseRestored', 'restoreWarehouse', now())
     on conflict do nothing`,
  );
  await setShelf({ items: false, materials: false, gold: false });
  await wait();

  const accounts = [];
  for (const vp of VIEWPORTS) {
    const a = await account(browser, vp, vp.name[0]);
    accounts.push(a);
    await seedItems(a.ids[0], vp.classId, ['common', 'rare', 'uncommon', 'epic', 'legendary']);
    // Left on the shelf earlier, before the town paused it: it can still be taken out.
    await seedItems(a.ids[1], vp.classId, ['rare', 'epic'], { shelf: a.accountId, offset: 50 });
    await db.query('update accounts set shelf_gold = 350 where id = $1', [a.accountId]);
    await shelfTab(a.page);
    await a.page.getByText('Not open yet').waitFor();
    await shoot(a.page, vp, 'shelf-off');
  }

  await setShelf({ items: true, materials: true, gold: true });
  await wait();
  for (const [n, vp] of VIEWPORTS.entries()) {
    const a = accounts[n];
    await shelfTab(a.page);
    // The two newest pack items are the Legendary and the Epic.
    const picker = a.page
      .getByRole('list', { name: 'Items to place on the account shelf' })
      .getByRole('button');
    for (let i = 0; i < 2; i++) await picker.nth(i).click();
    await a.page.getByLabel('Gold to place').fill('1500');
    await a.page.getByLabel('Timber').first().fill('20');
    await a.page.getByRole('button', { name: 'Place on the shelf' }).click();
    await a.page.getByText(/^Placed 2 items/).waitFor();
    await a.page.waitForTimeout(300);
    await shoot(a.page, vp, 'shelf-open');

    // The second hero takes them out.
    await a.ctx.request.post(`${baseUrl}/api/characters/${a.ids[1]}/select`);
    await shelfTab(a.page);
    const taking = a.page.getByRole('list', { name: 'Items to take out' }).getByRole('button');
    for (let i = 0; i < 2; i++) await taking.nth(i).click();
    await a.page.getByLabel('Gold to take').fill('1500');
    await a.page.getByRole('button', { name: /^Take out to / }).click();
    await a.page.getByText(/took 2 items/).waitFor();
    await a.page.waitForTimeout(300);
    await shoot(a.page, vp, 'shelf-other-hero');
    await a.ctx.request.post(`${baseUrl}/api/characters/${a.ids[0]}/select`);
  }

  await setShelf({ items: true, materials: true, gold: false });
  await wait();
  for (const [n, vp] of VIEWPORTS.entries()) {
    const a = accounts[n];
    await shelfTab(a.page);
    await a.page.getByText(/Placing gold on the shelf is paused/).waitFor();
    await shoot(a.page, vp, 'shelf-paused');

    // Full: fill every item place.
    const { rows } = await db.query(
      'select count(*)::int as n from item_instances where shelf_account_id = $1 and on_shelf',
      [a.accountId],
    );
    const rest = Array.from({ length: 20 - rows[0].n }, (_, i) =>
      i % 4 === 0 ? 'rare' : 'common',
    );
    await seedItems(a.ids[1], vp.classId, rest, { shelf: a.accountId, offset: 300 });
    await shelfTab(a.page);
    await a.page.getByText('Every item place is taken.', { exact: false }).waitFor();
    await shoot(a.page, vp, 'shelf-full');
  }
} finally {
  await browser.close();
  await db.end();
}
