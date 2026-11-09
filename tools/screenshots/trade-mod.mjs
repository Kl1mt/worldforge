// Captures ticket T.6's trade moderation UI at desktop (1440) and mobile (390): the docket's trade
// ledger (history), a trade's case file with the reversal dry run, the full-view confirm of what
// moves back (reason and a sanction filled in), the case after the reversal, a trade that can't be
// reversed (every reason in plain words), the trade pattern report, a reported trade in the queue,
// the empty, loading and error states, the admin panel's "Trades" tab, and on the player's side
// the Trading screen's report dialog and a reversed trade in the history. The e2e server keeps
// trading closed and its accounts are new, so the trades are stubbed answers rendered by the real
// screens. Made-up players; against a local server only, never the live site:
//   E2E_SEED_MODERATOR=warden@graumark.test E2E_SEED_ADMIN=castellan@graumark.test \
//     pnpm --filter @worldforge/server e2e:serve
//   pnpm --filter @worldforge/web dev
//   node tools/screenshots/trade-mod.mjs [baseUrl] [outDir]
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
const MODERATOR = process.env.MOD_EMAIL ?? 'warden@graumark.test';
const ADMIN = process.env.ADMIN_EMAIL ?? 'castellan@graumark.test';
const run = String(Date.now()).slice(-5);
const tag = [...run].map((d) => 'abcdefghij'[Number(d)]).join('');
mkdirSync(outDir, { recursive: true });

