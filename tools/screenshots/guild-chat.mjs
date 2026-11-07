// Captures the ticket 4.5 guild chat at desktop (1440) and mobile (390):
// - `guild-chat`: the founder's Guild Hall with the chronicle: a notice nailed up by an officer,
//   an evening of lines from guildmates, a line an officer struck (a tombstone), a hidden line,
//   and the founder's own line posted through the API;
// - `guild-chat-report`: the report dialog opened on a guildmate's line;
// - `guild-chat-muted` (mobile): a muted member reading the chat, with the reason in place of the
//   quill.
// Guildmates and their lines are seeded straight into the database (they never log in).
// Needs a dev server on a scratch PostgreSQL database:
//   DATABASE_URL=postgres://…/wf_shots pnpm db:migrate
//   DATABASE_URL=postgres://…/wf_shots SESSION_COOKIE_SECURE=false pnpm --filter @worldforge/server dev
//   pnpm --filter @worldforge/web dev
//   DATABASE_URL=postgres://…/wf_shots node tools/screenshots/guild-chat.mjs [baseUrl] [outDir]
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
const DAY = 24 * 60 * MIN;

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

async function shoot(page, vp, name, { full = true } = {}) {
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  if (overflow) console.warn(`! horizontal overflow on ${name} @ ${vp.name}`);
  const file = `${outDir}/${name}-${vp.name}.png`;
  if (full) {
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width: vp.width, height: Math.max(vp.height, height) });
    await page.screenshot({ path: file });
    await page.setViewportSize({ width: vp.width, height: vp.height });
  } else {
    await page.screenshot({ path: file });
  }
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

async function seeded(displayName) {
  const id = randomUUID();
  await db.query(
    `insert into accounts (id, email, display_name, password_hash, handle)
     values ($1, $2, $3, 'seeded', substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))`,
    [id, `${id}@graumark.test`, displayName],
  );
  await db.query(
    'insert into account_presence (account_id, last_seen_at, hidden) values ($1, now(), false)',
    [id],
  );
  return { id };
}

async function join(guildId, accountId, role) {
  await db.query(
    'insert into guild_members (account_id, guild_id, role, joined_at) values ($1, $2, $3, $4)',
    [accountId, guildId, role, new Date(Date.now() - 9 * DAY)],
  );
}

async function line(guildId, authorId, body, ago, extra = {}) {
  const id = randomUUID();
  const { rows } = await db.query(
    `insert into guild_messages (id, guild_id, seq, author_id, kind, body, created_at, removed_at, removed_by, removed_as)
     values ($1, $2, (select coalesce(max(seq), 0) + 1 from guild_messages where guild_id = $2),
             $3, $4, $5, $6, $7, $8, $9)
     returning id`,
    [
      id,
      guildId,
      authorId,
      extra.kind ?? 'chat',
      body,
      new Date(Date.now() - ago),
      extra.removedAs ? new Date(Date.now() - ago + MIN) : null,
      extra.removedBy ?? null,
      extra.removedAs ?? null,
    ],
  );
  return rows[0].id;
}

async function run(browser, vp) {
  const t = vp.tag.toLowerCase();
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
  const handle = (await res.json()).guild.handle;
  const gid = (await db.query('select id from guilds where handle = $1', [handle])).rows[0].id;
  const wren = await seeded(`Wren Of Ash ${t}`);
  await join(gid, wren.id, 'officer');
  const people = {};
  for (const n of ['Brannoc Vell', 'Odo Marrow', 'Old Tamsin', 'Ysolde Ash']) {
    people[n] = await seeded(`${n} ${t}`);
    await join(gid, people[n].id, 'member');
  }
  const mod = await seeded(`Warden Brann ${t}`);
  await db.query(`update accounts set role = 'moderator' where id = $1`, [mod.id]);

  await line(
    gid,
    people['Old Tamsin'].id,
    'Back from the Mirefen. The bog lights moved again.',
    95 * MIN,
  );
  await line(
    gid,
    people['Brannoc Vell'].id,
    'Did they follow you? Last week they followed me to the gate.',
    92 * MIN,
  );
  await line(
    gid,
    people['Odo Marrow'].id,
    'Anyone selling iron ingots? I need six for the forge.',
    70 * MIN,
  );
  await line(
    gid,
    people['Odo Marrow'].id,
    'buy cheap gold at my stall, best prices, whisper me',
    66 * MIN,
    {
      removedAs: 'removed',
      removedBy: wren.id,
    },
  );
  const hidden = await line(gid, people['Brannoc Vell'].id, 'a line the wardens hid', 52 * MIN);
  await db.query(
    `insert into sanctions (id, subject_id, kind, target_key, target, reason, issued_by, expires_at)
     values ($1, $2, 'hide', $3, $4, 'Insulting another player', $5, now() + interval '7 days')`,
    [
      randomUUID(),
      people['Brannoc Vell'].id,
      `message:${hidden}`,
      { kind: 'message', id: hidden },
      mod.id,
    ],
  );
  await line(
    gid,
    people['Ysolde Ash'].id,
    'I have four ingots. Meet at the forge after the crypt run?',
    40 * MIN,
  );
  const notice = await line(
    gid,
    wren.id,
    'Crypt tier III at dusk on Sunday.\nBring torches and two flasks each; Odo leads the second team.',
    30 * MIN,
    { kind: 'notice' },
  );
  await db.query('update guilds set notice_message_id = $1 where id = $2', [notice, gid]);
  await line(
    gid,
    people['Old Tamsin'].id,
    'Count me in. My hero finally reached level 19.',
    12 * MIN,
  );
  const own = await founder.ctx.request.post(`${baseUrl}/api/guild/chat`, {
    data: { text: 'Well met, all. I will bring the spare flasks.' },
  });
  if (own.status() !== 201) throw new Error(`post: ${own.status()} ${await own.text()}`);

  await founder.page.goto(`${baseUrl}/#/guild`);
  await founder.page.getByText('Well met, all.').waitFor();
  await shoot(founder.page, vp, 'guild-chat');

  // Report a guildmate's line.
  const chatline = founder.page.locator('.chatline', { hasText: 'Anyone selling iron ingots' });
  await chatline.hover();
  await chatline.getByRole('button', { name: 'Report' }).click();
  await founder.page.getByRole('dialog').waitFor();
  await founder.page.getByText('Spam or advertising').click();
  await shoot(founder.page, vp, 'guild-chat-report', { full: false });
  await founder.ctx.close();

  if (vp.name === 'mobile') {
    const muted = await hero(browser, vp, `Corvin Vale ${vp.tag}`, `Corvin${vp.tag}`);
    await join(gid, muted.account.id, 'member');
    await db.query(
      `insert into sanctions (id, subject_id, kind, reason, issued_by, expires_at)
       values ($1, $2, 'mute', 'Repeated insults in guild chat', $3, now() + interval '1 day')`,
      [randomUUID(), muted.account.id, mod.id],
    );
    await muted.page.goto(`${baseUrl}/#/guild`);
    await muted.page.locator('.chronicle__muted').waitFor();
    await muted.page.locator('.chronicle__muted').scrollIntoViewIfNeeded();
    await shoot(muted.page, vp, 'guild-chat-muted', { full: false });
    await muted.ctx.close();
  }
}

const browser = await playwright.chromium.launch();
try {
  mkdirSync(outDir, { recursive: true });
  for (const vp of VIEWPORTS) await run(browser, vp);
} finally {
  await browser.close();
  await db.end();
}
