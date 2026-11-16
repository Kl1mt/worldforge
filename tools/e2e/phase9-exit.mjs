// Phase 9 exit run, browser half (ticket 9.6) against the real server and UI: the key Phase 9
// screens in a real browser. Every flow goes through the screens; the only shortcut is what the e2e
// server seeds at start with E2E_SEED_PHASE9=1 (apps/server/src/e2e/seed-phase9.ts): two accounts
// weeks of play would otherwise provide (Aud, a level-30 warlock on the default loadout; Torvald, a
// level-38 warrior whose Tyrant's Lesson is ready to turn in, whose account has earned its third
// slot and 8 offline hours, and who owns one companion with six free Shrine draws left).
//
// Desktop (1440) contexts, one per account, side by side:
// Aud
// 1. Skills (#/character): the warlock's Soul Fragments explained; Agony (damage over time) as the
//    class skill, Corruption and Soul Burn as the spenders and Malice as the passive, Loadout I
//    saved ("Your hero fights with this loadout"); a locked skill shows "Locked"; Loadout II (the default) put in force and Loadout I
//    again, each with "Fight with it".
// 2. The map: she sets out to farm Blackwater; the area's scene shows the resource bar.
// 3. The arena (#/arena): her defence saved (it keeps the loadout in force).
// Torvald
// 4. The account (#/account): "Muster & vigil": 3 slots, 1 filled; 8 hours away.
// 5. The muster roll (#/characters): a free slot and the locked fourth with its deed.
// 6. The Tavern (#/tavern): the masters' lessons; the Tyrant's Lesson turned in (a new skill).
// 7. Skills: Forgebreaker, the Tyrant's skill, set in slot 2 and saved.
// 8. The Shrine (#/shrine, from the hub's lit shrine): a draw revealed, the odds opened, no paid
//    draw offered.
// 9. The collection book's Companions: his companion shown; beside his hero in the area scene.
// Fails (exit 1) on a missing step, a page error or any 429. Logs in 2 times.
//
// Needs a fresh e2e server with the seed, and the web dev server:
//   E2E_SEED_PHASE9=1 pnpm --filter @worldforge/server e2e:serve
//   pnpm --filter @worldforge/web dev
//   node tools/e2e/phase9-exit.mjs [baseUrl] [outDir]
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
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-9');
const PASSWORD = 'ashes-and-iron-42';
const VP = { width: 1440, height: 900 };
// Seeded at server start (seed-phase9.ts).
const AUD = 'p9-aud@graumark.test';
const TORVALD = 'p9-torvald@graumark.test';
const T = 20_000;

const started = Date.now();
const log = (who, text) =>
  console.log(`[p9 ${((Date.now() - started) / 1000).toFixed(0)}s] ${who}: ${text}`);
const problems = [];
const check = (ok, what) => {
  if (!ok) throw new Error(what);
};

async function shoot(page, name) {
  for (const close of await page.getByRole('button', { name: /^Dismiss: / }).all()) {
    await close.click({ timeout: 2_000 }).catch(() => undefined);
  }
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() =>
    Promise.all([...document.images].map((img) => img.decode().catch(() => undefined))),
  );
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  if (overflow) console.warn(`! horizontal overflow on ${name}`);
  const file = `${outDir}/${name}.png`;
  await page.screenshot({ path: file, fullPage: true });
  console.log(`saved ${file}`);
}

/** A fresh desktop context whose page fails the run on page errors and any 429. */
async function open(browser, label) {
  const context = await browser.newContext({ viewport: VP, deviceScaleFactor: 1 });
  context.setDefaultTimeout(T);
  const page = await context.newPage();
  // The return summary after time away: close it like a player would.
  await page.addLocatorHandler(page.locator('dialog.return'), async () => {
    await page.keyboard.press('Escape');
  });
  page.on('pageerror', (err) => problems.push(`page error @ ${label}: ${err.message}`));
  page.on('response', (res) => {
    if (res.status() === 429)
      problems.push(`429 @ ${label}: ${res.request().method()} ${res.url()}`);
  });
  return { context, page };
}

async function go(page, hash) {
  await page.goto(`${baseUrl}/${hash}`);
}

