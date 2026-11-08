// Captures ticket 5.7's account security screens at desktop (1440) and mobile (390) widths: the
// "verify your email" strip, the account screen's security panel (unverified, verified, mail not
// set up, loading error, the "log out other devices" confirm), the forgot-password screen (form,
// sent, mail not set up), the reset screen (form, a weak password, done, used and expired links),
// the verify screen (done, used link) and the login's per-account lock message.
// Made-up players on example.test addresses; mails never leave the e2e server, which writes them
// to E2E_MAIL_DIR, and this script reads the links from there. States the server cannot produce
// on demand (mail not set up, an expired link, a failed load, a locked login) are faked with
// Playwright route stubs; everything else is the real thing. Against a local server only:
//   E2E_MAIL_DIR=<dir> pnpm --filter @worldforge/server e2e:serve   (plus the web dev server)
//   node tools/screenshots/account-security.mjs [baseUrl] [outDir] [mailDir]
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
const mailDir = resolve(process.argv[4] ?? process.env.E2E_MAIL_DIR ?? 'mails');
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];
const PASSWORD = 'ashes-and-iron-42';
const run = String(Date.now()).slice(-5);
const tag = [...run].map((d) => 'abcdefghij'[Number(d)]).join('');

mkdirSync(outDir, { recursive: true });

