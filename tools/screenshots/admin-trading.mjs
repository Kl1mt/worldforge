// Captures the ticket T.2 UI at desktop (1440) and mobile (390): the admin panel's "Trading
// settings" folio at the launch defaults (empty history), while editing (unsaved changes, and a
// number over its hard maximum refused), after a save (success and the change history), a
// conflict with another admin's save, the moderators' read-only board on the docket, and loading
// and error (faked: the request is held, then 503).
//
// Everything is made-up: two admins and a moderator registered through the API on a scratch
// database, their roles set in the database (the stand-in for the role CLI).
//
// Needs a dev server on a scratch PostgreSQL database:
//   DATABASE_URL=postgres://…/wf_shots_trading pnpm db:migrate
//   DATABASE_URL=postgres://…/wf_shots_trading SESSION_COOKIE_SECURE=false \
//     pnpm --filter @worldforge/server dev
//   pnpm --filter @worldforge/web dev
//   DATABASE_URL=postgres://…/wf_shots_trading node tools/screenshots/admin-trading.mjs [baseUrl] [outDir]
// Never against the live site.
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
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-5');
const PASSWORD = 'ashes-and-iron-42';
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const existing = await db.query('select count(*)::int as n from game_settings');
if (existing.rows[0].n > 0) throw new Error('Use a fresh scratch database (settings were saved).');

async function shoot(page, vp, name, locator) {
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  if (overflow) console.warn(`! horizontal overflow on ${name} @ ${vp.name}`);
  const file = `${outDir}/${name}-${vp.name}.png`;
  await (locator ?? page.locator('main')).screenshot({
    path: file,
    style:
      '.bottombar { display: none !important; } .tset__savebar { position: static !important; }',
  });
  console.log(`saved ${file}`);
}

/** Registers an account (and a hero) through the API and gives it `role` in the database. */
async function staff(ctx, displayName, heroName, role) {
  const email = `${displayName.split(' ')[0].toLowerCase()}-${Date.now()}@graumark.test`;
  const reg = await ctx.request.post(`${baseUrl}/api/auth/register`, {
    data: { email, displayName, password: PASSWORD },
  });
  if (!reg.ok()) throw new Error(`register: ${reg.status()} ${await reg.text()}`);
  const made = await ctx.request.post(`${baseUrl}/api/characters`, {
    data: { name: heroName, classId: 'warrior', appearance: { banner: 'ash' } },
  });
  if (!made.ok()) throw new Error(`character: ${made.status()} ${await made.text()}`);
  await db.query(`update accounts set role = $2 where email = $1`, [email, role]);
  return email;
}

async function login(ctx, email) {
  const res = await ctx.request.post(`${baseUrl}/api/auth/login`, {
    data: { email, password: PASSWORD },
  });
  if (!res.ok()) throw new Error(`login: ${res.status()}`);
}

mkdirSync(outDir, { recursive: true });
const browser = await playwright.chromium.launch();
const contexts = [];
const newCtx = (vp) =>
  browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2 });
