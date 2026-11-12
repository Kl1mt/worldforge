// Phase 8 exit run, browser half (ticket 8.7) against the real server and UI: the key Phase 8
// screens in a real browser. Every flow goes through the screens; the only shortcut is the world
// the e2e server seeds at start with E2E_SEED_PHASE8=1 (apps/server/src/e2e/seed-phase8.ts): the
// town's works done (the Lantern Vigil), Season 1 under way, the guild "The Lantern Wardens" on the
// Guild Roll, and four accounts the owner and weeks of play would otherwise provide (Odric, a
// level-50 warrior in Marches Legendary +10 kit who leads the guild; Brynja, a level-46 hunter;
// Cass, a level-22 mage with a mixed pack and ready Tavern notices; Mira, an admin).
//
// Desktop (1440) contexts, one per account, side by side:
// Odric
// 1. Town: the era title (Era of the Lantern Vigil); the map: the Pale Marches and the Hollow Deep
//    open, and he sets out to farm the Deep; the Deep's scene is still under automation.
// 2. The Hollow Throne (#/throne): the door ("Before you descend"), he descends; later he claims
//    the reckoning (the Sovereign falls or keeps his throne).
// 3. The guild hall (#/treasury): a gift after ticking the no-refund line, the guild's name colour
//    bought for the hall and hung.
// 4. The Guild Roll (#/boards/guilds): the Wardens are listed with their parts.
// 5. Letters (#/inbox): the era's, a stage's and a drop's letters; the top bar's badge; mark all
//    read, and the badge goes.
// Cass
// 6. The Pack: search, the filters and the sort (fewer shown, the order by rarity).
// 7. Loot-filter presets: one kept, used, shared as a code; a code read back with its preview.
// 8. The Tavern: "Claim all" pays the ready notices at once.
// Brynja
// 9. The Throne's door is barred for her (Reach level 48) while the Deep is open on her map.
// Mira (admin)
// 10. The Events tab's automatic calendar: paused, turned on (with its confirmation), the next three
//     on Mondays at 00:00 UTC, paused again (as production keeps it).
// 11. The Readiness tab: every item with its state; a test letter sent to a typed address.
// Fails (exit 1) on a missing step, a page error or any 429. Logs in 4 times.
//
// Needs a fresh e2e server with the seed, and the web dev server:
//   E2E_SEED_PHASE8=1 pnpm --filter @worldforge/server e2e:serve
//   pnpm --filter @worldforge/web dev
//   node tools/e2e/phase8-exit.mjs [baseUrl] [outDir]
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
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-8');
const PASSWORD = 'ashes-and-iron-42';
const VP = { width: 1440, height: 900 };
// Seeded at server start (seed-phase8.ts).
const ODRIC = 'p8-odric@graumark.test';
const BRYNJA = 'p8-brynja@graumark.test';
const CASS = 'p8-cass@graumark.test';
const MIRA = 'p8-mira@graumark.test';
const ERA = 'Era of the Lantern Vigil';
const GUILD = 'The Lantern Wardens';

const started = Date.now();
const log = (who, text) =>
  console.log(`[p8 ${((Date.now() - started) / 1000).toFixed(0)}s] ${who}: ${text}`);
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

/** Animations running on the page (scenes, sprites, frames): none under automation. */
const running = (page) =>
  page.evaluate(
    () =>
      document
        .getAnimations()
        .filter((a) => a.playState === 'running' && a.effect?.getTiming().iterations === Infinity)
        .length,
  );

// ---- Odric -------------------------------------------------------------------------------------

async function townAndMap(page) {
  const who = 'Odric';
  log(who, '1. the town: the era title');
  await go(page, '#/hub');
  const era = page.locator('.hub-era__title');
  await era.waitFor();
  const eraText = (await era.innerText()).trim();
  check(eraText === ERA, `the town's era reads "${eraText}", not "${ERA}"`);
  await shoot(page, 'p8-01-town-era');

  log(who, '1. the map: the Pale Marches and the Hollow Deep open; he farms the Deep');
  await go(page, '#/map');
  const ledger = page.locator('.ledger__list');
  for (const place of ['The Pale Marches', 'The Hollow Deep', 'The Hollow Throne']) {
    await ledger
      .locator('.ledger__row', { hasText: place })
      .locator('.ledger__state', { hasText: /^(open|next|you are here)$/i })
      .waitFor();
  }
  await ledger.locator('.ledger__row', { hasText: 'The Hollow Deep' }).click();
  await page.getByRole('button', { name: /^(Farm|Travel to) The Hollow Deep$/ }).click();
  await page.waitForURL(/#\/area/);
  await page.getByRole('heading', { name: 'The Hollow Deep' }).first().waitFor();
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.ready)));
  const moving = await running(page);
  check(moving === 0, `the Deep's scene moves under automation (${moving} running)`);
  await shoot(page, 'p8-02-area-deep');
}

