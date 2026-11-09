// Phase 5 exit-criteria run, browser half (ticket 5.8, GDD §15 Phase 5) against the real server and
// UI: the boards, an arena duel and its result, the account security screens and a trade. Every
// flow goes through the screens; the only shortcut is the world the e2e server seeds at start with
// E2E_SEED_PHASE5=1 (apps/server/src/e2e/seed-phase5.ts): trading opened, the Warehouse restored,
// Season 1 under way, and three players the owner and time would otherwise provide (Ilse and
// Bertram, trade-ready friends; Corvin, a duel-ready stranger in Ilse's kit).
//
// Desktop (1440) contexts, one per account:
// 1. Boards: Ilse opens the Roll of Renown (Character Level) and sees her own place with a rank and
//    the other players by display name; she switches to Character Power with the class filter
//    (Warrior: Bertram, a hunter, drops out), opens "How is … measured?", then the season roll.
// 2. Arena: Ilse's rated list is drawn by the server (Corvin on it, her friend Bertram never); she
//    challenges Corvin: the result (verdict, both sides, the rating change of Season 1, the combat
//    log) shows and the duel is in her book; then a friendly challenge against Bertram's defence;
//    the Arena Ladder lists her under "your place".
// 3. Trading: Ilse sends Bertram an Epic and 250 gold as a gift (compose, review, send); Bertram
//    sees it in his inbox, looks closely and accepts; the hold shows on the result and in his
//    inbox; Ilse's history reads "Traded". Ilse places gold on the account shelf in the Warehouse.
// 4. Account security: Sela registers (unverified): the strip on the town screen, the security
//    panel ("Not verified yet."); she logs in on a second device; verifies through the mailed link;
//    logs out the other device (it is sent back to the login); three wrong current passwords on the
//    email change and three wrong logins lock the address: the next login answers 429 (per account)
//    and the screen says so; forgot/reset through the mailed link (the reset clears the lock and
//    logs out every device); she enters with the new password.
// Fails (exit 1) on a missing step, a page error or any 429 other than the one expected. Login is
// limited to 10 a minute per client: this run logs in 8 times (the throttle's failures included).
//
// Needs a fresh e2e server with the seed and a mail dir, and the web dev server:
//   E2E_SEED_PHASE5=1 E2E_MAIL_DIR=<dir> pnpm --filter @worldforge/server e2e:serve
//   pnpm --filter @worldforge/web dev
//   E2E_MAIL_DIR=<dir> node tools/e2e/phase5-exit.mjs [baseUrl] [outDir]
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require(process.env.PLAYWRIGHT_PATH ?? '/opt/node-tools/node_modules/playwright');
}

const baseUrl = process.argv[2] ?? 'http://localhost:5173';
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-5');
const mailDir = resolve(process.env.E2E_MAIL_DIR ?? 'mails');
const PASSWORD = 'ashes-and-iron-42';
const VP = { width: 1440, height: 900 };
/** Names are unique server-wide: a letters-only suffix per run. */
const SUFFIX = Date.now()
  .toString(26)
  .replace(/\d/g, (d) => 'qrstuvwxyz'[d])
  .slice(-5);
const cap = (s) => s[0].toUpperCase() + s.slice(1);
// Seeded at server start (seed-phase5.ts).
const ILSE = { email: 'p5-ilse@graumark.test', name: 'Ilse Varrow', hero: 'Ilse' };
const BERTRAM = { email: 'p5-bertram@graumark.test', name: 'Bertram Holt', hero: 'Bertram' };
const CORVIN = { name: 'Corvin Ashe', hero: 'Corvin' };
// Registered by this run.
const SELA = {
  email: `p5-sela-${SUFFIX}@graumark.test`,
  name: `Sela ${cap(SUFFIX)}`,
  hero: `Sela${SUFFIX}`,
  className: 'Hunter',
};
const NEW_PASSWORD = `embers-and-salt-${SUFFIX}`;
const GIFT_GOLD = 250;
const SHELF_GOLD = 100;

