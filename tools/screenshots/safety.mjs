// Captures the ticket 4.1 screens at desktop (1440) and mobile (390): the report dialog, the
// moderator queue with a case open, and the reported player's account standing after the mute.
// Needs the e2e server with a seeded moderator and the web dev server:
//   E2E_SEED_MODERATOR=warden@graumark.test pnpm --filter @worldforge/server e2e:serve
//   pnpm --filter @worldforge/web dev
//   node tools/screenshots/safety.mjs [baseUrl] [outDir]
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
const PASSWORD = 'ashes-and-iron-42';
const VIEWPORTS = [
  {
    name: 'desktop',
    width: 1440,
    height: 900,
    tag: 'a',
    hero: 'Aldous',
  },
  {
    name: 'mobile',
    width: 390,
    height: 844,
    tag: 'b',
    hero: 'Merewyn',
  },
];

async function shoot(page, vp, name, { full = true } = {}) {
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  if (overflow) console.warn(`! horizontal overflow on ${name} @ ${vp.name}`);
  if (full) {
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width: vp.width, height: Math.max(vp.height, height) });
  }
  const file = `${outDir}/${name}-${vp.name}.png`;
  await page.screenshot({ path: file });
  await page.setViewportSize({ width: vp.width, height: vp.height });
  console.log(`saved ${file}`);
}

async function context(browser, vp) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (err) => console.error(`! page error @ ${vp.name}: ${err.message}`));
  return { ctx, page };
}

async function api(ctx, method, path, data) {
  const res = await ctx.request.fetch(`${baseUrl}/api${path}`, {
    method,
    ...(data ? { data } : {}),
  });
  if (!res.ok()) throw new Error(`${method} ${path}: ${res.status()} ${await res.text()}`);
  return res.status() === 204 ? null : res.json();
}

async function player(browser, vp, displayName, hero) {
  const { ctx, page } = await context(browser, vp);
  const email = `${displayName.replace(/\s/g, '').toLowerCase()}-${Date.now()}@graumark.test`;
  await api(ctx, 'POST', '/auth/register', { email, displayName, password: PASSWORD });
  if (hero) {
    await api(ctx, 'POST', '/characters', {
      name: hero,
      classId: 'warrior',
      appearance: { banner: 'ember' },
    });
  }
  return { ctx, page };
}

// Registration is limited to 5 an hour per IP, so the run registers five accounts in all: the
// seeded moderator, one offender and one witness shared by both viewports, and a hero for each.
async function setup(browser) {
  mkdirSync(outDir, { recursive: true });
  const vp = VIEWPORTS[0];
  const offender = await player(browser, vp, 'Grim Jester', 'Jester');
  const witness = await player(browser, vp, 'Tilda Moor', null);
  const { player: ref } = await api(witness.ctx, 'GET', '/players/lookup?name=Grim%20Jester');
  await api(witness.ctx, 'POST', '/reports', {
    target: { kind: 'player', handle: ref.handle },
    reason: 'spam',
    note: 'Keeps offering cheap gold in every corner of the town.',
  });
  const warden = await context(browser, vp);
  await api(warden.ctx, 'POST', '/auth/login', {
    email: 'warden@graumark.test',
    password: PASSWORD,
  });
  await api(warden.ctx, 'POST', '/characters', {
    name: 'Brann',
    classId: 'warrior',
    appearance: { banner: 'dusk' },
  });
  return { offender, witness, warden };
}

async function run(browser, vp, shared) {
  const { offender, warden } = shared;
  // The hero reports the offender's name through the dialog.
  const hero = await player(browser, vp, `Pilgrim ${vp.tag.toUpperCase()}`, vp.hero);
  await hero.page.goto(`${baseUrl}/#/account`);
  await hero.page.getByRole('button', { name: 'Report a player' }).first().click();
  await hero.page.getByLabel('Display name').fill('grim jester');
  await hero.page.getByRole('button', { name: 'Find player' }).click();
  await hero.page.getByText('What are you reporting?').waitFor();
  await hero.page.getByText('Their display name').click();
  await hero.page.getByText('Harassment or bullying').click();
  await hero.page
    .getByLabel(/What happened/)
    .fill('Follows my hero from town to the fields and mocks every death.');
  await shoot(hero.page, vp, 'report-dialog', { full: false });
  await hero.page.getByRole('button', { name: 'Send report' }).click();
  await hero.page.getByText('Thank you. A moderator will look at it.').waitFor();
  await shoot(hero.page, vp, 'report-sent', { full: false });

  // The moderator's queue: desktop mutes the player (the witness's case); mobile forces a rename
  // on the name (both heroes' reports).
  await warden.page.setViewportSize({ width: vp.width, height: vp.height });
  await warden.page.goto(`${baseUrl}/#/moderation`);
  await warden.page.reload();
  const kind = vp.name === 'desktop' ? 'Player' : 'Display name';
  const row = warden.page.locator('.docket__row', { hasText: kind }).first();
  await row.waitFor();
  await row.click();
  await warden.page.getByRole('heading', { name: 'Grim Jester' }).waitFor();
  const action = vp.name === 'desktop' ? 'Mute' : 'Force rename';
  await warden.page.locator('.case').getByText(action, { exact: true }).click();
  await warden.page
    .getByRole('button', { name: vp.name === 'desktop' ? '1 day' : '7 days', exact: true })
    .click();
  await warden.page
    .getByLabel(/Reason \(shown to the player\)/)
    .fill(vp.name === 'desktop' ? 'Harassing other players.' : 'Names may not mock other players.');
  await shoot(warden.page, vp, 'moderator-queue');
  await warden.page.getByRole('button', { name: 'Issue sanction' }).click();
  await warden.page.locator('.docket__notice').waitFor();

  // The offender now sees why they cannot post (and, after the rename, that they must rename).
  await offender.page.setViewportSize({ width: vp.width, height: vp.height });
  await offender.page.goto(`${baseUrl}/#/account`);
  await offender.page.reload();
  await offender.page.getByText('Harassing other players.').first().waitFor();
  await shoot(offender.page, vp, 'account-standing');
  await hero.ctx.close();
}

const browser = await playwright.chromium.launch();
try {
  const shared = await setup(browser);
  for (const vp of VIEWPORTS) await run(browser, vp, shared);
  for (const c of Object.values(shared)) await c.ctx.close();
} finally {
  await browser.close();
}
