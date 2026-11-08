// Captures ticket 5.6 (arena rating, the Arena Ladder, the moderators' pattern report) at desktop
// (1440) and mobile (390):
// - `arena-rating`: a hero after a rated duel fought through the UI: the rating panel (season,
//   rating with its likely range, provisional) and the result with the rating's change;
// - `ladder-season`: the Arena Ladder of the season under way (ranked heroes, Duellist titles of
//   last season, your provisional hero in "your place");
// - `ladder-empty`: a filter no ranked hero fits (30 and above, warlocks);
// - `ladder-final`: last season's sealed final standings;
// - `ladder-loading`, `ladder-error`: the ladder request held back, and failing;
// - `moderation-patterns`: the docket's arena pattern report (pairs who met often), and
//   `moderation-patterns-empty`.
// Everyone but the viewer is seeded straight into the database with a session; seasons, ratings
// and honours are seeded by SQL, the duels are fought through the API.
// Needs a dev server on a scratch PostgreSQL database:
//   DATABASE_URL=postgres://…/wf_shots pnpm db:migrate
//   DATABASE_URL=postgres://…/wf_shots SESSION_COOKIE_SECURE=false pnpm --filter @worldforge/server dev
//   pnpm --filter @worldforge/web dev
//   DATABASE_URL=postgres://…/wf_shots node tools/screenshots/ladder.mjs [baseUrl] [outDir]
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
const NOW = Date.now();

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

async function shoot(page, vp, name, target = page.locator('main')) {
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

async function account(displayName, role = 'player') {
  const id = randomUUID();
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `insert into accounts (id, email, display_name, password_hash, handle, role, guide)
     values ($1, $2, $3, 'seeded', substr(replace(gen_random_uuid()::text, '-', ''), 1, 12), $4,
       '{"steps": [], "dismissed": true}'::jsonb)`,
    [id, `${id}@graumark.test`, displayName, role],
  );
  await db.query(`insert into sessions (id, account_id, expires_at) values ($1, $2, $3)`, [
    createHash('sha256').update(token).digest('hex'),
    id,
    new Date(NOW + 2 * DAY),
  ]);
  const { rows } = await db.query('select handle from accounts where id = $1', [id]);
  return { id, token, handle: rows[0].handle, displayName };
}

/** A hero row straight into the database (ladder entries never open a browser). */
async function hero(accountId, name, classId, level) {
  const id = randomUUID();
  await db.query(
    `insert into characters (id, account_id, name, class_id, level, appearance)
     values ($1, $2, $3, $4, $5, '{"banner":"ember"}'::jsonb)`,
    [id, accountId, name, classId, level],
  );
  return id;
}

async function player(browser, vp, displayName, heroName, classId, level, role) {
  const who = await account(displayName, role);
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
  return (await res.json()).defence.defenceId;
}

async function rated(p, defenceId, bracketId) {
  await db.query(
    `insert into duel_offers (character_id, account_id, bracket_id, defence_ids, offered_at)
     values ($1, $2, $3, $4, now())
     on conflict (character_id) do update set defence_ids = $4, offered_at = now()`,
    [p.character.id, p.id, bracketId, [defenceId]],
  );
  const res = await p.ctx.request.post(`${baseUrl}/api/arena/duels`, {
    data: { characterId: p.character.id, defenceId, kind: 'rated' },
    headers: { 'idempotency-key': randomUUID() },
  });
  if (!res.ok()) throw new Error(`duel: ${res.status()} ${await res.text()}`);
}

async function rating(season, characterId, accountId, classId, level, r, rd, games, wins) {
  const bracket = level >= 30 ? '30-plus' : level >= 20 ? '20-29' : '10-19';
  const draws = games >= 12 ? 1 : 0;
  await db.query(
    `insert into arena_ratings (season, character_id, account_id, class_id, level, bracket_id,
       rating_version, rating, deviation, volatility, games, wins, losses, draws, last_rated_at,
       updated_at)
     values ($1, $2, $3, $4, $5, $6, 1, $7, $8, 0.06, $9, $10, $11, $12, $13, $13)
     on conflict do nothing`,
    [
      season,
      characterId,
      accountId,
      classId,
      level,
      bracket,
      r,
      rd,
      games,
      wins,
      games - wins - draws,
      draws,
      new Date(NOW - DAY),
    ],
  );
}

async function openPage(p, hash) {
  const page = await p.ctx.newPage();
  page.on('pageerror', (err) => console.error(`! page error: ${err.message}`));
  await page.goto(`${baseUrl}/${hash}`);
  return page;
}

