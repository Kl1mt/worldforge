// Captures the ticket 4.4 Guild Hall at desktop (1440) and mobile (390):
// - `guild`: a founder's guild (founded through the API, gold from their hero): an officer,
//   members in every presence bucket (one hides it), a waiting petition and a sent invite;
// - `guild-hall`: a guildless hero's hall: the founding charter, an invitation, a petition, and
//   the banners in the hall;
// - `guild-profile`: another guild's public profile with "Petition to join" and Report;
// - `guild-case` (desktop): a reported guild in the moderator queue with its rename/disband choices;
// - `hub-guild-open` (desktop): the hub with the Guild Hall open.
// Guildmates are seeded straight into the database (they never log in), with aged presence.
// Needs a dev server on a scratch PostgreSQL database:
//   DATABASE_URL=postgres://…/wf_shots pnpm db:migrate
//   DATABASE_URL=postgres://…/wf_shots SESSION_COOKIE_SECURE=false pnpm --filter @worldforge/server dev
//   pnpm --filter @worldforge/web dev
//   DATABASE_URL=postgres://…/wf_shots node tools/screenshots/guilds.mjs [baseUrl] [outDir]
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

async function hero(browser, vp, displayName, name, gold = 0) {
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
    data: { name, classId: 'warrior', appearance: { banner: 'ember' } },
  });
  const { character } = await created.json();
  if (gold) await db.query('update characters set gold = $1 where id = $2', [gold, character.id]);
  return { ctx, page, account, character };
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

/** A guild seeded straight into the database, led by a seeded account. */
async function seededGuild(name, tag, emblem, leaderName, members = []) {
  const leader = await seeded(leaderName, { ago: 30 * MIN });
  const id = randomUUID();
  const { rows } = await db.query(
    `insert into guilds (id, handle, name, tag, emblem, created_by, created_at)
     values ($1, substr(replace(gen_random_uuid()::text, '-', ''), 1, 12), $2, $3, $4, $5, now() - interval '40 days')
     returning handle`,
    [id, name, tag, emblem, leader.id],
  );
  await join(id, leader.id, 'leader');
  for (const m of members) await join(id, (await seeded(m)).id, 'member');
  return { id, handle: rows[0].handle, leader };
}

async function join(guildId, accountId, role, ago = 0) {
  await db.query(
    'insert into guild_members (account_id, guild_id, role, joined_at) values ($1, $2, $3, $4)',
    [accountId, guildId, role, new Date(Date.now() - ago)],
  );
}

async function guildIdOf(handle) {
  return (await db.query('select id from guilds where handle = $1', [handle])).rows[0].id;
}

