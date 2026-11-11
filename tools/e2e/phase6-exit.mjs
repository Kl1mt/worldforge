// Phase 6 exit run, browser half (ticket 6.10, GDD §15 Phase 6) against the real server and UI: the
// key Phase 6 screens in a real browser. Every flow goes through the screens; the only shortcut is
// the world the e2e server seeds at start with E2E_SEED_PHASE6=1 (apps/server/src/e2e/
// seed-phase6.ts): the town's works done (the Forgeward Age), a Harvest of Bones under way, and
// three accounts the owner and many hours of play would otherwise provide (Hralda, a level-38
// warrior in Legendary +10 kit with the price of an awakening, a Prismatic and a Void piece and two
// keepsakes; Tamsin, a level-34 hunter; Ysolde, an admin).
//
// Desktop (1440) contexts, one per account, the three run side by side:
// Hralda
// 1. Town: the era title (Era of the Forgeward Age) and the event banner (Harvest of Bones); the
//    map: the banner, the Ashfall Verge and the Cinder Depths open, and she sets out to farm the
//    Depths.
// 2. Heroic: the Tavern keeper's weekly boss modifier, then the crypt door with Heroic (tier IV)
//    chosen: the same modifier (read again if a week boundary of the scaled clock fell between).
// 3. The Forge's "The Banked Fire": an item ready, the before/after quote, the full confirm, the
//    awakening; the item shows the ☼ mark and is locked (its frame reads "awakened … locked").
// 4. Tyrant's Forge (#/tyrant): the door with the week's modifier; she descends, the fight plays
//    out (scaled clock) and she claims the reckoning.
// 5. Prismatic and Void frames in the pack: both render (item-frame--prismatic / --void, the
//    tooltip's data-variant) and are still under automation (no motion classes, no running
//    animations, two captures of the frames byte-identical); with the A.14 override
//    `worldforge.sceneMotion = on` the motion class comes back (the freeze is the automation rule).
// 6. The collection book (#/collection): kind and ownership filters, an earned banner shown
//    ("Show it", then Worn), a locked keepsake with how to earn it.
// Tamsin
// 7. The Tyrant's door is barred for her (Reach level 36) while the Depths are open on her map;
//    the admin animation gallery is hidden from her (sent away from #/admin, the API answers 404).
// Ysolde (admin)
// 8. The admin panel's Events tab with the Harvest under way, then the animation gallery: frozen
//    under automation (no running animation, the Variants table's frames still) until Play.
// Fails (exit 1) on a missing step, a page error or any 429. Logs in 3 times.
//
// Needs a fresh e2e server with the seed, and the web dev server:
//   E2E_SEED_PHASE6=1 pnpm --filter @worldforge/server e2e:serve
//   pnpm --filter @worldforge/web dev
//   node tools/e2e/phase6-exit.mjs [baseUrl] [outDir]
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
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-6');
const PASSWORD = 'ashes-and-iron-42';
const VP = { width: 1440, height: 900 };
// Seeded at server start (seed-phase6.ts).
const HRALDA = { email: 'p6-hralda@graumark.test', hero: 'Hralda' };
const TAMSIN = { email: 'p6-tamsin@graumark.test', hero: 'Tamsin' };
const YSOLDE = { email: 'p6-ysolde@graumark.test', hero: 'Ysolde' };
const EVENT = 'Harvest of Bones';
const ERA = 'Era of the Forgeward Age';

const started = Date.now();
const log = (who, text) =>
  console.log(`[p6 ${((Date.now() - started) / 1000).toFixed(0)}s] ${who}: ${text}`);
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

/** The Prismatic/Void (and awakened) frames on the page: how many, and whether any moves. */
const frameMotion = (page, scope = 'body') =>
  page.evaluate((sel) => {
    const root = document.querySelector(sel);
    const frames = [
      ...(root?.querySelectorAll(
        '.item-frame--prismatic, .item-frame--void, .item-frame--awakened',
      ) ?? []),
    ];
    return {
      prismatic: frames.filter((f) => f.classList.contains('item-frame--prismatic')).length,
      void: frames.filter((f) => f.classList.contains('item-frame--void')).length,
      awakened: frames.filter((f) => f.classList.contains('item-frame--awakened')).length,
      motionClasses: frames.filter((f) => /item-frame--(shimmer|ember)/.test(f.className)).length,
      running: frames
        .flatMap((f) => f.getAnimations({ subtree: true }))
        .filter((a) => a.playState === 'running').length,
    };
  }, scope);

// ---- Hralda ------------------------------------------------------------------------------------

