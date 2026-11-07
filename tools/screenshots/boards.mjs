// Captures the ticket 5.2 UI: the Roll of Renown (`#/boards`), at desktop (1440) and mobile (390)
// widths: a populated roll, a class filter, the report menu, and the empty, loading and error
// states. Everything shown is real server data: the script registers a handful of players with
// made-up fantasy names, each farms the Abandoned Fields for a few real seconds on the fast clock
// and wears what drops, and the server's own refresh and sweep put them on the rolls. One player
// hides their profile (listed by name, no link, no hero name). Only loading and error are faked
// (the board request is held, then answered 503).
// Needs `pnpm build` and `E2E_TIME_SCALE=3000 pnpm --filter @worldforge/server e2e:serve` and
// `pnpm --filter @worldforge/web dev`.
//   node tools/screenshots/boards.mjs [baseUrl] [outDir]
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
/** Hero names are letters only: the run stamp as letters keeps reruns unique. */
const tag = [...run].map((d) => 'abcdefghij'[Number(d)]).join('');

/** Made-up players: display name, hero, class, real seconds of farming. */
const CAST = [
  ['Ravenna Ashgrove', 'Sigrun', 'warrior', 14],
  ['Old Tobiah', 'Meriel', 'mage', 11],
  ['Corvin of the Fen', 'Halvard', 'hunter', 9],
  ['Brother Anselm', 'Esk', 'warlock', 7],
];

async function player(displayName, heroName, classId) {
  const req = await playwright.request.newContext({ baseURL: baseUrl });
  const reg = await req.post('/api/auth/register', {
    data: {
      email: `${heroName.toLowerCase()}${run}@graumark.test`,
      displayName: `${displayName}`,
      password: PASSWORD,
    },
  });
  if (!reg.ok()) throw new Error(`register ${displayName}: ${reg.status()} ${await reg.text()}`);
  const made = await req.post('/api/characters', {
    data: { name: `${heroName}${tag}`, classId, appearance: { banner: 'ember' } },
  });
  if (!made.ok()) throw new Error(`character ${heroName}: ${made.status()} ${await made.text()}`);
  const { character } = await made.json();
  const start = await req.post(`/api/characters/${character.id}/activity`, {
    data: { areaId: 'abandonedFields' },
  });
  if (!start.ok()) throw new Error(`farm ${heroName}: ${start.status()}`);
  return { req, character };
}

/** Settles and wears whatever fills an empty slot. */
async function settleAndEquip({ req, character }) {
  await req.post(`/api/characters/${character.id}/activity/settle`);
  const inv = await (await req.get(`/api/characters/${character.id}/inventory`)).json();
  const worn = new Set(inv.equipped.map((i) => i.equippedSlot));
  for (const item of inv.inventory) {
    const res = await req.post(`/api/characters/${character.id}/items/${item.id}/equip`, {
      data: {},
    });
    if (res.ok()) {
      const after = await res.json();
      for (const i of after.equipped) worn.add(i.equippedSlot);
    }
  }
}

async function shoot(page, vp, name, locator) {
  await page.evaluate(() => document.fonts.ready);
  const file = `${outDir}/${name}-${vp.name}.png`;
  await locator.screenshot({ path: file, style: '.bottombar { display: none !important; }' });
  console.log(`saved ${file}`);
}

mkdirSync(outDir, { recursive: true });

// 1. The town's players farm on the fast clock.
const cast = [];
for (const [displayName, heroName, classId] of CAST) {
  cast.push(await player(displayName, heroName, classId));
}
const longest = Math.max(...CAST.map((c) => c[3]));
for (let s = 1; s <= longest; s++) {
  await new Promise((r) => setTimeout(r, 1000));
  for (const [i, c] of CAST.entries()) {
    if (s === c[3]) {
      await settleAndEquip(cast[i]);
      await cast[i].req.post(`/api/characters/${cast[i].character.id}/activity/stop`);
    }
  }
}
// One player keeps their profile to themselves: listed by name, no link, no hero name.
const hidden = await cast[2].req.post('/api/account/profile', {
  data: { visibility: 'hidden', shown: [], showcaseCharacterId: null },
});
if (!hidden.ok()) throw new Error(`profile: ${hidden.status()} ${await hidden.text()}`);

const browser = await playwright.chromium.launch();
try {
  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
    });
    // One viewer for both widths (registration is limited to 5 an hour per address).
    if (vp.name === 'desktop') {
      const reg = await context.request.post(`${baseUrl}/api/auth/register`, {
        data: {
          email: `viewer${run}@graumark.test`,
          displayName: `Wynne Hollow ${tag}`,
          password: PASSWORD,
        },
      });
      if (!reg.ok()) throw new Error(`register failed: ${reg.status()}`);
      const made = await context.request.post(`${baseUrl}/api/characters`, {
        data: { name: `Isolde${tag}`, classId: 'mage', appearance: { banner: 'moss' } },
      });
      if (!made.ok()) throw new Error(`character failed: ${made.status()}`);
    } else {
      const login = await context.request.post(`${baseUrl}/api/auth/login`, {
        data: { email: `viewer${run}@graumark.test`, password: PASSWORD },
      });
      if (!login.ok()) throw new Error(`login failed: ${login.status()}`);
    }
    const page = await context.newPage();
    const section = page.locator('section.renown');

    // 2. The populated roll (real data).
    await page.goto(`${baseUrl}/#/boards/level`, { waitUntil: 'networkidle' });
    await section.locator('.renown__list').waitFor();
    await shoot(page, vp, 'boards-level', page.locator('main'));
    await page.goto(`${baseUrl}/#/boards/power?class=hunter`, { waitUntil: 'networkidle' });
    await section.locator('.renown__list').waitFor();
    await shoot(page, vp, 'boards-power-class', section);
    await page.goto(`${baseUrl}/#/boards/gearScore`, { waitUntil: 'networkidle' });
    await section.locator('.renown__list').waitFor();
    if (vp.name === 'desktop') {
      await section.locator('details.renown__measured > summary').click();
      await section.locator('details.renown__report > summary').first().click();
      await shoot(page, vp, 'boards-report', section);
    }

    // 3. Empty: a level bracket nobody has reached.
    await page.goto(`${baseUrl}/#/boards/pveProgress?bracket=30-plus`, {
      waitUntil: 'networkidle',
    });
    await section.locator('.renown__empty').waitFor();
    await shoot(page, vp, 'boards-empty', section);

    // 4. Loading and error (faked: held, then 503).
    await page.route('**/api/leaderboards/**', async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.fulfill({
        status: 503,
        json: {
          error: { code: 'unavailable', message: 'The server is busy. Try again in a moment.' },
        },
      });
    });
    await page.goto(`${baseUrl}/#/boards/power`);
    await page.reload();
    await section.locator('.renown__wait').waitFor();
    await shoot(page, vp, 'boards-loading', section);
    await section.getByRole('alert').waitFor();
    await shoot(page, vp, 'boards-error', section);
    await page.unroute('**/api/leaderboards/**');
    await context.close();
  }
} finally {
  await browser.close();
  for (const c of cast) await c.req.dispose();
}