async function throneDoor(page) {
  const who = 'Odric';
  log(who, '2. the Hollow Throne: the door, then the descent');
  // He stops farming at the door's own button (a run never stacks with farming).
  await go(page, '#/throne');
  const door = page.locator('section.crypt-door');
  await door.getByRole('heading', { name: 'Before you descend' }).waitFor();
  await shoot(page, 'p8-03-throne-door');
  await door.getByRole('button', { name: 'Descend to the throne' }).click();
  await page.getByRole('heading', { name: /^(At the throne|The fighting has stopped)/ }).waitFor();
}

async function claimThrone(page) {
  const who = 'Odric';
  await go(page, '#/throne');
  const claim = page.getByRole('button', { name: 'Claim the spoils' });
  await claim.waitFor({ timeout: 90_000 });
  await claim.click();
  const verdict = page.getByRole('heading', {
    name: /The Hollow Sovereign falls|The Sovereign keeps his throne/,
  });
  await verdict.waitFor();
  log(who, `2. the reckoning: ${(await verdict.innerText()).trim()}`);
  await shoot(page, 'p8-04-throne-reckoning');
}

async function guildHall(page) {
  const who = 'Odric';
  log(who, '3. the guild hall: a gift (no refund, ticked), an upgrade bought and hung');
  await go(page, '#/treasury');
  const give = page.locator('.treasury__give');
  await give.waitFor();
  await page.getByLabel('How much').fill('12000');
  await page.getByLabel(/never given back/).check();
  await give.getByRole('button', { name: 'Give', exact: true }).click();
  await give.locator('.treasury__message--ok').waitFor();
  // The guild's name colour, 12,000 gold (the gift's whole sum).
  const ware = page.locator('.treasury__ware', { hasText: 'Forge-gold' });
  await ware.getByRole('button', { name: 'Buy for the hall' }).click();
  await ware.getByRole('button', { name: 'Hang it' }).click();
  await ware.getByRole('button', { name: 'Take down' }).waitFor();
  await shoot(page, 'p8-05-treasury');
  await go(page, '#/guild');
  await page.locator('.guildbanner').waitFor();
}

async function guildRoll(page) {
  const who = 'Odric';
  log(who, '4. the Guild Roll lists the Wardens');
  await go(page, '#/boards/guilds');
  await page.locator('.groll-list').getByText(GUILD).first().waitFor();
  await shoot(page, 'p8-06-guild-roll');
}

async function letters(page) {
  const who = 'Odric';
  log(who, '5. letters: the era, a stage and a drop; the badge; mark all read');
  await go(page, '#/inbox');
  await page.getByRole('heading', { name: 'Letters' }).waitFor();
  await page.getByText('A new era: The Lantern Vigil').first().waitFor();
  await page
    .getByText(/a stage is done/)
    .first()
    .waitFor();
  await page.getByText('A Legendary find').first().waitFor();
  const badge = page.locator('.purse__letters .new-tag');
  await badge.waitFor();
  await shoot(page, 'p8-07-letters');
  await page.getByRole('button', { name: 'Mark all read' }).click();
  await page.getByText(/^Everything read/).waitFor();
  await badge.waitFor({ state: 'detached' });
}

// ---- Cass --------------------------------------------------------------------------------------

async function pack(page) {
  const who = 'Cass';
  log(who, '6. the Pack: search, the filters, the sort');
  await go(page, '#/inventory');
  await page.getByRole('search').waitFor();
  const shown = async () => {
    const t = await page.getByText(/of \d+ shown/).innerText();
    return Number(t.match(/(\d+) of \d+ shown/)?.[1] ?? NaN);
  };
  await page.getByRole('button', { name: /^Filters/ }).click();
  await page.getByRole('combobox', { name: 'Sort' }).selectOption('rarity');
  await page.getByRole('combobox', { name: 'Lock' }).selectOption('yes');
  await page.getByText(/of \d+ shown/).waitFor();
  check((await shown()) === 2, `two locked items shown, not ${await shown()}`);
  await page.getByRole('combobox', { name: 'Lock' }).selectOption('any');
  await page.getByRole('searchbox').fill('legendary');
  await page.getByText(/1 of \d+ shown/).waitFor();
  await shoot(page, 'p8-08-pack-search');
  await page.getByRole('searchbox').fill('');
}

async function presets(page) {
  const who = 'Cass';
  log(who, '7. presets: keep, use, share; a code read back');
  await go(page, '#/inventory');
  await page.getByRole('tab', { name: /Loot filter/ }).click();
  await page.getByText('No presets yet.').waitFor();
  await page.getByRole('button', { name: 'Below Rare' }).click();
  await page.getByRole('textbox', { name: 'Keep the rules below as' }).fill('Deep runs');
  await page.getByRole('button', { name: 'Keep', exact: true }).click();
  await page.getByText('Saved as “Deep runs”.').waitFor();
  await page.getByRole('button', { name: 'Use' }).first().click();
  await page
    .getByText(/is now your loot filter/)
    .first()
    .waitFor();
  await page.getByRole('button', { name: 'Share' }).first().click();
  const code = page.locator('input[readonly], textarea[readonly]').filter({ hasText: '' });
  const value = await code
    .first()
    .inputValue()
    .catch(() => '');
  check(/^wf1\./.test(value), `the share code reads "${value}"`);
  await page.getByLabel('Import a code').fill(value);
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  await page.getByText('This code:').waitFor();
  // A broken code is refused with a plain message (and nothing changes).
  await page.getByLabel('Import a code').fill(`${value.slice(0, -2)}zz`);
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  await page.getByText(/changed or mistyped|not a loot-filter code/).waitFor();
  await shoot(page, 'p8-09-presets');
}

