// Captures ticket T.5's Trading screen at desktop (1440) and mobile (390): closed (the default, a
// real fresh account), the inbox with offers and a hold, an offer's full view (the confirm screen
// with both pans and the 72-hour hold), the compose flow and its confirm step, a refusal with
// plain reasons, history, and the empty, loading and error states. The e2e server keeps trading
// closed and its accounts are new, so the open states are stubbed answers rendered by the real
// screen. Made-up players on example.test addresses; against a local server only:
//   pnpm --filter @worldforge/server e2e:serve
//   pnpm --filter @worldforge/web dev
//   node tools/screenshots/trading.mjs [baseUrl] [outDir]
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

const req = await playwright.request.newContext({ baseURL: baseUrl });
const reg = await req.post('/api/auth/register', {
  data: { email: `oswin${run}@example.test`, displayName: `Oswin ${tag}`, password: PASSWORD },
});
if (!reg.ok()) throw new Error(`register: ${reg.status()} ${await reg.text()}`);
const made = await req.post('/api/characters', {
  data: { name: `Oswin${tag}`, classId: 'warrior', appearance: { banner: 'moss' } },
});
if (!made.ok()) throw new Error(`character: ${made.status()} ${await made.text()}`);
const { character } = await made.json();
await req.post('/api/account/guide', { data: { dismissed: true } });
const { account } = await (await req.get('/api/account')).json();

// ---- Stubbed answers (the shapes of docs/API_CONVENTIONS.md "Trading") ----
const H = 3_600_000;
const at = (h) => new Date(Date.now() + h * H).toISOString();
const item = (id, rarityId, extra = {}) => ({
  id,
  baseId: 'longsword',
  rarityId,
  itemLevel: 22,
  affixes: [
    { affixId: 'crit-chance', tier: 2, value: 4 },
    { affixId: 'crit-damage', tier: 2, value: 18 },
  ],
  equippedSlot: null,
  source: 'farming',
  createdAt: at(-30),
  upgradeLevel: 0,
  variant: null,
  effectId: null,
  effectRoll: null,
  setId: null,
  mythicId: null,
  locked: false,
  binding: 'equip',
  bindingReason: 'fresh',
  tradeable: true,
  ...extra,
});
const side = (items = [], gold = 0, materials = []) => ({ items, gold, materials });
const hero = { name: `Oswin${tag}`, classId: 'warrior', level: 22 };
const theirs = { name: 'Brisa', classId: 'mage', level: 19 };
const offer = (id, extra) => ({
  id,
  status: 'open',
  role: 'receiver',
  with: { handle: 'brisavellxyz1', displayName: 'Brisa Vell' },
  yourHero: { id: character.id, ...hero },
  theirHero: theirs,
  give: side(),
  ask: side(),
  gift: false,
  createdAt: at(-5),
  expiresAt: at(43),
  closedAt: null,
  heldUntil: null,
  endText: null,
  ...extra,
});
const SWAP = offer('00000000-0000-7000-8000-000000000001', {
  give: side([item('00000000-0000-7000-8000-0000000000a1', 'legendary')], 400, [
    { materialId: 'timber', quantity: 20 },
  ]),
  ask: side([item('00000000-0000-7000-8000-0000000000a2', 'epic')], 0, [
    { materialId: 'ironOre', quantity: 12 },
  ]),
});
const GIFT = offer('00000000-0000-7000-8000-000000000002', {
  role: 'sender',
  with: { handle: 'merelfenxyz12', displayName: 'Merel of the Fens' },
  theirHero: { name: 'Merel', classId: 'hunter', level: 17 },
  give: side([], 1500),
  gift: true,
});
const DONE = offer('00000000-0000-7000-8000-000000000003', {
  status: 'accepted',
  closedAt: at(-20),
  heldUntil: at(52),
  give: side([], 800),
  gift: true,
});
const VOID = offer('00000000-0000-7000-8000-000000000004', {
  status: 'void',
  role: 'sender',
  closedAt: at(-40),
  give: side([], 300),
  ask: side([], 0, [{ materialId: 'soulShard', quantity: 4 }]),
  endText:
    'This offer was withdrawn: trading of gold is paused. Everything in it went back to the sender.',
});
const INBOX = {
  open: true,
  received: [SWAP],
  sent: [GIFT],
  recent: [DONE, VOID],
  holds: [
    {
      characterId: character.id,
      heroName: hero.name,
      gold: 800,
      materials: [],
      items: 0,
      heldUntil: at(52),
    },
  ],
  pollMs: 30_000,
};
const HEROES = {
  heroes: [
    {
      id: character.id,
      ...hero,
      gold: 6200,
      heldGold: 800,
      materials: [
        { materialId: 'timber', quantity: 140, held: 0 },
        { materialId: 'soulShard', quantity: 9, held: 0 },
      ],
      items: [
        item('00000000-0000-7000-8000-0000000000b1', 'epic'),
        item('00000000-0000-7000-8000-0000000000b2', 'legendary'),
      ],
    },
  ],
};
const PARTNER = {
  handle: 'brisavellxyz1',
  displayName: 'Brisa Vell',
  relation: 'friend',
  allowed: true,
  reasons: [],
  heroes: [
    {
      id: '00000000-0000-7000-8000-0000000000c1',
      ...theirs,
      items: [item('00000000-0000-7000-8000-0000000000a2', 'epic')],
    },
  ],
};
const PARTNERS = {
  partners: [
    { ...PARTNER, heroes: undefined },
    {
      handle: 'merelfenxyz12',
      displayName: 'Merel of the Fens',
      relation: 'guildmate',
      allowed: false,
      reasons: [
        {
          check: 'relation_too_new',
          party: 'pair',
          text: 'You need to have been friends or guildmates for at least 7 days.',
        },
      ],
    },
  ],
};

