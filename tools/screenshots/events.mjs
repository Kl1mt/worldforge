// Captures the ticket 6.6 UI at desktop (1440) and mobile (390): the event banner in the town and
// on the map, the Tavern's event notice (before joining, joined with progress, loading, error),
// the honours chooser with the event title and keepsakes, a profile showing the event title, and
// the admin panel's Events tab (empty, and with the event under way and a past one).
//
// Everything is made-up and seeded into a scratch database. The event under way is scheduled
// through the admin API; the hero's progress and track are seeded as play would have written them
// (farming for hours is out of reach for a screenshot run). Only loading and error are faked.
//
// Needs a dev server on a scratch PostgreSQL database:
//   DATABASE_URL=postgres://…/wf_shots_events pnpm db:migrate
//   DATABASE_URL=postgres://…/wf_shots_events SESSION_COOKIE_SECURE=false pnpm --filter @worldforge/server dev
//   pnpm --filter @worldforge/web dev
//   DATABASE_URL=postgres://…/wf_shots_events node tools/screenshots/events.mjs [baseUrl] [outDir]
// Never against the live site.
import { mkdirSync } from 'node:fs';
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
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-6');
const PASSWORD = 'ashes-and-iron-42';
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];
const DAY = 24 * 60 * 60_000;

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const existing = await db.query('select count(*)::int as n from world_events');
if (existing.rows[0].n > 0)
  throw new Error('Use a fresh scratch database (it already has events).');

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

