// Captures the ticket 9.5 UI at desktop (1440) and mobile (390): the hub with the lit Summoning
// Shrine, the Shrine (loading, error, a full bank, the draw's reveal, the odds open, the marks
// shop, no draws left), the collection book's Companions, and the area scene with a companion
// beside the hero (and its plain fallback with the companion art blocked).
//
// Everything is made-up and seeded into a scratch database. The account is made ten days old (a
// full free bank) and given play draws as an event tier would grant them; every draw goes through
// the API or the Shrine's own button, so what is drawn depends on the server's seeds. Only loading
// and error are faked.
//
// Needs a dev server on a scratch PostgreSQL database:
//   DATABASE_URL=postgres://…/wf_shots_shrine pnpm db:migrate
//   DATABASE_URL=postgres://…/wf_shots_shrine SESSION_COOKIE_SECURE=false pnpm --filter @worldforge/server dev
//   pnpm --filter @worldforge/web dev
//   DATABASE_URL=postgres://…/wf_shots_shrine node tools/screenshots/shrine.mjs [baseUrl] [outDir]
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
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-9');
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

const keyed = (api, url, data = {}) =>
  api.post(`${baseUrl}${url}`, { data, headers: { 'idempotency-key': randomUUID() } });

mkdirSync(outDir, { recursive: true });
const browser = await playwright.chromium.launch();
const contexts = [];
try {
  const stamp = Date.now();
  const email = `wenna-${stamp}@graumark.test`;
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
    });
    if (vp.name === 'desktop') {
      const reg = await ctx.request.post(`${baseUrl}/api/auth/register`, {
        data: { email, displayName: 'Wenna Holt', password: PASSWORD },
      });
      if (!reg.ok()) throw new Error(`register: ${reg.status()} ${await reg.text()}`);
      const made = await ctx.request.post(`${baseUrl}/api/characters`, {
        data: { name: 'Brannoc', classId: 'hunter', appearance: { banner: 'moss' } },
      });
      if (!made.ok()) throw new Error(`character: ${made.status()} ${await made.text()}`);
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
  const me = (await db.query('select id from accounts where email = $1', [email])).rows[0];
  const hero = (await db.query('select id from characters where account_id = $1', [me.id])).rows[0];
  // Ten days old: the free bank opens full. Before the Shrine is first read.
  await db.query(`update accounts set created_at = now() - interval '10 days' where id = $1`, [
    me.id,
  ]);
  await db.query(`update characters set level = 24 where id = $1`, [hero.id]);
  const api = contexts[0].ctx.request;
  await api.post(`${baseUrl}/api/characters/${hero.id}/select`);

  // 1. The hub: the Shrine is lit (A.19's art, or the candle glow).
  for (const { vp, page } of contexts) {
    await page.goto(`${baseUrl}/#/hub`, { waitUntil: 'networkidle' });
    await page.locator('.hub__stage').waitFor();
    await shoot(page, vp, 'shrine-hub', page.locator('.hub__frame'));
  }

  // 2. Loading and error (faked).
  for (const { vp, page } of contexts) {
    await page.route('**/api/account/shrine', async (route) => {
      await new Promise((r) => setTimeout(r, 60_000));
      await route.abort();
    });
    await page.goto(`${baseUrl}/#/shrine`);
    await page.locator('.shrine[aria-busy="true"]').waitFor();
    await shoot(page, vp, 'shrine-loading', page.locator('.shrine'));
    await page.unroute('**/api/account/shrine');
    await page.route('**/api/account/shrine', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'unavailable', message: 'Down for a moment' } }),
      }),
    );
    await page.reload();
    await page.locator('.shrine [role="alert"]').waitFor();
    await shoot(page, vp, 'shrine-error', page.locator('.shrine'));
    await page.unroute('**/api/account/shrine');
  }

  // 3. A full bank (7 free) plus three play draws, as event tiers grant them.
  for (let t = 1; t <= 3; t++) {
    await db.query(
      `insert into shrine_draw_grants (account_id, source, source_key, count, granted_at)
       values ($1, 'play', $2, 1, now())`,
      [me.id, `event:900:tier:${t}`],
    );
  }
  for (const { vp, page } of contexts) {
    await page.goto(`${baseUrl}/#/shrine`, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.shrine__draw').waitFor();
    await shoot(page, vp, 'shrine-full-bank', page.locator('.shrine'));
  }

  // 4. A draw from the button, its reveal; the odds open.
  {
    const { vp, page } = contexts[0];
    await page.locator('.shrine__draw').click();
    await page.locator('.shrine-card').waitFor();
    await shoot(page, vp, 'shrine-reveal', page.locator('.shrine__altar'));
    await page.locator('.shrine__odds summary').click();
    await shoot(page, vp, 'shrine-odds', page.locator('.shrine__odds'));
  }
  {
    const { vp, page } = contexts[1];
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.shrine__draw').click();
    await page.locator('.shrine-card').waitFor();
    await shoot(page, vp, 'shrine-reveal', page.locator('.shrine__altar'));
  }

  // 5. Many draws (play draws granted for the run), so duplicates bring marks; then the shop.
  await db.query(
    `insert into shrine_draw_grants (account_id, source, source_key, count, granted_at)
     values ($1, 'play', 'season:900', 40, now())`,
    [me.id],
  );
  for (;;) {
    const res = await keyed(api, '/api/account/shrine/draw');
    if (res.status() === 409) break;
    if (!res.ok()) throw new Error(`draw: ${res.status()} ${await res.text()}`);
  }
  for (const { vp, page } of contexts) {
    await page.goto(`${baseUrl}/#/shrine`, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.shrine__shop').waitFor();
    await shoot(page, vp, 'shrine-empty-and-shop', page.locator('.shrine'));
  }
  {
    const { vp, page } = contexts[0];
    const buy = page.locator('.shrine-offer button:not([disabled])').first();
    if (await buy.count()) {
      await buy.click();
      await page.locator('.shrine__ok').waitFor();
      await shoot(page, vp, 'shrine-bought', page.locator('.shrine__shop'));
    } else console.warn('! not enough marks for any offer this run');
  }

  // 6. The collection book's Companions; one worn, beside the hero in the area scene.
  const owned = (
    await db.query(
      `select cosmetic_id from cosmetic_unlocks where account_id = $1 and cosmetic_id like 'companion.%' order by cosmetic_id`,
      [me.id],
    )
  ).rows.map((r) => r.cosmetic_id);
  if (owned.length > 0) {
    const worn = await keyed(api, '/api/account/cosmetics/equip', { companion: owned[0] });
    if (!worn.ok()) throw new Error(`equip: ${worn.status()} ${await worn.text()}`);
  }
  await keyed(api, `/api/characters/${hero.id}/activity`, { areaId: 'abandonedFields' });
  for (const { vp, page } of contexts) {
    await page.goto(`${baseUrl}/#/collection`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Companions' }).click();
    await page.locator('.book-card').first().waitFor();
    await shoot(page, vp, 'shrine-book-companions', page.locator('.book'));
    await page.goto(`${baseUrl}/#/area`, { waitUntil: 'networkidle' });
    await page.locator('.scene__hero').waitFor();
    if (owned.length > 0) await page.locator('.scene__companion').waitFor();
    await shoot(page, vp, 'shrine-area-companion', page.locator('.scene'));
    // The fallback: the companion art blocked (a plain wisp in code).
    await page.route(/\/assets\/companions\//, (route) => route.abort());
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.scene__hero').waitFor();
    await shoot(page, vp, 'shrine-area-companion-fallback', page.locator('.scene'));
    await page.unroute(/\/assets\/companions\//);
  }
} finally {
  for (const { ctx } of contexts) await ctx.close();
  await browser.close();
  await db.end();
}