const browser = await playwright.chromium.launch();
try {
  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
      storageState: await req.storageState(),
    });
    const page = await context.newPage();
    await page.addInitScript(
      ([k]) => window.localStorage.setItem(k, '99.0.0'),
      [`wf.seen.notes.${account.id}`],
    );
    const screen = page.locator('.trading');
    const settle = async () => {
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
    };
    const shoot = async (name, full = false) => {
      await settle();
      const file = `${outDir}/trade-${name}-${vp.name}.png`;
      if (full) await page.screenshot({ path: file, fullPage: true });
      else await screen.screenshot({ path: file });
      console.log(`saved ${file}`);
    };
    const toTrading = async () => {
      await page.goto('about:blank');
      await page.goto(`${baseUrl}/#/trading`, { waitUntil: 'networkidle' });
    };
    const stub = (pattern, json, status = 200) =>
      page.route(pattern, (route) => route.fulfill({ status, json }));

    // 1. Closed: the real answer for a fresh account (the default).
    await toTrading();
    await screen.getByText('Trading is closed', { exact: true }).waitFor();
    await shoot('closed', true);

    // 2. Open: the inbox with an offer to you, a hold, and the tabs.
    await stub('**/api/trading/offers', INBOX);
    await stub('**/api/trading/heroes', HEROES);
    await stub(`**/api/trading/offers/${SWAP.id}`, {
      offer: SWAP,
      decision: { allowed: true, reasons: [] },
    });
    await toTrading();
    await screen.getByText('Offers to you (1)').waitFor();
    await shoot('inbox');

    // 3. The full view of an offer to you: both pans, every item, the hold.
    await screen.getByRole('button', { name: 'Look closely' }).click();
    await screen.getByRole('button', { name: 'Accept the trade' }).waitFor();
    await shoot('offer', true);

    // 4. The same offer when it can't be accepted now (plain reasons from tradeDecision).
    await page.unroute(`**/api/trading/offers/${SWAP.id}`);
    await stub(`**/api/trading/offers/${SWAP.id}`, {
      offer: SWAP,
      decision: {
        allowed: false,
        reasons: [
          {
            check: 'item_locked',
            party: 'offer',
            text: 'Unlock this item before offering it.',
          },
          {
            check: 'cap_reached',
            party: 'you',
            text: 'You can receive 3 Legendary or set items a week (Mythic and Void count too).',
          },
        ],
      },
    });
    await toTrading();
    await screen.getByRole('button', { name: 'Look closely' }).click();
    await screen.getByText('Unlock this item before offering it.').waitFor();
    await shoot('refused');

    // 5. Sent and history.
    await toTrading();
    await screen.getByRole('button', { name: /^Sent/ }).click();
    await shoot('sent');
    await stub('**/api/trading/offers/history', { offers: [DONE, VOID], nextCursor: null });
    await screen.getByRole('button', { name: 'History' }).click();
    await screen.getByText('Withdrawn', { exact: false }).first().waitFor();
    await shoot('history');

    // 6. Compose: a friend, your hero's items, theirs, then the confirm step.
    await stub('**/api/trading/partners', PARTNERS);
    await stub(`**/api/trading/partners/${PARTNER.handle}`, PARTNER);
    await screen.getByRole('button', { name: 'New offer' }).click();
    await screen.getByLabel('Trade with').selectOption(PARTNER.handle);
    await screen.getByRole('button', { name: 'Review the offer' }).waitFor();
    const frames = screen.locator('.trading__choose button');
    await frames.first().click();
    await frames.nth(2).click();
    await screen.getByLabel(/^Gold/).first().fill('500');
    await shoot('compose', true);
    await screen.getByRole('button', { name: 'Review the offer' }).click();
    await screen.getByRole('button', { name: 'Send the offer' }).waitFor();
    await shoot('confirm', true);

    // 7. Empty (open, nothing waiting), loading and error.
    await page.unroute('**/api/trading/offers');
    await stub('**/api/trading/offers', { ...INBOX, received: [], sent: [], recent: [], holds: [] });
    await toTrading();
    await screen.getByText('No offers waiting for you.', { exact: false }).waitFor();
    await shoot('empty');
    await page.unroute('**/api/trading/offers');
    let release;
    const held = new Promise((r) => (release = r));
    await page.route('**/api/trading/offers', async (route) => {
      await held;
      await route.fulfill({
        status: 500,
        json: { error: { code: 'internal_error', message: 'Internal Server Error' } },
      });
    });
    await page.goto('about:blank');
    await page.goto(`${baseUrl}/#/trading`);
    await screen.getByText('Laying out the scales…').waitFor();
    await shoot('loading');
    release();
    await screen.getByRole('button', { name: 'Try again' }).waitFor();
    await shoot('error');
    await context.close();
  }
} finally {
  await browser.close();
}
