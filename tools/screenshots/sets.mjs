// Captures the ticket 3.3 UI: the set tracker on the character screen, a set piece's tooltip
// (set section with worn and packed pieces, active bonuses), and the chronicle line and return
// summary moment for a found set piece, at desktop (1440) and mobile (390) widths.
// Needs `pnpm --filter @worldforge/server e2e:serve` and `pnpm --filter @worldforge/web dev`.
// Auth, the hero and farming are real; set drops cannot be forced, so the script adds the items
// below (game-core `generateItem` with these seeds, warrior, item level 18) to the inventory and
// return-summary responses: four Drowned Vigil pieces worn, three pieces of the three sets in the
// pack. Display only: nothing is written to the server.
//   node tools/screenshots/sets.mjs [baseUrl] [outDir]
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require(process.env.PLAYWRIGHT_PATH ?? '/opt/node-tools/node_modules/playwright');
}

const baseUrl = process.argv[2] ?? 'http://localhost:5173';
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-3');
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

/** game-core generateItem output; equippedSlot marks the worn pieces. */
const GENERATED = [
  {
    seed: 41,
    baseId: 'vigil-helm',
    rarityId: 'legendary',
    itemLevel: 18,
    affixes: [
      { affixId: 'armor', tier: 2, value: 10 },
      { affixId: 'item-find', tier: 2, value: 0.1 },
      { affixId: 'health', tier: 1, value: 13 },
      { affixId: 'gold-find', tier: 1, value: 0.04 },
    ],
    setId: 'drowned-vigil',
    equippedSlot: 'head',
  },
  {
    seed: 42,
    baseId: 'vigil-hauberk',
    rarityId: 'legendary',
    itemLevel: 18,
    affixes: [
      { affixId: 'health', tier: 3, value: 44 },
      { affixId: 'physical-damage', tier: 2, value: 6 },
      { affixId: 'armor', tier: 3, value: 16 },
      { affixId: 'magic-damage', tier: 3, value: 13 },
    ],
    setId: 'drowned-vigil',
    equippedSlot: 'chest',
  },
  {
    seed: 43,
    baseId: 'vigil-gauntlets',
    rarityId: 'legendary',
    itemLevel: 18,
    affixes: [
      { affixId: 'attack-speed', tier: 2, value: 0.05 },
      { affixId: 'physical-damage', tier: 3, value: 9 },
      { affixId: 'magic-damage', tier: 3, value: 10 },
      { affixId: 'health', tier: 3, value: 49 },
    ],
    setId: 'drowned-vigil',
    equippedSlot: 'hands',
  },
  {
    seed: 44,
    baseId: 'vigil-sabatons',
    rarityId: 'legendary',
    itemLevel: 18,
    affixes: [
      { affixId: 'health', tier: 1, value: 14 },
      { affixId: 'resistance', tier: 2, value: 7 },
      { affixId: 'armor', tier: 2, value: 11 },
      { affixId: 'attack-speed', tier: 1, value: 0.04 },
    ],
    setId: 'drowned-vigil',
    equippedSlot: 'feet',
  },
  {
    seed: 45,
    baseId: 'vigil-seal',
    rarityId: 'legendary',
    itemLevel: 18,
    affixes: [
      { affixId: 'resource-yield', tier: 3, value: 0.12 },
      { affixId: 'crit-damage', tier: 2, value: 0.11 },
      { affixId: 'resistance', tier: 2, value: 8 },
      { affixId: 'health', tier: 3, value: 37 },
    ],
    setId: 'drowned-vigil',
    equippedSlot: null,
  },
  {
    seed: 46,
    baseId: 'choir-band',
    rarityId: 'legendary',
    itemLevel: 18,
    affixes: [
      { affixId: 'resource-yield', tier: 2, value: 0.1 },
      { affixId: 'magic-damage', tier: 1, value: 3 },
      { affixId: 'physical-damage', tier: 3, value: 13 },
      { affixId: 'health', tier: 1, value: 13 },
    ],
    setId: 'ashen-choir',
    equippedSlot: null,
  },
  {
    seed: 47,
    baseId: 'bloodmoon-fang',
    rarityId: 'legendary',
    itemLevel: 18,
    affixes: [
      { affixId: 'physical-damage', tier: 2, value: 7 },
      { affixId: 'health', tier: 3, value: 44 },
      { affixId: 'resistance', tier: 1, value: 3 },
      { affixId: 'magic-damage', tier: 1, value: 3 },
    ],
    setId: 'bloodmoon-hunt',
    equippedSlot: null,
  },
];

