// Captures ticket T.4's screens at desktop (1440) and mobile (390): the account screen's Trading
// panel while trading is closed (a fresh account: requirements unmet), the answer for a friend,
// the panel with trading open and every requirement met (stubbed: the e2e server keeps trading
// closed and its accounts are new), the empty state (no friends, stubbed), loading and error
// (stubbed), the moderator choosing "Restrict trading" in the queue, and the restricted player's
// standing. Made-up players on example.test addresses; against a local server only:
//   E2E_SEED_MODERATOR=warden@graumark.test pnpm --filter @worldforge/server e2e:serve
//   pnpm --filter @worldforge/web dev
//   node tools/screenshots/trade-eligibility.mjs [baseUrl] [outDir]
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
const tag = [...run].map((d) => 'abcdefghij'[Number(d)]).join('');
mkdirSync(outDir, { recursive: true });

async function newPlayer(who, name, banner) {
  const req = await playwright.request.newContext({ baseURL: baseUrl });
  const reg = await req.post('/api/auth/register', {
    data: { email: `${who}${run}@example.test`, displayName: `${name} ${tag}`, password: PASSWORD },
  });
  if (!reg.ok()) throw new Error(`register: ${reg.status()} ${await reg.text()}`);
  const made = await req.post('/api/characters', {
    data: { name: `${who.slice(0, 5)}${tag}`, classId: 'hunter', appearance: { banner } },
  });
  if (!made.ok()) throw new Error(`character: ${made.status()} ${await made.text()}`);
  await req.post('/api/account/guide', { data: { dismissed: true } });
  const { account } = await (await req.get('/api/account')).json();
  return { req, account };
}

const trader = await newPlayer('tamsin', 'Tamsin', 'moss');
const friend = await newPlayer('merel', 'Merel Fen', 'dusk');
await trader.req.post('/api/friends/requests', { data: { handle: friend.account.handle } });
const ok = await friend.req.post(`/api/friends/requests/${trader.account.handle}/accept`);
if (!ok.ok()) throw new Error(`accept: ${ok.status()} ${await ok.text()}`);
const warden = await playwright.request.newContext({ baseURL: baseUrl });
await warden.post('/api/auth/login', {
  data: { email: 'warden@graumark.test', password: PASSWORD },
});
await warden.post('/api/characters', {
  data: { name: 'Brann', classId: 'warrior', appearance: { banner: 'dusk' } },
});
await warden.post('/api/account/guide', { data: { dismissed: true } });

