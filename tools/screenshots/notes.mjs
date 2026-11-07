// Captures the ticket F.3 UI at desktop (1440) and mobile (390) widths: the "New in v…" herald
// slip and the status bar's version tag for a player who last read the notes at 0.5.0, then the
// "What's new" screen (#/notes) with 0.5.1 and 0.5.2 marked new, and the status bar once read.
// A made-up player registers, hides the first-steps guide (the slip waits for it) and is told
// they last read 0.5.0 (the localStorage marker); everything else is the real game.
// Needs `pnpm build` and `pnpm --filter @worldforge/server e2e:serve` and
// `pnpm --filter @worldforge/web dev`.
//   node tools/screenshots/notes.mjs [baseUrl] [outDir]
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
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-5');
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];
const PASSWORD = 'ashes-and-iron-42';
const run = String(Date.now()).slice(-5);
const tag = [...run].map((d) => 'abcdefghij'[Number(d)]).join('');

mkdirSync(outDir, { recursive: true });

// One player for both widths.
const req = await playwright.request.newContext({ baseURL: baseUrl });
const reg = await req.post('/api/auth/register', {
  data: {
    email: `crier${run}@graumark.test`,
    displayName: `Maud Ashby ${tag}`,
    password: PASSWORD,
  },
});
if (!reg.ok()) throw new Error(`register: ${reg.status()} ${await reg.text()}`);
const made = await req.post('/api/characters', {
  data: { name: `Odo${tag}`, classId: 'warrior', appearance: { banner: 'ash' } },
});
if (!made.ok()) throw new Error(`character: ${made.status()} ${await made.text()}`);
const guide = await req.post('/api/account/guide', { data: { dismissed: true } });
if (!guide.ok()) throw new Error(`guide: ${guide.status()} ${await guide.text()}`);
const { account } = await (await req.get('/api/account')).json();
const storageState = await req.storageState();
const seenKey = `wf.seen.notes.${account.id}`;

const browser = await playwright.chromium.launch();
try {
  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
      storageState,
    });
    const page = await context.newPage();
    const save = async (name, target, opts = {}) => {
      await page.evaluate(() => document.fonts.ready);
      const file = `${outDir}/${name}-${vp.name}.png`;
      await target.screenshot({ path: file, ...opts });
      console.log(`saved ${file}`);
    };

    // 1. Unread: last read at 0.5.0.
    await page.goto(`${baseUrl}/#/hub`, { waitUntil: 'networkidle' });
    await page.evaluate(([k]) => window.localStorage.setItem(k, '0.5.0'), [seenKey]);
    await page.reload({ waitUntil: 'networkidle' });
    const slip = page.locator('.notice--release');
    await slip.waitFor();
    await page.locator('.proclaim-version .new-tag').waitFor();
    await slip.hover(); // holds the slip while the picture is taken
    await page.evaluate(() => window.scrollTo(0, 0));
    await save('notes-unread', page);

    // 2. The notes screen, opened from the slip.
    await slip.locator('.notice__link').click();
    await page.locator('.proclaim__sheet--new').first().waitFor();
    await page.mouse.move(0, 0);
    await save('notes', page, {
      fullPage: true,
      style: '.bottombar { display: none !important; }',
    });

    // 3. Read: the tag is gone from the status bar.
    await page.locator('.proclaim-version .new-tag').waitFor({ state: 'detached' });
    await save('notes-read-statusbar', page.locator('.statusbar'));
    await context.close();
  }
} finally {
  await browser.close();
  await req.dispose();
}
