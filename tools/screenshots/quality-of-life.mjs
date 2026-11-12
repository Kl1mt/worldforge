// Captures the ticket 8.5 screens (the Pack's search, sort and filters; loot-filter presets with a
// share code and an import preview; the Tavern's "Claim all"; the Letters inbox with its badge) at
// desktop (1440) and mobile (390). Seeds the hero straight in PostgreSQL (level, a pack of mixed
// items, ready quests, a few inbox letters), so it needs the normal server on a real database plus
// the web dev server and a built game-core:
//   pnpm build
//   DATABASE_URL=… pnpm --filter @worldforge/server dev      (after pnpm db:migrate)
//   pnpm --filter @worldforge/web dev
//   DATABASE_URL=… node tools/screenshots/quality-of-life.mjs [baseUrl] [outDir]
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  ITEM_BASES,
  WORLD_ERAS,
  canClassUseItem,
  createRng,
  encodeLootFilterCode,
  generateItem,
} from '../../packages/game-core/dist/index.js';

const require = createRequire(import.meta.url);
const playwright = require('playwright');
const pg = require('../../apps/server/node_modules/pg');

const baseUrl = process.argv[2] ?? 'http://localhost:5173';
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-8');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required (the server’s database)');

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, hero: 'Edric', className: 'Warrior' },
  { name: 'mobile', width: 390, height: 844, hero: 'Wynne', className: 'Mage' },
];
const PASSWORD = 'ashes-and-iron-42';
const step = (vp, text) => console.log(`[${vp.name}] ${text}`);

async function shoot(page, vp, name, { full = true } = {}) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() =>
    Promise.all([...document.images].map((img) => img.decode().catch(() => undefined))),
  );
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  if (overflow) console.warn(`! horizontal overflow on ${name} @ ${vp.name}`);
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  if (full) await page.setViewportSize({ width: vp.width, height: Math.max(vp.height, height) });
  const file = `${outDir}/${name}-${vp.name}.png`;
  await page.screenshot({ path: file });
  await page.setViewportSize({ width: vp.width, height: vp.height });
  console.log(`saved ${file}`);
}

/** A pack of 28: commons to Legendaries, a set piece, a Void and a Prismatic, some locked. */
async function seedPack(db, characterId, classId) {
  await db.query('update characters set level = 22, gold = 4180 where id = $1', [characterId]);
  const rng = createRng(`qol-shots:${classId}`);
  const bases = ITEM_BASES.filter(
    (b) => !b.unique && b.minItemLevel <= 20 && canClassUseItem(b, classId),
  );
  const plan = [
    ...Array(10).fill({ rarityId: 'common' }),
    ...Array(7).fill({ rarityId: 'uncommon' }),
    ...Array(5).fill({ rarityId: 'rare' }),
    { rarityId: 'epic' },
    { rarityId: 'epic', locked: true },
    { rarityId: 'legendary', locked: true },
    { rarityId: 'legendary', variant: 'void' },
    { rarityId: 'legendary', variant: 'prismatic', binding: 'equip' },
    { rarityId: 'legendary', set: true },
  ];
  const setBase = ITEM_BASES.find((b) => b.id === 'vigil-helm');
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    const base = p.set ? setBase : bases[rng.int(0, bases.length - 1)];
    const item = generateItem({
      seed: 800 + i,
      baseId: base.id,
      rarityId: p.rarityId,
      itemLevel: 16 + rng.int(0, 4),
      classId,
      ...(p.set ? { setId: 'drowned-vigil' } : {}),
    });
    await db.query(
      `insert into item_instances (id, character_id, base_id, rarity_id, item_level, affixes, seed,
         effect_id, effect_roll, set_id, variant, locked, binding, source, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'farming',
         now() - ($14 || ' minutes')::interval)`,
      [
        randomUUID(),
        characterId,
        item.baseId,
        item.rarityId,
        item.itemLevel,
        JSON.stringify(item.affixes),
        item.seed,
        item.effectId ?? null,
        item.effectRoll ?? null,
        p.set ? 'drowned-vigil' : (item.setId ?? null),
        p.variant ?? null,
        p.locked ?? false,
        p.binding ?? 'account',
        String(plan.length - i),
      ],
    );
  }
}