const started = Date.now();
const log = (text) => console.log(`[p5 ${((Date.now() - started) / 1000).toFixed(0)}s] ${text}`);
const problems = [];
/** The one 429 this run asks for: the per-account login lock. */
let expectLoginLock = false;

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
  await page.evaluate(() => window.scrollTo(0, 0));
  const file = `${outDir}/${name}.png`;
  await page.screenshot({ path: file, fullPage: true });
  console.log(`saved ${file}`);
}

/** A fresh desktop context whose page fails the run on page errors and unexpected 429s. */
async function open(browser, label) {
  const context = await browser.newContext({ viewport: VP, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.addLocatorHandler(page.locator('dialog.return'), async () => {
    await page.keyboard.press('Escape');
  });
  page.on('pageerror', (err) => problems.push(`page error @ ${label}: ${err.message}`));
  page.on('response', (res) => {
    if (res.status() !== 429) return;
    if (expectLoginLock && new URL(res.url()).pathname === '/api/auth/login') return;
    problems.push(`429 @ ${label}: ${res.request().method()} ${res.url()}`);
  });
  return { context, page };
}

async function go(page, hash) {
  await page.goto(`${baseUrl}/${hash}`);
}

/** Opens a mailed link in a fresh page load, as from a mail client. */
async function openLink(page, hash) {
  await page.goto('about:blank');
  await page.goto(`${baseUrl}/${hash}`, { waitUntil: 'networkidle' });
}

async function loginForm(page, email, password) {
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Enter', exact: true }).click();
}

async function login(page, email, password = PASSWORD) {
  await page.goto(`${baseUrl}/#/login`, { waitUntil: 'networkidle' });
  await loginForm(page, email, password);
  await page.waitForURL(/#\/hub/);
}

/** The newest captured mail of a kind to an address, waiting until the server has written it. */
async function mailTo(to, kind, after = 0) {
  const by = Date.now() + 15_000;
  while (Date.now() < by) {
    const files = readdirSync(mailDir)
      .filter((f) => f.endsWith(`-${kind}.json`))
      .sort()
      .reverse();
    for (const f of files) {
      if (Number(f.slice(0, 4)) <= after) continue;
      const m = JSON.parse(readFileSync(join(mailDir, f), 'utf8'));
      if (m.to.toLowerCase() === to.toLowerCase()) return { ...m, seq: Number(f.slice(0, 4)) };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no ${kind} mail to ${to} in ${mailDir}`);
}
/** The hash part of a mailed link (the server's public base URL may differ from `baseUrl`). */
const hashOf = (m) => {
  const link = /https?:\/\/\S+/.exec(m.text)[0];
  return link.slice(link.indexOf('#'));
};

/** Reloads until the locator shows (the leaderboard sweep runs every few seconds), bounded. */
async function reloadUntil(page, locator, what, ms = 30_000) {
  const by = Date.now() + ms;
  for (;;) {
    if (await locator.isVisible().catch(() => false)) return;
    if (Date.now() > by) throw new Error(`${what} did not show`);
    await page.reload();
    await locator.waitFor({ timeout: 4_000 }).catch(() => undefined);
  }
}

async function boards(page) {
  log('1. Ilse opens the Roll of Renown: her place and the others by name');
  await go(page, '#/boards/level');
  const roll = page.locator('section.renown');
  const list = roll.locator('.renown__list');
  await list.waitFor();
  await reloadUntil(
    page,
    list.locator('.renown__row', { hasText: BERTRAM.name }).filter({ hasText: 'level 16' }),
    'Bertram at level 16 on the level roll',
  );
  await list.locator('.renown__row', { hasText: CORVIN.name }).waitFor();
  const mine = roll.locator('.renown__yours-list li', { hasText: ILSE.hero });
  await mine.waitFor();
  const rank = (await mine.locator('.renown__yours-rank').innerText()).trim();
  if (!/^\d+$/.test(rank)) throw new Error(`Ilse's place has no rank: "${rank}"`);
  await list.locator('.renown__row--you', { hasText: ILSE.name }).waitFor();
  log(`   Ilse is ${rank}. on Character Level`);
  await shoot(page, 'p5-01-boards-level');

  log('1. Character Power, Warriors only, and how it is measured');
  await roll
    .getByRole('navigation', { name: 'Rolls' })
    .getByRole('link', { name: 'Character Power' })
    .click();
  await page.waitForURL(/#\/boards\/power/);
  // The roll has re-rendered for Power (the filters build their links from it).
  const measured = roll.locator('details.renown__measured');
  const summary = measured.locator('summary', { hasText: 'How is Character Power measured?' });
  await summary.waitFor();
  await roll.locator('.renown__filters').getByLabel('Class').selectOption('warrior');
  await page.waitForURL(/class=warrior/);
  await reloadUntil(
    page,
    list.locator('.renown__row', { hasText: CORVIN.name }),
    'Corvin on the warriors power roll',
  );
  await list.locator('.renown__row--you', { hasText: ILSE.name }).waitFor();
  // Bertram (a hunter) leaves the roll once the warriors-only board is read.
  await list
    .locator('.renown__row', { hasText: BERTRAM.name })
    .waitFor({ state: 'detached', timeout: 10_000 })
    .catch(() => {
      throw new Error('Bertram (a hunter) is on the warriors-only roll');
    });
  await summary.click();
  await measured.getByText('Ties go to whoever got there first.', { exact: false }).waitFor();
  await shoot(page, 'p5-01-boards-power-warriors');

  log('1. The season roll');
  await roll.locator('.renown__filters').getByLabel('Class').selectOption('');
  await page.waitForURL((u) => !u.hash.includes('class='));
  await list.locator('.renown__row', { hasText: BERTRAM.name }).waitFor();
  await roll.locator('.renown__filters').getByLabel('Time').selectOption('current');
  await page.waitForURL(/season=current/);
  await roll.locator('.renown__season', { hasText: 'Season 1' }).waitFor();
  await reloadUntil(
    page,
    list.locator('.renown__row', { hasText: BERTRAM.name }),
    'Bertram on the season roll',
  );
  await roll.locator('.renown__yours-list li', { hasText: ILSE.hero }).waitFor();
  await shoot(page, 'p5-01-boards-season');
}

async function arena(page) {
  log('2. Ilse draws a rated list: Corvin is on it, her friend Bertram never');
  await go(page, '#/arena');
  const rated = page.locator('section.arena-rated');
  const slate = rated.locator('.arena-slate');
  await slate.waitFor();
  const corvin = slate.locator('.arena-slate__row', { hasText: CORVIN.name });
  await corvin.waitFor();
  if (await slate.locator('.arena-slate__row', { hasText: BERTRAM.name }).count()) {
    throw new Error('a friend is offered for a rated duel');
  }
  await shoot(page, 'p5-02-arena-slate');

  log('2. Ilse challenges Corvin: the result and the combat log');
  await corvin.getByRole('button', { name: 'Challenge' }).click();
  const bout = page.locator('.arena-bout');
  await bout.locator('.arena-bout__where', { hasText: 'Rated duel' }).waitFor();
  const verdict = (await bout.locator('.arena-bout__verdict').innerText()).trim();
  if (!/^(Victory|Defeat|Draw)/.test(verdict)) throw new Error(`no verdict: "${verdict}"`);
  // Season 1 is under way: the duel moved a rating.
  await bout.locator('.arena-bout__rating', { hasText: 'Rating' }).waitFor();
  await bout.getByText('Nothing you own changed.', { exact: false }).waitFor();
  const lines = await bout.getByRole('list', { name: 'Combat log' }).locator('li').count();
  if (lines < 2) throw new Error(`the combat log has ${lines} lines`);
  await page.locator('.arena-book__row').first().waitFor();
  log(`   ${verdict.split('\n')[0]}, ${lines} log lines`);
  await shoot(page, 'p5-02-arena-rated-result');

  log("2. A friendly challenge against Bertram's defence");
  const friend = page
    .locator('section.arena-friendly .arena-friends__row', { hasText: BERTRAM.name })
    .getByRole('button', { name: 'Challenge' });
  await friend.click();
  await bout.locator('.arena-bout__where', { hasText: 'Friendly challenge' }).waitFor();
  await bout.getByRole('list', { name: 'Combat log' }).locator('li').first().waitFor();
  if (await bout.locator('.arena-bout__rating').count()) {
    throw new Error('a friendly challenge moved a rating');
  }
  // Both duels in the book.
  await page.locator('.arena-book__row').nth(1).waitFor();
  await shoot(page, 'p5-02-arena-friendly-result');

  log('2. The Arena Ladder lists Ilse under "your place"');
  await go(page, '#/boards/arena');
  await page
    .locator('section.renown--ladder .renown__yours-list li', { hasText: ILSE.hero })
    .waitFor();
  await shoot(page, 'p5-02-arena-ladder');
}

async function trade(browser, A) {
  log('3. Ilse sends Bertram an Epic and gold as a gift');
  await go(A.page, '#/trading');
  const screen = A.page.locator('section.trading');
  await screen.getByRole('button', { name: 'New offer' }).click();
  const partner = screen.getByLabel('Trade with');
  await partner.locator('option', { hasText: BERTRAM.name }).waitFor({ state: 'attached' });
  const value = await partner.locator('option', { hasText: BERTRAM.name }).getAttribute('value');
  await partner.selectOption(value);
  const give = screen.getByRole('region', { name: 'You give' });
  const item = give.locator('.trading__choose button').first();
  await item.click();
  await give.getByLabel(/^Gold/).fill(String(GIFT_GOLD));
  await shoot(A.page, 'p5-03-trade-compose');
  await screen.getByRole('button', { name: 'Review the offer' }).click();
  await screen.getByRole('heading', { name: `Check your offer to ${BERTRAM.name}` }).waitFor();
  await screen.getByText('You get nothing back: this is a gift.').waitFor();
  await shoot(A.page, 'p5-03-trade-confirm');
  await screen.getByRole('button', { name: 'Send the offer' }).click();
  await screen.getByRole('button', { name: 'Cancel the offer' }).waitFor();
  await screen.getByRole('button', { name: 'Sent (1)' }).waitFor();
  await shoot(A.page, 'p5-03-trade-sent');

  log('3. Bertram logs in, looks closely and accepts');
  const B = await open(browser, 'Bertram');
  await login(B.page, BERTRAM.email);
  await go(B.page, '#/trading');
  const inbox = B.page.locator('section.trading');
  await inbox.getByRole('button', { name: 'Offers to you (1)' }).waitFor();
  const row = inbox.locator('.trading__row', { hasText: ILSE.name });
  await row.getByText(`you get 1 item, ${GIFT_GOLD} gold`, { exact: false }).waitFor();
  await row.getByRole('button', { name: 'Look closely' }).click();
  await inbox.getByRole('button', { name: 'Accept the trade' }).waitFor();
  await shoot(B.page, 'p5-03-trade-offer');
  await inbox.getByRole('button', { name: 'Accept the trade' }).click();
  await inbox
    .getByRole('status')
    .filter({ hasText: /^Traded\. What you received is held until/ })
    .waitFor();
  await shoot(B.page, 'p5-03-trade-accepted');

  log('3. The hold shows in his inbox; Ilse reads "Traded"');
  await B.page.reload();
  const holds = inbox.locator('.trading__holds');
  await holds.getByRole('heading', { name: 'Held after a trade' }).waitFor();
  await holds
    .locator('li', { hasText: BERTRAM.hero })
    .filter({ hasText: `${GIFT_GOLD} gold, 1 item held until` })
    .waitFor();
  await shoot(B.page, 'p5-03-trade-hold');
  await B.context.close();

  await A.page.reload();
  await screen.getByRole('button', { name: 'History' }).click();
  await screen
    .locator('.trading__row', { hasText: BERTRAM.name })
    .filter({ hasText: 'Traded' })
    .first()
    .waitFor();
  await shoot(A.page, 'p5-03-trade-history');

  log('3. Ilse places gold on the account shelf');
  await go(A.page, '#/warehouse');
  await A.page.getByRole('tab', { name: 'Account shelf' }).click();
  await A.page.getByRole('heading', { name: 'On the account shelf' }).waitFor();
  await A.page.getByLabel('Gold to place').fill(String(SHELF_GOLD));
  await A.page.getByRole('button', { name: 'Place on the shelf' }).click();
  await A.page.getByLabel('Gold to take').waitFor();
  const most = await A.page.getByLabel('Gold to take').getAttribute('max');
  if (Number(most) !== SHELF_GOLD) throw new Error(`the shelf holds ${most} gold`);
  await shoot(A.page, 'p5-03-account-shelf');
}

async function security(browser) {
  log('4. Sela registers: unverified, the strip and the security panel');
  const S1 = await open(browser, 'Sela 1');
  const p = S1.page;
  await p.goto(`${baseUrl}/#/register`, { waitUntil: 'networkidle' });
  await p.getByLabel('Email').fill(SELA.email);
  await p.getByLabel('Display name').fill(SELA.name);
  await p.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await p.getByRole('button', { name: 'Create account' }).click();
  await p.getByRole('heading', { name: 'Forge your first hero' }).waitFor();
  await p.getByLabel('Name', { exact: true }).fill(SELA.hero);
  await p.getByRole('radio', { name: new RegExp(`^${SELA.className}`) }).check({ force: true });
  await p.getByRole('button', { name: 'Forge hero' }).click();
  await p.waitForURL(/#\/hub/);
  await p.locator('.acct-verify-strip', { hasText: 'Your email is not verified yet.' }).waitFor();
  await shoot(p, 'p5-04-verify-strip');
  await go(p, '#/account');
  const panel = p.locator('.acct-sec');
  await panel.getByText('Not verified yet.', { exact: false }).waitFor();
  await panel.getByText('Open on this device only.').waitFor();

  log('4. A second device; the mailed link verifies the address');
  const S2 = await open(browser, 'Sela 2');
  await login(S2.page, SELA.email);
  await p.reload();
  await panel.getByText('Open here and on 1 other device.').waitFor();
  await shoot(p, 'p5-04-security-unverified');
  const verify = await mailTo(SELA.email, 'verify_email');
  await openLink(p, hashOf(verify));
  await p.getByRole('heading', { name: 'Your name is sealed' }).waitFor();
  await shoot(p, 'p5-04-verify-done');
  await go(p, '#/account');
  await panel
    .getByText(/^Verified/)
    .first()
    .waitFor();

  log('4. "Log out other devices": the second device is sent to the login');
  await panel.getByRole('button', { name: 'Log out other devices' }).click();
  await panel.getByRole('button', { name: 'Yes, log them out' }).click();
  await panel.getByText('1 other device was logged out.').waitFor();
  await shoot(p, 'p5-04-security-verified');
  await openLink(S2.page, '#/account');
  await S2.page.getByRole('button', { name: 'Enter', exact: true }).waitFor();

  log('4. Wrong passwords lock the address: three on the email change, three at the login');
  await panel.getByRole('button', { name: 'Change email address' }).click();
  const form = panel.locator('form.acct-sec__form');
  for (let i = 1; i <= 3; i++) {
    await form.getByLabel('New email').fill(`p5-sela-new-${SUFFIX}@graumark.test`);
    await form.getByLabel('Current password').fill(`not-the-password-${i}`);
    const answer = p.waitForResponse((r) => r.url().endsWith('/api/account/email'));
    await form.getByRole('button', { name: 'Change the address' }).click();
    if ((await answer).status() !== 403) throw new Error(`email change ${i}: not refused`);
    await form.locator('.field__error', { hasText: 'That password is not right.' }).waitFor();
  }
  await form.getByRole('button', { name: 'Cancel' }).click();
  const q = S2.page;
  for (let i = 1; i <= 3; i++) {
    const answer = q.waitForResponse((r) => new URL(r.url()).pathname === '/api/auth/login');
    await loginForm(q, SELA.email, `still-not-it-${i}`);
    if ((await answer).status() !== 401) throw new Error(`wrong login ${i}: not a 401`);
    await q.getByText('That email and password do not match an account.').waitFor();
  }
  expectLoginLock = true;
  const locked = q.waitForResponse((r) => new URL(r.url()).pathname === '/api/auth/login');
  await loginForm(q, SELA.email, PASSWORD);
  const res = await locked;
  const body = await res.json();
  expectLoginLock = false;
  if (res.status() !== 429 || body.error?.details?.limit !== 'account') {
    throw new Error(`the 7th failure answered ${res.status()} ${JSON.stringify(body)}`);
  }
  await q.getByText('Too many wrong passwords for this account', { exact: false }).waitFor();
  log(`   locked for ${body.error.details.retryAfterSeconds} s, even with the right password`);
  await shoot(q, 'p5-04-login-locked');

  log('4. Forgot/reset through the mailed link, then in with the new password');
  const before = (await mailTo(SELA.email, 'verify_email')).seq;
  await q.getByRole('link', { name: 'Forgot your password?' }).click();
  await q.getByRole('heading', { name: 'Forgot your password?' }).waitFor();
  await q.getByLabel('Email', { exact: true }).fill(SELA.email);
  await q.getByRole('button', { name: 'Send me a link' }).click();
  await q.getByRole('heading', { name: 'A letter is on its way' }).waitFor();
  const reset = await mailTo(SELA.email, 'reset_password', before);
  await openLink(q, hashOf(reset));
  await q.getByRole('heading', { name: 'Choose a new password' }).waitFor();
  if (q.url().includes('token=')) throw new Error('the token stayed in the address bar');
  await q.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
  await q.getByRole('button', { name: 'Set the new password' }).click();
  await q.getByRole('heading', { name: 'A new key is cut' }).waitFor();
  await shoot(q, 'p5-04-reset-done');
  // Every session ended: the first device is back at the login too.
  await openLink(p, '#/account');
  await p.getByRole('button', { name: 'Enter', exact: true }).waitFor();
  // The reset cleared the lock: the new password works at once.
  await q.getByRole('link', { name: 'Enter with the new password' }).click();
  await loginForm(q, SELA.email, NEW_PASSWORD);
  await q.waitForURL(/#\/hub/);
  await go(q, '#/account');
  await q
    .locator('.acct-sec')
    .getByText(/^Verified/)
    .first()
    .waitFor();
  await shoot(q, 'p5-04-after-reset');
  await S1.context.close();
  await S2.context.close();
}

async function run(browser) {
  const A = await open(browser, 'Ilse');
  log('Ilse logs in');
  await login(A.page, ILSE.email);
  await boards(A.page);
  await arena(A.page);
  await trade(browser, A);
  await A.context.close();
  await security(browser);
}

mkdirSync(outDir, { recursive: true });
const browser = await playwright.chromium.launch();
let failed = false;
try {
  await run(browser);
} catch (err) {
  failed = true;
  console.error(`✗ ${err.message}`);
} finally {
  await browser.close();
}
if (problems.length) {
  failed = true;
  for (const p of problems) console.error(`✗ ${p}`);
}
const took = ((Date.now() - started) / 1000).toFixed(0);
if (failed) process.exit(1);
console.log(`✓ phase 5 exit run passed in ${took} s`);
