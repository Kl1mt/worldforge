// Captures the ticket 4.9 weekly guild boss at desktop (1440) and mobile (390):
// - `guild-boss`: the founder's siege plate after their hero breaks the first stage through the UI
//   (the blow-by-blow, the chain of seals, the guild-only damage board with a former member, and
//   the spoils waiting to be claimed);
// - `guild-boss-claimed` (mobile): the same plate after claiming the spoils;
// - `guild-boss-fresh`: a new guild's plate before anyone has fought this week.
// Guildmates and their attempts are seeded straight into the database (they never log in).
// Needs a dev server on a scratch PostgreSQL database:
//   DATABASE_URL=postgres://…/wf_shots pnpm db:migrate
//   DATABASE_URL=postgres://…/wf_shots SESSION_COOKIE_SECURE=false pnpm --filter @worldforge/server dev
//   pnpm --filter @worldforge/web dev
//   DATABASE_URL=postgres://…/wf_shots node tools/screenshots/guild-boss.mjs [baseUrl] [outDir]
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
const DAY = 86_400_000;

/** Monday 00:00 UTC of the current week, as `YYYY-MM-DD` (game-core `guildBossWeek`). */
function weekKey(ms) {
  const day = Math.floor(ms / DAY);
  const weekday = (((day + 3) % 7) + 7) % 7;
  return new Date((day - weekday) * DAY).toISOString().slice(0, 10);
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

async function shoot(page, vp, name, target) {
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  if (overflow) console.warn(`! horizontal overflow on ${name} @ ${vp.name}`);
  const file = `${outDir}/${name}-${vp.name}.png`;
  // A viewport as tall as the page, so the phone's fixed bottom bar sits below the plate.
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: vp.width, height: Math.max(vp.height, height) });
  await target.screenshot({ path: file });
  await page.setViewportSize({ width: vp.width, height: vp.height });
  console.log(`saved ${file}`);
}

async function hero(browser, vp, displayName, name, { gold = 0, level = 1 } = {}) {
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
    data: { name, classId: 'hunter', appearance: { banner: 'ember' } },
  });
  const { character } = await created.json();
  await db.query('update characters set gold = $1, level = $2 where id = $3', [
    gold,
    level,
    character.id,
  ]);
  return { ctx, page, account, character };
}

async function found(owner, name, tag, emblem) {
  const res = await owner.ctx.request.post(`${baseUrl}/api/guilds`, {
    data: { characterId: owner.character.id, name, tag, emblem },
    headers: { 'idempotency-key': randomUUID() },
  });
  if (res.status() !== 201) throw new Error(`found: ${res.status()} ${await res.text()}`);
  const handle = (await res.json()).guild.handle;
  return (await db.query('select id from guilds where handle = $1', [handle])).rows[0].id;
}

async function seeded(displayName) {
  const id = randomUUID();
  await db.query(
    `insert into accounts (id, email, display_name, password_hash, handle)
     values ($1, $2, $3, 'seeded', substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))`,
    [id, `${id}@graumark.test`, displayName],
  );
  return { id };
}

async function join(guildId, accountId, role = 'member') {
  await db.query(
    'insert into guild_members (account_id, guild_id, role, joined_at) values ($1, $2, $3, $4)',
    [accountId, guildId, role, new Date(Date.now() - 9 * DAY)],
  );
}

/** A seeded attempt and its share of the guild's counter. */
async function attempt(guildId, accountId, no, damage, ago) {
  const week = weekKey(Date.now());
  const at = new Date(Date.now() - ago);
  await db.query(
    `insert into guild_boss_attempts
       (id, account_id, week, attempt_no, guild_id, boss_id, snapshot, damage, counted, "end", duration_ms, created_at)
     values ($1, $2, $3, $4, $5, 'risenGravewarden', $6, $7, $7, 'fell', 41000, $8)`,
    [
      randomUUID(),
      accountId,
      week,
      no,
      guildId,
      { classId: 'warrior', level: 16, xp: 0, equipment: [] },
      damage,
      at,
    ],
  );
  await db.query(
    `insert into guild_boss_weeks (guild_id, week, boss_id, total, attempts, stage, updated_at)
     values ($1, $2, 'risenGravewarden', $3, 1, 0, $4)
     on conflict (guild_id, week) do update
       set total = guild_boss_weeks.total + excluded.total, attempts = guild_boss_weeks.attempts + 1`,
    [guildId, week, damage, at],
  );
}

async function run(browser, vp) {
  const t = vp.tag.toLowerCase();
  const founder = await hero(browser, vp, `Ragna Steelbough ${vp.tag}`, `Ragna${vp.tag}`, {
    gold: 9_000,
    level: 24,
  });
  const gid = await found(founder, `Ashen Wardens ${vp.tag}`, `ASH${vp.tag}`, 'flame');
  const people = {};
  for (const [n, role] of [
    ['Wren Of Ash', 'officer'],
    ['Brannoc Vell', 'member'],
    ['Old Tamsin', 'member'],
    ['Ysolde Ash', 'member'],
  ]) {
    people[n] = await seeded(`${n} ${t}`);
    await join(gid, people[n].id, role);
  }
  const gone = await seeded(`Odo Marrow ${t}`);
  // A week of blows, just short of the first stage (Cracked, 18,000).
  await attempt(gid, people['Wren Of Ash'].id, 1, 3_412, 3 * DAY);
  await attempt(gid, people['Wren Of Ash'].id, 2, 2_986, 2 * DAY);
  await attempt(gid, people['Brannoc Vell'].id, 1, 2_754, 2 * DAY);
  await attempt(gid, people['Old Tamsin'].id, 1, 1_903, DAY);
  await attempt(gid, gone.id, 1, 2_210, DAY);
  await attempt(gid, people['Brannoc Vell'].id, 2, 2_301, 6 * 3_600_000);
  await attempt(gid, people['Wren Of Ash'].id, 3, 1_620, 3_600_000);

  await founder.page.goto(`${baseUrl}/#/guild`);
  const siege = founder.page.locator('.siege').first();
  await founder.page.getByRole('button', { name: 'Face the boss' }).waitFor();
  await founder.page.getByRole('button', { name: 'Face the boss' }).click();
  await founder.page.locator('.siege-blow').waitFor();
  await founder.page.locator('.siege-spoils').waitFor();
  await siege.scrollIntoViewIfNeeded();
  await shoot(founder.page, vp, 'guild-boss', siege);

  if (vp.name === 'mobile') {
    await founder.page.getByRole('button', { name: 'Claim' }).click();
    await founder.page.locator('.siege-spoils').waitFor({ state: 'detached' });
    await shoot(founder.page, vp, 'guild-boss-claimed', siege);
  }
  await founder.ctx.close();

  const fresh = await hero(browser, vp, `Corvin Vale ${vp.tag}`, `Corvin${vp.tag}`, {
    gold: 6_000,
    level: 14,
  });
  await found(fresh, `Mirefen Lanterns ${vp.tag}`, `MIR${vp.tag}`, 'moon');
  await fresh.page.goto(`${baseUrl}/#/guild`);
  await fresh.page.getByRole('button', { name: 'Face the boss' }).waitFor();
  await shoot(fresh.page, vp, 'guild-boss-fresh', fresh.page.locator('.siege').first());
  await fresh.ctx.close();
}

const browser = await playwright.chromium.launch();
try {
  mkdirSync(outDir, { recursive: true });
  for (const vp of VIEWPORTS) await run(browser, vp);
} finally {
  await browser.close();
  await db.end();
}
