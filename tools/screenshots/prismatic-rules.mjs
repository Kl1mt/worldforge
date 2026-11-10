// Captures the ticket 6.4 UI (rules, text and the trading switch; A.12's own `prismatic.mjs` covers
// the visual treatment) at desktop (1440) and mobile (390):
// - `inventory-prismatic-frames`: Prismatic items in the pack next to their Void and plain twins
//   (a Legendary weapon, a set piece and a Mythic), with A.12's treatment;
// - `tooltip-prismatic-legendary`, `tooltip-prismatic-set-piece`, `tooltip-prismatic-mythic`: the
//   tooltip's "Prismatic" line (combat properties +10 %);
// - `admin-trading-prismatic`: the admin panel's Trading settings with "Tradeable: Prismatic" off.
// Needs `pnpm build` (game-core's dist), the e2e server with an admin seed and the web dev server:
//   E2E_SEED_ADMIN=castellan@graumark.test pnpm --filter @worldforge/server e2e:serve
//   pnpm --filter @worldforge/web dev
//   node tools/screenshots/prismatic-rules.mjs [baseUrl] [outDir]
// Auth and the hero are real; a Prismatic drop cannot be forced, so the script adds the items
// below (game-core `generateItem`, fixed seeds) to the inventory response, each as Prismatic, as
// Void and plain. Display only: nothing is written to the server.
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require(process.env.PLAYWRIGHT_PATH ?? '/opt/node-tools/node_modules/playwright');
}
const core = await import(
  pathToFileURL(resolve(import.meta.dirname, '../../packages/game-core/dist/index.js')).href
);

const baseUrl = process.argv[2] ?? 'http://localhost:5173';
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-6');
const adminEmail = process.env.ADMIN_EMAIL ?? 'castellan@graumark.test';
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

const mythic = core.MYTHIC_ITEMS.find((m) => m.id === 'gravecallers-edge') ?? core.MYTHIC_ITEMS[0];
const GENERATED = [
  core.generateItem({
    seed: 604,
    itemLevel: 33,
    baseId: 'cinderforged-blade',
    rarityId: 'legendary',
    classId: 'warrior',
  }),
  core.generateItem({ seed: 605, itemLevel: 30, baseId: 'vigil-helm', classId: 'warrior' }),
  core.generateItem({ seed: 606, itemLevel: 33, baseId: mythic.baseId, classId: 'warrior' }),
];

const now = new Date().toISOString();
const row = (g, n, variant) => ({
  id: `0190f000-0000-7000-8000-00000006${variant === 'prismatic' ? 2 : variant ? 1 : 0}${n}0`,
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
// Prismatic, Void and plain side by side.
const items = GENERATED.flatMap((g, n) => [
  row(g, n, 'prismatic'),
  row(g, n, 'void'),
  row(g, n, null),
]);
const names = GENERATED.map((g) => core.getItemBase(g.baseId).name);

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

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/’/g, '.');

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
        displayName: `Prism ${String(Date.now()).slice(-6)}`,
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
      .fill(`${vp.name === 'desktop' ? 'Iriel' : 'Sefa'}${suffix}`);
    await page.getByRole('radio', { name: /^Warrior/ }).check({ force: true });
    await page.getByRole('radio', { name: 'Ember' }).check({ force: true });
    await page.getByRole('button', { name: 'Forge hero' }).click();
    await hashIs(page, '#/hub');

    await page.goto(`${baseUrl}/#/inventory`, { waitUntil: 'networkidle' });
    await page.locator('.stash__grid').waitFor();
    await page.locator('.item-frame--prismatic').first().waitFor();
    await shoot(page, vp, 'inventory-prismatic-frames', page.locator('.stash__grid'));
    for (const [name, i, rarity] of [
      ['tooltip-prismatic-legendary', 0, 'legendary'],
      ['tooltip-prismatic-set-piece', 1, 'legendary'],
      ['tooltip-prismatic-mythic', 2, 'mythic'],
    ]) {
      await page
        .getByRole('button', { name: new RegExp(`${escape(names[i])}, Prismatic ${rarity}`) })
        .first()
        .click();
      const tooltip = page.locator('.pack__inspect article.tooltip');
      await tooltip.locator('.tooltip__unique--prismatic').waitFor();
      await shoot(page, vp, name, tooltip);
    }
    await context.close();

    // The admin's Trading settings: the new switch, off at its default.
    const admin = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
    });
    const login = await admin.request.post(`${baseUrl}/api/auth/login`, {
      data: { email: adminEmail, password: 'ashes-and-iron-42' },
    });
    if (!login.ok()) throw new Error(`admin login: ${login.status()}`);
    // The seeded admin needs a hero for the app shell (a second run finds it already made).
    await admin.request.post(`${baseUrl}/api/characters`, {
      data: { name: `Ysolde${suffix}`, classId: 'warrior', appearance: { banner: 'ash' } },
    });
    const adminPage = await admin.newPage();
    await adminPage.goto(`${baseUrl}/#/admin/trading`, { waitUntil: 'networkidle' });
    await adminPage.getByRole('switch', { name: /Tradeable: Prismatic/ }).waitFor();
    // Seen without the fixed bars, as in admin-trading.mjs.
    await adminPage.addStyleTag({
      content:
        '.bottombar { display: none !important; } .tset__savebar { position: static !important; }',
    });
    await shoot(
      adminPage,
      vp,
      'admin-trading-prismatic',
      adminPage.locator('section.strong').first(),
    );
    await admin.close();
  }
} finally {
  await browser.close();
}
