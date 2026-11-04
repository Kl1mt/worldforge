// Captures the ticket 2.3 screens at desktop (1440) and mobile (390): the return summary with
// gathered materials, the Pack's materials tab and the professions panel on the character screen.
// Needs the e2e server with a fast farming clock and the web dev server:
//   E2E_TIME_SCALE=600 pnpm --filter @worldforge/server e2e:serve
//   pnpm --filter @worldforge/web dev
//   node tools/screenshots/materials.mjs [baseUrl] [outDir]
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
  { name: 'desktop', width: 1440, height: 900, hero: 'Osric', className: 'Warrior' },
  { name: 'mobile', width: 390, height: 844, hero: 'Maud', className: 'Hunter' },
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

/** The active character's materials and professions, read from the API (as the page's session). */
async function gathered(page) {
  return page.evaluate(async () => {
    const roster = await (await fetch('/api/characters')).json();
    const id = roster.activeCharacterId;
    return (await fetch(`/api/characters/${id}/materials`)).json();
  });
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
  await page.getByLabel('Email').fill(`mats-${tag}@graumark.test`);
  await page.getByLabel('Display name').fill(`Gatherer ${String(Date.now()).slice(-6)}`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('heading', { name: 'Forge your first hero' }).waitFor();
  await page.getByLabel('Name', { exact: true }).fill(vp.hero);
  await page.getByRole('radio', { name: new RegExp(`^${vp.className}`) }).check({ force: true });
  await page.getByRole('button', { name: 'Forge hero' }).click();
  await page.waitForURL(/#\/hub/);

  step(vp, 'pack before gathering (empty state)');
  await page.goto(`${baseUrl}/#/inventory`);
  await page.getByRole('tab', { name: /^Materials/ }).click();
  await page.getByText('No materials yet.').waitFor();
  if (vp.name === 'desktop') await shoot(page, vp, 'pack-materials-empty');

  step(vp, 'farm the Fields from the map');
  await page.goto(`${baseUrl}/#/map`);
  await page.getByRole('button', { name: /^Abandoned Fields/ }).click();
  await page.getByRole('button', { name: 'Farm Abandoned Fields' }).click();
  await page.waitForURL(/#\/area/);
  await page.waitForTimeout(20_000);

  step(vp, 'away for a while, then return');
  await page.goto('about:blank');
  await page.waitForTimeout(15_000);
  await page.goto(`${baseUrl}/#/area`);
  const dlg = page.getByRole('dialog');
  await dlg.getByText('Gathered').waitFor({ timeout: 30_000 });
  await shoot(page, vp, 'return-materials');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(9_000); // a settle for the Chronicle
  await shoot(page, vp, 'area-chronicle-materials');

  step(vp, 'materials tab');
  const g = await gathered(page);
  step(vp, `held: ${JSON.stringify(g.materials)}`);
  await page.goto(`${baseUrl}/#/inventory`);
  await page.getByRole('tab', { name: /^Materials/ }).click();
  await page.getByRole('list', { name: 'Materials held' }).waitFor();
  await shoot(page, vp, 'pack-materials');

  step(vp, 'professions panel');
  await page.goto(`${baseUrl}/#/character`);
  await page.getByRole('heading', { name: 'Professions' }).waitFor();
  await page.getByText('Woodcutting').first().waitFor();
  await shoot(page, vp, 'character-professions');
  await context.close();
}

mkdirSync(outDir, { recursive: true });
const browser = await playwright.chromium.launch();
try {
  for (const vp of VIEWPORTS) await run(browser, vp);
} finally {
  await browser.close();
}
