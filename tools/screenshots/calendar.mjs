// Captures the ticket 8.3 UI at desktop (1440) and mobile (390): the admin panel's automatic
// calendar (paused with the defaults; on, with the Procession put on by the scheduler's step and
// the next ones planned; a rotation being edited), the Tavern's Lantern Procession notice in its
// second week (week 1 done, week 2 under way, weeks 3–4 to come, the deeper road shut for a hero
// below 28), its reward track, and the Procession's keepsakes in the collection book (the
// Procession bearer look on the hero, the banners, the crest, the title colours).
//
// Everything is made-up and seeded into a scratch database. The calendar is set through the admin
// API and its event created by the scheduler's own step (`pnpm admin:events close`); the hero's
// progress and track are seeded as play would have written them (four weeks of farming are out of
// reach for a screenshot run).
//
// Needs a dev server on a scratch PostgreSQL database:
//   DATABASE_URL=postgres://…/wf_shots_calendar pnpm db:migrate
//   DATABASE_URL=postgres://…/wf_shots_calendar SESSION_COOKIE_SECURE=false SETTLE_INTERVAL_SECONDS=0 pnpm --filter @worldforge/server dev
//   pnpm --filter @worldforge/web dev
//   DATABASE_URL=postgres://…/wf_shots_calendar node tools/screenshots/calendar.mjs [baseUrl] [outDir]
// Never against the live site.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-8');
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

async function palettesDrawn(page) {
  await page.waitForFunction(
    () => document.querySelectorAll('[data-palette="pending"]').length === 0,
    null,
    { timeout: 15_000 },
  );
}

/** The scheduler's event step, as the running server does it (on the scratch database). */
function schedulerStep() {
  const out = execFileSync('pnpm', ['--silent', 'admin:events', 'close'], {
    env: process.env,
    encoding: 'utf8',
  });
  console.log(`scheduler step: ${out.trim()}`);
}