async function townAndMap(page) {
  const who = 'Hralda';
  log(who, '1. the town: era title and the event banner');
  await go(page, '#/hub');
  const era = page.locator('.hub-era__title');
  await era.waitFor();
  const eraText = (await era.innerText()).trim();
  check(eraText === ERA, `the town's era reads "${eraText}", not "${ERA}"`);
  await page.locator('.evt-banner', { hasText: EVENT }).waitFor();
  await shoot(page, 'p6-01-town-era-event');

  log(who, '1. the map: the banner, the Verge and the Depths open; she farms the Depths');
  await go(page, '#/map');
  await page.locator('.evt-banner', { hasText: EVENT }).waitFor();
  const ledger = page.locator('.ledger__list');
  for (const place of ['The Ashfall Verge', 'The Cinder Depths', 'The Tyrant’s Forge']) {
    await ledger
      .locator('.ledger__row', { hasText: place })
      .locator('.ledger__state', { hasText: /^(open|next|you are here)$/i })
      .waitFor();
  }
  await ledger.locator('.ledger__row', { hasText: 'The Cinder Depths' }).click();
  await page.getByRole('button', { name: /^(Farm|Travel to) The Cinder Depths$/ }).click();
  await page.waitForURL(/#\/area/);
  await page.getByRole('heading', { name: 'The Cinder Depths' }).first().waitFor();
  await go(page, '#/map');
  await ledger
    .locator('.ledger__row', { hasText: 'The Cinder Depths' })
    .locator('.ledger__state', { hasText: /you are here/i })
    .waitFor();
  await shoot(page, 'p6-02-map-depths');
}

async function heroic(page) {
  const who = 'Hralda';
  // The scaled clock can cross a week boundary between the two reads: read both again then.
  for (let attempt = 1; ; attempt++) {
    log(who, '2. the Tavern keeper names the week’s boss modifier');
    await go(page, '#/tavern');
    const tavern = page.locator('.tavern__boss-week .boss-mod__name');
    await tavern.waitFor();
    const keeper = (await tavern.innerText()).trim();
    log(who, `2. the crypt door, Heroic chosen (keeper: ${keeper})`);
    await go(page, '#/crypt');
    await page.getByRole('radio', { name: /Heroic/ }).click();
    const door = page.locator('section.crypt-door');
    await door.getByText(/Heroic:/).waitFor();
    await door.getByRole('button', { name: 'Enter the Heroic crypt' }).waitFor();
    const atDoor = (await door.locator('.boss-mod__name').innerText()).trim();
    if (atDoor === keeper) break;
    if (attempt >= 3) throw new Error(`the Tavern says "${keeper}", the Heroic door "${atDoor}"`);
  }
  await shoot(page, 'p6-03-heroic-door');
}

async function awaken(page) {
  const who = 'Hralda';
  log(who, '3. the Banked Fire: a quote, before/after, the confirm');
  await go(page, '#/forge');
  const panel = page.locator('section[aria-labelledby="awaken-title"]');
  await panel.waitFor();
  await panel.scrollIntoViewIfNeeded();
  const ready = panel.getByRole('list', { name: 'Items ready to awaken' });
  await ready.getByRole('button').first().click();
  await panel.locator('.awaken__compare').waitFor();
  await panel.locator('.awaken__after').waitFor();
  const name = (await panel.locator('.awaken__name').innerText()).trim();
  await panel.getByRole('button', { name: 'Awaken…' }).click();
  const confirm = panel.locator('.awaken__confirm');
  await confirm.waitFor();
  await confirm.getByText(/will be locked/).waitFor();
  await shoot(page, 'p6-04-awaken-confirm');
  await confirm.getByRole('button', { name: /Awaken it/ }).click();
  await page.getByText(`☼ ${name} is awakened`).waitFor();
  log(who, `3. ${name} is awakened: the ☼ mark and the lock`);
  const done = panel.getByRole('list', { name: 'Awakened items' });
  const frame = done.locator('.item-frame--awakened').first();
  await frame.waitFor();
  check(
    (await frame.locator('.item-frame__awakened').innerText()).trim() === '☼',
    'the awakened frame has no ☼ mark',
  );
  await frame.locator('.item-frame__lock').waitFor();
  const label = (await frame.getAttribute('aria-label')) ?? '';
  check(/awakened/.test(label) && /locked/.test(label), `the awakened frame reads "${label}"`);
  // The ember glow is still under automation, like the variants (A.12 rules).
  const ember = await frameMotion(page, 'section[aria-labelledby="awaken-title"]');
  check(
    ember.awakened >= 1 && ember.motionClasses === 0 && ember.running === 0,
    `the awakened frame moves under automation: ${JSON.stringify(ember)}`,
  );
  await shoot(page, 'p6-05-awakened');
}

async function tyrant(page) {
  const who = 'Hralda';
  log(who, '4. the Tyrant’s door: the week’s modifier, then the descent');
  await go(page, '#/tyrant');
  const door = page.locator('section.crypt-door');
  await door.getByRole('heading', { name: 'Before you descend' }).waitFor();
  await door.locator('.boss-mod__name').waitFor();
  await shoot(page, 'p6-06-tyrant-door');
  await door.getByRole('button', { name: 'Descend to the anvil' }).click();
  await page.getByRole('heading', { name: /^(In the forge|The fighting has stopped)/ }).waitFor();
}

async function claimTyrant(page) {
  const who = 'Hralda';
  await go(page, '#/tyrant');
  const claim = page.getByRole('button', { name: 'Claim the spoils' });
  await claim.waitFor({ timeout: 60_000 });
  await claim.click();
  const verdict = page.getByRole('heading', { name: /Forge Tyrant falls|keeps his forge/ });
  await verdict.waitFor();
  log(who, `4. the reckoning: ${(await verdict.innerText()).trim()}`);
  await shoot(page, 'p6-07-tyrant-reckoning');
}

async function variants(page) {
  const who = 'Hralda';
  log(who, '5. the pack: Prismatic and Void frames render, and are still');
  await go(page, '#/inventory');
  const grid = page.locator('.stash__grid');
  await grid.waitFor();
  const prism = grid.locator('.item-frame--prismatic').first();
  const voidFrame = grid.locator('.item-frame--void').first();
  await prism.waitFor();
  await voidFrame.waitFor();
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.ready)));
  const still = await frameMotion(page);
  check(still.prismatic >= 1 && still.void >= 1, `variant frames: ${JSON.stringify(still)}`);
  check(
    still.motionClasses === 0 && still.running === 0,
    `variant frames move under automation: ${JSON.stringify(still)}`,
  );
  const a = [await prism.screenshot(), await voidFrame.screenshot()];
  await page.waitForTimeout(1_200);
  const b = [await prism.screenshot(), await voidFrame.screenshot()];
  check(a[0].equals(b[0]) && a[1].equals(b[1]), 'a variant frame changed between two captures');
  log(who, `5. still: ${JSON.stringify(still)}, two captures identical`);
  for (const [frame, id] of [
    [prism, 'prismatic'],
    [voidFrame, 'void'],
  ]) {
    await frame.click();
    await page.locator(`.pack__inspect article.tooltip[data-variant="${id}"]`).waitFor();
  }
  await shoot(page, 'p6-08-pack-variants');

  log(who, '5. the A.14 override turns the motion back on (the freeze is the automation rule)');
  await page.evaluate(() => localStorage.setItem('worldforge.sceneMotion', 'on'));
  await page.reload();
  await grid.locator('.item-frame--prismatic.item-frame--shimmer').first().waitFor();
  await page.evaluate(() => localStorage.removeItem('worldforge.sceneMotion'));
  await page.reload();
  await grid.locator('.item-frame--prismatic').first().waitFor();
  const again = await frameMotion(page);
  check(
    again.motionClasses === 0,
    `still motion after the override is gone: ${JSON.stringify(again)}`,
  );
}

