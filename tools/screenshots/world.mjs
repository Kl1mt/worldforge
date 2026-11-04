// Captures the ticket 2.2 screens at desktop (1440) and mobile (390): the hub, the world map (new
// hero, then later with more areas open and a deferred switch), a building placeholder, and two
// areas (Abandoned Fields, then Old Burial Grounds after travelling there from the map).
// Needs the e2e server with a fast farming clock (levels come quickly) and the web dev server:
//   E2E_TIME_SCALE=600 OFFLINE_CAP_SECONDS=36000 pnpm --filter @worldforge/server e2e:serve
//   pnpm --filter @worldforge/web dev
//   node tools/screenshots/world.mjs [baseUrl] [outDir]
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
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-2');
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, hero: 'Wulfric', className: 'Warrior' },
  { name: 'mobile', width: 390, height: 844, hero: 'Hesper', className: 'Hunter' },
];
const PASSWORD = 'ashes-and-iron-42';
const step = (vp, text) => console.log(`[${vp.name}] ${text}`);

async function shoot(page, vp, name) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() =>
    Promise.all([...document.images].map((img) => img.decode().catch(() => undefined))),
  );
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  if (overflow) console.warn(`! horizontal overflow on ${name} @ ${vp.name}`);
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: vp.width, height: Math.max(vp.height, height) });
  const file = `${outDir}/${name}-${vp.name}.png`;
  await page.screenshot({ path: file });
  await page.setViewportSize({ width: vp.width, height: vp.height });
  console.log(`saved ${file}`);
}

/** The active character's level and activity, read from the API (as the page's session). */
async function state(page) {
  return page.evaluate(async () => {
    const roster = await (await fetch('/api/characters')).json();
    const hero = roster.characters.find((c) => c.id === roster.activeCharacterId);
    const act = await (await fetch(`/api/characters/${hero.id}/activity`)).json();
    return { level: hero.level, activity: act.activity };
  });
}

async function waitFor(page, predicate, timeoutMs, what) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const s = await state(page);
    if (predicate(s)) return s;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(s)}`);
    await page.waitForTimeout(2_000);
  }
}

/** Selects a place in the map ledger (the accessible control) and returns its detail panel. */
async function pick(page, name) {
  await page.getByRole('button', { name: new RegExp(`^${name}`) }).click();
}

async function run(browser, vp) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.on('pageerror', (err) => console.error(`! page error @ ${vp.name}: ${err.message}`));
  const tag = `${Date.now().toString(36)}${vp.name[0]}`;

  step(vp, 'register and forge a hero');
  await page.goto(`${baseUrl}/#/register`, { waitUntil: 'networkidle' });
  await page.getByLabel('Email').fill(`world-${tag}@graumark.test`);
  await page.getByLabel('Display name').fill(`Mapper ${String(Date.now()).slice(-6)}`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('heading', { name: 'Forge your first hero' }).waitFor();
  await page.getByLabel('Name', { exact: true }).fill(vp.hero);
  await page.getByRole('radio', { name: new RegExp(`^${vp.className}`) }).check({ force: true });
  await page.getByRole('button', { name: 'Forge hero' }).click();
  await page.waitForURL(/#\/hub/);
  await page.getByRole('heading', { name: 'Graumark' }).waitFor();
  await shoot(page, vp, 'hub');

  if (vp.name === 'desktop') {
    // Keyboard focus (Tab) so the focus-visible frame shows on the Tavern hotspot.
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Tab');
      const label = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
      if (label?.startsWith('Tavern')) break;
    }
    await shoot(page, vp, 'hub-focus');
    await page.getByRole('link', { name: /^Tavern/ }).click();
    await page.getByRole('heading', { name: 'The Tavern' }).waitFor();
    await shoot(page, vp, 'tavern');
  }

  step(vp, 'map: a new hero');
  await page.goto(`${baseUrl}/#/map`);
  await page.getByText('Lv 1–6').first().waitFor();
  await pick(page, 'Crowwood');
  await shoot(page, vp, 'map-new');

  step(vp, 'farm the Fields from the map');
  await pick(page, 'Abandoned Fields');
  await page.getByRole('button', { name: 'Farm Abandoned Fields' }).click();
  await page.waitForURL(/#\/area/);
  await waitFor(page, (s) => s.level >= 9, 240_000, 'level 9');
  await page.reload();
  await page.getByRole('heading', { name: 'Abandoned Fields', exact: true }).waitFor();
  await page.waitForTimeout(9_000); // a settle or two for the Chronicle
  const dlg = page.getByRole('dialog');
  if (await dlg.isVisible()) await page.keyboard.press('Escape');
  await shoot(page, vp, 'area-fields');

  step(vp, 'travel to the Old Burial Grounds');
  await page.goto(`${baseUrl}/#/map`);
  await pick(page, 'Old Burial Grounds');
  await page.getByRole('button', { name: 'Travel to Old Burial Grounds' }).click();
  await page.waitForURL(/#\/area/);
  const s = await state(page);
  if (s.activity?.pendingAreaId) {
    step(vp, 'switch deferred until the fight ends');
    await page.goto(`${baseUrl}/#/map`);
    await page.getByRole('status').filter({ hasText: 'then travelling to' }).waitFor();
    await shoot(page, vp, 'map-travelling');
    await page.goto(`${baseUrl}/#/area`);
  }
  await page
    .getByRole('heading', { name: 'Old Burial Grounds', exact: true })
    .waitFor({ timeout: 60_000 });
  await page.waitForTimeout(9_000);
  await shoot(page, vp, 'area-burial-grounds');

  step(vp, 'map: later');
  await page.goto(`${baseUrl}/#/map`);
  await pick(page, 'The Nameless Crypt');
  await shoot(page, vp, 'map');
  await context.close();
}

mkdirSync(outDir, { recursive: true });
const browser = await playwright.chromium.launch();
try {
  for (const vp of VIEWPORTS) await run(browser, vp);
} finally {
  await browser.close();
}
