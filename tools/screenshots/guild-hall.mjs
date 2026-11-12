// Captures the ticket 8.4 UI at desktop (1440) and mobile (390): the guild treasury & hall
// (loading, error, not in a guild, a member's view, the officer's view after buying and hanging
// upgrades, a gift with the no-refund notice confirmed), the guild page with the hall's look, and
// the Guild Roll (a season under way, and a past season's final standings with honours).
//
// Everything is made-up and seeded into a scratch database: the guilds' members, guild boss stages,
// PvE Progress rows, town-works gifts and the past season's archive are written as the server would
// have written them (a season of play is out of reach for a screenshot run); gifts, buys and hangs
// go through the API or the screen's own buttons. Only loading and error are faked.
//
// Needs a dev server on a scratch PostgreSQL database:
//   DATABASE_URL=postgres://…/wf_shots_guild pnpm db:migrate
//   DATABASE_URL=postgres://…/wf_shots_guild SESSION_COOKIE_SECURE=false pnpm --filter @worldforge/server dev
//   pnpm --filter @worldforge/web dev
//   DATABASE_URL=postgres://…/wf_shots_guild node tools/screenshots/guild-hall.mjs [baseUrl] [outDir]
// Never against the live site.
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
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
const DAY = 86_400_000;
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

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

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const handle = () =>
  Array.from({ length: 12 }, () => ALPHABET[Math.floor(Math.random() * 32)]).join('');

const keyed = (api, url, data) =>
  api.post(`${baseUrl}${url}`, { data, headers: { 'idempotency-key': randomUUID() } });

async function register(ctx, email, displayName, hero) {
  const reg = await ctx.request.post(`${baseUrl}/api/auth/register`, {
    data: { email, displayName, password: PASSWORD },
  });
  if (!reg.ok()) throw new Error(`register: ${reg.status()} ${await reg.text()}`);
  const made = await ctx.request.post(`${baseUrl}/api/characters`, {
    data: { name: hero, classId: 'warrior', appearance: { banner: 'ember' } },
  });
  if (!made.ok()) throw new Error(`character: ${made.status()} ${await made.text()}`);
  const { rows } = await db.query(
    'select a.id, c.id as hero from accounts a join characters c on c.account_id = a.id where a.email = $1',
    [email],
  );
  return rows[0];
}