// ---- Stubbed answers (the shapes of docs/API_CONVENTIONS.md "Trade moderation") ----
const H = 3_600_000;
const at = (h) => new Date(Date.now() + h * H).toISOString();
const item = (id, rarityId, extra = {}) => ({
  id,
  baseId: 'longsword',
  rarityId,
  itemLevel: 22,
  affixes: [
    { affixId: 'crit-chance', tier: 2, value: 0.04 },
    { affixId: 'crit-damage', tier: 2, value: 0.18 },
  ],
  equippedSlot: null,
  source: 'farming',
  createdAt: at(-90),
  upgradeLevel: 0,
  variant: null,
  effectId: null,
  effectRoll: null,
  setId: null,
  mythicId: null,
  locked: false,
  binding: 'equip',
  bindingReason: 'fresh',
  tradeable: false,
  ...extra,
});
const who = (handle, displayName, role = 'player') => ({ handle, displayName, role });
const OSWIN = who('oswinhalexyz1', 'Oswin Hale');
const BRISA = who('brisavellxyz2', 'Brisa Vell');
const MEREL = who('merelfenxyz34', 'Merel of the Fens');
const TOBIN = who('tobinashxyz56', 'Tobin Ash');
const count = (items, gold, materialUnits, rarities = []) => ({
  items,
  gold,
  materialUnits,
  rarities,
});
const LEGENDARY = item('00000000-0000-7000-8000-0000000000a1', 'legendary');
const EPIC = item('00000000-0000-7000-8000-0000000000a2', 'epic');
const TRADE_ID = '00000000-0000-7000-8000-000000000101';
const SPENT_ID = '00000000-0000-7000-8000-000000000102';
const summary = (id, sender, receiver, extra = {}) => ({
  id,
  status: 'accepted',
  kind: 'swap',
  sender,
  receiver,
  createdAt: at(-30),
  closedAt: at(-28),
  reversedAt: null,
  give: count(1, 400, 20, ['legendary']),
  ask: count(1, 0, 0, ['epic']),
  ...extra,
});
const LIST = {
  trades: [
    summary(TRADE_ID, OSWIN, BRISA),
    summary(SPENT_ID, MEREL, TOBIN, {
      kind: 'gift',
      give: count(0, 4_500, 0),
      ask: count(0, 0, 0),
      closedAt: at(-100),
      createdAt: at(-101),
    }),
    summary('00000000-0000-7000-8000-000000000103', MEREL, TOBIN, {
      kind: 'gift',
      give: count(2, 0, 0, ['epic', 'epic']),
      ask: count(0, 0, 0),
      reversedAt: at(-120),
      closedAt: at(-150),
      createdAt: at(-151),
    }),
    summary('00000000-0000-7000-8000-000000000104', BRISA, OSWIN, {
      status: 'declined',
      kind: 'gift',
      give: count(0, 250, 0),
      ask: count(0, 0, 0),
      closedAt: at(-200),
      createdAt: at(-210),
    }),
  ],
  nextCursor: null,
};
const trail = (extra = []) => [
  {
    event: 'trade.offer',
    at: at(-30),
    by: { handle: OSWIN.handle, displayName: OSWIN.displayName },
    text: 'Offer sent; the sender’s side went into escrow.',
  },
  {
    event: 'trade.accept',
    at: at(-28),
    by: { handle: BRISA.handle, displayName: BRISA.displayName },
    text: 'Accepted: both sides changed hands and are held for 72 hours.',
  },
  ...extra,
];
const CASE = {
  ...summary(TRADE_ID, OSWIN, BRISA),
  relation: 'friend',
  expiresAt: at(18),
  senderHero: { name: 'Oswin', classId: 'warrior', level: 24 },
  receiverHero: { name: 'Brisa', classId: 'mage', level: 21 },
  give: {
    items: [LEGENDARY],
    gold: 400,
    materials: [{ materialId: 'timber', quantity: 20 }],
  },
  ask: { items: [EPIC], gold: 0, materials: [] },
  voidReason: null,
  heldUntil: at(44),
  reversal: null,
  reversible: { possible: true, deadline: at(308), refusals: [], canAct: true, cannotAct: null },
  moves: {
    toSender: {
      items: [{ id: LEGENDARY.id, worn: true, locked: false }],
      gold: 400,
      materials: [{ materialId: 'timber', quantity: 20 }],
    },
    toReceiver: { items: [{ id: EPIC.id, worn: false, locked: true }], gold: 0, materials: [] },
  },
  holds: [
    {
      party: 'receiver',
      heldUntil: at(44),
      releasedAt: null,
      gold: 400,
      materials: [{ materialId: 'timber', quantity: 20 }],
      items: 1,
    },
    { party: 'sender', heldUntil: at(44), releasedAt: null, gold: 0, materials: [], items: 1 },
  ],
  trail: trail(),
  reports: { open: 1, reportId: '00000000-0000-7000-8000-000000000201' },
};
const REVERSED = {
  ...CASE,
  reversedAt: at(0),
  reversal: {
    at: at(0),
    reason: 'Stolen account: the items were given away by someone else.',
    by: { handle: 'wardenbrannxy', displayName: 'Warden Brann' },
  },
  reversible: {
    ...CASE.reversible,
    possible: false,
    refusals: [{ check: 'already_reversed', text: 'This trade has already been reversed.' }],
  },
  holds: CASE.holds.map((h) => ({ ...h, releasedAt: at(0) })),
  trail: trail([
    {
      event: 'trade.release',
      at: at(0),
      by: null,
      text: 'A hold ended early: the trade was reversed.',
    },
    {
      event: 'trade.release',
      at: at(0),
      by: null,
      text: 'A hold ended early: the trade was reversed.',
    },
    {
      event: 'trade.reverse',
      at: at(0),
      by: { handle: 'wardenbrannxy', displayName: 'Warden Brann' },
      text: 'Reversed by a moderator: everything went back. Reason: Stolen account: the items were given away by someone else.',
    },
  ]),
};
const SPENT = {
  ...summary(SPENT_ID, MEREL, TOBIN, { kind: 'gift', closedAt: at(-100), createdAt: at(-101) }),
  give: {
    items: [item('00000000-0000-7000-8000-0000000000a3', 'epic', { setId: null })],
    gold: 4_500,
    materials: [],
  },
  ask: { items: [], gold: 0, materials: [] },
  relation: 'guildmate',
  expiresAt: at(-53),
  senderHero: { name: 'Merel', classId: 'hunter', level: 31 },
  receiverHero: { name: 'Tobin', classId: 'warrior', level: 16 },
  voidReason: null,
  heldUntil: at(-28),
  reversal: null,
  reversible: {
    possible: false,
    deadline: at(236),
    refusals: [
      {
        check: 'item_forged',
        party: 'receiver',
        itemId: '00000000-0000-7000-8000-0000000000a3',
        text: 'An item from this trade was worked at the Forge (an upgrade, reroll or improvement). That work can’t be undone without creating or destroying value.',
      },
      {
        check: 'gold_spent',
        party: 'receiver',
        received: 4_500,
        available: 1_120,
        text: 'The hero no longer holds the gold it received in this trade (part of it was spent or traded on).',
      },
    ],
    canAct: true,
    cannotAct: null,
  },
  moves: {
    toSender: {
      items: [{ id: '00000000-0000-7000-8000-0000000000a3', worn: false, locked: false }],
      gold: 4_500,
      materials: [],
    },
    toReceiver: { items: [], gold: 0, materials: [] },
  },
  holds: [
    {
      party: 'receiver',
      heldUntil: at(-28),
      releasedAt: at(-27),
      gold: 4_500,
      materials: [],
      items: 1,
    },
  ],
  trail: [
    {
      event: 'trade.offer',
      at: at(-101),
      by: { handle: MEREL.handle, displayName: MEREL.displayName },
      text: 'Offer sent; the sender’s side went into escrow.',
    },
    {
      event: 'trade.accept',
      at: at(-100),
      by: { handle: TOBIN.handle, displayName: TOBIN.displayName },
      text: 'Accepted: both sides changed hands and are held for 72 hours.',
    },
    { event: 'trade.release', at: at(-27), by: null, text: 'A hold ended.' },
  ],
  reports: { open: 0, reportId: null },
};
const flow = (items, gold, materialUnits) => ({ items, gold, materialUnits });
const PATTERNS = {
  windowDays: 28,
  rules: {},
  totals: { trades: 41, reversed: 2, flaggedItems: 1 },
  pairs: [
    {
      a: MEREL,
      b: TOBIN,
      trades: 6,
      aToB: flow(4, 9_000, 120),
      bToA: flow(0, 0, 0),
      reversed: 1,
      firstOn: at(-600).slice(0, 10),
      lastOn: at(-28).slice(0, 10),
      flags: ['oneWay', 'onlyEachOther', 'sameInvite'],
    },
    {
      a: OSWIN,
      b: BRISA,
      trades: 3,
      aToB: flow(2, 400, 20),
      bToA: flow(2, 0, 0),
      reversed: 0,
      firstOn: at(-300).slice(0, 10),
      lastOn: at(-28).slice(0, 10),
      flags: [],
    },
  ],
  accounts: [
    {
      who: TOBIN,
      trades: 6,
      partners: 1,
      given: flow(0, 0, 0),
      received: flow(4, 9_000, 120),
      receivedWhileNew: flow(4, 9_000, 120),
      accountAgeDays: 19,
      weeksAtCap: 2,
      capsReached: ['gold'],
      flaggedItems: 0,
      reversals: 1,
      flags: ['newAccountReceiving', 'atCap'],
    },
    {
      who: who('quillmarxyz78', 'Quill Marrow'),
      trades: 1,
      partners: 1,
      given: flow(1, 0, 0),
      received: flow(0, 0, 0),
      receivedWhileNew: flow(0, 0, 0),
      accountAgeDays: 64,
      weeksAtCap: 0,
      capsReached: [],
      flaggedItems: 1,
      reversals: 0,
      flags: ['flaggedItems'],
    },
  ],
  inviteClusters: [{ members: [MEREL, TOBIN, who('ivyreedxyz901', 'Ivy Reed')], trades: 8 }],
};
const QUEUE = {
  cases: [
    {
      reportId: '00000000-0000-7000-8000-000000000201',
      target: { kind: 'trade', id: TRADE_ID },
      subject: { ...OSWIN, sanctions: [], pastSanctions: 0 },
      current: { value: 'Completed trade', hidden: false },
      reports: [
        {
          id: '00000000-0000-7000-8000-000000000201',
          reason: 'scam',
          note: 'This was not me: someone used my account and gave my sword away.',
          createdAt: at(-3),
          context: { displayName: OSWIN.displayName, status: 'accepted' },
          reporter: { handle: BRISA.handle, displayName: BRISA.displayName },
        },
      ],
      openedAt: at(-3),
    },
  ],
  openCases: 1,
  nextCursor: null,
};

