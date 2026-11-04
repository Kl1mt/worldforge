// Phase 1 exit-criteria run (tickets 1.8, 1.9) against the real server and UI, at desktop (1440)
// and mobile (390): register → create character → farm → get loot → equip → log out → (time
// passes) → log in → offline return summary. CI runs it on every PR (job `e2e`).
// Saves screenshots of the live screens to docs/screenshots/phase-1/ and fails (exit 1) when a
// step does not happen.
//
// Needs the e2e test server and the web dev server (see docs/TECH_STACK.md, "End-to-end run"):
//   OFFLINE_CAP_SECONDS=1800 pnpm --filter @worldforge/server e2e:serve   # PGlite, clock ×120
//   pnpm --filter @worldforge/web dev
//   node tools/e2e/farm-loop.mjs [baseUrl] [outDir]
//
// Loot shows up quickly only because the e2e server's farming clock runs fast (server-side);
// the client sends nothing but intents.
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
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-1');
/** Real seconds away before returning. With the ×120 clock that is ~50 minutes of game time. */
const AWAY_SECONDS = Number(process.env.E2E_AWAY_SECONDS ?? 25);
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, hero: 'Edric', className: 'Warrior' },
  { name: 'mobile', width: 390, height: 844, hero: 'Isolde', className: 'Mage' },
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
  // Grow the viewport to the page height instead of `fullPage`, so the fixed mobile bottom bar
  // stays at the bottom of the picture (same approach as tools/screenshots/).
  const height = full ? await page.evaluate(() => document.documentElement.scrollHeight) : 0;
  if (full) await page.setViewportSize({ width: vp.width, height: Math.max(vp.height, height) });
  const file = `${outDir}/${name}-${vp.name}.png`;
  await page.screenshot({ path: file });
  if (full) await page.setViewportSize({ width: vp.width, height: vp.height });
  console.log(`saved ${file}`);
}

async function run(browser, vp) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.on('pageerror', (err) => console.error(`! page error @ ${vp.name}: ${err.message}`));
  const stamp = `${vp.name}${Date.now()}`;
  const email = `${stamp}@graumark.test`;

  // 1. Register.
  step(vp, 'register');
  await page.goto(`${baseUrl}/#/register`, { waitUntil: 'networkidle' });
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Display name').fill(`Reeve ${String(Date.now()).slice(-6)}`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();

  // 2. Create a character (first hero: the guard opens creation).
  step(vp, 'create character');
  await page.getByRole('heading', { name: 'Forge your first hero' }).waitFor();
  await page.getByLabel('Name', { exact: true }).fill(vp.hero);
  await page.getByRole('radio', { name: new RegExp(`^${vp.className}`) }).check({ force: true });
  await page.getByRole('button', { name: 'Forge hero' }).click();
  // The hub is home (ticket 2.2); the area screen shows the Abandoned Fields until the hero travels.
  await page.waitForURL(/#\/hub/);
  await page.goto(`${baseUrl}/#/area`);
  await page.getByRole('button', { name: 'Farm Abandoned Fields' }).waitFor();
  await shoot(page, vp, 'area-idle');

  await page.goto(`${baseUrl}/#/inventory`);
  await page.getByText('Your pack is empty.').waitFor();
  await shoot(page, vp, 'inventory-empty', { full: false });

  // 3. Farm.
  step(vp, 'farm');
  await page.goto(`${baseUrl}/#/area`);
  await page.getByRole('button', { name: 'Farm Abandoned Fields' }).click();
  await page.getByRole('button', { name: new RegExp(`^Call ${vp.hero} back`) }).waitFor();

  // 4. Loot arrives through the settle poll (server time only).
  step(vp, 'wait for loot');
  await page.locator('.log__loot').first().waitFor({ timeout: 60_000 });
  await page.locator('.spoils__list li').first().waitFor();
  await page.waitForTimeout(500);
  await shoot(page, vp, 'area-farming');

  // 5. Equip an item the class can use, after reading the comparison.
  step(vp, 'equip');
  await page.goto(`${baseUrl}/#/inventory`);
  const sockets = page.locator('.stash__grid button.item-frame');
  await sockets.first().waitFor();
  const equipButton = page.getByRole('button', { name: 'Equip', exact: true });
  let picked = null;
  const count = await sockets.count();
  for (let i = 0; i < count; i++) {
    await sockets.nth(i).click();
    if (await equipButton.isEnabled()) {
      picked = await sockets.nth(i).getAttribute('aria-label');
      break;
    }
  }
  if (!picked) throw new Error(`no usable item among ${count} drops`);
  await page.locator('.tooltip__compare').first().waitFor();
  await shoot(page, vp, 'inventory-compare');
  await equipButton.click();
  await page.locator('.pack__notice--ok').waitFor();
  const notice = await page.locator('.pack__notice--ok').innerText();
  step(vp, `equipped: ${notice}`);
  await shoot(page, vp, 'inventory-equipped');

  await page.goto(`${baseUrl}/#/character`);
  const filledSlots = page.locator('.doll .slot:not(.slot--empty)');
  await filledSlots.first().waitFor();
  await filledSlots.first().locator('button').click();
  await page.getByRole('button', { name: 'Unequip' }).waitFor();
  await shoot(page, vp, 'character-equipped');

  // 6. Leave: log out (the session is revoked server-side), then come back later and log in.
  step(vp, 'log out');
  await page.goto(`${baseUrl}/#/area`);
  await page.getByRole('button', { name: 'Log out' }).click();
  await page.getByRole('heading', { name: 'Return to the Graumark' }).waitFor();
  const me = await context.request.get(`${baseUrl}/api/account`);
  if (me.status() !== 401) throw new Error(`still logged in after logout: ${me.status()}`);
  await page.close();

  step(vp, `away for ${AWAY_SECONDS}s`);
  await new Promise((r) => setTimeout(r, AWAY_SECONDS * 1000));
  const back = await context.newPage();
  back.on('pageerror', (err) => console.error(`! page error @ ${vp.name}: ${err.message}`));
  step(vp, 'log in');
  await back.goto(`${baseUrl}/#/login`, { waitUntil: 'networkidle' });
  await back.getByLabel('Email').fill(email);
  await back.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await back.getByRole('button', { name: 'Enter', exact: true }).click();
  await back.waitForURL(/#\/(hub|area|characters)/);
  if (!/#\/area/.test(back.url())) await back.goto(`${baseUrl}/#/area`);

  // 7. The offline return summary: valid, capped progress from server time.
  const dialog = back.getByRole('dialog', { name: `${vp.hero} kept the fields` });
  await dialog.waitFor({ timeout: 20_000 });
  const kills = Number(
    (await dialog.locator('.return__tally dd').first().innerText()).replace(/\D/g, ''),
  );
  if (!(kills > 0)) throw new Error('return summary shows no kills');
  const notes = await dialog.locator('.return__notes').innerText();
  step(vp, `return summary: ${kills} kills; ${notes.replace(/\s+/g, ' ').trim()}`);
  await back.waitForTimeout(300);
  await shoot(back, vp, 'return-summary', { full: false });

  await dialog.getByRole('button', { name: 'Back to the fields' }).click();
  await dialog.waitFor({ state: 'hidden' });
  await context.close();
}

mkdirSync(outDir, { recursive: true });
const browser = await playwright.chromium.launch();
let failed = false;
try {
  for (const vp of VIEWPORTS) {
    try {
      await run(browser, vp);
      step(vp, 'PASS');
    } catch (err) {
      failed = true;
      console.error(`[${vp.name}] FAIL: ${err.message}`);
    }
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
