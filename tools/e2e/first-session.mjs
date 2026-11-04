// First-session run (ticket 2.7) against the real server and UI, at desktop (1440) and mobile
// (390): register → forge a hero → the guide points to the fields → farm → first drop ("new"
// markers, level-up notice) → equip → the Tavern → the guide is done and closed, and stays
// closed after a reload and a fresh login (remembered per account). On the way it captures the
// "what continues offline" note, an area-unlocked and a quest-complete notice, and the world
// map's "Places of Graumark" list. Fails (exit 1) when a step does not happen.
//
// Needs the e2e server with a fast farming clock and the web dev server:
//   E2E_TIME_SCALE=600 OFFLINE_CAP_SECONDS=36000 pnpm --filter @worldforge/server e2e:serve
//   pnpm --filter @worldforge/web dev
//   node tools/e2e/first-session.mjs [baseUrl] [outDir]
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
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-2');
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, hero: 'Wendel', className: 'Warrior' },
  { name: 'mobile', width: 390, height: 844, hero: 'Saoirse', className: 'Hunter' },
];
const PASSWORD = 'ashes-and-iron-42';
const step = (vp, text) => console.log(`[${vp.name}] ${text}`);

async function shoot(page, vp, name, { full = false } = {}) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() =>
    Promise.all([...document.images].map((img) => img.decode().catch(() => undefined))),
  );
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  if (overflow) console.warn(`! horizontal overflow on ${name} @ ${vp.name}`);
  const file = `${outDir}/${name}-${vp.name}.png`;
  // Navigation focuses <main>, which can scroll the top bar away; shots start at the top.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: file, fullPage: full });
  console.log(`saved ${file}`);
}

/** Closes the return dialog if a settle opened it. */
async function closeDialog(page) {
  const dlg = page.getByRole('dialog');
  if (await dlg.isVisible().catch(() => false)) await page.keyboard.press('Escape');
}

async function guideTitle(page) {
  return page.locator('.guide__title').textContent();
}

async function expectGuide(page, stepName) {
  await page.locator('.guide__name', { hasText: stepName }).waitFor({ timeout: 90_000 });
}

/** Navigates via the guide's own link (the guided path), not by URL. */
async function follow(page, label) {
  await page.locator('.guide').getByRole('link', { name: label }).click();
}

