// Captures the ticket 2.4 screens at desktop (1440) and mobile (390): the Tavern notice board for a
// new hero, the board with a story quest and a contract taken, the area screen's quest tracker,
// a quest ready to turn in, and the board after the payout.
// Needs the e2e server with a fast farming clock and the web dev server:
//   E2E_TIME_SCALE=600 OFFLINE_CAP_SECONDS=36000 pnpm --filter @worldforge/server e2e:serve
//   pnpm --filter @worldforge/web dev
//   node tools/screenshots/tavern.mjs [baseUrl] [outDir]
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
  { name: 'desktop', width: 1440, height: 900, hero: 'Aldous', className: 'Warrior' },
  { name: 'mobile', width: 390, height: 844, hero: 'Merewyn', className: 'Mage' },
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

/** The active character's quest board, read from the API (as the page's session). */
async function board(page) {
  return page.evaluate(async () => {
    const roster = await (await fetch('/api/characters')).json();
    return (await fetch(`/api/characters/${roster.activeCharacterId}/quests`)).json();
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
  await page.getByLabel('Email').fill(`tavern-${tag}@graumark.test`);
  await page.getByLabel('Display name').fill(`Tapster ${String(Date.now()).slice(-6)}`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('heading', { name: 'Forge your first hero' }).waitFor();
  await page.getByLabel('Name', { exact: true }).fill(vp.hero);
  await page.getByRole('radio', { name: new RegExp(`^${vp.className}`) }).check({ force: true });
  await page.getByRole('button', { name: 'Forge hero' }).click();
  await page.waitForURL(/#\/hub/);

  step(vp, 'the notice board');
  await page.goto(`${baseUrl}/#/tavern`);
  await page.getByRole('button', { name: 'Take the quest' }).waitFor();
  await shoot(page, vp, 'tavern-board');

  step(vp, 'take the story quest and a contract');
  await page.getByRole('button', { name: 'Take the quest' }).click();
  await page.getByRole('heading', { name: 'The Furrows of the Dead' }).waitFor();
  await page.getByRole('button', { name: 'Take contract' }).first().click();
  await page.getByText('Taken').first().waitFor();
  await shoot(page, vp, 'tavern-taken');

  step(vp, 'farm the Fields');
  await page.goto(`${baseUrl}/#/map`);
  await page.getByRole('button', { name: /^Abandoned Fields/ }).click();
  await page.getByRole('button', { name: 'Farm Abandoned Fields' }).click();
  await page.waitForURL(/#\/area/);
  await page.locator('.tracker__quest').first().waitFor();
  await page.waitForTimeout(12_000);
  await shoot(page, vp, 'area-tracker');

  step(vp, 'wait for the story quest to be ready');
  const until = Date.now() + 240_000;
  for (;;) {
    const b = await board(page);
    if (b.quests.some((q) => q.kind === 'story' && q.status === 'ready')) break;
    if (Date.now() > until) throw new Error('quest never got ready');
    await page.waitForTimeout(3_000);
  }
  await page.waitForTimeout(6_000);
  const dlg = page.getByRole('dialog');
  if (await dlg.isVisible()) await page.keyboard.press('Escape');
  await page.locator('.tracker__quest--ready').first().waitFor();
  await shoot(page, vp, 'area-tracker-ready');

  step(vp, 'turn in');
  await page.goto(`${baseUrl}/#/tavern`);
  await page.getByRole('button', { name: 'Turn in' }).first().waitFor();
  await shoot(page, vp, 'tavern-ready');
  await page.getByRole('button', { name: 'Turn in' }).first().click();
  await page.getByText('Paid out').waitFor();
  await shoot(page, vp, 'tavern-paid');
  await context.close();
}

mkdirSync(outDir, { recursive: true });
const browser = await playwright.chromium.launch();
try {
  for (const vp of VIEWPORTS) await run(browser, vp);
} finally {
  await browser.close();
}
