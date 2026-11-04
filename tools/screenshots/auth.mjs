// Captures the ticket 1.2 gate screens (login, register) at desktop (1440) and mobile (390)
// widths, plus each form's error state. Needs `pnpm dev` with a migrated database.
//   node tools/screenshots/auth.mjs [baseUrl] [outDir]
// Uses the Playwright that ships with the environment (`require('playwright')`).
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
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

async function shoot(page, vp, name) {
  await page.evaluate(() => document.fonts.ready);
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

mkdirSync(outDir, { recursive: true });
const browser = await playwright.chromium.launch();
try {
  for (const vp of VIEWPORTS) {
    // A fresh context per viewport: no session cookie, so the gate is shown.
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    await page.goto(`${baseUrl}/#/login`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Return to the Graumark' }).waitFor();
    await shoot(page, vp, 'login');

    await page.getByLabel('Email').fill('nobody@graumark.test');
    await page.getByLabel('Password', { exact: true }).fill('not-the-password');
    await page.getByRole('button', { name: 'Enter', exact: true }).click();
    await page.getByRole('alert').waitFor();
    await shoot(page, vp, 'login-error');

    await page.goto(`${baseUrl}/#/register`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Sign the ledger' }).waitFor();
    await shoot(page, vp, 'register');

    await page.getByLabel('Email').fill('not-an-email');
    await page.getByLabel('Display name').fill('Ed');
    await page.getByLabel('Password', { exact: true }).fill('short');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByRole('alert').waitFor();
    await shoot(page, vp, 'register-error');

    await context.close();
  }
} finally {
  await browser.close();
}