mkdirSync(outDir, { recursive: true });
const browser = await playwright.chromium.launch();
const contexts = [];
try {
  const email = `ansel-${Date.now()}@graumark.test`;
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
    });
    if (vp.name === 'desktop') {
      const reg = await ctx.request.post(`${baseUrl}/api/auth/register`, {
        data: { email, displayName: 'Wenna Harrow', password: PASSWORD },
      });
      if (!reg.ok()) throw new Error(`register: ${reg.status()} ${await reg.text()}`);
      const made = await ctx.request.post(`${baseUrl}/api/characters`, {
        data: { name: 'Corwen', classId: 'mage', appearance: { banner: 'ash' } },
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
  await db.query(`update characters set level = 22, experience = 900 where id = $1`, [hero.id]);
  const api = contexts[0].ctx.request;
  await api.post(`${baseUrl}/api/characters/${hero.id}/select`);

  // 1. The calendar as it starts: paused, the default rotation, the next three as held.
  for (const { vp, page } of contexts) {
    await page.goto(`${baseUrl}/#/admin/events`, { waitUntil: 'networkidle' });
    await page.locator('.evcal').waitFor();
    await shoot(page, vp, 'calendar-admin-paused', page.locator('.evcal'));
  }

  // 2. Turned on; the scheduler's step puts the Procession on (started 8 days ago for the shots).
  const set = await api.post(`${baseUrl}/api/admin/events/calendar`, {
    data: {
      rotation: [
        { definitionId: 'lanternProcession', days: 28 },
        { definitionId: 'harvestOfBones', days: 7 },
      ],
      gapDays: 5,
      paused: false,
    },
  });
  if (!set.ok()) throw new Error(`calendar: ${set.status()} ${await set.text()}`);
  schedulerStep();
  const start = new Date(Math.floor((Date.now() - 8 * DAY) / 3_600_000) * 3_600_000);
  await db.query('update world_events set starts_at = $1, ends_at = $2 where number = 1', [
    start,
    new Date(start.getTime() + 28 * DAY),
  ]);
  for (const { vp, page } of contexts) {
    await page.goto(`${baseUrl}/#/admin/events`, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.evcal__state--on').waitFor();
    await shoot(page, vp, 'calendar-admin-on', page.locator('section.strong'));
  }
  // The rotation being edited (desktop: add an entry, unsaved).
  {
    const { vp, page } = contexts[0];
    await page.getByRole('button', { name: 'Add an event' }).click();
    await shoot(page, vp, 'calendar-admin-editing', page.locator('.evcal__form'));
    await page.reload({ waitUntil: 'networkidle' });
  }

  // 3. The Tavern in week 2: week 1 done, week 2 under way, the deeper road shut at level 22.
  const joined = await api.post(`${baseUrl}/api/characters/${hero.id}/event/join`);
  if (joined.status() !== 201) throw new Error(`join: ${joined.status()} ${await joined.text()}`);
  await db.query(
    `update event_participants set progress = '{1500,150,0,1630,212,0,0,0,0,0,0,0}', bounty_kills = 340,
       bonus = '{"ironOre":13}', tallies = 20 where event = 1 and character_id = $1`,
    [hero.id],
  );
  await db.query(
    `insert into event_tracks (event, account_id, tallies, updated_at) values (1, $1, 35, now())`,
    [viewer.id],
  );
  for (const [tier, cosmetic] of [
    [1, 'title-colour.wick-amber'],
    [2, 'banner.procession-lantern'],
  ]) {
    await db.query(
      `insert into event_track_grants (event, account_id, tier, cosmetic_id, granted_at) values (1, $1, $2, $3, now())`,
      [viewer.id, tier, cosmetic],
    );
  }
  for (const { vp, page } of contexts) {
    await page.goto(`${baseUrl}/#/tavern`, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.evt-week--now').waitFor();
    await shoot(page, vp, 'calendar-tavern-weeks', page.locator('.evt-notice__quests'));
    await shoot(page, vp, 'calendar-tavern-track', page.locator('.evt-notice__track'));
    await shoot(page, vp, 'calendar-tavern', page.locator('.evt-notice'));
  }

  // 4. The keepsakes in the collection book (all seven granted for the shot), worn.
  const track = [
    'title-colour.wick-amber',
    'banner.procession-lantern',
    'crest.lantern-brass',
    'title-colour.deep-lantern',
    'appearance.lantern-bearer',
    'banner.hollow-procession',
    'title.keeper-of-the-long-road',
  ];
  for (const [i, cosmetic] of track.entries()) {
    await db.query(
      `insert into cosmetic_unlocks (account_id, cosmetic_id, source, granted_at) values ($1, $2, $3, now())
       on conflict do nothing`,
      [viewer.id, cosmetic, `event:1:tier:${i + 1}`],
    );
  }
  const keyed = (url, data) =>
    api.post(`${baseUrl}${url}`, { data, headers: { 'idempotency-key': randomUUID() } });
  const dress = await keyed(`/api/characters/${hero.id}/appearance`, {
    appearance: 'appearance.lantern-bearer',
  });
  if (!dress.ok()) throw new Error(`appearance: ${dress.status()} ${await dress.text()}`);
  const equip = await keyed('/api/account/cosmetics/equip', {
    banner: 'banner.procession-lantern',
    crest: 'crest.lantern-brass',
    titleColour: 'title-colour.wick-amber',
  });
  if (!equip.ok()) throw new Error(`equip: ${equip.status()} ${await equip.text()}`);
  for (const { vp, page } of contexts) {
    await page.goto(`${baseUrl}/#/collection`, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.book-card').first().waitFor();
    await page.locator('.book-card', { hasText: 'Procession bearer' }).click();
    await palettesDrawn(page);
    await shoot(page, vp, 'calendar-book-bearer', page.locator('.book'));
    await page.getByRole('button', { name: 'Banners' }).click();
    await page.locator('.book-card', { hasText: 'Hollow procession banner' }).click();
    await shoot(page, vp, 'calendar-book-banners', page.locator('.book'));
    await page.getByRole('button', { name: 'Crests' }).click();
    await page.locator('.book-card', { hasText: 'Lantern-brass crest' }).click();
    await shoot(page, vp, 'calendar-book-crest', page.locator('.book'));
  }
} finally {
  for (const c of contexts) await c.ctx.close();
  await browser.close();
  await db.end();
}
