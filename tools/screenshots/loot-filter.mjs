// Captures the ticket 3.7 screens (loot filter, pack full, several items at once, item lock, and
// the return summary with filtered and overflowing drops) at desktop (1440) and mobile (390).
// Seeds the hero straight in PostgreSQL (level, a full pack with a few locked items) and moves
// the farming activity two hours back, so it needs the normal server on a real database plus the
// web dev server and a built game-core:
//   pnpm build
//   DATABASE_URL=… pnpm --filter @worldforge/server dev      (after pnpm db:migrate)
//   pnpm --filter @worldforge/web dev
//   DATABASE_URL=… node tools/screenshots/loot-filter.mjs [baseUrl] [outDir]
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  DEFAULT_ACTIVITY_CONFIG,
  ITEM_BASES,
  canClassUseItem,
  createRng,
  generateItem,
} from '../../packages/game-core/dist/index.js';

const require = createRequire(import.meta.url);
const playwright = require('playwright');
const pg = require('../../apps/server/node_modules/pg');

const baseUrl = process.argv[2] ?? 'http://localhost:5173';
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-3');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required (the server’s database)');

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, hero: 'Edric', className: 'Warrior' },
  { name: 'mobile', width: 390, height: 844, hero: 'Wynne', className: 'Mage' },
];
const PASSWORD = 'ashes-and-iron-42';
const CAPACITY = DEFAULT_ACTIVITY_CONFIG.inventory.capacity;
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

/** A full pack: mostly commons and uncommons, some rares, an epic and a Legendary; 3 locked. */
async function seed(db, characterId, classId) {
  await db.query('update characters set level = 14, gold = 2210 where id = $1', [characterId]);
  const rng = createRng(`lf-shots:${classId}`);
  const bases = ITEM_BASES.filter(
    (b) => !b.unique && b.minItemLevel <= 14 && canClassUseItem(b, classId),
  );
  const rarities = [
    ...Array(30).fill('common'),
    ...Array(18).fill('uncommon'),
    ...Array(9).fill('rare'),
    'epic',
    'epic',
    'legendary',
  ];
  for (let i = 0; i < CAPACITY; i++) {
    const base = bases[rng.int(0, bases.length - 1)];
    const item = generateItem({
      seed: 500 + i,
      baseId: base.id,
      rarityId: rarities[i],
      itemLevel: 9 + rng.int(0, 5),
      classId,
    });
    const locked = rarities[i] === 'legendary' || (rarities[i] === 'rare' && i % 4 === 0);
    await db.query(
      `insert into item_instances (id, character_id, base_id, rarity_id, item_level, affixes, seed,
         effect_id, effect_roll, locked, source, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'farming', now() - ($11 || ' minutes')::interval)`,
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
        locked,
        String(CAPACITY - i),
      ],
    );
  }
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
  await page.getByLabel('Email').fill(`sift-${tag}@graumark.test`);
  await page.getByLabel('Display name').fill(`Sifter ${String(Date.now()).slice(-6)}`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('heading', { name: 'Forge your first hero' }).waitFor();
  // Hero names are unique across accounts: add a few letters so the script can run again.
  const suffix = [...Date.now().toString(26).slice(-4)]
    .map((c) => String.fromCharCode(97 + (parseInt(c, 26) % 26)))
    .join('');
  await page.getByLabel('Name', { exact: true }).fill(`${vp.hero}${suffix}`);
  await page.getByRole('radio', { name: new RegExp(`^${vp.className}`) }).check({ force: true });
  await page.getByRole('button', { name: 'Forge hero' }).click();
  await page.waitForURL(/#\/hub/);
  const id = await page.evaluate(
    async () => (await (await fetch('/api/characters')).json()).activeCharacterId,
  );
  // The first-session guide would cover the pack on phones; it is not what these shots are about.
  await page.evaluate(() =>
    fetch('/api/account/guide', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dismissed: true }),
    }),
  );

  step(vp, 'seed a full pack');
  await seed(db, id, vp.className.toLowerCase());

  step(vp, 'loot filter: write standing orders');
  await page.goto(`${baseUrl}/#/inventory`);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: /Loot filter/ }).click();
  await page.getByText('No standing orders').waitFor();
  await shoot(page, vp, 'loot-filter-off');
  await page.getByRole('radio', { name: /Salvage/ }).check();
  await page.getByRole('button', { name: 'Below Rare' }).click();
  await page.getByRole('button', { name: 'Critical Damage', exact: true }).click();
  await page.getByRole('button', { name: 'Attack Speed', exact: true }).click();
  await page.getByRole('button', { name: 'Save filter' }).click();
  await page.getByText(/^Filter saved/).waitFor();
  await shoot(page, vp, 'loot-filter');

  step(vp, 'farm, then come back two hours later');
  await page.evaluate(
    (cid) =>
      fetch(`/api/characters/${cid}/activity`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ areaId: 'oldBurialGrounds' }),
      }),
    id,
  );
  // Leave the game first: an open page polls settle and would collect the window itself.
  await page.goto('about:blank');
  await db.query(
    `update activities set started_at = now() - interval '2 hours',
       settled_at = now() - interval '2 hours', last_seen_at = now() - interval '2 hours',
       summary = jsonb_set(summary, '{since}',
         to_jsonb(to_char((now() - interval '2 hours') at time zone 'utc',
           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
     where character_id = $1`,
    [id],
  );
  await page.goto(`${baseUrl}/#/area`, { waitUntil: 'networkidle' });
  await page.getByRole('dialog').waitFor();
  await page.getByText(/^Your loot filter/).waitFor();
  await shoot(page, vp, 'return-filtered', { full: false });
  await page.getByRole('button', { name: 'Back to the fields' }).click();

  step(vp, 'pack full: select several, sell or salvage');
  await page.goto(`${baseUrl}/#/inventory`);
  await page.getByText('Your pack is full.').waitFor();
  await shoot(page, vp, 'pack-full');
  await page.getByRole('button', { name: 'Sell or salvage several' }).click();
  await page.getByRole('button', { name: /^Common \d+/ }).click();
  await page.getByRole('button', { name: 'All Common' }).click();
  await shoot(page, vp, 'pack-bulk');
  await page.getByRole('button', { name: /^Salvage for/ }).click();
  await page.getByText(/^Salvaged \d+ items/).waitFor();
  await page.getByRole('button', { name: 'Done selecting' }).click();
  await page.getByRole('button', { name: /^All \d+/ }).click();

  step(vp, 'a locked item');
  await page
    .getByRole('button', { name: /, legendary, locked/ })
    .first()
    .click();
  await page.getByRole('button', { name: 'Unlock' }).waitFor();
  await shoot(page, vp, 'pack-locked');
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
