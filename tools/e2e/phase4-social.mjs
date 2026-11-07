// Phase 4 exit-criteria run, browser half (ticket 4.11, GDD §15 Phase 4: "players can take part in
// social systems safely; permissions, moderation and abuse reporting are in place") against the
// real server and UI. Everything goes through the screens; the only shortcut is the seeded staff
// accounts, made at server start the way the owner's `pnpm admin:role` would.
//
// Desktop (1440) contexts, one per account:
// 1. A registers, forges a hero and farms the Abandoned Fields; B registers and forges a hero;
//    C ("pest") registers and forges a hero.
// 2. A sends B a friend request by display name; B accepts at the door; A's roll lists B with a
//    presence bucket and no time or date.
// 3. C sends A a request; A blocks C instead; C's lookup of A's name finds no one.
// 4. B finds A's profile by name and reports A (reason and note) through the report dialog.
// 5. The moderator opens the queue, sees the case and mutes A with a reason; A sees the mute on
//    the standing strip and the moderator's reason on the account screen.
// 6. A, holding farmed gold, gives a little to the Warehouse's first stage on the town works; the
//    board shows A's share today; the Warehouse itself is still closed, with a link to the works.
// 7. The admin opens the panel: server status, invites, telemetry with an audit-log reconcile
//    (all checks match), a search for A and A's file; no email address on any of these pages.
// 8. B (no staff role) visiting #/moderation and #/admin gets the unknown-address treatment (sent
//    home to the hub), not the screens.
// Fails (exit 1) on a missing step, a page error or any 429 response. About 25 s at the default ×120 clock.
//
// Needs a fresh e2e server (register is limited to 5 per hour per client; this run registers 3)
// with the seeded staff, and the web dev server:
//   E2E_SEED_MODERATOR=warden@graumark.test E2E_SEED_ADMIN=castellan@graumark.test \
//     pnpm --filter @worldforge/server e2e:serve
//   pnpm --filter @worldforge/web dev
//   node tools/e2e/phase4-social.mjs [baseUrl] [outDir]
// The staff emails are read from E2E_SEED_MODERATOR / E2E_SEED_ADMIN (same defaults).
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
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-4');
const MODERATOR_EMAIL = process.env.E2E_SEED_MODERATOR ?? 'warden@graumark.test';
const ADMIN_EMAIL = process.env.E2E_SEED_ADMIN ?? 'castellan@graumark.test';
const PASSWORD = 'ashes-and-iron-42';
const VP = { width: 1440, height: 900 };
/** Names are unique server-wide: a letters-only suffix per run keeps re-runs apart. */
const SUFFIX = Date.now()
  .toString(26)
  .replace(/\d/g, (d) => 'qrstuvwxyz'[d])
  .slice(-5);
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const PLAYERS = {
  a: { key: 'a', name: `Aldra ${cap(SUFFIX)}`, hero: `Aldra${SUFFIX}`, className: 'Warrior' },
  b: { key: 'b', name: `Bertil ${cap(SUFFIX)}`, hero: `Bertil${SUFFIX}`, className: 'Hunter' },
  c: { key: 'c', name: `Pest ${cap(SUFFIX)}`, hero: `Pest${SUFFIX}`, className: 'Warrior' },
};
for (const p of Object.values(PLAYERS)) p.email = `p4-${p.key}-${SUFFIX}@graumark.test`;
const MUTE_REASON = `Rude words in the square (${SUFFIX})`;
const REPORT_NOTE = `Keeps shouting at newcomers by the well (${SUFFIX}).`;
/** An email address anywhere in page text (handles like `@d8amyqhw7jnh` have no domain). */
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[a-z]{2,}/i;

const started = Date.now();
const log = (text) => console.log(`[p4 ${((Date.now() - started) / 1000).toFixed(0)}s] ${text}`);
const problems = [];

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

