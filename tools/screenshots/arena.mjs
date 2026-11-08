// Captures the ticket 5.5 arena (the Proving Ring) at desktop (1440) and mobile (390):
// - `arena-rated`: a level-14 hero after a rated duel fought through the UI (the result with its
//   log, the rated slate with one diamond spent, the defence, friendly challenges, the duel book);
// - `arena-friendly`: a friendly challenge opened from the friend list (`#/arena/friendly/<handle>`)
//   and fought across brackets;
// - `arena-defended`: the rival's view of the same rated duel, opened from their duel book;
// - `arena-fresh`: a level-4 hero (no defence, rated duels locked, no companions, empty book);
// - `arena-loading` and `arena-error`: the arena state request held back, and failing.
// Rivals are seeded straight into the database with a session (they never open a browser), then
// save their defences through the API.
// Needs a dev server on a scratch PostgreSQL database:
//   DATABASE_URL=postgres://…/wf_shots pnpm db:migrate
//   DATABASE_URL=postgres://…/wf_shots SESSION_COOKIE_SECURE=false pnpm --filter @worldforge/server dev
//   pnpm --filter @worldforge/web dev
//   DATABASE_URL=postgres://…/wf_shots node tools/screenshots/arena.mjs [baseUrl] [outDir]
import { mkdirSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, tag: 'A' },
  { name: 'mobile', width: 390, height: 844, tag: 'B' },
];
const DAY = 86_400_000;

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

async function shoot(page, vp, name, target = page.locator('main')) {
  // The patch-notes herald slip is not part of the arena.
  await page.addStyleTag({ content: '.notice { display: none !important; }' });
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  if (overflow) console.warn(`! horizontal overflow on ${name} @ ${vp.name}`);
  const file = `${outDir}/${name}-${vp.name}.png`;
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: vp.width, height: Math.max(vp.height, height) });
  await target.screenshot({ path: file });
  await page.setViewportSize({ width: vp.width, height: vp.height });
  console.log(`saved ${file}`);
}

/** An account with a live session, inserted directly (no registration limit). */
async function account(displayName) {
  const id = randomUUID();
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `insert into accounts (id, email, display_name, password_hash, handle)
     values ($1, $2, $3, 'seeded', substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))`,
    [id, `${id}@graumark.test`, displayName],
  );
  await db.query(`insert into sessions (id, account_id, expires_at) values ($1, $2, $3)`, [
    createHash('sha256').update(token).digest('hex'),
    id,
    new Date(Date.now() + 2 * DAY),
  ]);
  const { rows } = await db.query('select handle from accounts where id = $1', [id]);
  return { id, token, handle: rows[0].handle, displayName };
}

/** A player: an account, a hero at `level` (wearing its starting kit) and a browser context. */
async function player(browser, vp, displayName, heroName, classId, level) {
  const who = await account(displayName);
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
  });
  await ctx.addCookies([
    { name: 'wf_session', value: who.token, url: baseUrl.replace(/\/$/, '') + '/api' },
  ]);
  const created = await ctx.request.post(`${baseUrl}/api/characters`, {
    data: { name: heroName, classId, appearance: { banner: 'ember' } },
  });
  if (!created.ok()) throw new Error(`character: ${created.status()} ${await created.text()}`);
  const { character } = await created.json();
  await db.query('update characters set level = $1 where id = $2', [level, character.id]);
  return { ...who, ctx, character };
}

async function defend(p) {
  const res = await p.ctx.request.post(`${baseUrl}/api/arena/defence`, {
    data: { characterId: p.character.id },
  });
  if (!res.ok()) throw new Error(`defence: ${res.status()} ${await res.text()}`);
}

async function friends(a, b) {
  const [low, high] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
  await db.query(
    `insert into friendships (account_low, account_high, status, requested_by, accepted_at)
     values ($1, $2, 'friends', $1, now())`,
    [low, high],
  );
}

async function openPage(p, hash) {
  const page = await p.ctx.newPage();
  page.on('pageerror', (err) => console.error(`! page error: ${err.message}`));
  // Skip the first-steps guide (these heroes are not new players).
  await db
    .query(`update accounts set guide = '{"steps": [], "dismissed": true}'::jsonb where id = $1`, [
      p.id,
    ])
    .catch(() => {});
  await page.goto(`${baseUrl}/${hash}`);
  return page;
}