async function collection(page) {
  const who = 'Hralda';
  log(who, '6. the collection book: filters, an earned banner shown, a locked keepsake');
  await go(page, '#/collection');
  const book = page.locator('section.book');
  await book.locator('.book-card').first().waitFor();
  await book.getByRole('group', { name: 'Kind' }).getByRole('button', { name: 'Banners' }).click();
  await book.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Earned' }).click();
  const cards = book.locator('.book-card');
  await cards.first().waitFor();
  check(
    (await book.locator('.book-card--locked').count()) === 0,
    'the Earned filter shows a locked keepsake',
  );
  const forgeward = cards.filter({ hasText: 'Forgeward banner' });
  await forgeward.click();
  await book.getByRole('button', { name: 'Show it' }).click();
  await book.getByRole('status').filter({ hasText: /./ }).waitFor();
  await forgeward.locator('.book-card__state', { hasText: 'Worn' }).waitFor();
  await shoot(page, 'p6-09-collection-worn');
  await book.getByRole('group', { name: 'Kind' }).getByRole('button', { name: 'All' }).click();
  await book
    .getByRole('group', { name: 'Show' })
    .getByRole('button', { name: 'Still to earn' })
    .click();
  await cards.first().waitFor();
  check(
    (await cards.count()) === (await book.locator('.book-card--locked').count()),
    'Still to earn shows an earned keepsake',
  );
  await cards.first().click();
  await book.locator('.book__earn', { hasText: 'How to earn it' }).waitFor();
  await book.locator('.book__locked').waitFor();
  const source = (await cards.first().locator('.book-card__meta').innerText()).trim();
  log(who, `6. a locked keepsake: ${source}`);
  await shoot(page, 'p6-10-collection-locked');
}

