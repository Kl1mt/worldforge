// Captures the ticket T.1 binding line in the item tooltip at desktop (1440) and mobile (390):
// - `tooltip-binding-open`: a fresh Legendary from farming ("Binds when worn", can't be traded);
// - `tooltip-binding-worn`: the same kind of item after it was worn ("Account-bound");
// - `tooltip-binding-forged`: an upgraded Legendary ("Bound by work at the forge");
// - `tooltip-binding-hoard`: a set piece from a boss hoard ("Boss hoard loot is always bound");
// - `tooltip-binding-mythic`: a fresh Mythic from a crypt chamber ("Binds when worn").
// Needs `pnpm --filter @worldforge/server e2e:serve` and `pnpm --filter @worldforge/web dev`.
// Auth and the hero are real; the script adds the items below (game-core `generateItem` output, as
// in void.mjs) to the inventory response with each binding state. Display only: nothing is
// written to the server.
//   node tools/screenshots/binding.mjs [baseUrl] [outDir]
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
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-5');
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

/** game-core `generateItem` output (warrior), as in void.mjs. */
const GENERATED = [
  {
    seed: 7,
    baseId: 'knights-greatsword',
    rarityId: 'legendary',
    itemLevel: 18,
    affixes: [
      { affixId: 'physical-damage', tier: 1, value: 4 },
      { affixId: 'crit-damage', tier: 2, value: 0.14 },
      { affixId: 'attack-speed', tier: 1, value: 0.03 },
      { affixId: 'boss-damage', tier: 1, value: 0.03 },
    ],
    effectId: 'rage-fuelled-strikes',
    effectRoll: 0.5,
  },
  {
    seed: 7,
    baseId: 'abbey-signet',
    rarityId: 'legendary',
    itemLevel: 18,
    affixes: [
      { affixId: 'physical-damage', tier: 1, value: 4 },
      { affixId: 'resistance', tier: 2, value: 7 },
      { affixId: 'crit-damage', tier: 1, value: 0.08 },
      { affixId: 'gold-find', tier: 1, value: 0.03 },
    ],
    effectId: 'bloodrush',
    effectRoll: 0.5,
  },
  {
    seed: 77,
    baseId: 'gravecallers-edge',
    rarityId: 'mythic',
    itemLevel: 18,
    affixes: [
      { affixId: 'physical-damage', tier: 3, value: 11 },
      { affixId: 'magic-damage', tier: 3, value: 14 },
      { affixId: 'boss-damage', tier: 1, value: 0.03 },
      { affixId: 'rage-heavy-strike', tier: 2, value: 0.13 },
      { affixId: 'crit-damage', tier: 2, value: 0.11 },
    ],
    effectId: 'gravecallers-hunger',
    mythicId: 'gravecallers-edge',
  },
  {
    seed: 78,
    baseId: 'crown-of-the-hollow-king',
    rarityId: 'mythic',
    itemLevel: 19,
    affixes: [
      { affixId: 'health', tier: 3, value: 43 },
      { affixId: 'xp-gain', tier: 3, value: 0.08 },
      { affixId: 'armor', tier: 3, value: 19 },
      { affixId: 'resistance', tier: 1, value: 3 },
      { affixId: 'item-find', tier: 3, value: 0.12 },
    ],
    effectId: 'hollow-majesty',
    mythicId: 'crown-of-the-hollow-king',
  },
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
  },
];

const now = new Date().toISOString();
const row = (g, n, over) => ({
  id: `0190f000-0000-7000-8000-00000000071${n}`,
  baseId: g.baseId,
  rarityId: g.rarityId,
  itemLevel: g.itemLevel,
  affixes: g.affixes,
  equippedSlot: null,
  source: 'farming',
  createdAt: now,
  upgradeLevel: 0,
  variant: null,
  effectId: g.effectId ?? null,
  effectRoll: g.effectRoll ?? null,
  setId: g.setId ?? null,
  mythicId: g.mythicId ?? null,
  locked: false,
  binding: 'equip',
  bindingReason: 'fresh',
  tradeable: false,
  ...over,
});
const [greatsword, signet, edge, crown, helm] = GENERATED;
const items = [
  row(greatsword, 0, {}),
  row(signet, 1, { upgradeLevel: 3, binding: 'account', bindingReason: 'forged' }),
  row(edge, 2, { source: 'dungeon:namelessCrypt' }),
  row(crown, 3, { binding: 'account', bindingReason: 'worn' }),
  row(helm, 4, { source: 'hoard:namelessCrypt', binding: 'account', bindingReason: 'source' }),
];

async function shoot(page, vp, name, locator) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() =>
    Promise.all([...document.images].map((img) => img.decode().catch(() => undefined))),
  );
  const file = `${outDir}/${name}-${vp.name}.png`;
  await locator.screenshot({ path: file });
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
        displayName: `Binder ${String(Date.now()).slice(-6)}`,
        password: 'ashes-and-iron-42',
      },
    });
    if (!reg.ok()) throw new Error(`register failed: ${reg.status()}`);
    const page = await context.newPage();
    await page.route('**/api/characters/*/inventory', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.inventory = [...items, ...body.inventory];
      await route.fulfill({ response, json: body });
    });

    await page.goto(`${baseUrl}/#/area`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Forge your first hero' }).waitFor();
    const suffix = Array.from({ length: 4 }, () =>
      String.fromCharCode(97 + Math.floor(Math.random() * 26)),
    ).join('');
    await page
      .getByLabel('Name', { exact: true })
      .fill(`${vp.name === 'desktop' ? 'Ortwin' : 'Ysolde'}${suffix}`);
    await page.getByRole('radio', { name: /^Warrior/ }).check({ force: true });
    await page.getByRole('radio', { name: 'Ember' }).check({ force: true });
    await page.getByRole('button', { name: 'Forge hero' }).click();
    await hashIs(page, '#/hub');

    await page.goto(`${baseUrl}/#/inventory`, { waitUntil: 'networkidle' });
    await page.locator('.stash__grid').waitFor();
    for (const [name, label] of [
      ['tooltip-binding-open', /Knight.s Greatsword, legendary/],
      ['tooltip-binding-forged', /Abbey Signet.*legendary/],
      ['tooltip-binding-mythic', /Gravecaller.s Edge, mythic/],
      ['tooltip-binding-worn', /Crown of the Hollow King, mythic/],
      ['tooltip-binding-hoard', /Helm of the Drowned Vigil, legendary/],
    ]) {
      await page.getByRole('button', { name: label }).first().click();
      const tooltip = page.locator('.pack__inspect article.tooltip');
      await tooltip.locator('.tooltip__binding').waitFor();
      await shoot(page, vp, name, tooltip);
    }
    await context.close();
  }
} finally {
  await browser.close();
}
