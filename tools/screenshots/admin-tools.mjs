// Captures the ticket D.4 admin tools at desktop (1440) and mobile (390): the inspector on a test
// account (items, testing tools), the grant preview, the hero deletion confirmation, the read-only
// "view as player" sheet, a normal account (testing tools off) and the World tab.
// Needs the e2e server with a seeded admin and test account, and the web dev server:
//   E2E_SEED_ADMIN=castellan@graumark.test E2E_SEED_TEST_ACCOUNT=probe@graumark.test \
//     pnpm --filter @worldforge/server e2e:serve
//   pnpm --filter @worldforge/web dev
//   node tools/screenshots/admin-tools.mjs [baseUrl] [outDir]
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
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/deploy');
const PASSWORD = 'ashes-and-iron-42';
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

async function shoot(page, vp, name, { full = true } = {}) {
  // The patch-notes slip (a release notice) would cover the panel.
  await page.addStyleTag({ content: '.notices { display: none !important; }' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  if (overflow) console.warn(`! horizontal overflow on ${name} @ ${vp.name}`);
  const file = `${outDir}/admin-tools-${name}-${vp.name}.png`;
  await page.screenshot({ path: file, fullPage: full });
  console.log(`saved ${file}`);
}

async function api(ctx, method, path, data, key) {
  const res = await ctx.request.fetch(`${baseUrl}/api${path}`, {
    method,
    ...(data ? { data } : {}),
    headers: key ? { 'Idempotency-Key': key } : {},
  });
  if (!res.ok()) throw new Error(`${method} ${path}: ${res.status()} ${await res.text()}`);
  return res.status() === 204 ? null : res.json();
}

async function login(browser, email, hero, vp = VIEWPORTS[0], classId = 'warrior') {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (err) => console.error(`! page error @ ${vp.name}: ${err.message}`));
  await api(ctx, 'POST', '/auth/login', { email, password: PASSWORD });
  const { characters } = await api(ctx, 'GET', '/characters');
  let character = characters[0];
  if (!character && hero) {
    ({ character } = await api(ctx, 'POST', '/characters', {
      name: hero,
      classId,
      appearance: { banner: 'ember' },
    }));
  }
  await api(ctx, 'POST', '/account/guide', { dismissed: true }).catch(() => undefined);
  return { ctx, page, character };
}

async function setup(browser) {
  mkdirSync(outDir, { recursive: true });
  const probe = await login(browser, 'probe@graumark.test', 'Probewyn');
  const { account } = await api(probe.ctx, 'GET', '/account');
  // A normal player for the "testing tools are off" view.
  const plainCtx = await browser.newContext();
  const plain = await api(plainCtx, 'POST', '/auth/register', {
    email: `plain-${Date.now()}@graumark.test`,
    displayName: 'Mara Quill',
    password: PASSWORD,
  });
  await api(plainCtx, 'POST', '/characters', {
    name: 'Maraquill',
    classId: 'hunter',
    appearance: { banner: 'ash' },
  });
  const admin = await login(browser, 'castellan@graumark.test', 'Ysolde');
  const heroUrl = `/admin/accounts/${account.handle}/heroes/${probe.character.id}`;
  const r = (reason) => ({ reason });
  await api(
    admin.ctx,
    'POST',
    `${heroUrl}/level`,
    { level: 22, ...r('testing the Pass') },
    randomUUID(),
  );
  await api(
    admin.ctx,
    'POST',
    `${heroUrl}/gold`,
    { mode: 'grant', amount: 25_000, ...r('upgrade tests') },
    randomUUID(),
  );
  await api(
    admin.ctx,
    'POST',
    `${heroUrl}/materials`,
    { mode: 'grant', materials: { ironOre: 120, timber: 80 }, ...r('forge tests') },
    randomUUID(),
  );
  await api(
    admin.ctx,
    'POST',
    `${heroUrl}/progress`,
    {
      gravewardenDefeated: true,
      cryptTierCleared: 2,
      ashenWardenDefeated: false,
      ...r('open the Abbey'),
    },
    randomUUID(),
  );
  for (const spec of [
    { baseId: 'longsword', rarityId: 'legendary', itemLevel: 22, variant: 'void', upgradeLevel: 4 },
    { baseId: 'longsword', rarityId: 'epic', itemLevel: 20, variant: null, upgradeLevel: 0 },
  ]) {
    const { seed } = await api(admin.ctx, 'POST', `${heroUrl}/items/preview`, spec);
    await api(
      admin.ctx,
      'POST',
      `${heroUrl}/items/grant`,
      { ...spec, seed, ...r('item tests') },
      randomUUID(),
    );
  }
  return {
    admin,
    handle: account.handle,
    plainHandle: plain.account.handle,
    heroName: probe.character.name,
  };
}

const browser = await playwright.chromium.launch();
try {
  const s = await setup(browser);
  for (const vp of VIEWPORTS) {
    const { page } = await login(browser, 'castellan@graumark.test', 'Ysolde', vp);
    await page.goto(`${baseUrl}/#/admin/inspect/${s.handle}`);
    await page.getByRole('heading', { name: 'Probe Ansel' }).waitFor();
    await shoot(page, vp, 'inspector-test');

    // The grant preview.
    const preview = page.getByRole('button', { name: 'Preview', exact: true });
    await preview.scrollIntoViewIfNeeded();
    await preview.click();
    await page.getByText(/Preview · roll/).waitFor();
    await shoot(page, vp, 'grant-preview', { full: false });

    // The deletion confirmation (cancelled afterwards).
    await page.getByRole('button', { name: 'Delete hero…' }).first().click();
    const dialog = page.locator('dialog[open]');
    await dialog.waitFor();
    await dialog.getByRole('textbox').last().fill(s.heroName);
    await shoot(page, vp, 'delete-confirm', { full: false });
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'View as player (read-only)' }).first().click();
    await page.getByText(/Read-only view/).waitFor();
    await shoot(page, vp, 'view-as');

    await page.goto(`${baseUrl}/#/admin/inspect/${s.plainHandle}`);
    await page.getByRole('heading', { name: 'Mara Quill' }).waitFor();
    await shoot(page, vp, 'inspector-normal');

    await page.goto(`${baseUrl}/#/admin/world`);
    await page.getByText('ashenPassCleared').first().waitFor();
    await shoot(page, vp, 'world');
    await page.context().close();
  }
} finally {
  await browser.close();
}
