// Captures the ticket 1.3 character screens (first-hero creation, its error state, the roster
// with a free slot, and the full roster) at desktop (1440) and mobile (390) widths.
// Needs `pnpm dev` with a migrated database. Each viewport registers a new account; the
// character names are fixed, so run it against a database where they are still free.
//   node tools/screenshots/characters.mjs [baseUrl] [outDir]
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
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, heroes: ['Edric', 'Isolde'] },
  { name: 'mobile', width: 390, height: 844, heroes: ['Maelis', 'Corvin'] },
];

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

async function forge(page, name, className, banner) {
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByRole('radio', { name: new RegExp(`^${className}`) }).check({ force: true });
  await page.getByRole('radio', { name: banner }).check({ force: true });
}

mkdirSync(outDir, { recursive: true });
const browser = await playwright.chromium.launch();
try {
  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
    });
    const stamp = `${vp.name}${Date.now()}`;
    const reg = await context.request.post(`${baseUrl}/api/auth/register`, {
      data: {
        email: `${stamp}@graumark.test`,
        displayName: `Muster ${String(Date.now()).slice(-6)}`,
        password: 'ashes-and-iron-42',
      },
    });
    if (!reg.ok()) throw new Error(`register failed: ${reg.status()}`);
    const page = await context.newPage();

    // No characters yet: the guard lands on character creation.
    await page.goto(`${baseUrl}/#/area`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Forge your first hero' }).waitFor();
    await forge(page, vp.heroes[0], 'Warrior', 'Ember');
    await page.getByLabel('Name', { exact: true }).fill('');
    await shoot(page, vp, 'character-create');

    await page.getByLabel('Name', { exact: true }).fill('Ed 9');
    await page.getByRole('button', { name: 'Forge hero' }).click();
    await page.locator('.field__error').waitFor();
    await shoot(page, vp, 'character-create-error');

    await forge(page, vp.heroes[0], 'Warrior', 'Ember');
    await page.getByRole('button', { name: 'Forge hero' }).click();
    await page.waitForURL(/#\/area/);
    await page.locator('.purse__gold').waitFor();

    await page.goto(`${baseUrl}/#/characters`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Choose your hero' }).waitFor();
    await shoot(page, vp, 'character-select');

    await page.getByRole('button', { name: 'Forge a hero' }).click();
    await forge(page, vp.heroes[1], 'Mage', 'Dusk');
    await shoot(page, vp, 'character-create-second');
    await page.getByRole('button', { name: 'Forge hero' }).click();
    await page.waitForURL(/#\/area/);
    await page.locator('.purse__gold').waitFor();

    await page.goto(`${baseUrl}/#/characters`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Choose your hero' }).waitFor();
    await shoot(page, vp, 'character-select-full');

    await context.close();
  }
} finally {
  await browser.close();
}
