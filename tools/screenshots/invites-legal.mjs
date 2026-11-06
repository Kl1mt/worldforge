// Captures the ticket D.2 screens at desktop (1440) and mobile (390): register with an invite
// link (prefilled code), a refused code, registration closed, and the privacy policy page. Also
// checks that the legal links are in the footer of the login, register, legal and character
// screens, and that an invite link registers. Needs `pnpm dev` with REGISTRATION_MODE=invite and
// an invite code with at least two uses (`pnpm admin:invite create --uses 3`).
//   node tools/screenshots/invites-legal.mjs <inviteCode> [baseUrl] [outDir]
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

const invite = process.argv[2];
if (!invite) {
  console.error('Usage: node tools/screenshots/invites-legal.mjs <inviteCode> [baseUrl] [outDir]');
  process.exit(2);
}
const baseUrl = process.argv[3] ?? 'http://localhost:5173';
const outDir = resolve(process.argv[4] ?? 'docs/screenshots/deploy');
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

async function shoot(page, vp, name) {
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  if (overflow) console.warn(`! horizontal overflow on ${name} @ ${vp.name}`);
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: vp.width, height: Math.max(vp.height, height) });
  const file = `${outDir}/${name}-${vp.name}.png`;
  await page.screenshot({ path: file });
  await page.setViewportSize({ width: vp.width, height: vp.height });
  console.log(`saved ${file}`);
}

async function expectLegalFooter(page, where) {
  const nav = page.getByRole('navigation', { name: 'Legal' });
  await nav.waitFor();
  for (const [name, href] of [
    ['Impressum', '#/impressum'],
    ['Datenschutz', '#/datenschutz'],
  ]) {
    const got = await nav.getByRole('link', { name }).getAttribute('href');
    if (got !== href) throw new Error(`${where}: footer link ${name} is ${got}`);
  }
  console.log(`ok: legal footer links on ${where}`);
}

mkdirSync(outDir, { recursive: true });
const browser = await playwright.chromium.launch();
let seq = Date.now() % 100000;
try {
  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    await page.goto(`${baseUrl}/#/login`, { waitUntil: 'networkidle' });
    await expectLegalFooter(page, `login @ ${vp.name}`);

    // An invite link in the query form lands on the register screen with the code filled in.
    await page.goto(`${baseUrl}/?invite=${invite}`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Sign the ledger' }).waitFor();
    const value = await page.getByLabel('Invite code').inputValue();
    if (value !== invite) throw new Error(`invite field holds "${value}"`);
    await expectLegalFooter(page, `register @ ${vp.name}`);
    await shoot(page, vp, 'register-invite');

    await page.getByLabel('Invite code').fill('AAAA-BBBB-CCCC-DDDD');
    await page.getByLabel('Email').fill(`d2-${vp.name}-${seq}@graumark.test`);
    await page.getByLabel('Display name').fill(`Herald ${seq % 1000}${vp.name[0]}`);
    await page.getByLabel('Password', { exact: true }).fill('ashes-and-iron-42');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByText('That invite code cannot be used', { exact: false }).waitFor();
    await shoot(page, vp, 'register-invite-error');

    await page.getByLabel('Invite code').fill(invite);
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.waitForURL(/#\/characters/);
    await expectLegalFooter(page, `characters @ ${vp.name}`);

    await page.goto(`${baseUrl}/#/datenschutz`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Datenschutzerklärung', level: 1 }).waitFor();
    await expectLegalFooter(page, `datenschutz @ ${vp.name}`);
    await shoot(page, vp, 'legal-datenschutz');
    await context.close();

    // Registration closed (the config answer is faked; the server would refuse with 403 too).
    const closed = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
    });
    const p2 = await closed.newPage();
    await p2.route('**/api/config', (route) =>
      route.fulfill({ json: { registration: { mode: 'closed' } } }),
    );
    await p2.goto(`${baseUrl}/#/register`, { waitUntil: 'networkidle' });
    await p2.getByRole('heading', { name: 'The ledger is closed' }).waitFor();
    await shoot(p2, vp, 'register-closed');
    await closed.close();
    seq += 1;
  }
} finally {
  await browser.close();
}
