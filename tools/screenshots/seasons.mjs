// Captures the ticket 5.3 UI at desktop (1440) and mobile (390): season rolls (under way, sealed
// with honours, before any season, loading and error), honours on a profile and the owner's
// chooser (none yet, earned), a guild roster with members' honours, and the admin panel's season
// calendar (empty, and with a current, next and past season).
//
// Everything is made-up: fantasy names, seeded straight into a scratch database (they never log
// in). The past season's standings are seeded as the refresh would have written them; the running
// server's own season job seals them and gives the honours. The current season's rows come from the
// server's refresh and sweep. One registered viewer (made admin in the database, the stand-in for
// the role CLI) looks around. Only loading and error are faked (the request is held, then 503).
//
// Needs a dev server on a scratch PostgreSQL database with a short scheduler interval:
//   DATABASE_URL=postgres://…/wf_shots_seasons pnpm db:migrate
//   DATABASE_URL=postgres://…/wf_shots_seasons SESSION_COOKIE_SECURE=false SETTLE_INTERVAL_SECONDS=3 \
//     pnpm --filter @worldforge/server dev
//   pnpm --filter @worldforge/web dev
//   DATABASE_URL=postgres://…/wf_shots_seasons node tools/screenshots/seasons.mjs [baseUrl] [outDir]
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
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const WEEK = 7 * DAY;

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const existing = await db.query('select count(*)::int as n from seasons');
if (existing.rows[0].n > 0)
  throw new Error('Use a fresh scratch database (it already has seasons).');

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