async function hralda(browser) {
  const { context, page } = await open(browser, 'Hralda');
  await login(page, HRALDA.email);
  await townAndMap(page);
  await heroic(page);
  await awaken(page);
  await tyrant(page);
  // The fight plays out while she looks through her pack and the book.
  await variants(page);
  await collection(page);
  await claimTyrant(page);
  await context.close();
}

// ---- Tamsin ------------------------------------------------------------------------------------

async function tamsin(browser) {
  const who = 'Tamsin';
  const { context, page } = await open(browser, who);
  await login(page, TAMSIN.email);
  log(who, '7. the Depths open on her map, the Tyrant’s door barred: level 36');
  await go(page, '#/map');
  const ledger = page.locator('.ledger__list');
  const depths = ledger.locator('.ledger__row', { hasText: 'The Cinder Depths' });
  // The ledger fills in once the world has loaded ("…" until then).
  await depths.locator('.ledger__state', { hasText: /^(open|next)$/i }).waitFor();
  await go(page, '#/tyrant');
  const door = page.locator('section.crypt-door');
  await door.getByRole('heading', { name: 'The furnace door is barred' }).waitFor();
  await door.getByRole('list', { name: 'Needed to enter' }).getByText('Reach level 36').waitFor();
  await shoot(page, 'p6-11-tyrant-barred');

  log(who, '7. the admin animation gallery is hidden from a player');
  await go(page, '#/admin/animations');
  await page.waitForFunction(() => !location.hash.startsWith('#/admin'));
  check((await page.locator('.anim-gallery').count()) === 0, 'a player sees the gallery');
  const api = await context.request.get(`${baseUrl}/api/admin/events`);
  check(api.status() === 404, `a player's admin request answers ${api.status()}, not 404`);
  await context.close();
}

// ---- Ysolde (admin) ----------------------------------------------------------------------------

async function ysolde(browser) {
  const who = 'Ysolde';
  const { context, page } = await open(browser, who);
  await login(page, YSOLDE.email);
  log(who, '8. the admin panel’s Events tab: the Harvest under way');
  await go(page, '#/admin');
  await page
    .getByRole('navigation', { name: 'Admin sections' })
    .getByRole('link', { name: /Events/ })
    .click();
  await page.waitForURL(/#\/admin\/events/);
  const card = page.locator('.evfolio__card', { hasText: EVENT });
  await card.waitFor();
  await card
    .getByText(/Under way/i)
    .first()
    .waitFor();
  await shoot(page, 'p6-12-admin-events');

  log(who, '8. the animation gallery: frozen until Play');
  await page
    .getByRole('navigation', { name: 'Admin sections' })
    .getByRole('link', { name: /Animations/ })
    .click();
  await page.waitForURL(/#\/admin\/animations/);
  await page.locator('.anim-gallery').waitFor();
  await page.waitForFunction(() => !document.querySelector('.anim-gallery__loading'));
  const gallery = () =>
    page.evaluate(() => {
      const root = document.querySelector('.anim-gallery');
      return {
        armed: root?.classList.contains('scene-anim') ?? false,
        running: (root?.getAnimations({ subtree: true }) ?? []).filter(
          (a) => a.playState === 'running',
        ).length,
      };
    });
  const before = await gallery();
  check(
    !before.armed && before.running === 0,
    `the gallery moves before Play: ${JSON.stringify(before)}`,
  );
  const table = page.locator('section[aria-label="Variants"]');
  await table.waitFor();
  const still = await frameMotion(page, 'section[aria-label="Variants"]');
  check(
    still.prismatic >= 1 && still.void >= 1 && still.running === 0,
    `the Variants table before Play: ${JSON.stringify(still)}`,
  );
  await shoot(page, 'p6-13-gallery-frozen');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector('.anim-gallery')
      ?.getAnimations({ subtree: true })
      .some((a) => a.playState === 'running'),
  );
  const after = await gallery();
  log(who, `8. before Play ${JSON.stringify(before)}, after ${JSON.stringify(after)}`);
  await context.close();
}

mkdirSync(outDir, { recursive: true });
const browser = await playwright.chromium.launch();
let failed = false;
try {
  const runs = await Promise.allSettled([hralda(browser), tamsin(browser), ysolde(browser)]);
  for (const r of runs) {
    if (r.status === 'rejected') {
      failed = true;
      console.error(`✗ ${r.reason?.stack ?? r.reason}`);
    }
  }
} finally {
  await browser.close();
}
for (const p of problems) console.error(`✗ ${p}`);
const seconds = ((Date.now() - started) / 1000).toFixed(1);
if (failed || problems.length > 0) {
  console.error(`Phase 6 exit run FAILED after ${seconds} s`);
  process.exit(1);
}
console.log(`Phase 6 exit run passed in ${seconds} s`);