try {
  const setup = await newCtx(VIEWPORTS[0]);
  const adminEmail = await staff(setup, 'Castellan Ysolde', 'Sigrun', 'admin');
  const otherCtx = await newCtx(VIEWPORTS[0]);
  await staff(otherCtx, 'Steward Oryn', 'Halvard', 'admin');
  const modEmail = await staff(await newCtx(VIEWPORTS[0]), 'Warden Brann', 'Esk', 'moderator');
  await setup.close();

  for (const vp of VIEWPORTS) {
    const ctx = await newCtx(vp);
    await login(ctx, adminEmail);
    const mod = await newCtx(vp);
    await login(mod, modEmail);
    const page = await ctx.newPage();
    const modPage = await mod.newPage();
    for (const p of [page, modPage]) {
      p.on('pageerror', (err) => console.error(`! page error @ ${vp.name}: ${err.message}`));
    }
    contexts.push({ vp, ctx, mod, page, modPage });
  }

  const folio = (page) => page.locator('section.strong');
  const lever = (page, name) => page.getByRole('switch', { name });
  const limit = (page, label) => page.getByLabel(label, { exact: true });

  // 1. The launch defaults, never changed (desktop first, so the history is still empty).
  for (const { vp, page } of contexts) {
    await page.goto(`${baseUrl}/#/admin/trading`, { waitUntil: 'networkidle' });
    await page.locator('.tset__history .tset__empty').waitFor();
    await shoot(page, vp, 'admin-trading-defaults', folio(page));
  }

  // 2. Editing: open trading with items, a typo over the hard maximum (refused before saving),
  //    then a valid number; 3. saved, with the history.
  const versions = [];
  for (const { vp, page } of contexts) {
    await page.goto(`${baseUrl}/#/admin/trading`, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.tset__state').waitFor();
    const first = versions.length === 0;
    if (first) {
      await lever(page, 'Trading').click();
      await lever(page, 'Trade: items').click();
      await lever(page, 'Shelf: items').click();
    } else {
      await lever(page, 'Trade: materials').click();
      await lever(page, 'Shelf: materials').click();
    }
    await limit(page, 'Gold per week').fill('100000');
    await page.locator('.tset__limit-error').waitFor();
    await shoot(page, vp, 'admin-trading-refused', folio(page));
    await limit(page, 'Gold per week').fill(first ? '15000' : '12000');
    await page.locator('.tset__limit-error').waitFor({ state: 'detached' });
    await shoot(page, vp, 'admin-trading-editing', folio(page));
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.locator('.tset__ok').waitFor();
    await page.locator('.tset__entry').first().waitFor();
    await shoot(page, vp, 'admin-trading-saved', folio(page));
    versions.push(vp.name);
  }

  // 4. A conflict: the other admin saves while this one has unsaved changes.
  for (const { vp, page } of contexts) {
    await page.goto(`${baseUrl}/#/admin/trading`, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.tset__state').waitFor();
    await lever(page, 'Tradeable: Mythic').click();
    const current = await otherCtx.request.get(`${baseUrl}/api/mod/settings/trading`);
    const view = await current.json();
    const settings = { ...view.settings, limits: { ...view.settings.limits } };
    settings.limits.epicPerWeek = settings.limits.epicPerWeek === 12 ? 8 : 12;
    const res = await otherCtx.request.put(`${baseUrl}/api/admin/settings/trading`, {
      data: { expectedVersion: view.version, settings },
      headers: { 'idempotency-key': randomUUID() },
    });
    if (!res.ok()) throw new Error(`other admin save: ${res.status()} ${await res.text()}`);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByRole('button', { name: 'Reload the settings' }).waitFor();
    await shoot(page, vp, 'admin-trading-conflict', folio(page));
  }

  // 5. The moderators' docket: the same board, read-only.
  for (const { vp, modPage } of contexts) {
    await modPage.goto(`${baseUrl}/#/moderation`, { waitUntil: 'networkidle' });
    const board = modPage.locator('section.tset-docket');
    await board.locator('.tset__entry').first().waitFor();
    await shoot(modPage, vp, 'admin-trading-moderator', board);
  }

  // 6. Loading and error (faked: held, then 503).
  const fail = async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.fulfill({
      status: 503,
      json: {
        error: { code: 'unavailable', message: 'The server is busy. Try again in a moment.' },
      },
    });
  };
  for (const { vp, page } of contexts) {
    await page.route('**/api/mod/settings/trading*', fail);
    await page.goto(`${baseUrl}/#/admin/trading`);
    await page.reload();
    await page.locator('.tset .strong__wait').first().waitFor();
    await shoot(page, vp, 'admin-trading-loading', folio(page));
    await page.locator('.tset [role="alert"]').waitFor();
    await shoot(page, vp, 'admin-trading-error', folio(page));
    await page.unroute('**/api/mod/settings/trading*');
  }
  await otherCtx.close();
} finally {
  for (const c of contexts) {
    await c.ctx.close();
    await c.mod.close();
  }
  await browser.close();
  await db.end();
}