/** Letters as the server writes them (the shapes of `notifyTx`), newest last. */
async function seedLetters(db, accountId, characterId) {
  const letters = [
    ['world.era', { from: WORLD_ERAS[1].id, to: WORLD_ERAS[2].id }, 26 * 60],
    [
      'world.stage',
      { projectId: 'restoreWarehouse', stageId: 'raiseRoof', stageIndex: 1 },
      25 * 60,
    ],
    [
      'event.reward',
      { eventId: 'harvestOfBones', event: 1, tier: 1, cosmeticId: 'banner.harvest-sheaf' },
      300,
    ],
    [
      'duel.defence',
      { duelId: randomUUID(), kind: 'rated', bracketId: '20-29', outcome: 'held', rating: 14 },
      90,
    ],
    ['trade.received', { offerId: randomUUID() }, 40],
    [
      'drop',
      {
        characterId,
        source: 'farming',
        placeId: 'sunkenAbbey',
        count: 2,
        items: [
          { baseId: 'vigil-helm', rarityId: 'legendary', setId: 'drowned-vigil' },
          { baseId: 'iron-ring', rarityId: 'legendary', variant: 'void' },
        ],
      },
      12,
    ],
  ];
  for (const [kind, data, minutesAgo] of letters) {
    await db.query(
      `insert into account_notifications (id, account_id, kind, data, created_at)
       values ($1, $2, $3, $4, now() - ($5 || ' minutes')::interval)`,
      [randomUUID(), accountId, kind, JSON.stringify(data), String(minutesAgo)],
    );
  }
  // The two oldest are already read.
  await db.query(
    `update account_notifications set read_at = now()
     where account_id = $1 and kind in ('world.era', 'world.stage')`,
    [accountId],
  );
}