async function until(what, fn, timeoutMs = 60_000) {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** An account that never logs in, with one hero at `level`. */
async function seeded(displayName, heroName, classId, level) {
  const id = randomUUID();
  const { rows } = await db.query(
    `insert into accounts (id, email, display_name, password_hash, handle)
     values ($1, $2, $3, 'seeded', substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
     returning handle`,
    [id, `${id}@graumark.test`, displayName],
  );
  const hero = randomUUID();
  await db.query(
    `insert into characters (id, account_id, name, class_id, appearance, level, experience)
     values ($1, $2, $3, $4, '{"banner":"ash"}', $5, $6)`,
    [hero, id, heroName, classId, level, level * 37],
  );
  return { id, handle: rows[0].handle, hero, heroName, classId, level };
}

const TOWN = [
  ['Ravenna Ashgrove', 'Sigrun', 'warrior', 27],
  ['Old Tobiah', 'Meriel', 'mage', 25],
  ['Corvin of the Fen', 'Halvard', 'hunter', 24],
  ['Brother Anselm', 'Esk', 'warlock', 23],
  ['Maud Thistlewick', 'Brannoc', 'warrior', 21],
  ['Edric Coldwater', 'Tamsin', 'mage', 19],
  ['Sister Ysmay', 'Ilse', 'warlock', 17],
  ['Garrow the Tall', 'Doran', 'hunter', 15],
  ['Linnet Fairmoor', 'Wenna', 'mage', 12],
  ['Oswin Blackreed', 'Corwen', 'warrior', 9],
];

/** Plausible season-one standings for a hero (as the refresh would have stored them). */
function standings(h, i) {
  const gear = h.level * 46 + ((i * 37) % 90);
  const power = Math.min(4000, h.level * 128 + ((i * 53) % 210));
  const pve = Math.max(2, Math.min(9, Math.floor(h.level / 3)));
  return [
    ['level', h.level, [h.level, h.level * 37]],
    ['gearScore', gear, [gear]],
    ['power', power, [power]],
    ['pveProgress', pve, [pve, pve - 1, i % 3]],
  ];
}

mkdirSync(outDir, { recursive: true });
const browser = await playwright.chromium.launch();
const contexts = [];
try {
  // The viewer: registered through the API, an admin by the database (the role CLI's stand-in).
  const email = `wynne-${Date.now()}@graumark.test`;
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
    });
    if (vp.name === 'desktop') {
      const reg = await ctx.request.post(`${baseUrl}/api/auth/register`, {
        data: { email, displayName: 'Wynne Hollow', password: PASSWORD },
      });
      if (!reg.ok()) throw new Error(`register: ${reg.status()} ${await reg.text()}`);
      const made = await ctx.request.post(`${baseUrl}/api/characters`, {
        data: { name: 'Isolde', classId: 'mage', appearance: { banner: 'moss' } },
      });
      if (!made.ok()) throw new Error(`character: ${made.status()} ${await made.text()}`);
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
  const viewer = (await db.query('select id from accounts where email = $1', [email])).rows[0];
  const viewerHero = (
    await db.query('select id from characters where account_id = $1', [viewer.id])
  ).rows[0];

  // 1. Before any season: the empty season roll, no honours, an empty calendar.
  for (const { vp, page } of contexts) {
    const roll = page.locator('section.renown');
    await page.goto(`${baseUrl}/#/boards/level?season=current`, { waitUntil: 'networkidle' });
    await roll.locator('.renown__empty').waitFor();
    await shoot(page, vp, 'seasons-none', roll);
    await page.goto(`${baseUrl}/#/profile`, { waitUntil: 'networkidle' });
    await page.locator('.honours .honours__none').waitFor();
    await shoot(page, vp, 'honours-none', page.locator('.honours'));
    await page.goto(`${baseUrl}/#/admin/seasons`, { waitUntil: 'networkidle' });
    await page.locator('.almanac__seasons').waitFor();
    await shoot(page, vp, 'admin-seasons-empty', page.locator('section.strong'));
  }

  // 2. A past season, seeded in one transaction (season one just ended, season two under way),
  //    with its standings; the server's season job then seals it and gives the honours.
  const town = [];
  for (const [name, hero, cls, level] of TOWN) town.push(await seeded(name, hero, cls, level));
  await db.query(`update characters set level = 22, experience = 900 where id = $1`, [
    viewerHero.id,
  ]);
  const now = Date.now();
  const s1End = new Date(now - 10 * MIN);
  const s1Start = new Date(s1End.getTime() - 8 * WEEK);
  const s2End = new Date(s1End.getTime() + 8 * WEEK);
  await db.query('begin');
  await db.query(
    'insert into seasons (number, starts_at, ends_at) values (1, $1, $2), (2, $2, $3)',
    [s1Start, s1End, s2End],
  );
  const ranked = [
    ...town.slice(0, 3),
    { id: viewer.id, hero: viewerHero.id, classId: 'mage', level: 22 },
    ...town.slice(3),
  ];
  for (const [i, h] of ranked.entries()) {
    for (const [metric, value, key] of standings(h, i)) {
      const at = new Date(s1Start.getTime() + (i + 1) * DAY);
      await db.query(
        `insert into season_entries (season, character_id, metric, account_id, class_id, level,
           formula_version, value, sort_key, base_sort_key, achieved_at, updated_at)
         values (1, $1, $2, $3, $4, $5, 1, $6, $7, null, $8, $8)`,
        [h.hero, metric, h.id, h.classId, h.level, value, key, at],
      );
    }
  }
  await db.query('commit');
  // A guild with the viewer among honoured members.
  const guildId = randomUUID();
  await db.query(
    `insert into guilds (id, handle, name, tag, emblem, created_by, created_at)
     values ($1, substr(replace(gen_random_uuid()::text, '-', ''), 1, 12), 'The Ember Vigil', 'EMB',
       'flame', $2, now() - interval '30 days')`,
    [guildId, town[0].id],
  );
  const members = [
    [town[0].id, 'leader'],
    [town[2].id, 'officer'],
    [viewer.id, 'member'],
    [town[5].id, 'member'],
    [town[9].id, 'member'],
  ];
  for (const [accountId, role] of members) {
    await db.query(
      `insert into guild_members (account_id, guild_id, role, joined_at)
       values ($1, $2, $3, now() - interval '20 days')`,
      [accountId, guildId, role],
    );
  }
  const api = contexts[0].ctx.request;
  await until('season one sealed and honoured', async () => {
    const res = await api.get(`${baseUrl}/api/seasons`);
    const body = await res.json();
    return body.past?.[0]?.status === 'closed';
  });
  // The current season: the sweep puts the town on it; the viewer's own write refreshes now.
  await api.post(`${baseUrl}/api/characters/${viewerHero.id}/select`);
  await until('the current season roll', async () => {
    const res = await api.get(`${baseUrl}/api/leaderboards/level?scope=season&limit=100`);
    return (await res.json()).board.total >= 8;
  });
  // The viewer shows a title from one roll and the frame from another.
  const mine = await (await api.get(`${baseUrl}/api/account/prestige`)).json();
  const byMetric = (m) => mine.earned.find((e) => e.metric === m);
  const chose = await api.post(`${baseUrl}/api/account/prestige`, {
    data: {
      title: { season: 1, metric: (byMetric('pveProgress') ?? mine.earned[0]).metric },
      frame: { season: 1, metric: mine.earned[0].metric },
    },
  });
  if (!chose.ok()) throw new Error(`prestige: ${chose.status()} ${await chose.text()}`);

  // 3. Success states.
  for (const { vp, page } of contexts) {
    const roll = page.locator('section.renown');
    await page.goto(`${baseUrl}/#/boards/level?season=1`, { waitUntil: 'networkidle' });
    await roll.locator('.renown__list').waitFor();
    await shoot(page, vp, 'seasons-final', page.locator('main'));
    await page.goto(`${baseUrl}/#/boards/power?season=current`, { waitUntil: 'networkidle' });
    await roll.locator('.renown__list').waitFor();
    await shoot(page, vp, 'seasons-current', roll);
    if (vp.name === 'desktop') {
      await page.goto(`${baseUrl}/#/boards/gearScore`, { waitUntil: 'networkidle' });
      await roll.locator('.renown__list').waitFor();
      await roll.locator('details.renown__measured > summary').click();
      await shoot(page, vp, 'seasons-alltime-measured', roll);
    }
    await page.goto(`${baseUrl}/#/profile/${town[0].handle}`, { waitUntil: 'networkidle' });
    await page.locator('.herald__title').waitFor();
    await shoot(page, vp, 'honours-profile', page.locator('section.herald'));
    await page.goto(`${baseUrl}/#/profile`, { waitUntil: 'networkidle' });
    await page.locator('.honours form').waitFor();
    await shoot(page, vp, 'honours-earned', page.locator('.honours'));
    await page.goto(`${baseUrl}/#/guild`, { waitUntil: 'networkidle' });
    await page.locator('.guildroll .roll__row').first().waitFor();
    // The hall's other panels load around the roster; let the layout settle first.
    await page.waitForLoadState('networkidle');
    await page.locator('.guildroll').scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await shoot(page, vp, 'honours-guild', page.locator('.guildroll'));
    await page.goto(`${baseUrl}/#/admin/seasons`, { waitUntil: 'networkidle' });
    await page.locator('.seasoncard').first().waitFor();
    await shoot(page, vp, 'admin-seasons', page.locator('section.strong'));
  }

  // 4. Loading and error (faked: held, then 503).
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
    const roll = page.locator('section.renown');
    await page.route('**/api/leaderboards/**', fail);
    await page.goto(`${baseUrl}/#/boards/level?season=current`);
    await page.reload();
    await roll.locator('.renown__wait').waitFor();
    await shoot(page, vp, 'seasons-loading', roll);
    await roll.getByRole('alert').waitFor();
    await shoot(page, vp, 'seasons-error', roll);
    await page.unroute('**/api/leaderboards/**');
    await page.route('**/api/account/prestige', fail);
    await page.goto(`${baseUrl}/#/profile`);
    await page.reload();
    await page.locator('.honours .herald__wait').waitFor();
    await shoot(page, vp, 'honours-loading', page.locator('.honours'));
    await page.locator('.honours [role="alert"]').waitFor();
    await shoot(page, vp, 'honours-error', page.locator('.honours'));
    await page.unroute('**/api/account/prestige');
  }
} finally {
  for (const c of contexts) await c.ctx.close();
  await browser.close();
  await db.end();
}