/** Seasons, last season's honours and this season's ladder (shared by both viewports). */
async function seedTown() {
  await db.query(
    `insert into seasons (number, starts_at, ends_at, created_at, archived_at, awarded_at)
     values (1, $1, $2, $1, $3, $3), (2, $2, $4, $2, null, null)`,
    [
      new Date(NOW - 70 * DAY),
      new Date(NOW - 14 * DAY),
      new Date(NOW - 14 * DAY + 600_000),
      new Date(NOW + 42 * DAY),
    ],
  );
  const ladder = [
    ['Mirela Thorn', 'Mirela', 'mage', 18, 1812, 58, 41, 31],
    ['Grimwald Oke', 'Grimwald', 'warrior', 19, 1744, 64, 36, 25],
    ['Sable Quint', 'Sable', 'hunter', 16, 1702, 71, 28, 19],
    ['Harrow Lane', 'Harrow', 'warlock', 24, 1688, 66, 33, 21],
    ['Iska Marr', 'Iska', 'mage', 27, 1655, 88, 22, 14],
    ['Bram Coldwater', 'Bram', 'warrior', 31, 1631, 92, 19, 12],
    ['Nell Ashgrove', 'Nell', 'hunter', 13, 1598, 104, 15, 9],
    ['Teodor Vash', 'Teodor', 'warlock', 22, 1562, 97, 17, 9],
    ['Ulla Fenwick', 'Ulla', 'warrior', 12, 1521, 118, 12, 6],
    ['Pell Rook', 'Pell', 'mage', 15, 1488, 124, 11, 5],
    ['Dorcas Hale', 'Dorcas', 'hunter', 25, 1440, 109, 14, 6],
    ['Ivo Brand', 'Ivo', 'warrior', 17, 1395, 131, 10, 3],
  ];
  const people = [];
  for (const [i, [name, heroName, cls, level, r, rd, games, wins]] of ladder.entries()) {
    const who = await account(name);
    const id = await hero(who.id, heroName, cls, level);
    await rating(2, id, who.id, cls, level, r, rd, games, wins);
    // Last season (sealed): a slightly different order.
    const last = 1500 + (ladder.length - i) * 31 + (i % 3) * 17;
    await rating(1, id, who.id, cls, level, last, 70, 20 + i, 12);
    people.push({ who, id, cls, level, last });
  }
  // Last season's final standings, honours and displays (Champion and Exalted Duellists).
  const order = [...people].sort((a, b) => b.last - a.last);
  for (const [i, p] of order.entries()) {
    await db.query(
      `insert into season_standings (season, metric, rank, character_id, account_id, class_id,
         level, formula_version, value, sort_key, achieved_at)
       values (1, 'arena', $1, $2, $3, $4, $5, 1, $6, $7, $8)`,
      [
        i + 1,
        p.id,
        p.who.id,
        p.cls,
        p.level,
        Math.round(p.last),
        [Math.round(p.last * 100), 20],
        new Date(NOW - 15 * DAY),
      ],
    );
    const tier = i === 0 ? 'champion' : i < 10 ? 'exalted' : 'veteran';
    await db.query(
      `insert into season_awards (season, account_id, metric, tier, rank, character_id, awarded_at)
       values (1, $1, 'arena', $2, $3, $4, $5)`,
      [p.who.id, tier, i + 1, p.id, new Date(NOW - 14 * DAY)],
    );
    if (i < 4)
      await db.query(
        `insert into prestige_displays (account_id, title_season, title_metric, frame_season,
           frame_metric, updated_at) values ($1, 1, 'arena', 1, 'arena', now())`,
        [p.who.id],
      );
  }
}

/** Two pairs who met often in rated duels (fought through the API), for the pattern report. */
async function seedPatterns(browser, vp) {
  const out = [];
  for (const [a, b, n] of [
    ['Faro Teague', 'Lisle Teague', 6],
    ['Corin Ash', 'Moll Sparrow', 4],
  ]) {
    const x = await player(browser, vp, a, a.split(' ')[0], 'warrior', 33);
    const y = await player(browser, vp, b, b.split(' ')[0], 'warrior', 33);
    const yId = await defend(y);
    for (let i = 0; i < n; i++) await rated(x, yId, '30-plus');
    out.push(x, y);
  }
  // The second pair registered with the same invite (the D.2 audit row's invite id).
  const invite = randomUUID();
  for (const p of out.slice(2))
    await db.query(
      `insert into audit_log (id, account_id, event, data) values ($1, $2, 'account.register', $3)`,
      [randomUUID(), p.id, { inviteId: invite }],
    );
  return out;
}