const browser = await playwright.chromium.launch();
try {
  for (const vp of VIEWPORTS) {
    const open = async (who) => {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 2,
        storageState: await who.storageState(),
      });
      const page = await context.newPage();
      return { context, page };
    };
    const { context, page } = await open(trader.req);
    await page.addInitScript(
      ([k]) => window.localStorage.setItem(k, '99.0.0'),
      [`wf.seen.notes.${trader.account.id}`],
    );
    const panel = page.locator('.trade-elig');
    const settle = async (p) => {
      await p.evaluate(() => document.fonts.ready);
      await p.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
    };
    const shootPanel = async (name) => {
      await settle(page);
      await panel.scrollIntoViewIfNeeded();
      const file = `${outDir}/trade-eligibility-${name}-${vp.name}.png`;
      await panel.screenshot({ path: file });
      console.log(`saved ${file}`);
    };
    const toAccount = async () => {
      // A fresh load each time (a hash change alone would not fetch again).
      await page.goto('about:blank');
      await page.goto(`${baseUrl}/#/account`, { waitUntil: 'networkidle' });
      await panel.locator('.trade-elig__reqs').waitFor();
    };

    // 1. Closed, a fresh account; the whole account screen once for context.
    await toAccount();
    await settle(page);
    await page.screenshot({
      path: `${outDir}/trade-eligibility-account-${vp.name}.png`,
      fullPage: true,
    });
    console.log(`saved trade-eligibility-account-${vp.name}`);
    await shootPanel('closed');

    // 2. Asking about the friend.
    await panel.getByRole('button', { name: 'Check' }).click();
    await panel.locator('.trade-elig__answer').waitFor();
    await shootPanel('friend');

    // 3. Trading open, every requirement met (stubbed answer, the real panel).
    await page.route('**/api/trading/eligibility', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      const used = { 'legendarySet:received': 1, 'gold:given': 2500, 'trades:any': 2 };
      await route.fulfill({
        response: res,
        json: {
          ...body,
          trading: { open: true, kinds: { items: true, materials: true, gold: false } },
          you: {
            eligible: true,
            requirements: body.you.requirements.map((r) => ({
              ...r,
              met: true,
              ...(r.id === 'accountAge'
                ? { text: 'Your account is old enough.', metAt: undefined }
                : {}),
              ...(r.id === 'heroLevel' ? { text: 'Your best hero is level 22.', value: 22 } : {}),
              ...(r.id === 'email' ? { text: 'Your email address is verified.' } : {}),
              ...(r.id === 'standing'
                ? { text: 'Nothing stops you from trading.', sanctions: [] }
                : {}),
            })),
          },
          usage: {
            ...body.usage,
            caps: body.usage.caps.map((c) => ({
              ...c,
              used: used[`${c.metric}:${c.direction}`] ?? 0,
            })),
          },
        },
      });
    });
    await toAccount();
    await panel.getByText('Your limits').waitFor();
    await shootPanel('open');
    await page.unroute('**/api/trading/eligibility');

    // 4. No friends yet (stubbed list).
    await page.route('**/api/friends', async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), friends: [] } });
    });
    await toAccount();
    await panel.getByText('you have no friends listed').waitFor();
    await shootPanel('no-friends');
    await page.unroute('**/api/friends');

    // 5. Loading and a failed load (stubbed).
    let release;
    const held = new Promise((r) => (release = r));
    await page.route('**/api/trading/eligibility', async (route) => {
      await held;
      await route.fulfill({
        status: 500,
        json: { error: { code: 'internal_error', message: 'Internal Server Error' } },
      });
    });
    await page.goto('about:blank');
    await page.goto(`${baseUrl}/#/account`);
    await panel.getByText('Reading the trade ledger…').waitFor();
    await shootPanel('loading');
    release();
    await panel.getByRole('button', { name: 'Try again' }).waitFor();
    await shootPanel('error');
    await page.unroute('**/api/trading/eligibility');

    // 6. The moderator restricts the trader's trading from a fresh report.
    const filed = await friend.req.post('/api/reports', {
      data: {
        target: { kind: 'player', handle: trader.account.handle },
        reason: 'spam',
        note: 'Keeps asking me to buy gold from a website.',
      },
    });
    if (!filed.ok()) throw new Error(`report: ${filed.status()} ${await filed.text()}`);
    const mod = await open(warden);
    await mod.page.goto(`${baseUrl}/#/moderation`, { waitUntil: 'networkidle' });
    const row = mod.page.locator('.docket__row', { hasText: 'Tamsin' }).first();
    await row.waitFor();
    await row.click();
    await mod.page.locator('.case').getByText('Restrict trading', { exact: true }).click();
    await mod.page.getByRole('button', { name: '7 days', exact: true }).click();
    await mod.page
      .getByLabel(/Reason \(shown to the player\)/)
      .fill('Offering gold for real money is not allowed.');
    await settle(mod.page);
    await mod.page.screenshot({ path: `${outDir}/moderation-restrict-trade-${vp.name}.png` });
    console.log(`saved moderation-restrict-trade-${vp.name}`);
    if (vp.name === 'desktop') {
      await mod.page.getByRole('button', { name: 'Issue sanction' }).click();
      await mod.page.locator('.docket__notice').waitFor();
    } else {
      // The restriction from the desktop pass is still active; dismiss this report.
      await mod.page.locator('.case').getByText('Dismiss', { exact: true }).click();
      await mod.page
        .getByRole('button', { name: /Dismiss|Close the case/ })
        .last()
        .click();
    }
    await mod.context.close();

    // 7. The restricted player's standing and panel.
    await toAccount();
    await page.getByText('Offering gold for real money is not allowed.').first().waitFor();
    await settle(page);
    await page.screenshot({
      path: `${outDir}/trade-eligibility-restricted-${vp.name}.png`,
      fullPage: true,
    });
    console.log(`saved trade-eligibility-restricted-${vp.name}`);
    await context.close();
  }
} finally {
  await browser.close();
  await trader.req.dispose();
  await friend.req.dispose();
  await warden.dispose();
}