async function claimAll(page) {
  const who = 'Cass';
  log(who, '8. the Tavern: claim all');
  await go(page, '#/tavern');
  const claim = page.getByRole('button', { name: /^Claim all/ });
  await claim.waitFor();
  await claim.click();
  await page.getByText(/rewards? claimed/).waitFor();
  await shoot(page, 'p8-10-tavern-claimed');
}

// ---- Brynja ------------------------------------------------------------------------------------

async function barred(page) {
  const who = 'Brynja';
  log(who, '9. the Throne barred at 46 (Reach level 48); the Deep open on her map');
  await go(page, '#/map');
  await page
    .locator('.ledger__row', { hasText: 'The Hollow Deep' })
    .locator('.ledger__state', { hasText: /^(open|next|you are here)$/i })
    .waitFor();
  await go(page, '#/throne');
  await page.getByRole('heading', { name: 'The lantern road is dark' }).waitFor();
  await page
    .getByText(/level 48/)
    .first()
    .waitFor();
  await shoot(page, 'p8-11-throne-barred');
}

// ---- Mira (admin) ------------------------------------------------------------------------------

async function calendar(page) {
  const who = 'Mira';
  log(who, '10. the automatic calendar: paused, on (confirmed), the next three, paused again');
  await go(page, '#/admin/events');
  const cal = page.locator('.evcal');
  await cal.locator('.evcal__state--paused').waitFor();
  await cal.getByRole('button', { name: 'Turn on…' }).click();
  await cal.getByRole('button', { name: 'Turn it on' }).click();
  await cal.locator('.evcal__state--on').waitFor();
  const starts = await cal.locator('.evcal__plan .strong__note').allInnerTexts();
  check(starts.length === 3, `the next three: ${starts.length}`);
  for (const s of starts) {
    check(/^Mon, .* 00:00 →/.test(s.trim()), `a planned event starts "${s}", not Monday 00:00`);
  }
  await shoot(page, 'p8-12-calendar-on');
  await cal.getByRole('button', { name: 'Pause' }).click();
  await cal.locator('.evcal__state--paused').waitFor();
}

async function readiness(page) {
  const who = 'Mira';
  log(who, '11. the Readiness tab: every item, then a test letter');
  await go(page, '#/admin/readiness');
  await page.locator('.readyroll__entry').first().waitFor();
  const entries = await page.locator('.readyroll__entry').count();
  check(entries >= 9, `readiness items: ${entries}`);
  for (const title of ['Email (SMTP)', 'Season 1', 'The first event', 'Reserved staff names']) {
    await page.locator('.readyroll__entry', { hasText: title }).first().waitFor();
  }
  // Season 1 is under way (seeded): its entry is not "not set".
  const season = page.locator('.readyroll__entry', { hasText: 'Season 1' }).first();
  check(
    !(await season.getAttribute('class')).includes('readyroll__entry--not_set'),
    'Season 1 reads not set',
  );
  await page.getByLabel('Send to').fill('owner-check@mail.example.test');
  await page.getByRole('button', { name: 'Send test letter' }).click();
  await page.locator('.readyroll-letter__result').waitFor();
  await shoot(page, 'p8-13-readiness');
}

// ---- run ---------------------------------------------------------------------------------------

mkdirSync(outDir, { recursive: true });
const browser = await playwright.chromium.launch();
let failed = null;
try {
  const odric = await open(browser, 'Odric');
  const cass = await open(browser, 'Cass');
  const brynja = await open(browser, 'Brynja');
  const mira = await open(browser, 'Mira');
  await Promise.all([
    login(odric.page, ODRIC),
    login(cass.page, CASS),
    login(brynja.page, BRYNJA),
    login(mira.page, MIRA),
  ]);
  await Promise.all([
    (async () => {
      await townAndMap(odric.page);
      await throneDoor(odric.page);
      await guildHall(odric.page);
      await guildRoll(odric.page);
      await letters(odric.page);
      await claimThrone(odric.page);
    })(),
    (async () => {
      await pack(cass.page);
      await presets(cass.page);
      await claimAll(cass.page);
    })(),
    barred(brynja.page),
    (async () => {
      await calendar(mira.page);
      await readiness(mira.page);
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
  console.error(`phase 8 exit run failed after ${seconds}s`);
  process.exit(1);
}
console.log(`phase 8 exit run passed in ${seconds}s`);
