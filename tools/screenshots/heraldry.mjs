// Captures the ticket A.8 heraldry art in the UI at desktop (1440) and mobile (390):
// - `heraldry-profile`: a player's own profile with five deeds shown (the 32×32 achievement icons
//   at ×2, ×1 on phones), the deeds ledger (earned and locked), and their guild's crest;
// - `heraldry-guild`: that guild's public page as another player sees it (crest at ×2 on the
//   banner, ×1 on phones).
// Achievements and the guild are seeded straight into the database.
// Needs a dev server on a scratch PostgreSQL database:
//   DATABASE_URL=postgres://…/wf_shots pnpm db:migrate
//   DATABASE_URL=postgres://…/wf_shots SESSION_COOKIE_SECURE=false pnpm --filter @worldforge/server dev
//   pnpm --filter @worldforge/web dev
//   DATABASE_URL=postgres://…/wf_shots node tools/screenshots/heraldry.mjs [baseUrl] [outDir]
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
  { name: 'desktop', width: 1440, height: 900, tag: 'A' },
  { name: 'mobile', width: 390, height: 844, tag: 'B' },
];
const DAY = 24 * 60 * 60_000;
// Earned deeds, oldest first; the first five are shown on the profile in this order.
const EARNED = [
  'gravewardenSlain',
  'firstLegendary',
  'forgePlus10',
  'level20',
  'storyGraumark',
  'firstEpic',
  'forgePlus5',
  'level10',
  'contracts10',
];

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

async function shoot(page, vp, name) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() =>
    [...document.images].every((img) => img.complete && img.naturalWidth > 0),
  );
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
  const created = await ctx.request.post(`${baseUrl}/api/characters`, {
    data: { name, classId: 'warrior', appearance: { banner: 'dusk' } },
  });
  const { character } = await created.json();
  return { ctx, page, account, character };
}

async function run(browser, vp) {
  const t = vp.tag.toLowerCase();
  const owner = await hero(browser, vp, `Ilse Ravensworn ${vp.tag}`, `Ilse${vp.tag}`);
  for (const [i, id] of EARNED.entries()) {
    await db.query(
      `insert into account_achievements
         (account_id, achievement_id, character_id, source, awarded_at, shown_slot)
       values ($1, $2, $3, 'live', $4, $5)`,
      [
        owner.account.id,
        id,
        owner.character.id,
        new Date(Date.now() - (EARNED.length - i) * 3 * DAY),
        i < 5 ? i : null,
      ],
    );
  }
  const guildId = randomUUID();
  const { rows } = await db.query(
    `insert into guilds (id, handle, name, tag, emblem, created_by, created_at)
     values ($1, substr(replace(gen_random_uuid()::text, '-', ''), 1, 12), $2, $3, 'wolf', $4,
             now() - interval '30 days')
     returning handle`,
    [guildId, `Wolves of the Pass ${vp.tag}`, `WLF${vp.tag}`, owner.account.id],
  );
  await db.query(
    `insert into guild_members (account_id, guild_id, role, joined_at) values ($1, $2, 'leader', now())`,
    [owner.account.id, guildId],
  );
  await owner.page.goto(`${baseUrl}/#/profile`);
  await owner.page.getByText('Warden Unmade').first().waitFor();
  await shoot(owner.page, vp, 'heraldry-profile');

  const visitor = await hero(browser, vp, `Bram Tollen ${t}`, `Bram${vp.tag}`);
  await visitor.page.goto(`${baseUrl}/#/guild/${rows[0].handle}`);
  await visitor.page.getByText('Petition to join').waitFor();
  await shoot(visitor.page, vp, 'heraldry-guild');
  await owner.ctx.close();
  await visitor.ctx.close();
}

const browser = await playwright.chromium.launch();
try {
  mkdirSync(outDir, { recursive: true });
  for (const vp of VIEWPORTS) await run(browser, vp);
} finally {
  await browser.close();
  await db.end();
}