async function run(browser, vp, others) {
  const t = vp.tag.toLowerCase();
  // The founder: founds through the API, paying from their hero.
  const founder = await hero(browser, vp, `Hedda Ironvow ${vp.tag}`, `Hedda${vp.tag}`, 9_000);
  const res = await founder.ctx.request.post(`${baseUrl}/api/guilds`, {
    data: {
      characterId: founder.character.id,
      name: `Ashen Wardens ${vp.tag}`,
      tag: `ASH${vp.tag}`,
      emblem: 'flame',
    },
    headers: { 'idempotency-key': randomUUID() },
  });
  if (res.status() !== 201) throw new Error(`found: ${res.status()} ${await res.text()}`);
  const ash = (await res.json()).guild.handle;
  const ashId = await guildIdOf(ash);
  const officer = await seeded(`Wren Of Ash ${t}`, { ago: 2 * MIN });
  await join(ashId, officer.id, 'officer', 20 * DAY);
  for (const [name, opts] of [
    [`Brannoc Vell ${t}`, { ago: 4 * MIN }],
    [`Odo Marrow ${t}`, { ago: 5 * HOUR }],
    [`Old Tamsin ${t}`, { ago: 3 * DAY }],
    [`Corvin Vale ${t}`, { ago: 19 * DAY }],
    [`Ysolde Ash ${t}`, { ago: MIN, hidden: true }],
  ]) {
    await join(ashId, (await seeded(name, opts)).id, 'member', 5 * DAY);
  }
  const petitioner = await seeded(`Pell Harrow ${t}`);
  await db.query('insert into guild_applications (guild_id, account_id) values ($1, $2)', [
    ashId,
    petitioner.id,
  ]);
  const invited = await seeded(`Gideon Ferrow ${t}`);
  await db.query(
    'insert into guild_invites (guild_id, account_id, invited_by) values ($1, $2, $3)',
    [ashId, invited.id, founder.account.id],
  );
  await founder.page.goto(`${baseUrl}/#/guild`);
  await founder.page.getByText(`Wren Of Ash ${t}`).waitFor();
  await shoot(founder.page, vp, 'guild');

  // A guildless hero: an invitation from the Crows, a petition at Oakheart, the charter form.
  const visitor = await hero(browser, vp, `Varro Quill ${vp.tag}`, `Varro${vp.tag}`, 6_240);
  await db.query(
    'insert into guild_invites (guild_id, account_id, invited_by) values ($1, $2, $3)',
    [others.crows.id, visitor.account.id, others.crows.leader.id],
  );
  await db.query('insert into guild_applications (guild_id, account_id) values ($1, $2)', [
    others.oak.id,
    visitor.account.id,
  ]);
  await visitor.page.goto(`${baseUrl}/#/guild`);
  await visitor.page.getByText('Found a guild').first().waitFor();
  await visitor.page.getByText('Crows of Velmar').first().waitFor();
  await visitor.page.getByLabel('Guild name', { exact: true }).fill('The Lantern Oath');
  await visitor.page.getByLabel('Tag', { exact: true }).fill('lnt');
  await visitor.page.getByText('Tower').first().click();
  await shoot(visitor.page, vp, 'guild-hall');

  // The founder's guild as the visitor sees it.
  await visitor.page.goto(`${baseUrl}/#/guild/${ash}`);
  await visitor.page.getByText('Petition to join').waitFor();
  await shoot(visitor.page, vp, 'guild-profile');

  if (vp.name === 'desktop') {
    await visitor.page.goto(`${baseUrl}/#/hub`);
    await visitor.page.waitForTimeout(500);
    await shoot(visitor.page, vp, 'hub-guild-open');
  }
  await founder.ctx.close();
  await visitor.ctx.close();
}

const browser = await playwright.chromium.launch();
try {
  mkdirSync(outDir, { recursive: true });
  const others = {
    crows: await seededGuild('Crows of Velmar', 'CRW', 'crow', 'Mira Coldwater', [
      'Sable Reed',
      'Hob Kettle',
      'Ines Morrow',
    ]),
    oak: await seededGuild('Oakheart Company', 'OAK', 'oak', 'Tam Oakhand', ['Ludo Fenn']),
    tower: await seededGuild('The Grey Tower', 'GRT', 'tower', 'Aldric Stone', []),
  };
  for (const vp of VIEWPORTS) await run(browser, vp, others);

  // A moderator with a reported guild.
  const vp = VIEWPORTS[0];
  const mod = await hero(browser, vp, 'Warden Brann', 'Brann');
  await db.query(`update accounts set role = 'moderator' where id = $1`, [mod.account.id]);
  const reporter = await seeded('Pell Harrow');
  await db.query(
    `insert into reports (id, reporter_id, subject_id, target_kind, target_key, target, context, reason, note)
     values ($1, $2, $3, 'guild', $4, $5, $6, 'inappropriate', $7)`,
    [
      randomUUID(),
      reporter.id,
      others.oak.leader.id,
      `guild:${others.oak.id}`,
      { kind: 'guild', handle: others.oak.handle },
      {
        displayName: 'Tam Oakhand',
        value: 'Oakheart Company [OAK]',
        name: 'Oakheart Company',
        tag: 'OAK',
      },
      'The name copies my old guild, and their recruiters spam the hall.',
    ],
  );
  await mod.page.goto(`${baseUrl}/#/moderation`);
  await mod.page.getByText('Rename the guild').waitFor();
  await shoot(mod.page, vp, 'guild-case');
  await mod.ctx.close();
} finally {
  await browser.close();
  await db.end();
}
