// Captures the Phase 0 visual prototype at desktop (1440) and mobile (390) widths.
// Usage: start the app (`pnpm dev`, or `pnpm --filter @worldforge/web preview`), then
//   node tools/screenshots/phase-0.mjs [baseUrl] [outDir]
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

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:5173';
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-0');
const SCREENS = ['area', 'character', 'inventory'];
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

mkdirSync(outDir, { recursive: true });
const browser = await playwright.chromium.launch();
try {
  for (const vp of VIEWPORTS) {
    const page = await browser.newPage({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
    });
    for (const screen of SCREENS) {
      await page.goto(`${baseUrl}/#/${screen}`, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      if (overflow) console.warn(`! horizontal overflow on ${screen} @ ${vp.name}`);
      // Grow the viewport to the full page so fixed bars (mobile nav) sit at the bottom.
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      await page.setViewportSize({ width: vp.width, height: Math.max(vp.height, height) });
      await page.evaluate(() => document.fonts.ready);
      const file = `${outDir}/${screen}-${vp.name}.png`;
      await page.screenshot({ path: file });
      await page.setViewportSize({ width: vp.width, height: vp.height });
      console.log(`saved ${file}`);
    }
    await page.close();
  }
} finally {
  await browser.close();
}