async function api(page, method, url, body, headers = {}) {
  return page.evaluate(
    async ({ method, url, body, headers }) => {
      const res = await fetch(url, {
        method,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    { method, url, body, headers },
  );
}

async function run(browser, db, vp) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  page.on('pageerror', (err) => console.error(`! page error @ ${vp.name}: ${err.message}`));
  const tag = `${Date.now().toString(36)}${vp.name[0]}`;

  step(vp, 'register and forge a hero');
  await page.goto(`${baseUrl}/#/register`, { waitUntil: 'networkidle' });
  await page.getByLabel('Email').fill(`comfort-${tag}@graumark.test`);
  await page.getByLabel('Display name').fill(`Comfort ${String(Date.now()).slice(-6)}`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('heading', { name: 'Forge your first hero' }).waitFor();
  const suffix = [...Date.now().toString(26).slice(-4)]
    .map((c) => String.fromCharCode(97 + (parseInt(c, 26) % 26)))
    .join('');
  await page.getByLabel('Name', { exact: true }).fill(`${vp.hero}${suffix}`);
  await page.getByRole('radio', { name: new RegExp(`^${vp.className}`) }).check({ force: true });
  await page.getByRole('button', { name: 'Forge hero' }).click();
  await page.waitForURL(/#\/hub/);
  const { activeCharacterId: id } = (await api(page, 'GET', '/api/characters')).body;
  await api(page, 'POST', '/api/account/guide', { dismissed: true });
  const { rows } = await db.query('select account_id from characters where id = $1', [id]);
  const accountId = rows[0].account_id;

  step(vp, 'seed the pack, quests and letters');
  await seedPack(db, id, vp.className.toLowerCase());
  await api(page, 'POST', `/api/characters/${id}/quests`, {
    kind: 'story',
    questId: 'furrowsOfTheDead',
  });
  for (const slot of [0, 1, 2]) {
    await api(page, 'POST', `/api/characters/${id}/quests`, { kind: 'contract', slot });
  }
  // Two of the four done (test set-up: their targets as progress).
  await db.query(
    `update character_quests q set progress = (
       select jsonb_agg(coalesce((o->>'count')::int, 1)) from jsonb_array_elements(q.objectives) o)
     where q.id in (select id from character_quests where character_id = $1
       order by accepted_at, id limit 3)`,
    [id],
  );
  await seedLetters(db, accountId, id);

  step(vp, 'the pack: search, filters, sort');
  await page.goto(`${baseUrl}/#/inventory`);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('search').waitFor();
  await page.getByRole('button', { name: /^Filters/ }).click();
  await page.getByRole('combobox', { name: 'Sort' }).selectOption('rarity');
  await page.getByRole('combobox', { name: 'Lock' }).selectOption('no');
  await page.getByRole('searchbox').fill('legendary');
  await page.getByText(/of \d+ shown/).waitFor();
  await shoot(page, vp, 'qol-pack-search');
  await page.getByRole('searchbox').fill('');
  await page.getByRole('button', { name: 'Clear' }).click();

  step(vp, 'loot filter: presets, a share code, an import');
  await page.getByRole('tab', { name: /Loot filter/ }).click();
  await page.getByText('No presets yet.').waitFor();
  await page.getByRole('button', { name: 'Below Rare' }).click();
  await page.getByRole('textbox', { name: 'Keep the rules below as' }).fill('Abbey runs');
  await page.getByRole('button', { name: 'Keep', exact: true }).click();
  await page.getByText('Saved as “Abbey runs”.').waitFor();
  await page.getByRole('button', { name: 'Below Uncommon' }).click();
  await page.getByRole('textbox', { name: 'Keep the rules below as' }).fill('Early fields');
  await page.getByRole('button', { name: 'Keep', exact: true }).click();
  await page.getByText('Saved as “Early fields”.').waitFor();
  await page.getByRole('button', { name: 'Use' }).first().click();
  await page
    .getByText(/is now your loot filter/)
    .first()
    .waitFor();
  await page.getByRole('button', { name: 'Share' }).first().click();
  const shared = encodeLootFilterCode({
    action: 'sell',
    belowRarity: 'epic',
    wantedAffixes: ['crit-chance', 'crit-damage'],
    wantedEffects: [],
    include: ['set'],
  });
  await page.getByLabel('Import a code').fill(shared);
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  await page.getByText('This code:').waitFor();
  await shoot(page, vp, 'qol-filter-presets');

  step(vp, 'the Tavern: claim all');
  await page.goto(`${baseUrl}/#/tavern`);
  await page.getByRole('button', { name: /^Claim all/ }).waitFor();
  await shoot(page, vp, 'qol-tavern-ready');
  await page.getByRole('button', { name: /^Claim all/ }).click();
  await page.getByText(/rewards? claimed/).waitFor();
  await shoot(page, vp, 'qol-tavern-claimed', { full: false });

  step(vp, 'the letters');
  await page.goto(`${baseUrl}/#/inbox`);
  await page.getByRole('heading', { name: 'Letters' }).waitFor();
  await page.getByText('A trade offer arrived').waitFor();
  await shoot(page, vp, 'qol-inbox');
  await page.getByRole('button', { name: 'Mark all read' }).click();
  await page.getByText(/^Everything read/).waitFor();
  await shoot(page, vp, 'qol-inbox-read', { full: false });
  await context.close();
}

mkdirSync(outDir, { recursive: true });
const db = new pg.Client({ connectionString: databaseUrl });
await db.connect();
const browser = await playwright.chromium.launch();
try {
  for (const vp of VIEWPORTS) await run(browser, db, vp);
} finally {
  await browser.close();
  await db.end();
}