async function run(browser, vp, moderator) {
  const t = vp.tag;
  // Each viewport duels in its own bracket, so neither meets the other's rivals.
  const level = t === 'A' ? 14 : 23;
  const me = await player(browser, vp, `Brannoc Vell ${t}`, `Brannoc${t}`, 'warrior', level);
  // Rivals of the same class and starting kit: equal bracket Power, so the arena names them.
  for (const [name, heroName, l] of [
    ['Ysolde Ash', 'Ysolde', level + 2],
    ['Wren Of Ash', 'Wren', level - 1],
    ['Old Tamsin', 'Tamsin', level + 4],
  ]) {
    const r = await player(browser, vp, `${name} ${t}`, `${heroName}${t}`, 'warrior', l);
    await defend(r);
    await r.ctx.close();
  }
  await defend(me);
  // Six rated duels already this season (provisional).
  await rating(2, me.character.id, me.id, 'warrior', level, 1538, 182, 6, 4);

  const page = await openPage(me, '#/arena');
  await page.locator('.arena-slate__row').first().waitFor();
  await page.locator('.arena-slate__row .btn').first().click();
  await page.locator('.arena-bout__rating').waitFor();
  await page.locator('.arena-rating__number').waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  await shoot(page, vp, 'arena-rating');

  await page.goto(`${baseUrl}/#/boards/arena`);
  await page.locator('.renown--ladder .renown__row').first().waitFor();
  await page.locator('.renown__yours-list li').first().waitFor();
  await shoot(page, vp, 'ladder-season');

  await page.goto(`${baseUrl}/#/boards/arena?class=warlock&bracket=30-plus`);
  await page.locator('.renown--ladder .renown__empty').waitFor();
  await shoot(page, vp, 'ladder-empty');

  await page.goto(`${baseUrl}/#/boards/arena?season=1`);
  await page.locator('.renown--ladder h2', { hasText: 'final standings' }).waitFor();
  await page.locator('.renown--ladder .renown__row').first().waitFor();
  await shoot(page, vp, 'ladder-final');

  await page.route('**/api/arena/ladder*', async (route) => {
    await new Promise((r) => setTimeout(r, 4_000));
    await route.continue().catch(() => {});
  });
  await page.goto(`${baseUrl}/#/boards/arena`);
  await page.reload();
  await page.locator('.renown__wait').waitFor();
  await shoot(page, vp, 'ladder-loading');
  await page.unroute('**/api/arena/ladder*');
  await page.route('**/api/arena/ladder*', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'unavailable', message: 'Down for a moment.' } }),
    }),
  );
  await page.reload();
  await page.locator('.renown__alert').waitFor();
  await shoot(page, vp, 'ladder-error');
  await page.close();
  await me.ctx.close();

  // The moderators' pattern report.
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
  });
  await ctx.addCookies([
    { name: 'wf_session', value: moderator.token, url: baseUrl.replace(/\/$/, '') + '/api' },
  ]);
  const mod = await ctx.newPage();
  mod.on('pageerror', (err) => console.error(`! page error: ${err.message}`));
  await mod.goto(`${baseUrl}/#/moderation`);
  await mod.locator('.patterns__pair').first().waitFor();
  await shoot(mod, vp, 'moderation-patterns', mod.locator('.patterns'));
  await mod.route('**/api/mod/arena/patterns*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        windowDays: 14,
        rules: { minDuels: 3, repeated: 5, lopsidedShare: 0.8, lopsidedMin: 4 },
        pairs: [],
      }),
    }),
  );
  await mod.reload();
  await mod.locator('.patterns__empty').waitFor();
  await shoot(mod, vp, 'moderation-patterns-empty', mod.locator('.patterns'));
  await ctx.close();
}

const browser = await playwright.chromium.launch();
try {
  mkdirSync(outDir, { recursive: true });
  await seedTown();
  const moderator = await account('Warden Ilse', 'moderator');
  const ilse = await hero(moderator.id, 'Ilse', 'hunter', 21);
  await db.query('update accounts set active_character_id = $1 where id = $2', [
    ilse,
    moderator.id,
  ]);
  const seeders = await seedPatterns(browser, VIEWPORTS[0]);
  for (const p of seeders) await p.ctx.close();
  for (const vp of VIEWPORTS) await run(browser, vp, moderator);
} finally {
  await browser.close();
  await db.end();
}