async function settleShot(page, path, selector) {
  await page.evaluate(() => document.fonts.ready);
  await page.locator(selector).screenshot({ path });
  console.log(`saved ${path}`);
}

async function login(ctx, email) {
  const res = await ctx.request.post(`${baseUrl}/api/auth/login`, {
    data: { email, password: PASSWORD },
  });
  if (!res.ok()) throw new Error(`login ${email}: ${res.status()} ${await res.text()}`);
  const { account } = await (await ctx.request.get(`${baseUrl}/api/account`)).json();
  // Staff play too: the app opens on hero creation until the account has one.
  const list = await (await ctx.request.get(`${baseUrl}/api/characters`)).json();
  if ((list.characters ?? list).length === 0) {
    const name = `${account.displayName.split(' ').pop()}${tag}`.slice(0, 16);
    await ctx.request.post(`${baseUrl}/api/characters`, {
      data: { name, classId: 'warrior', appearance: { banner: 'ash' } },
    });
  }
  await ctx.request.post(`${baseUrl}/api/account/guide`, { data: { dismissed: true } });
  return account;
}

const browser = await playwright.chromium.launch();
try {
  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    const me = await login(context, MODERATOR);
    await page.addInitScript(
      ([k]) => window.localStorage.setItem(k, '99.0.0'),
      [`wf.seen.notes.${me.id}`],
    );
    const settle = async () => {
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
    };
    const shoot = async (name, locator) => {
      await settle();
      const file = `${outDir}/trade-mod-${name}-${vp.name}.png`;
      await locator.screenshot({ path: file });
      console.log(`saved ${file}`);
    };
    const stub = (pattern, json, status = 200) =>
      page.route(pattern, (route) => route.fulfill({ status, json }));
    const desk = page.locator('.tdesk');
    const toDocket = async (hash = '#/moderation') => {
      await page.goto('about:blank');
      await page.goto(`${baseUrl}/${hash}`, { waitUntil: 'networkidle' });
    };

    // 1. The queue with a reported trade (it links to the trade's case).
    await stub('**/api/mod/queue*', QUEUE);
    await stub('**/api/mod/trading/patterns*', PATTERNS);
    await stub(/\/api\/mod\/trades(\?.*)?$/, LIST);
    await stub(`**/api/mod/trades/${TRADE_ID}`, CASE);
    await stub(`**/api/mod/trades/${SPENT_ID}`, SPENT);
    await toDocket();
    await page.getByRole('link', { name: 'Open the trade' }).waitFor();
    await shoot('queue', page.locator('.case'));

    // 2. The ledger and 3. the pattern report.
    await desk.getByText('Oswin Hale').first().waitFor();
    await shoot('ledger', desk);
    await page.locator('.tpat').getByText('Only each other').first().waitFor();
    await shoot('patterns', page.locator('.tpat'));

    // 4. A reversible case, 5. the confirm, 6. after the reversal.
    await page.getByRole('link', { name: 'Open the trade' }).click();
    await desk.getByRole('button', { name: 'Reverse this trade…' }).waitFor();
    await shoot('case', desk);
    await desk.getByRole('button', { name: 'Reverse this trade…' }).click();
    await desk
      .getByLabel('Reason (both players read it)')
      .fill('Stolen account: the items were given away by someone else.');
    await desk.locator('.tdesk__sanction select').first().selectOption('restrictTrade');
    await shoot('confirm', page.locator('.tdesk__confirm'));
    await page.route(`**/api/mod/trades/${TRADE_ID}/reverse`, (route) =>
      route.fulfill({
        status: 200,
        json: { offerId: TRADE_ID, reversedAt: at(0), sanction: null, case: REVERSED },
      }),
    );
    await desk.locator('.tdesk__sanction select').first().selectOption('');
    await desk.getByRole('button', { name: 'Reverse everything' }).click();
    await desk.getByText(/^Reversed\. Everything went back/).waitFor();
    await shoot('reversed', desk);

    // 7. A trade that can't be reversed.
    await desk.getByRole('button', { name: '← The ledger' }).click();
    await desk.getByRole('button', { name: 'Open the case' }).nth(1).click();
    await desk.getByText('This trade can’t be reversed').waitFor();
    await shoot('refused', desk);

    // 8. Empty, 9. error, 10. loading.
    await page.unroute(/\/api\/mod\/trades(\?.*)?$/);
    await stub(/\/api\/mod\/trades(\?.*)?$/, { trades: [], nextCursor: null });
    await toDocket();
    await desk.getByText(/No trades yet/).waitFor();
    await shoot('empty', desk);
    await page.unroute(/\/api\/mod\/trades(\?.*)?$/);
    await stub(
      /\/api\/mod\/trades(\?.*)?$/,
      { error: { code: 'unavailable', message: 'The database is busy.' } },
      503,
    );
    await toDocket();
    await desk.getByRole('button', { name: 'Try again' }).waitFor();
    await shoot('error', desk);
    await page.unroute(/\/api\/mod\/trades(\?.*)?$/);
    await page.route(/\/api\/mod\/trades(\?.*)?$/, () => undefined);
    await toDocket().catch(() => undefined);
    await desk.getByText('Opening the ledger…').waitFor();
    await shoot('loading', desk);
    await page.unroute(/\/api\/mod\/trades(\?.*)?$/);
    await context.close();

    // 11. The admin panel's Trades tab (desktop and mobile).
    const adminCtx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
    });
    const admin = await adminCtx.newPage();
    const adminAccount = await login(adminCtx, ADMIN);
    await admin.addInitScript(
      ([k]) => window.localStorage.setItem(k, '99.0.0'),
      [`wf.seen.notes.${adminAccount.id}`],
    );
    await admin.route('**/api/mod/trading/patterns*', (r) => r.fulfill({ json: PATTERNS }));
    await admin.route(/\/api\/mod\/trades(\?.*)?$/, (r) => r.fulfill({ json: LIST }));
    await admin.goto(`${baseUrl}/#/admin/trades`, { waitUntil: 'networkidle' });
    await admin.locator('.tdesk').getByText('Oswin Hale').first().waitFor();
    await admin.evaluate(() => document.fonts.ready);
    await admin.locator('.strong').screenshot({ path: `${outDir}/trade-mod-admin-${vp.name}.png` });
    console.log(`saved ${outDir}/trade-mod-admin-${vp.name}.png`);
    await adminCtx.close();

    // 12. The player's side: report a trade, and a reversed trade in the history.
    const playerCtx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
    });
    const req = playerCtx.request;
    const reg = await req.post(`${baseUrl}/api/auth/register`, {
      data: {
        email: `brisa${run}${vp.name}@example.test`,
        displayName: `Brisa ${tag}${vp.name[0]}`,
        password: PASSWORD,
      },
    });
    if (!reg.ok()) throw new Error(`register: ${reg.status()} ${await reg.text()}`);
    const made = await req.post(`${baseUrl}/api/characters`, {
      data: { name: `Brisa${tag}${vp.name[0]}`, classId: 'mage', appearance: { banner: 'dusk' } },
    });
    if (!made.ok()) throw new Error(`character: ${made.status()} ${await made.text()}`);
    const { character } = await made.json();
    await req.post(`${baseUrl}/api/account/guide`, { data: { dismissed: true } });
    const { account } = await (await req.get(`${baseUrl}/api/account`)).json();
    const player = await playerCtx.newPage();
    await player.addInitScript(
      ([k]) => window.localStorage.setItem(k, '99.0.0'),
      [`wf.seen.notes.${account.id}`],
    );
    const offer = {
      id: TRADE_ID,
      status: 'accepted',
      role: 'receiver',
      with: { handle: OSWIN.handle, displayName: OSWIN.displayName },
      yourHero: { id: character.id, name: `Brisa${tag}`, classId: 'mage', level: 21 },
      theirHero: { name: 'Oswin', classId: 'warrior', level: 24 },
      give: { items: [LEGENDARY], gold: 400, materials: [{ materialId: 'timber', quantity: 20 }] },
      ask: { items: [EPIC], gold: 0, materials: [] },
      gift: false,
      createdAt: at(-30),
      expiresAt: at(18),
      closedAt: at(-28),
      heldUntil: at(44),
      endText: null,
      reversal: null,
    };
    const inbox = {
      open: true,
      received: [],
      sent: [],
      recent: [offer],
      holds: [],
      pollMs: 30_000,
    };
    await player.route('**/api/trading/offers', (r) => r.fulfill({ json: inbox }));
    await player.route('**/api/trading/heroes', (r) => r.fulfill({ json: { heroes: [] } }));
    await player.route(`**/api/trading/offers/${TRADE_ID}`, (r) =>
      r.fulfill({ json: { offer, decision: null } }),
    );
    await player.route('**/api/trading/offers/history*', (r) =>
      r.fulfill({ json: { offers: [offer], nextCursor: null } }),
    );
    await player.goto(`${baseUrl}/#/trading`, { waitUntil: 'networkidle' });
    await player.locator('.trading').getByRole('button', { name: 'History' }).click();
    await player.locator('.trading').getByRole('button', { name: 'View' }).first().click();
    await player.getByRole('button', { name: 'Report this trade' }).click();
    await player
      .locator('dialog.report')
      .getByText('A scam, a stolen account or selling for real money')
      .click();
    await player.evaluate(() => document.fonts.ready);
    await player
      .locator('dialog.report')
      .screenshot({ path: `${outDir}/trade-mod-report-${vp.name}.png` });
    console.log(`saved ${outDir}/trade-mod-report-${vp.name}.png`);
    await player.keyboard.press('Escape');
    const reversedOffer = {
      ...offer,
      heldUntil: null,
      reversal: {
        at: at(0),
        reason: 'Stolen account: the items were given away by someone else.',
        text: 'A moderator reversed this trade: everything in it went back to the hero it came from.',
      },
    };
    await player.unroute(`**/api/trading/offers/${TRADE_ID}`);
    await player.unroute('**/api/trading/offers');
    await player.route('**/api/trading/offers', (r) =>
      r.fulfill({ json: { ...inbox, recent: [reversedOffer] } }),
    );
    await player.route(`**/api/trading/offers/${TRADE_ID}`, (r) =>
      r.fulfill({ json: { offer: reversedOffer, decision: null } }),
    );
    await player.unroute('**/api/trading/offers/history*');
    await player.route('**/api/trading/offers/history*', (r) =>
      r.fulfill({ json: { offers: [reversedOffer], nextCursor: null } }),
    );
    await player.goto('about:blank');
    await player.goto(`${baseUrl}/#/trading`, { waitUntil: 'networkidle' });
    await player.locator('.trading').getByRole('button', { name: 'History' }).click();
    await player.locator('.trading').getByText('Reversed by a moderator').waitFor();
    await settleShot(player, `${outDir}/trade-mod-player-history-${vp.name}.png`, '.trading');
    await player.locator('.trading').getByRole('button', { name: 'View' }).first().click();
    await player.getByText('The moderator’s reason').waitFor();
    await player.evaluate(() => document.fonts.ready);
    await player
      .locator('.trading')
      .screenshot({ path: `${outDir}/trade-mod-player-reversed-${vp.name}.png` });
    console.log(`saved ${outDir}/trade-mod-player-reversed-${vp.name}.png`);
    await playerCtx.close();
  }
} finally {
  await browser.close();
}