/** The newest captured mail of a kind to an address, waiting for it to be written. */
async function mailTo(to, kind) {
  for (let i = 0; i < 50; i += 1) {
    const files = readdirSync(mailDir)
      .filter((f) => f.endsWith(`-${kind}.json`))
      .sort()
      .reverse();
    for (const f of files) {
      const m = JSON.parse(readFileSync(join(mailDir, f), 'utf8'));
      if (m.to.toLowerCase() === to.toLowerCase()) return m;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no ${kind} mail to ${to}`);
}
const linkOf = (m) => /https?:\/\/\S+/.exec(m.text)[0];
/** The hash part of a mailed link (the e2e server's base URL may differ from `baseUrl`). */
const hashOf = (m) => linkOf(m).slice(linkOf(m).indexOf('#'));

async function newPlayer(req, who) {
  const email = `${who}${run}@example.test`;
  const reg = await req.post('/api/auth/register', {
    data: {
      email,
      displayName: `${who[0].toUpperCase()}${who.slice(1)} ${tag}`,
      password: PASSWORD,
    },
  });
  if (!reg.ok()) throw new Error(`register: ${reg.status()} ${await reg.text()}`);
  const made = await req.post('/api/characters', {
    data: { name: `${who.slice(0, 4)}${tag}`, classId: 'hunter', appearance: { banner: 'moss' } },
  });
  if (!made.ok()) throw new Error(`character: ${made.status()} ${await made.text()}`);
  const guide = await req.post('/api/account/guide', { data: { dismissed: true } });
  if (!guide.ok()) throw new Error(`guide: ${guide.status()}`);
  const { account } = await (await req.get('/api/account')).json();
  return { email, account, storageState: await req.storageState() };
}

const browser = await playwright.chromium.launch();
try {
  for (const vp of VIEWPORTS) {
    // A fresh player per width (unverified), plus a second login so "other devices" shows one.
    const req = await playwright.request.newContext({ baseURL: baseUrl });
    const p = await newPlayer(req, vp.name === 'desktop' ? 'keyward' : 'keymob');
    const second = await playwright.request.newContext({ baseURL: baseUrl });
    await second.post('/api/auth/login', { data: { email: p.email, password: PASSWORD } });

    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
      storageState: p.storageState,
    });
    const page = await context.newPage();
    await page.addInitScript(
      ([k]) => window.localStorage.setItem(k, '99.0.0'),
      [`wf.seen.notes.${p.account.id}`],
    );
    const save = async (name, { full = false } = {}) => {
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
      const file = `${outDir}/${name}-${vp.name}.png`;
      await page.screenshot({ path: file, fullPage: full });
      console.log(`saved ${file}`);
    };
    const securityPanel = page.locator('.acct-sec');
    // A mailed link opens a fresh page (as from a mail client), never a hash change in this one.
    const openLink = async (hash) => {
      await page.goto('about:blank');
      await page.goto(`${baseUrl}/${hash}`, { waitUntil: 'networkidle' });
    };

    // 1. The strip on the town screen.
    await page.goto(`${baseUrl}/#/hub`, { waitUntil: 'networkidle' });
    await page.locator('.acct-verify-strip').waitFor();
    await save('verify-strip');

    // 2. The security panel, unverified (a letter is out), then the confirm for other devices.
    await page.goto(`${baseUrl}/#/account`, { waitUntil: 'networkidle' });
    await securityPanel.getByText('Not verified yet.').waitFor();
    await securityPanel.scrollIntoViewIfNeeded();
    await save('account-security-unverified', { full: true });
    await securityPanel.getByRole('button', { name: 'Log out other devices' }).click();
    await securityPanel.getByRole('button', { name: 'Yes, log them out' }).waitFor();
    await save('account-security-confirm', { full: true });
    await securityPanel.getByRole('button', { name: 'Yes, log them out' }).click();
    await securityPanel.getByText('1 other device was logged out.').waitFor();

    // 3. The change-email form, opened.
    await securityPanel.getByRole('button', { name: 'Change email address' }).click();
    await securityPanel.getByLabel('New email').fill(`new-${p.email}`);
    await save('account-security-change-email', { full: true });
    await securityPanel.getByRole('button', { name: 'Cancel' }).click();

    // 4. The panel without mail set up, and when it cannot be loaded (both stubbed).
    await page.route('**/api/account/security', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({
        response: res,
        json: { security: { ...body.security, mailEnabled: false, verificationPending: false } },
      });
    });
    await page.reload({ waitUntil: 'networkidle' });
    await securityPanel.getByText('Email is not set up on this server yet').waitFor();
    await save('account-security-no-mail', { full: true });
    await page.unroute('**/api/account/security');
    await page.route('**/api/account/security', (route) =>
      route.fulfill({
        status: 500,
        json: { error: { code: 'internal_error', message: 'Internal Server Error' } },
      }),
    );
    await page.reload({ waitUntil: 'networkidle' });
    await securityPanel.getByRole('button', { name: 'Try again' }).waitFor();
    await save('account-security-error', { full: true });
    await page.unroute('**/api/account/security');

    // 5. Verify through the mailed link: done, then the same link again (used).
    const verifyMail = await mailTo(p.email, 'verify_email');
    await openLink(hashOf(verifyMail));
    await page.getByRole('heading', { name: 'Your name is sealed' }).waitFor();
    await save('verify-done');
    await openLink(hashOf(verifyMail));
    await page.getByRole('heading', { name: 'This link does not open anything' }).waitFor();
    await save('verify-used');
    await page.goto(`${baseUrl}/#/account`, { waitUntil: 'networkidle' });
    await securityPanel.getByText(/^Verified/).waitFor();
    await save('account-security-verified', { full: true });

    // 6. Logged out: the gate's link, the forgot screen (form, sent, mail not set up).
    await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));
    await page.goto(`${baseUrl}/#/login`, { waitUntil: 'networkidle' });
    await page.getByRole('link', { name: 'Forgot your password?' }).click();
    await page.getByRole('heading', { name: 'Forgot your password?' }).waitFor();
    await page.getByLabel('Email', { exact: true }).fill(p.email);
    await save('forgot-form');
    await page.getByRole('button', { name: 'Send me a link' }).click();
    await page.getByRole('heading', { name: 'A letter is on its way' }).waitFor();
    await save('forgot-sent');
    await page.route('**/api/config', async (route) => {
      const res = await route.fetch();
      await route.fulfill({
        response: res,
        json: { ...(await res.json()), email: { enabled: false } },
      });
    });
    await openLink('#/forgot');
    await page.getByRole('heading', { name: 'No letters leave the Graumark yet' }).waitFor();
    await save('forgot-no-mail');
    await page.unroute('**/api/config');

    // 7. The reset screen: a weak password, then a good one; the link again (used); expired (stub).
    const resetMail = await mailTo(p.email, 'reset_password');
    await openLink(hashOf(resetMail));
    await page.getByRole('heading', { name: 'Choose a new password' }).waitFor();
    // The token has left the address bar.
    if (page.url().includes('token=')) throw new Error('the token stayed in the address bar');
    await save('reset-form');
    await page.getByLabel('New password', { exact: true }).fill('short');
    await page.getByRole('button', { name: 'Set the new password' }).click();
    await page.getByText('Use at least 10 characters.').waitFor();
    await save('reset-weak');
    await page.getByLabel('New password', { exact: true }).fill(`embers-and-salt-${run}`);
    await page.getByRole('button', { name: 'Set the new password' }).click();
    await page.getByRole('heading', { name: 'A new key is cut' }).waitFor();
    await save('reset-done');
    // The used link: the form opens (there is no separate token probe), and setting fails.
    await openLink(hashOf(resetMail));
    await page.getByLabel('New password', { exact: true }).fill('a-perfectly-fine-password');
    await page.getByRole('button', { name: 'Set the new password' }).click();
    await page.getByRole('heading', { name: 'This link does not open anything' }).waitFor();
    await save('reset-used');
    await page.route('**/api/auth/reset-password', (route) =>
      route.fulfill({
        status: 400,
        json: {
          error: { code: 'token_expired', message: 'This link has expired. Ask for a new one.' },
        },
      }),
    );
    const fake = 'Q'.repeat(43);
    await openLink(`#/reset?token=${fake}`);
    await page.getByLabel('New password', { exact: true }).fill('a-perfectly-fine-password');
    await page.getByRole('button', { name: 'Set the new password' }).click();
    await page.getByRole('heading', { name: 'This link has faded' }).waitFor();
    await save('reset-expired');
    await page.unroute('**/api/auth/reset-password');

    // 8. The login after too many wrong passwords (stubbed answer, the real message).
    await page.route('**/api/auth/login', (route) =>
      route.fulfill({
        status: 429,
        headers: { 'retry-after': '240' },
        json: {
          error: {
            code: 'rate_limited',
            message: 'Too many failed attempts for this account.',
            details: { retryAfterSeconds: 240, limit: 'account' },
          },
        },
      }),
    );
    await openLink('#/login');
    await page.getByLabel('Email', { exact: true }).fill(p.email);
    await page.getByLabel('Password', { exact: true }).fill('not-the-password');
    await page.getByRole('button', { name: 'Enter' }).click();
    await page.getByText('Too many wrong passwords for this account').waitFor();
    await save('login-locked');
    await page.unroute('**/api/auth/login');

    await context.close();
    await req.dispose();
    await second.dispose();
  }
} finally {
  await browser.close();
}