mkdirSync(outDir, { recursive: true });
const browser = await playwright.chromium.launch();
const contexts = [];
try {
  const email = `aldith-${Date.now()}@graumark.test`;
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
    });
    if (vp.name === 'desktop') {
      const reg = await ctx.request.post(`${baseUrl}/api/auth/register`, {
        data: { email, displayName: 'Aldith Marrow', password: PASSWORD },
      });
      if (!reg.ok()) throw new Error(`register: ${reg.status()} ${await reg.text()}`);
      const made = await ctx.request.post(`${baseUrl}/api/characters`, {
        data: { name: 'Hedda', classId: 'hunter', appearance: { banner: 'moss' } },
      });
      if (!made.ok()) throw new Error(`character: ${made.status()} ${await made.text()}`);
      await db.query(
        `update accounts set role = 'admin', profile_visibility = 'public' where email = $1`,
        [email],
      );
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
  const viewer = (await db.query('select id, handle from accounts where email = $1', [email]))
    .rows[0];
  const hero = (await db.query('select id from characters where account_id = $1', [viewer.id]))
    .rows[0];
  await db.query(`update characters set level = 14, experience = 900 where id = $1`, [hero.id]);
  const api = contexts[0].ctx.request;
  await api.post(`${baseUrl}/api/characters/${hero.id}/select`);

  // 1. Nothing on the calendar.
  for (const { vp, page } of contexts) {
    await page.goto(`${baseUrl}/#/admin/events`, { waitUntil: 'networkidle' });
    await page.locator('.evfolio').waitFor();
    await shoot(page, vp, 'events-admin-empty', page.locator('section.strong'));
  }

  // 2. A past run (closed and swept), then the Harvest under way, scheduled through the admin API.
  const now = Date.now();
  await db.query(
    `insert into world_events (number, definition_id, starts_at, ends_at, created_at, closed_at, rewards_swept_at)
     values (1, 'harvestOfBones', $1, $2, $1, $3, $3)`,
    [new Date(now - 40 * DAY), new Date(now - 33 * DAY), new Date(now - 33 * DAY + 6 * 60_000)],
  );
  const start = new Date(Math.floor((now - 2 * DAY) / 60_000) * 60_000);
  const scheduled = await api.post(`${baseUrl}/api/admin/events`, {
    data: {
      definitionId: 'harvestOfBones',
      startsAt: new Date(now).toISOString(),
      endsAt: new Date(start.getTime() + 7 * DAY).toISOString(),
    },
  });
  if (!scheduled.ok()) throw new Error(`schedule: ${scheduled.status()} ${await scheduled.text()}`);
  // Start it two days back (as if scheduled then).
  await db.query('update world_events set starts_at = $1 where number = 2', [start]);

  for (const { vp, page } of contexts) {
    await page.goto(`${baseUrl}/#/hub`, { waitUntil: 'networkidle' });
    await page.locator('.evt-banner').waitFor();
    await shoot(page, vp, 'events-banner-town', page.locator('.hub__head').locator('xpath=..'));
    await page.goto(`${baseUrl}/#/map`, { waitUntil: 'networkidle' });
    await page.locator('.evt-banner').waitFor();
    await shoot(page, vp, 'events-banner-map', page.locator('.evt-banner'));
    await page.goto(`${baseUrl}/#/tavern`, { waitUntil: 'networkidle' });
    await page.locator('.evt-notice__join').waitFor();
    await shoot(page, vp, 'events-tavern-join', page.locator('.evt-notice'));
  }

  // 3. Joined, with progress and two tiers (seeded as the settlements would have written them).
  const joined = await api.post(`${baseUrl}/api/characters/${hero.id}/event/join`);
  if (joined.status() !== 201) throw new Error(`join: ${joined.status()} ${await joined.text()}`);
  await db.query(
    `update event_participants set progress = '{60,12,212,1}', bounty_kills = 287, bonus = '{"soulShard":7}', tallies = 35
     where event = 2 and character_id = $1`,
    [hero.id],
  );
  await db.query(
    `insert into event_tracks (event, account_id, tallies, updated_at) values (2, $1, 35, now())`,
    [viewer.id],
  );
  for (const [tier, cosmetic] of [
    [1, 'banner.harvest-sheaf'],
    [2, 'title-colour.bone-white'],
  ]) {
    await db.query(
      `insert into event_track_grants (event, account_id, tier, cosmetic_id, granted_at) values (2, $1, $2, $3, now())`,
      [viewer.id, tier, cosmetic],
    );
    await db.query(
      `insert into cosmetic_unlocks (account_id, cosmetic_id, source, granted_at) values ($1, $2, $3, now())`,
      [viewer.id, cosmetic, `event:2:tier:${tier}`],
    );
  }
  for (const { vp, page } of contexts) {
    await page.goto(`${baseUrl}/#/tavern`, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.evt-task__meter').first().waitFor();
    await shoot(page, vp, 'events-tavern-joined', page.locator('.evt-notice'));
    await page.goto(`${baseUrl}/#/admin/events`, { waitUntil: 'networkidle' });
    await page.locator('.evfolio__card').first().waitFor();
    await shoot(page, vp, 'events-admin', page.locator('section.strong'));
  }

  // 4. The top tier: the title, chosen on the profile.
  await db.query(
    `update event_participants set progress = '{60,12,400,1}', tallies = 50 where event = 2 and character_id = $1`,
    [hero.id],
  );
  await db.query(`update event_tracks set tallies = 50 where event = 2 and account_id = $1`, [
    viewer.id,
  ]);
  await db.query(
    `insert into event_track_grants (event, account_id, tier, cosmetic_id, granted_at) values (2, $1, 3, 'title.reaper-of-the-harvest', now())`,
    [viewer.id],
  );
  await db.query(
    `insert into cosmetic_unlocks (account_id, cosmetic_id, source, granted_at) values ($1, 'title.reaper-of-the-harvest', 'event:2:tier:3', now())`,
    [viewer.id],
  );
  const chose = await api.post(`${baseUrl}/api/account/prestige`, {
    data: { title: null, frame: null, cosmeticTitle: 'title.reaper-of-the-harvest' },
  });
  if (!chose.ok()) throw new Error(`prestige: ${chose.status()} ${await chose.text()}`);
  for (const { vp, page } of contexts) {
    await page.goto(`${baseUrl}/#/profile`, { waitUntil: 'networkidle' });
    await page.locator('.honours form').waitFor();
    await shoot(page, vp, 'events-honours', page.locator('.honours'));
    await page.goto(`${baseUrl}/#/profile/${viewer.handle}`, { waitUntil: 'networkidle' });
    await page.locator('.herald__title').waitFor();
    await shoot(page, vp, 'events-profile-title', page.locator('section.herald'));
    await page.goto(`${baseUrl}/#/tavern`, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.evt-tier--granted').nth(2).waitFor();
    await shoot(page, vp, 'events-tavern-complete', page.locator('.evt-notice__track'));
  }

  // 5. Loading and error of the Tavern notice (faked: held, then 503).
  const fail = async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.fulfill({
      status: 503,
      json: { error: { code: 'unavailable', message: 'The server is busy.' } },
    });
  };
  for (const { vp, page } of contexts) {
    await page.route('**/event', fail);
    await page.goto(`${baseUrl}/#/tavern`);
    await page.reload();
    await page.locator('.evt-notice__wait').waitFor();
    await shoot(page, vp, 'events-tavern-loading', page.locator('.evt-notice__wait'));
    await page.locator('.evt-notice__alert').waitFor();
    await shoot(page, vp, 'events-tavern-error', page.locator('.evt-notice__alert'));
    await page.unroute('**/event');
  }
} finally {
  for (const c of contexts) await c.ctx.close();
  await browser.close();
  await db.end();
}