async function run(browser, vp) {
  const t = vp.tag;
  // Each viewport duels in its own bracket, so neither meets the other's rivals.
  const up = t === 'A' ? 0 : 20;
  const me = await player(browser, vp, `Brannoc Vell ${t}`, `Brannoc${t}`, 'warrior', 14 + up);
  const rivals = [];
  for (const [name, hero, cls, level] of [
    ['Ysolde Ash', 'Ysolde', 'mage', 16],
    ['Wren Of Ash', 'Wren', 'hunter', 12],
    ['Old Tamsin', 'Tamsin', 'warlock', 18],
  ]) {
    const r = await player(browser, vp, `${name} ${t}`, `${hero}${t}`, cls, level + up);
    await defend(r);
    rivals.push(r);
  }
  const friend = await player(
    browser,
    vp,
    `Corvin Vale ${t}`,
    `Corvin${t}`,
    'mage',
    t === 'A' ? 27 : 7,
  );
  await defend(friend);
  await friends(me, friend);
  await defend(me);

  // A rated duel through the UI.
  const page = await openPage(me, '#/arena');
  await page.locator('.arena-slate__row').first().waitFor();
  await page.locator('.arena-slate__row .btn').first().click();
  await page.locator('.arena-bout').waitFor();
  await page.locator('.arena-book__row').first().waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  await shoot(page, vp, 'arena-rated');
  const duelHref = await page.locator('.arena-book__row').first().getAttribute('href');

  // A friendly challenge from the friend list link.
  await page.goto(`${baseUrl}/#/arena/friendly/${friend.handle}`);
  await page.reload();
  await page.locator('.arena-friends__row--focus .btn').first().waitFor();
  await page.locator('.arena-friends__row--focus .btn').first().click();
  await page.locator('.arena-bout__where', { hasText: 'Friendly' }).waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  await shoot(page, vp, 'arena-friendly');
  await page.close();

  // The rival who defended: opened from their duel book.
  const { rows } = await db.query(
    `select a.id from accounts a join duels d on d.defender_account_id = a.id
     where d.challenger_account_id = $1 and d.kind = 'rated' limit 1`,
    [me.id],
  );
  const defender = rivals.find((r) => r.id === rows[0].id);
  const theirs = await openPage(defender, duelHref);
  await theirs.locator('.arena-bout').waitFor();
  await theirs.locator('.arena-book__row').first().waitFor();
  await shoot(theirs, vp, 'arena-defended');
  await theirs.close();

  // A fresh, low hero: no defence, rated duels locked, no companions, an empty book.
  const fresh = await player(browser, vp, `Odo Marrow ${t}`, `Odo${t}`, 'hunter', 4);
  const freshPage = await openPage(fresh, '#/arena');
  await freshPage.locator('.arena-book .arena__quiet').waitFor();
  await freshPage.locator('.arena-friendly .arena__quiet').waitFor();
  await shoot(freshPage, vp, 'arena-fresh');

  // Loading (held back) and error (refused) states.
  await freshPage.route('**/api/arena?*', async (route) => {
    await new Promise((r) => setTimeout(r, 4_000));
    await route.continue().catch(() => {});
  });
  await freshPage.reload();
  await freshPage.locator('.arena [aria-busy="true"]').first().waitFor();
  await shoot(freshPage, vp, 'arena-loading');
  await freshPage.unroute('**/api/arena?*');
  await freshPage.route('**/api/arena?*', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'unavailable', message: 'Down for a moment.' } }),
    }),
  );
  await freshPage.reload();
  await freshPage.locator('.arena .arena__strip--crimson').waitFor();
  await shoot(freshPage, vp, 'arena-error');
  await freshPage.close();

  for (const p of [me, friend, fresh, ...rivals]) await p.ctx.close();
}

const browser = await playwright.chromium.launch();
try {
  mkdirSync(outDir, { recursive: true });
  for (const vp of VIEWPORTS) await run(browser, vp);
} finally {
  await browser.close();
  await db.end();
}
