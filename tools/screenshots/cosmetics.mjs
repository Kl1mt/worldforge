// Captures the ticket 6.8 UI at desktop (1440) and mobile (390): the collection book (everything,
// appearances with the preview, still to earn, after equipping, loading, error, and the fallbacks
// with the banner and crest art blocked), the profile showing a hero appearance, banner, crest and
// title colour, a guild roster row with the crest mark and coloured title, the area scene with the
// hero's palette, and the admin animation gallery's Palettes table.
//
// Everything is made-up and seeded into a scratch database. Unlocks are seeded as the grants would
// have written them (reaching level 40 or a season honour is out of reach for a screenshot run);
// equips go through the API and the book's own buttons. Only loading and error are faked.
//
// Needs a dev server on a scratch PostgreSQL database:
//   DATABASE_URL=postgres://…/wf_shots_cosm pnpm db:migrate
//   DATABASE_URL=postgres://…/wf_shots_cosm SESSION_COOKIE_SECURE=false pnpm --filter @worldforge/server dev
//   pnpm --filter @worldforge/web dev
//   DATABASE_URL=postgres://…/wf_shots_cosm node tools/screenshots/cosmetics.mjs [baseUrl] [outDir]
// Never against the live site.
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
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
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

async function shoot(page, vp, name, locator) {
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  if (overflow) console.warn(`! horizontal overflow on ${name} @ ${vp.name}`);
  const file = `${outDir}/${name}-${vp.name}.png`;
  await (locator ?? page.locator('main')).screenshot({
    path: file,
    style: '.bottombar { display: none !important; }',
  });
  console.log(`saved ${file}`);
}

/** Waits until every palette-swapped sprite in view has been drawn. */
async function palettesDrawn(page) {
  await page.waitForFunction(
    () => document.querySelectorAll('[data-palette="pending"]').length === 0,
    null,
    { timeout: 15_000 },
  );
}

const keyed = (api, url, data) =>
  api.post(`${baseUrl}${url}`, { data, headers: { 'idempotency-key': randomUUID() } });