const now = new Date().toISOString();
const items = GENERATED.map((g, n) => ({
  id: `0190f000-0000-7000-8000-00000000003${n}`,
  baseId: g.baseId,
  rarityId: g.rarityId,
  itemLevel: g.itemLevel,
  affixes: g.affixes,
  equippedSlot: g.equippedSlot,
  source: 'farming',
  createdAt: now,
  upgradeLevel: 0,
  variant: null,
  effectId: null,
  effectRoll: null,
  setId: g.setId,
  mythicId: null,
  locked: false,
}));
const worn = items.filter((i) => i.equippedSlot);
const packed = items.filter((i) => !i.equippedSlot);

async function shoot(page, vp, name, locator) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() =>
    Promise.all([...document.images].map((img) => img.decode().catch(() => undefined))),
  );
  const file = `${outDir}/${name}-${vp.name}.png`;
  if (locator) await locator.screenshot({ path: file });
  else await page.screenshot({ path: file });
  console.log(`saved ${file}`);
}

/** Waits for a hash route (polling the URL: the app's CSP blocks page-side evaluation). */
async function hashIs(page, hash) {
  for (let i = 0; i < 100; i++) {
    if (new URL(page.url()).hash.startsWith(hash)) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`never reached ${hash} (at ${page.url()})`);
}

mkdirSync(outDir, { recursive: true });
const browser = await playwright.chromium.launch();
try {
  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
    });
    const stamp = `${vp.name}${Date.now()}`;
    const reg = await context.request.post(`${baseUrl}/api/auth/register`, {
      data: {
        email: `${stamp}@graumark.test`,
        displayName: `Seeker ${String(Date.now()).slice(-6)}`,
        password: 'ashes-and-iron-42',
      },
    });
    if (!reg.ok()) throw new Error(`register failed: ${reg.status()}`);
    const page = await context.newPage();

    // The worn pieces replace whatever the hero wears in their slots; the rest join the pack.
    await page.route('**/api/characters/*/inventory', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const slots = new Set(worn.map((i) => i.equippedSlot));
      body.equipped = [...worn, ...body.equipped.filter((i) => !slots.has(i.equippedSlot))];
      body.inventory = [...packed, ...body.inventory];
      await route.fulfill({ response, json: body });
    });
    let summaries = 0;
    await page.route('**/api/characters/*/activity/settle', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      if (body.summary && summaries++ === 0) {
        const since = new Date(Date.parse(body.summary.until) - 3 * 3_600_000).toISOString();
        const found = packed[0];
        body.summary = {
          ...body.summary,
          since,
          simulatedMs: 3 * 3_600_000,
          kills: 1_802,
          xpGained: 88_410,
          goldGained: 951,
          itemsGained: 58,
          items: [
            ...body.summary.items,
            {
              id: found.id,
              baseId: found.baseId,
              rarityId: found.rarityId,
              itemLevel: found.itemLevel,
              setId: found.setId,
            },
          ],
        };
      }
      await route.fulfill({ response, json: body });
    });

    await page.goto(`${baseUrl}/#/area`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Forge your first hero' }).waitFor();
    const suffix = Array.from({ length: 4 }, () =>
      String.fromCharCode(97 + Math.floor(Math.random() * 26)),
    ).join('');
    await page
      .getByLabel('Name', { exact: true })
      .fill(`${vp.name === 'desktop' ? 'Aldric' : 'Brann'}${suffix}`);
    await page.getByRole('radio', { name: /^Warrior/ }).check({ force: true });
    await page.getByRole('radio', { name: 'Ember' }).check({ force: true });
    await page.getByRole('button', { name: 'Forge hero' }).click();
    await hashIs(page, '#/hub');
    await page.goto(`${baseUrl}/#/map`);
    await page.getByRole('button', { name: 'Farm Abandoned Fields' }).click();
    await hashIs(page, '#/area');
    await page.waitForTimeout(2000);
    await page.reload({ waitUntil: 'networkidle' });
    const dialog = page.locator('dialog.return');
    await dialog.waitFor({ timeout: 15_000 });
    await shoot(page, vp, 'return-summary-set-piece', dialog.locator('.return__plate'));
    await dialog.getByRole('button', { name: 'Back to the fields' }).click();
    await page.locator('.log__row--chase').first().waitFor();
    await shoot(page, vp, 'chronicle-set-piece', page.locator('.log'));

    await page.goto(`${baseUrl}/#/character`, { waitUntil: 'networkidle' });
    const sets = page.locator('section.sets');
    await sets.locator('.set').first().waitFor();
    await shoot(page, vp, 'character-set-tracker', sets);

    await page.goto(`${baseUrl}/#/inventory`, { waitUntil: 'networkidle' });
    await page
      .getByRole('button', { name: /Seal of the Drowned Vigil/ })
      .first()
      .click();
    const tooltip = page.locator('.pack__inspect article.tooltip');
    await tooltip.locator('.tooltip__set').waitFor();
    await shoot(page, vp, 'tooltip-set-piece', tooltip);
    await context.close();
  }
} finally {
  await browser.close();
}
