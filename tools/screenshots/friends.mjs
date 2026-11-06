// Captures the ticket 4.3 friends screen at desktop (1440) and mobile (390): a hero with
// companions in every presence bucket (and one who hides it), requests at the door, a sent
// request and a blocked player; plus the empty roll of a new hero. Presence comes from the last
// authenticated request, so the companions are seeded straight into the database with aged
// "last seen" times (they never log in). Needs a dev server on a scratch PostgreSQL database:
//   DATABASE_URL=postgres://…/wf_shots pnpm db:migrate
//   DATABASE_URL=postgres://…/wf_shots SESSION_COOKIE_SECURE=false pnpm --filter @worldforge/server dev
//   pnpm --filter @worldforge/web dev
//   DATABASE_URL=postgres://…/wf_shots node tools/screenshots/friends.mjs [baseUrl] [outDir]
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
  { name: 'desktop', width: 1440, height: 900, hero: 'Aldous', tag: 'A' },
  { name: 'mobile', width: 390, height: 844, hero: 'Merewyn', tag: 'B' },
];
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

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
  await ctx.request.post(`${baseUrl}/api/characters`, {
    data: { name, classId: 'warrior', appearance: { banner: 'ember' } },
  });
  return { ctx, page, account };
}

/** An account that never logs in, with a presence row `ago` ms old (or none). */
async function seeded(displayName, { ago = null, hidden = false } = {}) {
  const id = randomUUID();
  const { rows } = await db.query(
    `insert into accounts (id, email, display_name, password_hash, handle)
     values ($1, $2, $3, 'seeded', substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
     returning handle`,
    [id, `${id}@graumark.test`, displayName],
  );
  if (ago !== null || hidden) {
    await db.query(
      'insert into account_presence (account_id, last_seen_at, hidden) values ($1, $2, $3)',
      [id, ago === null ? null : new Date(Date.now() - ago), hidden],
    );
  }
  return { id, handle: rows[0].handle };
}

async function pair(a, b, status, requestedBy) {
  const [low, high] = a < b ? [a, b] : [b, a];
  await db.query(
    `insert into friendships (account_low, account_high, status, requested_by, accepted_at)
     values ($1, $2, $3, $4, $5)`,
    [low, high, status, requestedBy, status === 'friends' ? new Date() : null],
  );
}

async function run(browser, vp) {
  const h = await hero(browser, vp, `Pilgrim ${vp.tag}`, vp.hero);
  const me = h.account.id;
  const tag = vp.tag.toLowerCase();
  const friends = [
    [`Ysolde Ash ${tag}`, { ago: 2 * MIN }],
    [`Brannoc ${tag}`, { ago: 6 * MIN }],
    [`Wren Hollow ${tag}`, { ago: 5 * HOUR }],
    [`Old Tamsin ${tag}`, { ago: 3 * DAY }],
    [`Corvin Vale ${tag}`, { ago: 19 * DAY }],
    [`Mira Lantern ${tag}`, { ago: MIN, hidden: true }],
  ];
  for (const [name, opts] of friends) {
    const f = await seeded(name, opts);
    await pair(me, f.id, 'friends', f.id);
  }
  for (const name of [`Hob Kettle ${tag}`, `Sable Reed ${tag}`]) {
    const f = await seeded(name);
    await pair(me, f.id, 'pending', f.id);
  }
  const asked = await seeded(`Gideon Ferrow ${tag}`);
  await pair(me, asked.id, 'pending', me);
  const pest = await seeded(`Gold Seller ${tag}`);
  await db.query('insert into blocks (blocker_id, blocked_id) values ($1, $2)', [me, pest.id]);

  await h.page.goto(`${baseUrl}/#/friends`);
  await h.page.getByText(`Ysolde Ash ${tag}`).waitFor();
  await shoot(h.page, vp, 'friends');
  await h.ctx.close();
}

const browser = await playwright.chromium.launch();
try {
  mkdirSync(outDir, { recursive: true });
  for (const vp of VIEWPORTS) await run(browser, vp);
  // A new hero: the empty roll and inbox.
  const vp = VIEWPORTS[1];
  const fresh = await hero(browser, vp, 'Pilgrim C', 'Odile');
  await fresh.page.goto(`${baseUrl}/#/friends`);
  await fresh.page.getByText('No companions yet.', { exact: false }).waitFor();
  await shoot(fresh.page, vp, 'friends-empty');
  await fresh.ctx.close();
} finally {
  await browser.close();
  await db.end();
}
