// Captures art ticket A.12: Prismatic items in the pack grid next to their Void and plain twins,
// Prismatic tooltips (a Legendary, a set piece, a Mythic, a tier-4 Legendary) and the drop moment
// (return summary), at desktop (1440) and mobile (390) widths. The Prismatic sweep is frozen under
// automation, so the frames show the still look (the reduced-motion look too).
// Needs a server (`pnpm --filter @worldforge/server e2e:serve`, or `dev` on a scratch database)
// and `pnpm --filter @worldforge/web dev`. Auth and the hero are real; Prismatic drops come from
// ticket 6.4, so the script adds the items below (game-core `generateItem` output, as in void.mjs)
// to the inventory and return-summary responses, each as Prismatic, Void and plain. Display only:
// nothing is written to the server. Until 6.4 is merged the web build must know the `prismatic`
// variant id (game-core `ITEM_VARIANTS`), or the frames draw plain.
//   node tools/screenshots/prismatic.mjs [baseUrl] [outDir]
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
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-6');
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

/**
 * game-core `generateItem` output (warrior): two Legendaries, two Mythics (as in legendary.mjs)
 * and a Drowned Vigil piece (as in sets.mjs).
 */
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
const row = (g, n, variant) => ({
  id: `0190f000-0000-7000-8000-0000000006${VARIANTS.indexOf(variant)}${n}`,
  baseId: g.baseId,
  rarityId: g.rarityId,
  itemLevel: g.itemLevel,
  affixes: g.affixes,
  equippedSlot: null,
  source: 'farming',
  createdAt: now,
  upgradeLevel: 0,
  variant,
  effectId: g.effectId ?? null,
  effectRoll: g.effectRoll ?? null,
  setId: g.setId ?? null,
  mythicId: g.mythicId ?? null,
  locked: false,
});
// A tier-4 Legendary (A.15's icons) on the greatsword's roll: display only.
GENERATED.push({ ...GENERATED[0], baseId: 'cinderforged-blade', itemLevel: 33 });
const VARIANTS = [null, 'void', 'prismatic'];
// Prismatic, Void and plain triplets side by side (pack order: newest first).
const items = GENERATED.flatMap((g, n) => [
  row(g, n, 'prismatic'),
  row(g, n, 'void'),
  row(g, n, null),
]);
const found = items.filter(
  (i) =>
    i.variant === 'prismatic' &&
    ['knights-greatsword', 'vigil-helm', 'crown-of-the-hollow-king'].includes(i.baseId),
);

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

    await page.route('**/api/characters/*/inventory', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.inventory = [...items, ...body.inventory];
      await route.fulfill({ response, json: body });
    });
    let summaries = 0;
    await page.route('**/api/characters/*/activity/settle', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      if (body.summary && summaries++ === 0) {
        const since = new Date(Date.parse(body.summary.until) - 3 * 3_600_000).toISOString();
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
            ...found.map((i) => ({
              id: i.id,
              baseId: i.baseId,
              rarityId: i.rarityId,
              itemLevel: i.itemLevel,
              ...(i.effectId ? { effectId: i.effectId } : {}),
              ...(i.mythicId ? { mythicId: i.mythicId } : {}),
              ...(i.setId ? { setId: i.setId } : {}),
              variant: 'prismatic',
            })),
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
    await shoot(page, vp, 'prismatic-return-summary', dialog.locator('.return__plate'));
    await dialog.getByRole('button', { name: 'Back to the fields' }).click();

    await page.goto(`${baseUrl}/#/inventory`, { waitUntil: 'networkidle' });
    await page.locator('.stash__grid').waitFor();
    await shoot(page, vp, 'prismatic-pack', page.locator('.stash__grid'));
    await shoot(page, vp, 'prismatic-pack-page');
    for (const [name, label] of [
      ['prismatic-tooltip-legendary', /Knight.s Greatsword, Prismatic legendary/],
      ['prismatic-tooltip-set-piece', /Helm of the Drowned Vigil, Prismatic legendary/],
      ['prismatic-tooltip-mythic', /Crown of the Hollow King, Prismatic mythic/],
      ['prismatic-tooltip-tier4', /Cinderforged Blade, Prismatic legendary/],
    ]) {
      await page.getByRole('button', { name: label }).first().click();
      const tooltip = page.locator('.pack__inspect article.tooltip');
      await tooltip.locator('.tooltip__variant').waitFor();
      await shoot(page, vp, name, tooltip);
    }
    // Layout check: a Prismatic frame has exactly its plain twin's box.
    const box = async (label) => page.getByRole('button', { name: label }).first().boundingBox();
    const [p, v, f] = await Promise.all([
      box(/Knight.s Greatsword, Prismatic legendary/),
      box(/Knight.s Greatsword, Void legendary/),
      box(/Knight.s Greatsword, legendary/),
    ]);
    for (const b of [p, v]) {
      if (b.width !== f.width || b.height !== f.height) {
        throw new Error(`frame box differs: ${JSON.stringify({ p, v, f })}`);
      }
    }
    console.log(`frame boxes equal (${f.width}×${f.height}) @ ${vp.name}`);
    await context.close();
  }
} finally {
  await browser.close();
}
