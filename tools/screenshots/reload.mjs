// Captures the ticket F.4 reload hint at desktop (1440) and mobile (390) widths: the herald slip
// when the server runs a newer version than the open tab ("Graumark has changed: v… is out"),
// and the slip after a part of the build failed to load. A made-up player registers and hides
// the first-steps guide (the hint waits for it); the only thing faked is the version in the
// health answer (a pretend deploy) and the failed load (Vite's `vite:preloadError` event).
// Against a local server only (`pnpm playtest`, or `e2e:serve` plus the web dev server).
//   node tools/screenshots/reload.mjs [baseUrl] [outDir]
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
    email: `gate${run}@graumark.test`,
    displayName: `Wat Fenner ${tag}`,
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
const notesKey = `wf.seen.notes.${account.id}`;

// A pretend deploy: the server answers with the next patch number.
const [maj, min, pat] = (await (await req.get('/api/health')).json()).version
  .split('.')
  .map(Number);
const NEXT = `${maj}.${min}.${pat + 1}`;

const browser = await playwright.chromium.launch();
try {
  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
      storageState,
    });
    const page = await context.newPage();
    const save = async (name) => {
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => window.scrollTo(0, 0));
      // The slip slides in; take the picture once it has settled.
      await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
      const file = `${outDir}/${name}-${vp.name}.png`;
      await page.screenshot({ path: file });
      console.log(`saved ${file}`);
    };

    // 1. The tab's build is current: no hint. The notes count as read (no "New in v…" slip).
    await page.goto(`${baseUrl}/#/hub`, { waitUntil: 'networkidle' });
    await page.evaluate(
      ([k]) => {
        window.localStorage.setItem(k, '99.0.0');
        window.localStorage.removeItem('wf.reload.later');
      },
      [notesKey],
    );

    // 2. A newer version went live: the hint, with Reload and Later.
    await page.route('**/api/health', async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), version: NEXT } });
    });
    await page.reload({ waitUntil: 'networkidle' });
    const slip = page.locator('.notice--reload');
    await slip.waitFor();
    await save('reload-hint');

    // 3. Later: gone, and still gone after a reload (kept for that version).
    await slip.getByRole('button', { name: 'Later' }).click();
    await slip.waitFor({ state: 'detached' });
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.statusbar .health--ok').waitFor();
    if ((await page.locator('.notice--reload').count()) !== 0)
      throw new Error('Later did not hold');

    // 4. A part of the old build fails to load: the hint returns, whatever "Later" said.
    await page.evaluate(() => window.dispatchEvent(new Event('vite:preloadError')));
    await slip.waitFor();
    await save('reload-hint-failed-load');
    await context.close();
  }
} finally {
  await browser.close();
  await req.dispose();
}