mkdirSync(outDir, { recursive: true });
const browser = await playwright.chromium.launch();
try {
  const stamp = Date.now();
  const now = Date.now();
  // Seasons: the last one (archived, with honours) and the one under way.
  const { rows: last } = await db.query('select coalesce(max(number), 0) as n from seasons');
  const prev = Number(last[0].n) + 1;
  const cur = prev + 1;
  await db.query(
    `insert into seasons (number, starts_at, ends_at, archived_at, awarded_at, guild_archived_at, guild_awarded_at)
     values ($1, $2, $3, $4, $4, $4, $4), ($5, $3, $6, null, null, null, null)`,
    [
      prev,
      new Date(now - 76 * DAY),
      new Date(now - 20 * DAY),
      new Date(now - 20 * DAY + 600_000),
      cur,
      new Date(now + 36 * DAY),
    ],
  );

  // Players: the leader (officer view on desktop), a member (mobile), a stranger.
  const lead = await browser.newContext({
    viewport: VIEWPORTS[0],
    deviceScaleFactor: 2,
  });
  const memberCtx = await browser.newContext({ viewport: VIEWPORTS[1], deviceScaleFactor: 2 });
  const leader = await register(lead, `hall-lead-${stamp}@graumark.test`, 'Isolde Varn', 'Hadwin');
  const member = await register(
    memberCtx,
    `hall-mem-${stamp}@graumark.test`,
    'Brannoc Vell',
    'Wren',
  );
  await db.query('update characters set gold = 400000, level = 42 where account_id = any($1)', [
    [leader.id, member.id],
  ]);
  for (const id of [leader.hero, member.hero]) {
    for (const m of ['ironOre', 'soulShard', 'abbeySilver', 'timber', 'rawHide']) {
      await db.query(
        `insert into character_materials (character_id, material_id, quantity) values ($1, $2, 400)
         on conflict (character_id, material_id) do update set quantity = 400`,
        [id, m],
      );
    }
  }
  const found = await keyed(lead.request, '/api/guilds', {
    characterId: leader.hero,
    name: 'The Ashen Wardens',
    tag: 'ASH',
    emblem: 'flame',
  });
  if (!found.ok()) throw new Error(`found: ${found.status()} ${await found.text()}`);
  const guild = (
    await db.query(`select id, handle from guilds where tag = 'ASH' and disbanded_at is null`)
  ).rows[0];
  // Seeded as the guild's earlier weeks: members joined a month ago.
  await db.query(
    `insert into guild_members (account_id, guild_id, role, joined_at) values ($1, $2, 'officer', $3)`,
    [member.id, guild.id, new Date(now - 30 * DAY)],
  );
  await db.query('update guild_members set joined_at = $2 where guild_id = $1', [
    guild.id,
    new Date(now - 30 * DAY),
  ]);

  /** A seeded guild of `n` made-up members with stages and PvE rows. */
  async function seedGuild(name, tag, emblem, n, stages, pve) {
    const gid = randomUUID();
    await db.query(
      `insert into guilds (id, handle, name, tag, emblem, created_at) values ($1, $6, $2, $3, $4, $5)`,
      [gid, name, tag, emblem, new Date(now - 90 * DAY), handle()],
    );
    const ids = [];
    for (let i = 0; i < n; i++) {
      const id = randomUUID();
      ids.push(id);
      await db.query(
        `insert into accounts (id, handle, email, display_name, password_hash) values ($1, $4, $2, $3, 'x')`,
        [id, `seed-${tag}-${i}-${stamp}@graumark.test`, `${tag} Sworn ${i + 1}`, handle()],
      );
      await db.query(
        `insert into guild_members (account_id, guild_id, role, joined_at) values ($1, $2, $3, $4)`,
        [id, gid, i === 0 ? 'leader' : 'member', new Date(now - 60 * DAY)],
      );
    }
    return { gid, ids, stages, pve };
  }
  async function seedFacts(gid, ids, stages, pve, startMs) {
    let w = 0;
    for (const stage of stages) {
      const at = new Date(startMs + (w * 7 + 2) * DAY);
      const week = new Date(at);
      week.setUTCDate(week.getUTCDate() - ((week.getUTCDay() + 6) % 7));
      const weekKey = week.toISOString().slice(0, 10);
      for (let s = 1; s <= stage; s++) {
        const attempt = randomUUID();
        await db.query(
          `insert into guild_boss_attempts (id, account_id, week, attempt_no, guild_id, boss_id, snapshot, damage, counted, "end", duration_ms, created_at)
           values ($1, $2, $3, $4, $5, 'risenGravewarden', '{}', 1, 1, 'fell', 1, $6)`,
          [attempt, ids[s % ids.length], weekKey, 100 + w * 10 + s, gid, at],
        );
        await db.query(
          `insert into guild_boss_stages (guild_id, week, stage, reached_at, attempt_id) values ($1, $2, $3, $4, $5)
           on conflict do nothing`,
          [gid, weekKey, s, at, attempt],
        );
      }
      w += 1;
    }
    for (const [i, id] of ids.entries()) {
      const hero = randomUUID();
      await db.query(
        `insert into characters (id, account_id, name, class_id, appearance, level, progress)
         values ($1, $2, $3, 'hunter', '{"banner":"ash"}', 44, '{}') on conflict do nothing`,
        [hero, id, `Seed${Math.floor(Math.random() * 1e9)}`],
      );
      await db.query(
        `insert into leaderboard_entries (character_id, metric, account_id, class_id, level, formula_version, value, sort_key, inputs_hash, input, achieved_at, updated_at)
         values ($1, 'pveProgress', $2, 'hunter', 44, 6, $3, array[$3::bigint, 0, 0], 'seed', '{}', now(), now())`,
        [hero, id, pve[i % pve.length]],
      );
    }
  }
  const curStart = now - 20 * DAY;
  const others = [
    await seedGuild('The Lantern Watch', 'LNT', 'moon', 6, [3, 4, 3], [22, 19, 25, 12, 16, 20]),
    await seedGuild('Crowfall Company', 'CROW', 'crow', 4, [2, 2], [14, 18, 9, 11]),
    await seedGuild('Oath of the Anvil', 'OATH', 'anvil', 3, [1], [8, 6, 10]),
  ];
  for (const g of others) await seedFacts(g.gid, g.ids, g.stages, g.pve, curStart);
  await seedFacts(guild.id, [leader.id, member.id], [4, 5, 3], [25, 21], curStart);
  // A third Warden so the guild is listed (three counted members).
  const third = await seedGuild('Spare', 'SPR', 'oak', 1, [], [17]);
  await db.query('update guild_members set guild_id = $1, role = $2 where account_id = $3', [
    guild.id,
    'member',
    third.ids[0],
  ]);
  await seedFacts(guild.id, third.ids, [], [17], curStart);
  // The past season's final standings and honours (as the archive and the award would write).
  const past = [
    [others[0].gid, 'The Lantern Watch', 'LNT', 'moon', 1, 'champion', 2410],
    [guild.id, 'The Ashen Wardens', 'ASH', 'flame', 2, 'exalted', 1980],
    [others[1].gid, 'Crowfall Company', 'CROW', 'crow', 3, 'renowned', 1205],
    [others[2].gid, 'Oath of the Anvil', 'OATH', 'anvil', 4, null, 410],
  ];
  for (const [gid, name, tag, emblem, rank, tier, value] of past) {
    await db.query(
      `insert into guild_season_standings (season, guild_id, rank, name, tag, emblem, formula_version, value, sort_key, inputs_hash, input, members, achieved_at)
       values ($1, $2, $3, $4, $5, $6, 1, $7, array[$7::bigint, $7::bigint, 0, 0], 'seed', $8, 3, $9)`,
      [
        prev,
        gid,
        rank,
        name,
        tag,
        emblem,
        value,
        JSON.stringify({ stages: Array(Math.floor(value / 20)).fill(1), members: [] }),
        new Date(now - 21 * DAY),
      ],
    );
    if (tier)
      await db.query(
        `insert into guild_season_awards (season, guild_id, tier, rank, awarded_at) values ($1, $2, $3, $4, $5)`,
        [prev, gid, tier, rank, new Date(now - 20 * DAY)],
      );
  }
  // The Lantern Watch's hall: bought and hung (as its officers would).
  for (const [u, gold] of [
    ['hall-banner.pale-silks', 45000],
    ['crest-frame.gilt-wreath', 50000],
    ['guild-colour.forge-gold', 12000],
  ]) {
    await db.query(
      `insert into guild_hall_upgrades (guild_id, upgrade_id, gold, materials, bought_at) values ($1, $2, $3, '{}', now())`,
      [others[0].gid, u, gold],
    );
  }
  await db.query(
    `insert into guild_hall_displays (guild_id, hall_banner, crest_frame, title_colour, updated_at)
     values ($1, 'hall-banner.pale-silks', 'crest-frame.gilt-wreath', 'guild-colour.forge-gold', now())`,
    [others[0].gid],
  );

  // The scheduler would refresh the guild roll within a run; do it now (the owner's command).
  execSync('pnpm --silent admin:leaderboards refresh', { stdio: 'inherit', env: process.env });

  const leadPage = await lead.newPage();
  const memPage = await memberCtx.newPage();
  for (const p of [leadPage, memPage])
    p.on('pageerror', (err) => console.error(`! page error: ${err.message}`));
  const pages = [
    { vp: VIEWPORTS[0], page: leadPage, api: lead.request },
    { vp: VIEWPORTS[1], page: memPage, api: memberCtx.request },
  ];

  // 1. Loading and error (faked).
  for (const { vp, page } of pages) {
    await page.route('**/api/guild/hall', async (route) => {
      await new Promise((r) => setTimeout(r, 60_000));
      await route.abort();
    });
    await page.goto(`${baseUrl}/#/treasury`);
    await page.locator('.treasury__status').waitFor();
    await shoot(page, vp, 'treasury-loading', page.locator('.treasury'));
    await page.unroute('**/api/guild/hall');
    await page.route('**/api/guild/hall', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'unavailable', message: 'Down for a moment' } }),
      }),
    );
    await page.reload();
    await page.locator('.treasury [role="alert"]').waitFor();
    await shoot(page, vp, 'treasury-error', page.locator('.treasury'));
    await page.unroute('**/api/guild/hall');
  }

  // 2. The leader gives through the form (the notice confirmed), then the treasury fills.
  {
    const { vp, page } = pages[0];
    await page.goto(`${baseUrl}/#/treasury`, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.treasury__give').waitFor();
    await page.getByLabel('How much').fill('20000');
    await page.getByLabel(/never given back/).check();
    await shoot(page, vp, 'treasury-give', page.locator('.treasury__give'));
    await page.getByRole('button', { name: 'Give', exact: true }).click();
    await page.locator('.treasury__give .treasury__message--ok').waitFor();
    await shoot(page, vp, 'treasury-given', page.locator('.treasury__give'));
  }
  for (const { api, hero } of [
    { api: lead.request, hero: leader.hero },
    { api: memberCtx.request, hero: member.hero },
  ]) {
    const res = await keyed(api, '/api/guild/hall/contribute', {
      characterId: hero,
      offer: [
        { resource: 'gold', amount: 23800 },
        { resource: 'ironOre', amount: 29 },
        { resource: 'soulShard', amount: 39 },
        { resource: 'timber', amount: 12 },
      ],
      acknowledgeNoRefund: true,
    });
    if (!res.ok()) console.warn(`gift: ${res.status()} ${await res.text()}`);
  }
  // Earlier days' gifts (each day's share is capped, so a month of giving is seeded).
  await db.query(
    `update guild_treasuries set gold = gold + 60000,
       materials = '{"ironOre":200,"soulShard":160,"timber":130,"rawHide":40,"abbeySilver":12}'
     where guild_id = $1`,
    [guild.id],
  );
  for (const u of [
    'hall-banner.iron-drapes',
    'crest-frame.iron-rim',
    'guild-colour.blood-wine',
    'backdrop.hearth-glow',
  ]) {
    const res = await keyed(lead.request, '/api/guild/hall/buy', { upgradeId: u });
    if (!res.ok()) console.warn(`buy ${u}: ${res.status()} ${await res.text()}`);
  }
  await keyed(lead.request, '/api/guild/hall/display', {
    hallBanner: 'hall-banner.iron-drapes',
    titleColour: 'guild-colour.blood-wine',
    backdrop: 'backdrop.hearth-glow',
  });

  // 3. The treasury: the officer's view (desktop, hangs the frame with the button), a member's.
  {
    const { vp, page } = pages[0];
    await page.goto(`${baseUrl}/#/treasury`, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    const rim = page.locator('.treasury__ware', { hasText: 'Iron rim' });
    await rim.getByRole('button', { name: 'Hang it' }).click();
    await rim.getByRole('button', { name: 'Take down' }).waitFor();
    await shoot(page, vp, 'treasury-officer', page.locator('.treasury'));
  }
  {
    const { vp, page } = pages[1];
    await page.goto(`${baseUrl}/#/treasury`, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.treasury__ledger').waitFor();
    await shoot(page, vp, 'treasury-member', page.locator('.treasury'));
  }

  // 4. The guild page with the hall's look; the guild roll now and last season.
  for (const { vp, page } of pages) {
    await page.goto(`${baseUrl}/#/guild`, { waitUntil: 'networkidle' });
    await page.locator('.guildbanner').waitFor();
    await page.locator('.guildbanner [data-upgrade="crest-frame.iron-rim"]').waitFor();
    await shoot(page, vp, 'guild-hall-look', page.locator('.guildbanner'));
    await page.goto(`${baseUrl}/#/boards/guilds`, { waitUntil: 'networkidle' });
    await page.locator('.groll-list').waitFor();
    await shoot(page, vp, 'guild-roll', page.locator('.renown'));
    await page.goto(`${baseUrl}/#/boards/guilds?season=${prev}`, { waitUntil: 'networkidle' });
    await page.locator('.groll-honour').first().waitFor();
    await shoot(page, vp, 'guild-roll-final', page.locator('.renown'));
  }

  // 5. Not in a guild.
  {
    const ctx = await browser.newContext({ viewport: VIEWPORTS[1], deviceScaleFactor: 2 });
    await register(ctx, `hall-none-${stamp}@graumark.test`, 'Odo Marrow', 'Odo');
    const page = await ctx.newPage();
    await page.goto(`${baseUrl}/#/treasury`, { waitUntil: 'networkidle' });
    await page.locator('.treasury__empty').waitFor();
    await shoot(page, VIEWPORTS[1], 'treasury-no-guild', page.locator('.treasury'));
  }
} finally {
  await browser.close();
  await db.end();
}