async function login(page, email) {
  await page.goto(`${baseUrl}/#/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Enter', exact: true }).click();
  await page.waitForURL(/#\/hub/);
}

/** One skill's row in the Skills book. */
const skillRow = (page, name) =>
  page.locator('.skills__book li', {
    has: page.locator('.skill__name .display', { hasText: new RegExp(`^${name}$`) }),
  });

/** Picks a socket, then sets a skill into it from the book. */
async function place(page, socket, name, button) {
  await page.locator('.socket__pick', { hasText: socket }).click();
  await skillRow(page, name).getByRole('button', { name: button }).click();
  await page
    .locator('.socket__pick', { hasText: socket })
    .locator('.socket__name', { hasText: name })
    .waitFor();
}

/** Loadout tab n (1–3), and the same tab once it is the one in force. */
const tab = (page, n) => page.locator(`#skills-tab-${n}`);
const inForce = (page, n) => page.locator(`#skills-tab-${n}.skills__tab--force`);

/** Sets out to farm an area from the map. */
async function farm(page, place) {
  await go(page, '#/map');
  const ledger = page.locator('.ledger__list');
  await ledger.locator('.ledger__row', { hasText: place }).first().click();
  const button = page.getByRole('button', { name: new RegExp(`^(Farm|Travel to) ${place}$`) });
  if (await button.count()) await button.click();
  await go(page, '#/area');
  await page.locator('.scene__hero').waitFor();
}

// ---- Aud ---------------------------------------------------------------------------------------

async function audSkills(page) {
  const who = 'Aud';
  log(who, '1. Skills: Soul Fragments, Agony, the spenders and the passive: Loadout I');
  await go(page, '#/character');
  await page.locator('.skills__resource').waitFor();
  const res = (await page.locator('.skills__resource').innerText()).toLowerCase();
  check(res.includes('soul'), `the warlock's resource reads "${res}"`);
  await inForce(page, 1).waitFor();
  await place(page, 'Class skill (slot 1)', 'Agony', 'Set in slot 1');
  await place(page, 'Spender (slot 2)', 'Corruption', 'Set in slot 2');
  await place(page, 'Spender (slot 3)', 'Soul Burn', 'Set in slot 3');
  await place(page, 'Passive', 'Malice', 'Take as passive');
  // A skill above her level is shown, locked.
  check((await page.locator('.skill__lock').count()) > 0, 'no locked skill is shown at level 30');
  await page.getByRole('button', { name: 'Save Loadout I' }).click();
  await page.getByText('Your hero fights with this loadout.').waitFor();
  await shoot(page, 'p9-01-aud-loadout');

  log(who, '1. presets: Loadout II (the default) in force, then Loadout I again');
  await tab(page, 2).click();
  await page.getByRole('button', { name: 'Fight with it' }).click();
  await inForce(page, 2).waitFor();
  await tab(page, 1).click();
  await page
    .locator('.socket__pick', { hasText: 'Class skill (slot 1)' })
    .locator('.socket__name', { hasText: 'Agony' })
    .waitFor();
  await page.getByRole('button', { name: 'Fight with it' }).click();
  await inForce(page, 1).waitFor();
  await page.getByText('Your hero fights with this loadout.').waitFor();
}

async function audScene(page) {
  log('Aud', '2. she farms Blackwater; the scene shows her resource');
  await farm(page, 'Blackwater');
  await page.locator('.scene__resource').waitFor();
  await shoot(page, 'p9-02-aud-scene');
}

async function audDefence(page) {
  log('Aud', '3. the arena: her defence saved with the loadout in force');
  await go(page, '#/arena');
  await page.getByRole('button', { name: 'Save my defence' }).click();
  await page.getByRole('button', { name: 'Refresh my defence' }).waitFor();
  await shoot(page, 'p9-03-aud-defence');
}

// ---- Torvald -----------------------------------------------------------------------------------

async function torAccount(page) {
  const who = 'Torvald';
  log(who, '4. the account: three slots, one filled; 8 hours away');
  await go(page, '#/account');
  const ledger = page.locator('.muster-ledger');
  await ledger.getByText('Muster & vigil').waitFor();
  await ledger.getByText('3 slots, 1 filled.').waitFor();
  await ledger.getByText('8 hours', { exact: true }).first().waitFor();
  await ledger.scrollIntoViewIfNeeded();
  await shoot(page, 'p9-04-torvald-account');

  log(who, '5. the muster roll: a locked slot with its deed');
  await go(page, '#/characters');
  await page.getByText('Locked slot', { exact: true }).waitFor();
  await shoot(page, 'p9-05-torvald-muster');
}

async function torLesson(page) {
  const who = 'Torvald';
  log(who, '6. the Tavern: the Tyrant’s Lesson turned in');
  await go(page, '#/tavern');
  await page.getByText('The masters’ lessons').waitFor();
  await page.getByRole('heading', { name: 'The Tyrant’s Lesson' }).first().waitFor();
  await page.getByRole('button', { name: 'Turn in' }).first().click();
  await page.getByText('a new skill learned').waitFor();
  await page
    .getByText(/Learned · /)
    .first()
    .waitFor();
  await shoot(page, 'p9-06-torvald-lesson');

  log(who, '7. Skills: Forgebreaker in slot 2, saved');
  await go(page, '#/character');
  await inForce(page, 1).waitFor();
  await place(page, 'Spender (slot 2)', 'Forgebreaker', 'Set in slot 2');
  await page.getByRole('button', { name: 'Save Loadout I' }).click();
  await page.getByText('Your hero fights with this loadout.').waitFor();
  await page
    .getByRole('button', { name: 'Save Loadout I' })
    .and(page.locator('[disabled]'))
    .waitFor();
  await shoot(page, 'p9-07-torvald-skills');
}

async function torShrine(page) {
  const who = 'Torvald';
  log(who, '8. the Shrine from the hub: a draw revealed, the odds, no paid draws');
  await go(page, '#/hub');
  await page.locator('.hub__stage').waitFor();
  await go(page, '#/shrine');
  await page.locator('.shrine__draw').waitFor();
  check(
    (await page
      .getByRole('button', { name: /buy|purchase/i })
      .filter({ hasText: /draw/i })
      .count()) === 0,
    'the Shrine offers a paid draw',
  );
  await page.locator('.shrine__draw').click();
  await page.locator('.shrine-card').waitFor();
  await page.locator('.shrine__odds summary').click();
  await page.locator('.shrine__odds[open]').waitFor();
  await shoot(page, 'p9-08-torvald-shrine');

  log(who, '9. the book’s Companions: his companion shown, beside him in the scene');
  await go(page, '#/collection');
  await page.getByRole('button', { name: 'Companions' }).click();
  await page.locator('.book-card').first().waitFor();
  // The owned companions only (the seed's draw, and perhaps today's): one shown.
  await page.getByRole('button', { name: 'Earned', exact: true }).click();
  await page.locator('.book-card').first().click();
  await page.getByRole('button', { name: 'Show it' }).click();
  await page.getByRole('button', { name: 'Put it away' }).waitFor();
  await shoot(page, 'p9-09-torvald-book');
  await farm(page, 'Blackwater');
  await page.locator('.scene__companion').waitFor();
  await shoot(page, 'p9-10-torvald-companion');
}

mkdirSync(outDir, { recursive: true });
const browser = await playwright.chromium.launch();
let failed = null;
try {
  const aud = await open(browser, 'Aud');
  const tor = await open(browser, 'Torvald');
  await Promise.all([login(aud.page, AUD), login(tor.page, TORVALD)]);
  await Promise.all([
    (async () => {
      await audSkills(aud.page);
      await audScene(aud.page);
      await audDefence(aud.page);
    })(),
    (async () => {
      await torAccount(tor.page);
      await torLesson(tor.page);
      await torShrine(tor.page);
    })(),
  ]);
} catch (err) {
  failed = err;
} finally {
  await browser.close();
}
const seconds = ((Date.now() - started) / 1000).toFixed(0);
if (failed || problems.length) {
  if (failed) console.error(`FAIL: ${failed.message}`);
  for (const p of problems) console.error(`FAIL: ${p}`);
  console.error(`phase 9 exit run failed after ${seconds}s`);
  process.exit(1);
}
console.log(`phase 9 exit run passed in ${seconds}s`);