mkdirSync(outDir, { recursive: true });
const browser = await playwright.chromium.launch();
const contexts = [];
try {
  const stamp = Date.now();
  const email = `isolde-${stamp}@graumark.test`;
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
    });
    if (vp.name === 'desktop') {
      const reg = await ctx.request.post(`${baseUrl}/api/auth/register`, {
        data: { email, displayName: 'Isolde Varn', password: PASSWORD },
      });
      if (!reg.ok()) throw new Error(`register: ${reg.status()} ${await reg.text()}`);
      for (const [name, classId, banner] of [
        ['Hadwin', 'warrior', 'ember'],
        ['Ysolde', 'mage', 'dusk'],
      ]) {
        const made = await ctx.request.post(`${baseUrl}/api/characters`, {
          data: { name, classId, appearance: { banner } },
        });
        if (!made.ok()) throw new Error(`character: ${made.status()} ${await made.text()}`);
      }
      await db.query(`update accounts set role = 'admin' where email = $1`, [email]);
    } else {
      const login = await ctx.request.post(`${baseUrl}/api/auth/login`, {
        data: { email, password: PASSWORD },
      });
      if (!login.ok()) throw new Error(`login: ${login.status()}`);
    }
    const page = await ctx.newPage();
    page.on('pageerror', (err) => console.error(`! page error @ ${vp.name}: ${err.message}`));
    contexts.push({ vp, ctx, page });
  }
  const me = (await db.query('select id, handle from accounts where email = $1', [email])).rows[0];
  const heroes = (
    await db.query('select id, name from characters where account_id = $1 order by created_at', [
      me.id,
    ])
  ).rows;
  const [hadwin, ysolde] = heroes;
  await db.query(
    `update characters set level = 40, progress = '{"gravewardenDefeated":true,"cryptTierCleared":3,"ashenWardenDefeated":true,"forgeTyrantDefeated":true}' where id = $1`,
    [hadwin.id],
  );
  await db.query(`update characters set level = 22 where id = $1`, [ysolde.id]);
  const api = contexts[0].ctx.request;
  await api.post(`${baseUrl}/api/characters/${hadwin.id}/select`);

  // What this account earned in play: level 40, the Tyrant, the Warden, the crypt's Legendary
  // tier, the Forgeward Outpost, a Legendary find, ten contracts and the Harvest's first tier.
  const unlocks = [
    ['appearance.ashen', `milestone:${hadwin.id}`],
    ['appearance.ember', `milestone:${hadwin.id}`],
    ['appearance.grave-moss', 'achievement:gravewardenSlain'],
    ['banner.warden-flame', `milestone:${hadwin.id}`],
    ['banner.crypt-seal', 'achievement:cryptTier3'],
    ['banner.forgeward', 'achievement:forgewardBuilder'],
    ['banner.harvest-sheaf', 'event:1:tier:1'],
    ['crest.iron', 'achievement:contracts10'],
    ['title-colour.ember', 'achievement:firstLegendary'],
  ];
  for (const [id, source] of unlocks) {
    await db.query(
      `insert into cosmetic_unlocks (account_id, cosmetic_id, source, granted_at) values ($1, $2, $3, now() - interval '3 days')`,
      [me.id, id, source],
    );
  }

  // 1. Loading and error (faked), before anything is worn.
  for (const { vp, page } of contexts) {
    await page.route('**/api/account/collection', async (route) => {
      await new Promise((r) => setTimeout(r, 60_000));
      await route.abort();
    });
    await page.goto(`${baseUrl}/#/collection`);
    await page.locator('.book[aria-busy="true"]').waitFor();
    await shoot(page, vp, 'cosmetics-book-loading', page.locator('.book'));
    await page.unroute('**/api/account/collection');
    await page.route('**/api/account/collection', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'unavailable', message: 'Down for a moment' } }),
      }),
    );
    await page.reload();
    await page.locator('.book [role="alert"]').waitFor();
    await shoot(page, vp, 'cosmetics-book-error', page.locator('.book'));
    await page.unroute('**/api/account/collection');
  }

  // 2. The whole book; appearances with the preview; still to earn.
  for (const { vp, page } of contexts) {
    await page.goto(`${baseUrl}/#/collection`, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.book-card').first().waitFor();
    await palettesDrawn(page);
    await shoot(page, vp, 'cosmetics-book', page.locator('.book'));
    await page.getByRole('button', { name: 'Appearances' }).click();
    await page.locator('.book-card', { hasText: 'Ember' }).click();
    await palettesDrawn(page);
    await shoot(page, vp, 'cosmetics-book-appearances', page.locator('.book'));
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await page.getByRole('button', { name: 'Still to earn' }).click();
    await page.locator('.book-card').first().click();
    await shoot(page, vp, 'cosmetics-book-locked', page.locator('.book'));
    await page.getByRole('button', { name: 'Everything' }).click();
  }

  // 3. Equip from the book: Hadwin in Ember, the Forgeward banner (desktop clicks the buttons).
  {
    const { vp, page } = contexts[0];
    await page.getByRole('button', { name: 'Appearances' }).click();
    await page.locator('.book-card', { hasText: 'Ember' }).click();
    await page.getByRole('button', { name: /Dress Hadwin/ }).click();
    await page.getByRole('status').waitFor();
    await page.getByRole('button', { name: 'Banners' }).click();
    await page.locator('.book-card', { hasText: 'Forgeward banner' }).click();
    await page.getByRole('button', { name: 'Show it' }).click();
    await page.getByRole('status').waitFor();
    await palettesDrawn(page);
    await shoot(page, vp, 'cosmetics-book-equipped', page.locator('.book'));
  }
  // The rest through the API (crest, title colour; Ysolde in Grave-moss), and a season title.
  const equip = await keyed(api, '/api/account/cosmetics/equip', {
    crest: 'crest.iron',
    titleColour: 'title-colour.ember',
  });
  if (!equip.ok()) throw new Error(`equip: ${equip.status()} ${await equip.text()}`);
  const wear = await keyed(api, `/api/characters/${ysolde.id}/appearance`, {
    appearance: 'appearance.grave-moss',
  });
  if (!wear.ok()) throw new Error(`wear: ${wear.status()} ${await wear.text()}`);
  await db.query(
    `insert into seasons (number, starts_at, ends_at, archived_at, awarded_at) values (1, now() - interval '70 days', now() - interval '14 days', now() - interval '14 days', now() - interval '14 days') on conflict do nothing`,
  );
  await db.query(
    `insert into season_awards (season, account_id, metric, tier, rank, character_id, awarded_at) values (1, $1, 'level', 'veteran', 31, $2, now() - interval '14 days')`,
    [me.id, hadwin.id],
  );
  await db.query(
    `insert into cosmetic_unlocks (account_id, cosmetic_id, source, granted_at) values ($1, 'banner.season-laurel', 'season:1', now() - interval '14 days')`,
    [me.id],
  );
  const title = await api.post(`${baseUrl}/api/account/prestige`, {
    data: { title: { season: 1, metric: 'level' }, frame: null },
  });
  if (!title.ok()) throw new Error(`prestige: ${title.status()} ${await title.text()}`);

  // 4. The profile, the scene, the roster.
  const guildId = randomUUID();
  await db.query(
    `insert into guilds (id, handle, name, tag, emblem, created_by) values ($1, $2, 'The Ember Watch', 'EMBR', 'flame', $3)`,
    [guildId, `g${stamp.toString(36)}`, me.id],
  );
  await db.query(
    `insert into guild_members (account_id, guild_id, role, joined_at) values ($1, $2, 'leader', now())`,
    [me.id, guildId],
  );
  for (const { vp, page } of contexts) {
    await page.goto(`${baseUrl}/#/profile/${me.handle}`, { waitUntil: 'networkidle' });
    await page.locator('.herald__hero').first().waitFor();
    await palettesDrawn(page);
    await shoot(page, vp, 'cosmetics-profile', page.locator('section.herald'));
    await page.goto(`${baseUrl}/#/guild`, { waitUntil: 'networkidle' });
    await page.locator('.cosm-crestmark').first().waitFor();
    // The roster row: the crest mark, the name and the title in its colour.
    await shoot(
      page,
      vp,
      'cosmetics-roster',
      page
        .locator('.fellow__who')
        .filter({ has: page.locator('.cosm-crestmark') })
        .first()
        .locator('xpath=..'),
    );
    await page.goto(`${baseUrl}/#/area`, { waitUntil: 'networkidle' });
    await page.locator('.scene__hero').waitFor();
    await palettesDrawn(page);
    await shoot(page, vp, 'cosmetics-area-scene', page.locator('.scene'));
  }

  // 5. Fallbacks: the banner and crest art blocked (a failed load draws the plain look).
  for (const { vp, page } of contexts) {
    await page.route(/\/assets\/(banners|crests)\//, (route) => route.abort());
    await page.goto(`${baseUrl}/#/collection`, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Banners' }).click();
    await page.locator('.book-card', { hasText: 'Forgeward banner' }).click();
    await page.locator('.cosm-banner--plain').first().waitFor();
    await shoot(page, vp, 'cosmetics-book-fallback', page.locator('.book'));
    await page.unroute(/\/assets\/(banners|crests)\//);
  }

  // 6. The admin animation gallery's Palettes table.
  {
    const { vp, page } = contexts[0];
    await page.goto(`${baseUrl}/#/admin/animations`, { waitUntil: 'networkidle' });
    const table = page.locator('section[aria-label="Palettes"]');
    await table.waitFor();
    await table.scrollIntoViewIfNeeded();
    await palettesDrawn(page);
    await shoot(page, vp, 'cosmetics-admin-palettes', table);
  }
} finally {
  for (const { ctx } of contexts) await ctx.close();
  await browser.close();
  await db.end();
}