/** Closes the return summary or any other dialog a settle opened. */
async function closeDialog(page) {
  for (let i = 0; i < 3; i++) {
    const dlg = page.getByRole('dialog');
    if (!(await dlg.isVisible().catch(() => false))) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
}

/** A fresh desktop context whose page fails the run on page errors and 429s. */
async function open(browser, label) {
  const context = await browser.newContext({ viewport: VP, deviceScaleFactor: 1 });
  const page = await context.newPage();
  // The return summary opens whenever a settle brings news (A farms all along): close it whenever
  // it stands in the way of an action.
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
  await closeDialog(page);
}

async function forgeHero(page, p) {
  await page.getByRole('heading', { name: 'Forge your first hero' }).waitFor();
  await page.getByLabel('Name', { exact: true }).fill(p.hero);
  await page.getByRole('radio', { name: new RegExp(`^${p.className}`) }).check({ force: true });
  await page.getByRole('button', { name: 'Forge hero' }).click();
  await page.waitForURL(/#\/hub/);
}

async function register(page, p) {
  await page.goto(`${baseUrl}/#/register`, { waitUntil: 'networkidle' });
  await page.getByLabel('Email').fill(p.email);
  await page.getByLabel('Display name').fill(p.name);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await forgeHero(page, p);
}

/** Staff log in; their seeded accounts have no hero yet, and the game screens need one. */
async function staffLogin(page, email, hero) {
  await page.goto(`${baseUrl}/#/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Enter', exact: true }).click();
  const forge = page.getByRole('heading', { name: 'Forge your first hero' });
  await Promise.race([forge.waitFor(), page.waitForURL(/#\/hub/)]);
  if (await forge.isVisible().catch(() => false)) {
    await forgeHero(page, { hero, className: 'Warrior' });
  }
  await closeDialog(page);
}

/** The hero's gold as the purse in the top bar shows it. */
async function purseGold(page) {
  const label = await page.locator('.purse__gold').getAttribute('aria-label');
  return Number((label ?? '0').replace(/[^\d]/g, ''));
}

async function noEmailOnPage(page, where) {
  const text = await page.locator('body').innerText();
  const hit = EMAIL_RE.exec(text);
  if (hit) throw new Error(`an email address is shown on ${where}: ${hit[0]}`);
}

async function run(browser) {
  const { a, b, c } = PLAYERS;

  log('1. A registers, forges a hero and farms the Abandoned Fields');
  const A = await open(browser, 'A');
  await register(A.page, a);
  await go(A.page, '#/area');
  await A.page.getByRole('button', { name: 'Farm Abandoned Fields' }).click();
  await A.page.getByRole('button', { name: `Call ${a.hero} back` }).waitFor();
  await shoot(A.page, 'p4-01-a-farming');
  const farmFrom = Date.now();

  log('1. B and C register and forge heroes');
  const B = await open(browser, 'B');
  await register(B.page, b);
  await shoot(B.page, 'p4-01-b-hub');
  const C = await open(browser, 'C');
  await register(C.page, c);
  await shoot(C.page, 'p4-01-c-hub');

  log('2. A sends B a friend request by display name');
  await go(A.page, '#/friends');
  const send = A.page.locator('form.letters', { hasText: 'Send word' });
  await send.getByLabel('Display name').fill(b.name);
  await send.getByRole('button', { name: 'Send a request' }).click();
  await A.page
    .locator('.letters__row', { hasText: b.name })
    .getByRole('button', { name: 'Withdraw' })
    .waitFor();
  await shoot(A.page, 'p4-02-a-request-sent');

  log('2. B accepts at the door');
  await go(B.page, '#/friends');
  const door = B.page.locator('.letters__row', { hasText: a.name });
  await door.getByRole('button', { name: 'Accept' }).click();
  await B.page.locator('.roll__row', { hasText: a.name }).waitFor();
  await shoot(B.page, 'p4-02-b-accepted');

  log('2. A sees B on the roll with a presence bucket and no time or date');
  await A.page.reload();
  await closeDialog(A.page);
  const row = A.page.locator('.roll__row', { hasText: b.name });
  await row.waitFor();
  const presence = (await row.locator('.roll__presence').innerText()).trim();
  if (!/^(Online now|Seen today|Seen this week|Away for a while)$/.test(presence)) {
    throw new Error(`B's presence on A's roll is not a bucket: "${presence}"`);
  }
  const rollText = (await A.page.locator('.fellowship__roll').innerText()).replace(/@\w+/g, '');
  const timeish =
    /\d{1,2}:\d{2}|\d{4}-\d{2}|\b\d+\s*(s|sec|min|minutes?|h|hours?|d|days?)\b|\bago\b|yesterday|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*day\b/i;
  if (timeish.test(rollText)) throw new Error(`A's roll shows a time or date: ${rollText}`);
  if (await A.page.locator('.fellowship__roll time').count()) {
    throw new Error("A's roll has a <time> element");
  }
  log(`   B is "${presence}"`);
  await shoot(A.page, 'p4-02-a-roll');

  log('3. C sends A a request; A blocks C');
  await go(C.page, '#/friends');
  const cSend = C.page.locator('form.letters', { hasText: 'Send word' });
  await cSend.getByLabel('Display name').fill(a.name);
  await cSend.getByRole('button', { name: 'Send a request' }).click();
  await C.page.locator('.letters__row', { hasText: a.name }).waitFor();
  await A.page.reload();
  await closeDialog(A.page);
  const pest = A.page.locator('.letters__row', { hasText: c.name });
  await pest.getByRole('button', { name: 'Block' }).click();
  await pest.getByRole('button', { name: 'Block?' }).click();
  await A.page.locator('.letters__row--struck', { hasText: c.name }).waitFor();
  if (
    await A.page.locator('.letters__row:not(.letters__row--struck)', { hasText: c.name }).count()
  ) {
    throw new Error("C's request is still at A's door after the block");
  }
  await shoot(A.page, 'p4-03-a-blocked-c');

  log("3. C's lookup of A's name finds no one");
  await go(C.page, '#/profile');
  await C.page.getByRole('heading', { name: c.name }).waitFor();
  const find = C.page.getByRole('search');
  await find.getByLabel('Find a player').fill(a.name);
  await find.getByRole('button', { name: 'Find' }).click();
  await find.getByRole('alert').filter({ hasText: 'No player goes by that name.' }).waitFor();
  if (/#\/profile\/\w/.test(C.page.url())) throw new Error('C was taken to a profile of A');
  await shoot(C.page, 'p4-03-c-not-found');

  log("4. B finds A's profile by name and reports A");
  await go(B.page, '#/profile');
  await B.page.getByRole('heading', { name: b.name }).waitFor();
  const bFind = B.page.getByRole('search');
  await bFind.getByLabel('Find a player').fill(a.name);
  await bFind.getByRole('button', { name: 'Find' }).click();
  await B.page.waitForURL(/#\/profile\/\w+/);
  await B.page.getByRole('heading', { name: a.name, level: 1 }).waitFor();
  await B.page.getByRole('button', { name: 'Report player' }).click();
  const dialog = B.page.getByRole('dialog', { name: 'Tell the wardens' });
  await dialog.waitFor();
  await dialog.getByRole('radio', { name: 'Harassment or bullying' }).check();
  await dialog.getByLabel(/What happened/).fill(REPORT_NOTE);
  await shoot(B.page, 'p4-04-b-report-dialog');
  await dialog.getByRole('button', { name: 'Send report' }).click();
  await B.page.getByRole('dialog', { name: 'Report sent' }).waitFor();
  await shoot(B.page, 'p4-04-b-report-sent');
  await B.page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();

  log('5. The moderator opens the queue and mutes A');
  const M = await open(browser, 'moderator');
  await staffLogin(M.page, MODERATOR_EMAIL, `Brann${SUFFIX}`);
  await M.page.getByRole('link', { name: 'Moderator queue' }).click();
  await M.page.getByRole('heading', { name: 'The docket' }).waitFor();
  const caseRow = M.page.getByRole('list', { name: 'Open cases' }).getByRole('button', {
    name: new RegExp(a.name),
  });
  await caseRow.click();
  const file = M.page.locator('article.case');
  await file.getByRole('heading', { name: a.name }).waitFor();
  await file.getByText(REPORT_NOTE).waitFor();
  await file.getByText(`by ${b.name}`, { exact: false }).waitFor();
  await shoot(M.page, 'p4-05-mod-case');
  await file.getByRole('radio', { name: /^Mute/ }).check();
  const durations = file.locator('.case__durations button');
  await durations.first().waitFor();
  await durations.first().click();
  await file.getByLabel('Reason (shown to the player)').fill(MUTE_REASON);
  await file.getByRole('button', { name: 'Issue sanction' }).click();
  await M.page.locator('.docket__notice', { hasText: `Muted: ${a.name}` }).waitFor();
  await shoot(M.page, 'p4-05-mod-muted');
  await M.context.close();

  log('5. A sees the mute and the reason in their standing');
  // The standing is read when the shell mounts: A comes back to the game (a fresh page load).
  await go(A.page, '#/hub');
  await A.page.reload();
  const strip = A.page.locator('.standing-strip', { hasText: 'You are muted' });
  await strip.waitFor();
  await shoot(A.page, 'p4-05-a-standing-strip');
  await strip.getByRole('link', { name: 'Why?' }).click();
  await A.page.waitForURL(/#\/account/);
  await A.page.locator('.writ__reason', { hasText: MUTE_REASON }).waitFor();
  await shoot(A.page, 'p4-05-a-account');

  log('6. A farms until there is gold to give');
  await go(A.page, '#/area');
  let gold = await purseGold(A.page);
  const goldBy = Date.now() + 150_000;
  while (gold < 10) {
    if (Date.now() > goldBy) throw new Error(`A holds only ${gold} gold after farming`);
    await A.page.waitForTimeout(8_000);
    await A.page.reload();
    await closeDialog(A.page);
    await A.page.locator('.purse__gold').waitFor();
    gold = await purseGold(A.page);
  }
  log(`   A holds ${gold} gold after ${((Date.now() - farmFrom) / 1000).toFixed(0)} s of farming`);

  log("6. A gives gold to the Warehouse's first stage");
  await go(A.page, '#/works');
  const project = A.page.locator('section', {
    has: A.page.getByRole('heading', { name: 'Restore the Graumark Warehouse' }),
  });
  await project.locator('.works__current-title', { hasText: 'Clear the rubble' }).waitFor();
  const giveGold = project.getByLabel('Give Gold');
  await giveGold.fill('5');
  for (const other of await project.locator('.works__give input').all()) {
    if ((await other.getAttribute('id')) === (await giveGold.getAttribute('id'))) continue;
    if (await other.isEnabled()) await other.fill('0');
  }
  await shoot(A.page, 'p4-06-a-works-before');
  await project.getByRole('button', { name: `Give from ${a.hero}` }).click();
  await project.getByRole('status').filter({ hasText: 'Given: 5 gold.' }).waitFor();
  await project
    .locator('.works__need', { hasText: 'Gold' })
    .locator('.works__share', { hasText: /^Your share today: 5 \// })
    .waitFor();
  await shoot(A.page, 'p4-06-a-works-given');

  log('6. The Warehouse is still closed and points to the works');
  await go(A.page, '#/warehouse');
  const closed = A.page.locator('.warehouse__closed');
  await closed.getByText('The doors are still off their hinges.').waitFor();
  await closed.getByRole('link', { name: 'See the town works' }).waitFor();
  await shoot(A.page, 'p4-06-a-warehouse-closed');

  log('7. The admin opens the panel: server status');
  const D = await open(browser, 'admin');
  await staffLogin(D.page, ADMIN_EMAIL, `Ysolde${SUFFIX}`);
  await D.page.getByRole('link', { name: 'Admin panel' }).click();
  await D.page.getByRole('heading', { name: 'The strongroom' }).waitFor();
  const tabs = D.page.getByRole('navigation', { name: 'Admin sections' });
  await tabs.getByRole('link', { name: /^Server/ }).click();
  const reg = D.page.locator('.gauge', { hasText: 'Registration' });
  await reg
    .locator('.gauge__value')
    .filter({ hasText: /Open|Invite only|Closed/ })
    .waitFor();
  const accounts = Number(
    (
      await D.page.locator('.gauge__counts div', { hasText: 'Accounts' }).locator('dd').innerText()
    ).replace(/[^\d]/g, ''),
  );
  // Three players and two staff from this run at least.
  if (!(accounts >= 5)) throw new Error(`server status counts ${accounts} accounts`);
  await noEmailOnPage(D.page, 'the server status');
  await shoot(D.page, 'p4-07-admin-status');

  log('7. Invites');
  await tabs.getByRole('link', { name: /^Invites/ }).click();
  await D.page.getByRole('heading', { name: 'Invite codes' }).waitFor();
  await D.page
    .getByText('No invites yet.')
    .or(D.page.getByRole('list', { name: 'Invite codes, newest first' }))
    .waitFor();
  await noEmailOnPage(D.page, 'the invites tab');
  await shoot(D.page, 'p4-07-admin-invites');

  log('7. Telemetry with an audit-log reconcile');
  await tabs.getByRole('link', { name: /^Telemetry/ }).click();
  const window_ = D.page.getByRole('form', { name: 'Telemetry window' });
  await window_.waitFor();
  await window_.getByRole('checkbox', { name: /Check against the audit log/ }).check();
  await window_.getByRole('button', { name: 'Show report' }).click();
  const tally = D.page.locator('.tally');
  await tally.waitFor({ timeout: 60_000 });
  const tallyText = await tally.innerText();
  if (!/all \d+ checks match/.test(tallyText)) throw new Error(`reconcile: ${tallyText}`);
  log(`   ${tallyText.split('\n')[0]}`);
  await noEmailOnPage(D.page, 'the telemetry tab');
  await shoot(D.page, 'p4-07-admin-telemetry');

  log("7. A player search for A, and A's file");
  await tabs.getByRole('link', { name: /^Players/ }).click();
  const seek = D.page.getByRole('search', { name: 'Find a player' });
  await seek.getByLabel('Display name or handle').fill(a.name);
  await seek.getByRole('button', { name: 'Search' }).click();
  const match = seek.getByRole('list', { name: 'Matching players' }).getByRole('link', {
    name: new RegExp(a.name),
  });
  await match.click();
  const dossier = D.page.locator('article.dossier');
  await dossier.getByRole('heading', { name: a.name }).waitFor();
  await dossier.getByRole('list', { name: 'Heroes' }).getByText(a.hero).waitFor();
  await dossier.getByRole('list', { name: 'Active sanctions' }).getByText(MUTE_REASON).waitFor();
  await noEmailOnPage(D.page, "A's player file");
  const html = await D.page.content();
  for (const email of [a.email, b.email, c.email, MODERATOR_EMAIL, ADMIN_EMAIL]) {
    if (html.includes(email)) throw new Error(`the admin page source holds ${email}`);
  }
  await shoot(D.page, 'p4-07-admin-player-file');
  await D.context.close();

  log('8. B (no staff role) at #/moderation and #/admin gets the unknown address');
  for (const hash of ['#/moderation', '#/admin']) {
    await B.page.goto(`${baseUrl}/${hash}`);
    await B.page.waitForURL(/#\/hub$/);
    await B.page.locator('.hub, .signpost').first().waitFor();
    for (const heading of ['The docket', 'The strongroom']) {
      if (await B.page.getByRole('heading', { name: heading }).count()) {
        throw new Error(`B sees "${heading}" at ${hash}`);
      }
    }
    if (await B.page.getByRole('link', { name: /Moderator queue|Admin panel/ }).count()) {
      throw new Error('B is shown a staff link');
    }
    await shoot(B.page, `p4-08-b-${hash.slice(2)}`);
  }

  for (const x of [A, B, C]) await x.context.close();
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
console.log(`✓ phase 4 social flow passed in ${took} s`);
