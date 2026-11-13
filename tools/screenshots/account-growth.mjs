// Captures ticket 9.4 at desktop (1440) and mobile (390): the account page's "Muster & vigil"
// (slots and offline hours: a fresh account, and one with deeds earned) and the hero list with its
// locked slot. The deeds are earned through the admin progress tools on the seeded test account,
// the same hook a settlement or a crypt claim runs.
// Needs the e2e server with a seeded admin and test account, and the web dev server:
//   E2E_SEED_ADMIN=castellan@graumark.test E2E_SEED_TEST_ACCOUNT=probe@graumark.test \
//     pnpm --filter @worldforge/server e2e:serve
//   pnpm --filter @worldforge/web dev
//   node tools/screenshots/account-growth.mjs [baseUrl] [outDir]
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
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-9');
const PASSWORD = 'ashes-and-iron-42';
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

async function shoot(page, name, vp) {
  await page.evaluate(() => document.fonts.ready);
  const file = `${outDir}/account-growth-${name}-${vp.name}.png`;
  await page.screenshot({ path: file, fullPage: true });
  console.log(`saved ${file}`);
}

async function context(browser, vp) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
  });
  return { ctx, page: await ctx.newPage() };
}

mkdirSync(outDir, { recursive: true });
const browser = await playwright.chromium.launch();
try {
  // The test account: one hero raised to 28 with the crypt's first tier (3rd slot, two deeds),
  // then two more heroes to fill every slot, so the hero list shows the locked 4th.
  const probe = await context(browser, VIEWPORTS[0]);
  await api(probe.ctx, 'POST', '/auth/login', { email: 'probe@graumark.test', password: PASSWORD });
  await api(probe.ctx, 'POST', '/account/guide', { dismissed: true }).catch(() => undefined);
  const { account } = await api(probe.ctx, 'GET', '/account');
  const { character } = await api(probe.ctx, 'POST', '/characters', {
    name: 'Probewyn',
    classId: 'warrior',
    appearance: { banner: 'ember' },
  });
  const admin = await context(browser, VIEWPORTS[0]);
  await api(admin.ctx, 'POST', '/auth/login', {
    email: 'castellan@graumark.test',
    password: PASSWORD,
  });
  const heroUrl = `/admin/accounts/${account.handle}/heroes/${character.id}`;
  await api(admin.ctx, 'POST', `${heroUrl}/level`, { level: 28, reason: 'slots' }, randomUUID());
  await api(
    admin.ctx,
    'POST',
    `${heroUrl}/progress`,
    {
      gravewardenDefeated: true,
      cryptTierCleared: 1,
      ashenWardenDefeated: false,
      reason: 'deeds',
    },
    randomUUID(),
  );
  for (const [name, classId, banner] of [
    ['Probeline', 'mage', 'ash'],
    ['Probeholt', 'hunter', 'moss'],
  ]) {
    await api(probe.ctx, 'POST', '/characters', { name, classId, appearance: { banner } });
  }
  await api(probe.ctx, 'POST', `/characters/${character.id}/select`);

  for (const vp of VIEWPORTS) {
    // The grown account.
    const { ctx, page } = await context(browser, vp);
    await api(ctx, 'POST', '/auth/login', { email: 'probe@graumark.test', password: PASSWORD });
    await page.goto(`${baseUrl}/#/account`);
    await page.getByText('Muster & vigil').waitFor();
    await page.getByText('Hours away').waitFor();
    await page.locator('.muster-ledger').scrollIntoViewIfNeeded();
    await shoot(page, 'earned', vp);
    await page.goto(`${baseUrl}/#/characters`);
    await page.getByText('Locked slot', { exact: true }).waitFor();
    await shoot(page, 'hero-list', vp);
    await ctx.close();

    // A fresh account: two slots, 3 hours, what comes next.
    const fresh = await context(browser, vp);
    await api(fresh.ctx, 'POST', '/auth/register', {
      email: `fresh-${vp.name}-${Date.now()}@graumark.test`,
      displayName: vp.name === 'desktop' ? 'Ada Wren' : 'Ada Quill',
      password: PASSWORD,
    });
    await api(fresh.ctx, 'POST', '/account/guide', { dismissed: true }).catch(() => undefined);
    await api(fresh.ctx, 'POST', '/characters', {
      name: vp.name === 'desktop' ? 'Adawren' : 'Adaquill',
      classId: 'warlock',
      appearance: { banner: 'ash' },
    });
    await fresh.page.goto(`${baseUrl}/#/account`);
    await fresh.page.getByText('Hours away').waitFor();
    await shoot(fresh.page, 'fresh', vp);
    await fresh.ctx.close();
  }
} finally {
  await browser.close();
}
