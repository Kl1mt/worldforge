// Ticket 6.5b: Item Awakening at the Forge ("The Banked Fire") at desktop (1440) and mobile (390):
// the panel with an item ready (before/after quote, price), the full confirm, the success notice
// and the awakened item's tooltip, the "not enough to pay" state, the set progress quote, the empty
// state for a hero with nothing to awaken, and the admin gallery's Variants table with the awakened
// rows. Everything is real: the test account's hero is set up with D.4's admin tools (level,
// gold, Embers, Seals and shards, and the items granted with the grant tool, one of them already
// awakened), and the awakening is done through the panel. The ember glow is still under
// automation, so the frames show the still look (the reduced-motion look too).
//   E2E_SEED_ADMIN=castellan@graumark.test E2E_SEED_TEST_ACCOUNT=probe@graumark.test \
//     pnpm --filter @worldforge/server e2e:serve
//   pnpm --filter @worldforge/web dev
//   node tools/screenshots/awakening.mjs [baseUrl] [outDir]
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
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
const PASSWORD = 'ashes-and-iron-42';
const ADMIN = process.env.E2E_SEED_ADMIN ?? 'castellan@graumark.test';
const PROBE = process.env.E2E_SEED_TEST_ACCOUNT ?? 'probe@graumark.test';
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

async function api(ctx, method, path, data, key) {
  const res = await ctx.request.fetch(`${baseUrl}/api${path}`, {
    method,
    ...(data ? { data } : {}),
    headers: key ? { 'Idempotency-Key': key } : {},
  });
  if (!res.ok()) throw new Error(`${method} ${path}: ${res.status()} ${await res.text()}`);
  return res.status() === 204 ? null : res.json();
}

async function context(browser, vp) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (err) => console.error(`! page error @ ${vp.name}: ${err.message}`));
  return { ctx, page };
}