async function run(browser, vp) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
  });
  // Record every notice as it appears: with the fast clock several arrive in one burst and fade.
  await context.addInitScript(() => {
    window.__notices = [];
    new MutationObserver(() => {
      for (const el of document.querySelectorAll('.notice')) {
        const title = el.querySelector('.notice__title')?.textContent ?? '';
        const kind = [...el.classList].find((c) => c.startsWith('notice--'))?.slice(8) ?? '';
        if (!window.__notices.some((n) => n.title === title)) window.__notices.push({ kind, title });
      }
    }).observe(document, { childList: true, subtree: true });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  const tag = `${Date.now().toString(36)}${vp.name[0]}`;
  const email = `first-${tag}@graumark.test`;
  // Hero names are unique per server: a letters-only suffix keeps re-runs apart.
  const suffix = [...Date.now().toString(26).slice(-4)]
    .map((c) => String.fromCharCode(97 + (parseInt(c, 26) % 26)))
    .join('');
  const heroName = `${vp.hero}-${suffix}`;

  step(vp, 'register and forge a hero');
  await page.goto(`${baseUrl}/#/register`, { waitUntil: 'networkidle' });
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Display name').fill(`Newcomer ${String(Date.now()).slice(-6)}`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('heading', { name: 'Forge your first hero' }).waitFor();
  await page.getByLabel('Name', { exact: true }).fill(heroName);
  await page.getByRole('radio', { name: new RegExp(`^${vp.className}`) }).check({ force: true });
  await page.getByRole('button', { name: 'Forge hero' }).click();
  await page.waitForURL(/#\/hub/);

  step(vp, 'the guide greets the new hero in town');
  await expectGuide(page, 'Send your hero out');
  if (!(await guideTitle(page)).includes('1 of 5')) throw new Error('guide should start at 1 of 5');
  await shoot(page, vp, 'first-steps-hub');

  if (vp.name === 'mobile') {
    step(vp, 'hide the guide, bring it back from the status bar');
    await page.locator('.guide').getByRole('button', { name: 'Hide guide' }).click();
    await page.locator('.guide').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Show first steps' }).click();
    await expectGuide(page, 'Send your hero out');
  }

  step(vp, 'follow the guide to the fields; read what continues offline');
  await follow(page, 'To the fields');
  await page.waitForURL(/#\/area/);
  await page.locator('.offline__summary').click();
  await page.getByText('Carries on').waitFor();
  const offline = await page.locator('.offline').innerText();
  // The cap comes from the server (OFFLINE_CAP_SECONDS), not a placeholder.
  if (!/up to \d+ (hours?|min)/.test(offline) || offline.includes('a few hours')) {
    throw new Error(`offline note lacks the server cap: ${offline}`);
  }
  await shoot(page, vp, 'first-steps-area', { full: true });
  await page.locator('.offline__summary').click();

  step(vp, 'farm until the first drop (and the first level)');
  await page.getByRole('button', { name: 'Farm Abandoned Fields' }).click();
  await expectGuide(page, 'Wait for the first drop');
  await page.locator('.notice').first().waitFor({ timeout: 90_000 });
  await page.waitForTimeout(500);
  await shoot(page, vp, 'notice-level');
  await expectGuide(page, 'Equip it');
  await closeDialog(page);
  await page.locator('.spoils .item-frame--new').first().waitFor();
  await shoot(page, vp, 'first-steps-drop');

  step(vp, 'the Pack marks the new drops; equip one');
  const packNav = page.locator('.nav__link[href="#/inventory"] .new-tag:visible');
  await packNav.waitFor();
  await follow(page, 'Open the pack');
  await page.waitForURL(/#\/inventory/);
  await page.locator('.stash__grid .item-frame--new').first().waitFor();
  await shoot(page, vp, 'first-steps-pack');
  const sockets = page.locator('.stash__grid button.item-frame');
  const equipButton = page.getByRole('button', { name: 'Equip', exact: true });
  let picked = false;
  const count = await sockets.count();
  for (let i = 0; i < count && !picked; i++) {
    await sockets.nth(i).click();
    picked = await equipButton.isEnabled();
  }
  if (!picked) throw new Error(`no usable item among ${count} drops`);
  await equipButton.click();
  await page.locator('.pack__notice--ok').waitFor();
  await expectGuide(page, 'Visit the Tavern');

  step(vp, 'visit the Tavern: the path is done');
  await follow(page, 'To the Tavern');
  await page.waitForURL(/#\/tavern/);
  await page.locator('.guide__name', { hasText: 'The road is yours' }).waitFor();
  await page.locator('.note .new-tag').first().waitFor();
  await shoot(page, vp, 'first-steps-tavern');

  step(vp, 'take the story quest; farm until it is done (all three notice kinds)');
  await page.getByRole('button', { name: 'Take the quest' }).click();
  await page.locator('.entry').first().waitFor();
  await page.locator('.guide').getByRole('button', { name: 'Close' }).click();
  await page.locator('.guide').waitFor({ state: 'detached' });
  await page.goto(`${baseUrl}/#/area`);
  await page.locator('.notice--quest').first().waitFor({ timeout: 240_000 });
  await closeDialog(page);
  await shoot(page, vp, 'notice-quest');
  const seen = await page.evaluate(() => window.__notices);
  step(vp, `notices: ${seen.map((n) => `${n.kind}: ${n.title}`).join(' | ')}`);
  for (const kind of ['level', 'unlock', 'quest']) {
    if (!seen.some((n) => n.kind === kind)) throw new Error(`no ${kind} notice appeared`);
  }

  step(vp, 'the guide stays closed after a reload and a new login');
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.area__title').waitFor();
  if (await page.locator('.guide').count()) throw new Error('guide came back after a reload');
  const fresh = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  const again = await fresh.newPage();
  await again.goto(`${baseUrl}/#/login`, { waitUntil: 'networkidle' });
  await again.getByLabel('Email').fill(email);
  await again.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await again.getByRole('button', { name: 'Enter', exact: true }).click();
  await again.waitForURL(/#\/hub/);
  await again.locator('.hub, .signpost').first().waitFor();
  await again.waitForTimeout(1_000);
  if (await again.locator('.guide').count()) throw new Error('guide came back on a new login');
  await fresh.close();

  step(vp, 'the world map list');
  await page.goto(`${baseUrl}/#/map`);
  await page.locator('.ledger__row').first().waitFor();
  await closeDialog(page);
  await page.locator('.ledger').screenshot({ path: `${outDir}/map-ledger-${vp.name}.png` });
  console.log(`saved ${outDir}/map-ledger-${vp.name}.png`);
  // The state label shares the name's row: same top within a few pixels.
  const misaligned = await page.evaluate(() =>
    [...document.querySelectorAll('.ledger__row')].some((row) => {
      const name = row.querySelector('.ledger__name').getBoundingClientRect();
      const state = row.querySelector('.ledger__state').getBoundingClientRect();
      return state.bottom > name.bottom + 2 || state.top < name.top - 2;
    }),
  );
  if (misaligned) throw new Error('map ledger state labels are not on the name row');

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  await context.close();
}

mkdirSync(outDir, { recursive: true });
const browser = await playwright.chromium.launch();
let failed = false;
try {
  for (const vp of VIEWPORTS) {
    try {
      await run(browser, vp);
    } catch (err) {
      failed = true;
      console.error(`✗ [${vp.name}] ${err.message}`);
    }
  }
} finally {
  await browser.close();
}
if (failed) process.exit(1);
console.log('✓ first-session flow passed at desktop and mobile');
