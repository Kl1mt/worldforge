// Captures the ticket B.2 screens (a pack over capacity after valuable drops survived a full pack,
// the return summary saying so, and the "counts once" note on a Legendary effect) at desktop
// (1440) and mobile (390). Seeds the hero straight in PostgreSQL (a pack three Legendaries over
// capacity, and the return summary's over-capacity count) and moves the farming activity two
// hours back, so it needs the normal server on a real database plus the web dev server and a
// built game-core:
//   pnpm build
//   DATABASE_URL=… pnpm --filter @worldforge/server dev      (after pnpm db:migrate)
//   pnpm --filter @worldforge/web dev
//   DATABASE_URL=… node tools/screenshots/over-capacity.mjs [baseUrl] [outDir]
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
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

/** A full pack of ordinary items and three Legendaries beyond the capacity (as B.2 keeps them). */
async function seed(db, characterId, classId) {
  await db.query('update characters set level = 14, gold = 2210 where id = $1', [characterId]);
  const rng = createRng(`oc-shots:${classId}`);
  const bases = ITEM_BASES.filter(
    (b) => !b.unique && b.minItemLevel <= 14 && canClassUseItem(b, classId),
  );
  const rarities = [
    ...Array(32).fill('common'),
    ...Array(18).fill('uncommon'),
    ...Array(8).fill('rare'),
    'epic',
    'epic',
    'legendary',
    'legendary',
    'legendary',
  ];
  for (let i = 0; i < rarities.length; i++) {
    const base = bases[rng.int(0, bases.length - 1)];
    const item = generateItem({
      seed: 700 + i,
      baseId: base.id,
      rarityId: rarities[i],
      itemLevel: 9 + rng.int(0, 5),
      classId,
    });
    await db.query(
      `insert into item_instances (id, character_id, base_id, rarity_id, item_level, affixes, seed,
         effect_id, effect_roll, source, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'farming', now() - ($10 || ' minutes')::interval)`,
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
        String(rarities.length - i),
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
  await page.getByLabel('Email').fill(`hoard-${tag}@graumark.test`);
  await page.getByLabel('Display name').fill(`Hoarder ${String(Date.now()).slice(-6)}`);
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
  const id = await page.evaluate(
    async () => (await (await fetch('/api/characters')).json()).activeCharacterId,
  );
  await page.evaluate(() =>
    fetch('/api/account/guide', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dismissed: true }),
    }),
  );

  step(vp, 'seed a pack over capacity');
  await seed(db, id, vp.className.toLowerCase());

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
  await page.goto('about:blank');
  // The three Legendaries above the limit count as this absence's over-capacity drops.
  await db.query(
    `update activities set started_at = now() - interval '2 hours',
       settled_at = now() - interval '2 hours', last_seen_at = now() - interval '2 hours',
       summary = jsonb_set(jsonb_set(jsonb_set(summary, '{since}',
         to_jsonb(to_char((now() - interval '2 hours') at time zone 'utc',
           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))), '{itemsOverCapacity}', '3'), '{itemsGained}', '3')
     where character_id = $1`,
    [id],
  );
  await page.goto(`${baseUrl}/#/area`, { waitUntil: 'networkidle' });
  await page.getByRole('dialog').waitFor();
  await page.getByText(/^Over capacity:/).waitFor();
  await shoot(page, vp, 'return-over-capacity', { full: false });
  await page.getByRole('button', { name: 'Back to the fields' }).click();

  step(vp, 'the pack over capacity');
  await page.goto(`${baseUrl}/#/inventory`);
  await page.getByText(/^Over capacity: \d+/).waitFor();
  await shoot(page, vp, 'pack-over-capacity');

  step(vp, 'a Legendary effect: counts once');
  await page
    .getByRole('button', { name: /, legendary/ })
    .first()
    .click();
  await page.getByText('Worn twice, only the stronger copy counts.').first().waitFor();
  await shoot(page, vp, 'tooltip-counts-once');
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