async function shoot(page, vp, name, locator) {
  await page.addStyleTag({ content: '.notices { display: none !important; }' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  if (overflow) console.warn(`! horizontal overflow on ${name} @ ${vp.name}`);
  const file = `${outDir}/awakening-${name}-${vp.name}.png`;
  if (locator) await locator.screenshot({ path: file });
  else await page.screenshot({ path: file, fullPage: true });
  console.log(`saved ${file}`);
}

/** The test account's hero at level 38 (created once). */
async function setupHero(browser, vp, admin) {
  const c = await context(browser, vp);
  await api(c.ctx, 'POST', '/auth/login', { email: PROBE, password: PASSWORD });
  const { account } = await api(c.ctx, 'GET', '/account');
  const { characters } = await api(c.ctx, 'GET', '/characters');
  const character =
    characters[0] ??
    (
      await api(c.ctx, 'POST', '/characters', {
        name: 'Hralda',
        classId: 'warrior',
        appearance: { banner: 'ember' },
      })
    ).character;
  await api(c.ctx, 'POST', '/account/guide', { dismissed: true }).catch(() => undefined);
  const heroUrl = `/admin/accounts/${account.handle}/heroes/${character.id}`;
  await api(
    admin.ctx,
    'POST',
    `${heroUrl}/level`,
    { level: 38, reason: 'awakening screenshots' },
    randomUUID(),
  );
  return { ...c, character, heroUrl };
}

/**
 * Restocks the hero for one viewport: the price of one awakening, a fresh +10 Legendary longsword
 * (worn), a +10 Drowned Vigil helm, an awakened Void hauberk (worn) and Prismatic ring (granted
 * awakened with the grant tool), and +8 gauntlets (worn; not eligible).
 */
async function restock(hero, admin) {
  const reason = { reason: 'awakening screenshots' };
  await api(
    admin.ctx,
    'POST',
    `${hero.heroUrl}/gold`,
    { mode: 'grant', amount: 30_000, ...reason },
    randomUUID(),
  );
  await api(
    admin.ctx,
    'POST',
    `${hero.heroUrl}/materials`,
    {
      mode: 'grant',
      materials: { tyrantsEmber: 3, gravewardenSeal: 2, soulShard: 30 },
      ...reason,
    },
    randomUUID(),
  );
  const granted = [];
  for (const spec of [
    { baseId: 'longsword', rarityId: 'legendary', itemLevel: 37, variant: null, upgradeLevel: 10 },
    { baseId: 'vigil-helm', rarityId: 'legendary', itemLevel: 37, variant: null, upgradeLevel: 10 },
    {
      baseId: 'vigil-hauberk',
      rarityId: 'legendary',
      itemLevel: 37,
      variant: 'void',
      upgradeLevel: 10,
      awakened: true,
    },
    {
      baseId: 'iron-ring',
      rarityId: 'legendary',
      itemLevel: 37,
      variant: 'prismatic',
      upgradeLevel: 10,
      awakened: true,
    },
    {
      baseId: 'vigil-gauntlets',
      rarityId: 'legendary',
      itemLevel: 37,
      variant: null,
      upgradeLevel: 8,
    },
  ]) {
    const { seed } = await api(admin.ctx, 'POST', `${hero.heroUrl}/items/preview`, spec);
    const { item } = await api(
      admin.ctx,
      'POST',
      `${hero.heroUrl}/items/grant`,
      { ...spec, seed, ...reason },
      randomUUID(),
    );
    granted.push(item);
  }
  for (const [i, slot] of [
    [0, 'weapon'],
    [2, 'chest'],
    [4, 'hands'],
  ]) {
    await api(hero.ctx, 'POST', `/characters/${hero.character.id}/items/${granted[i].id}/equip`, {
      slot,
    });
  }
}

async function openForge(page) {
  await page.goto(`${baseUrl}/#/forge`, { waitUntil: 'networkidle' });
  const panel = page.locator('section[aria-labelledby="awaken-title"]');
  await panel.waitFor();
  await panel.scrollIntoViewIfNeeded();
  return panel;
}

mkdirSync(outDir, { recursive: true });
const browser = await playwright.chromium.launch();
try {
  const admin = await context(browser, VIEWPORTS[0]);
  await api(admin.ctx, 'POST', '/auth/login', { email: ADMIN, password: PASSWORD });
  let n = 0;
  for (const vp of VIEWPORTS) {
    n++;
    const hero = await setupHero(browser, vp, admin);
    await restock(hero, admin);
    const { page } = hero;
    let panel = await openForge(page);
    await panel.getByText('Ready to awaken').waitFor();
    await panel.locator('.awaken__compare').waitFor();
    await shoot(page, vp, 'ready', panel);

    // The full confirm.
    await panel.getByRole('button', { name: 'Awaken…' }).click();
    await panel.locator('.awaken__confirm').waitFor();
    await shoot(page, vp, 'confirm', panel);

    // Awaken it: the notice, the awakened list, and the set piece's quote (now short of Embers).
    await panel.getByRole('button', { name: /Awaken it/ }).click();
    await page.getByText(/is awakened/).waitFor();
    panel = page.locator('section[aria-labelledby="awaken-title"]');
    await panel
      .getByRole('list', { name: 'Items ready to awaken' })
      .getByRole('button', { name: /helm/i })
      .first()
      .click();
    await panel.locator('.awaken__set').waitFor();
    await page
      .locator('.notice, [role="status"]')
      .first()
      .scrollIntoViewIfNeeded()
      .catch(() => undefined);
    await shoot(page, vp, 'done');
    await panel.scrollIntoViewIfNeeded();
    await shoot(page, vp, 'set-short', panel);

    // The awakened sword's tooltip at the Anvil (its effect × 1.1 and the binding line).
    const anvil = page.locator('section[aria-labelledby="anvil-title"]');
    await anvil.scrollIntoViewIfNeeded();
    await anvil
      .getByRole('button', { name: /awakened legendary/ })
      .first()
      .click();
    const tip = anvil.locator('.forge-work__item .tooltip');
    await tip.locator('.tooltip__unique--awakened').waitFor();
    await shoot(page, vp, 'tooltip', tip);
    await hero.ctx.close();

    // A hero with nothing to awaken: the empty state.
    const plain = await context(browser, vp);
    await api(plain.ctx, 'POST', '/auth/register', {
      email: `awaken-empty-${vp.name}-${Date.now()}@graumark.test`,
      displayName: `Mara Quill ${vp.name === 'mobile' ? 'II' : 'I'}`,
      password: PASSWORD,
    });
    await api(plain.ctx, 'POST', '/characters', {
      name: `Maraquill${'ab'[n - 1]}`,
      classId: 'hunter',
      appearance: { banner: 'ash' },
    });
    await api(plain.ctx, 'POST', '/account/guide', { dismissed: true }).catch(() => undefined);
    const empty = await openForge(plain.page);
    await empty.getByText('No item is ready to awaken.').waitFor();
    await shoot(plain.page, vp, 'empty', empty);
    await plain.ctx.close();

    // The admin gallery's Variants table (frozen until Play under automation).
    const gal = await context(browser, vp);
    await api(gal.ctx, 'POST', '/auth/login', { email: ADMIN, password: PASSWORD });
    const { characters } = await api(gal.ctx, 'GET', '/characters');
    if (characters.length === 0) {
      await api(gal.ctx, 'POST', '/characters', {
        name: 'Ysolde',
        classId: 'warrior',
        appearance: { banner: 'dusk' },
      });
    }
    await api(gal.ctx, 'POST', '/account/guide', { dismissed: true }).catch(() => undefined);
    await gal.page.goto(`${baseUrl}/#/admin/animations`, { waitUntil: 'networkidle' });
    const variants = gal.page.locator('section[aria-label="Variants"]');
    await variants.waitFor();
    await variants.scrollIntoViewIfNeeded();
    await shoot(gal.page, vp, 'gallery', variants);
    await gal.ctx.close();
  }
} finally {
  await browser.close();
}
