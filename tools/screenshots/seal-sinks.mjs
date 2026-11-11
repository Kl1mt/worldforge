// Ticket 6.11: the Forge's Engraver and the Seal and Silver Counter at desktop (1440) and mobile
// (390): the engraver with a quote (seal-wax and silver inlay), the awakening-reserve warning, the
// success notice and the engraved item's tooltip, the "not enough" state, the empty state; the
// counter with its offers, after a purchase (owned), everything bought, loading and error (the only
// faked states); the collection book with the exchange's tinted banner and crests. The test
// account's hero is set up with D.4's admin tools (level, Seals, silver, a granted +10 Legendary
// ready to awaken); everything else goes through the panels.
//   E2E_SEED_ADMIN=castellan@graumark.test E2E_SEED_TEST_ACCOUNT=probe@graumark.test \
//     pnpm --filter @worldforge/server e2e:serve
//   pnpm --filter @worldforge/web dev
//   node tools/screenshots/seal-sinks.mjs [baseUrl] [outDir]
// Never against the live site.
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
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
const ADMIN = process.env.E2E_SEED_ADMIN ?? 'castellan@graumark.test';
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

async function api(ctx, method, path, data, key) {
  const res = await ctx.request.fetch(`${baseUrl}/api${path}`, {
    method,
    ...(data ? { data } : {}),
    headers: key ? { 'Idempotency-Key': key } : {},
  });
  if (!res.ok()) throw new Error(`${method} ${path}: ${res.status()} ${await res.text()}`);
  return res.status() === 204 ? null : res.json();
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

async function shoot(page, vp, name, locator, { notices = false } = {}) {
  if (!notices) await page.addStyleTag({ content: '.notices { display: none !important; }' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  if (overflow) console.warn(`! horizontal overflow on ${name} @ ${vp.name}`);
  const file = `${outDir}/seal-sinks-${name}-${vp.name}.png`;
  if (locator) await locator.screenshot({ path: file });
  else await page.screenshot({ path: file, fullPage: false });
  console.log(`saved ${file}`);
}

/** A fresh player with a hero (registered through the API), its admin hero URL for the tools. */
async function newHero(browser, vp, admin, tag, classId = 'warrior') {
  const c = await context(browser, vp);
  const stamp = `${vp.name}-${tag}-${Date.now()}`;
  await api(c.ctx, 'POST', '/auth/register', {
    email: `seal-${stamp}@graumark.test`,
    displayName: `Wax Wright ${tag} ${vp.name === 'mobile' ? 'II' : 'I'}`,
    password: PASSWORD,
  });
  const { account } = await api(c.ctx, 'GET', '/account');
  const { character } = await api(c.ctx, 'POST', '/characters', {
    name: `Odric${tag}${vp.name === 'mobile' ? 'm' : 'd'}`.slice(0, 16),
    classId,
    appearance: { banner: 'ember' },
  });
  await api(c.ctx, 'POST', '/account/guide', { dismissed: true }).catch(() => undefined);
  return { ...c, account, character };
}

mkdirSync(outDir, { recursive: true });
const browser = await playwright.chromium.launch();
try {
  const admin = await context(browser, VIEWPORTS[0]);
  await api(admin.ctx, 'POST', '/auth/login', { email: ADMIN, password: PASSWORD });
  for (const vp of VIEWPORTS) {
    // The test account is the one the admin tools may stock; make a fresh one per viewport by
    // registering and marking it a test account is CLI-only, so use the seeded probe for stocking.
    const probe = await context(browser, vp);
    await api(probe.ctx, 'POST', '/auth/login', {
      email: process.env.E2E_SEED_TEST_ACCOUNT ?? 'probe@graumark.test',
      password: PASSWORD,
    });
    const { account } = await api(probe.ctx, 'GET', '/account');
    let { characters } = await api(probe.ctx, 'GET', '/characters');
    const character =
      characters.find((c) => c.name === `Hralda${vp.name === 'mobile' ? 'm' : 'd'}`) ??
      (
        await api(probe.ctx, 'POST', '/characters', {
          name: `Hralda${vp.name === 'mobile' ? 'm' : 'd'}`,
          classId: 'warrior',
          appearance: { banner: 'ember' },
        })
      ).character;
    await api(probe.ctx, 'POST', '/account/guide', { dismissed: true }).catch(() => undefined);
    await api(probe.ctx, 'POST', `/characters/${character.id}/select`).catch(() => undefined);
    const heroUrl = `/admin/accounts/${account.handle}/heroes/${character.id}`;
    const reason = { reason: 'seal sink screenshots' };
    await api(admin.ctx, 'POST', `${heroUrl}/level`, { level: 38, ...reason }, randomUUID());
    await api(
      admin.ctx,
      'POST',
      `${heroUrl}/materials`,
      {
        mode: 'grant', // The mobile hero gets exactly one inlay's silver (the purchases are the desktop's).
        materials: { gravewardenSeal: 3, abbeySilver: vp.name === 'desktop' ? 60 : 15 },
        ...reason,
      },
      randomUUID(),
    );
    const items = [];
    for (const spec of [
      {
        baseId: 'longsword',
        rarityId: 'legendary',
        itemLevel: 37,
        variant: null,
        upgradeLevel: 10,
      },
      { baseId: 'vigil-helm', rarityId: 'epic', itemLevel: 35, variant: null, upgradeLevel: 4 },
    ]) {
      const { seed } = await api(admin.ctx, 'POST', `${heroUrl}/items/preview`, spec);
      const { item } = await api(
        admin.ctx,
        'POST',
        `${heroUrl}/items/grant`,
        { ...spec, seed, ...reason },
        randomUUID(),
      );
      items.push(item);
    }
    await api(probe.ctx, 'POST', `/characters/${character.id}/items/${items[0].id}/equip`, {
      slot: 'weapon',
    });
    await api(probe.ctx, 'POST', `/characters/${character.id}/items/${items[1].id}/equip`, {
      slot: 'head',
    });

    const page = probe.page;
    await page.goto(`${baseUrl}/#/forge`, { waitUntil: 'networkidle' });
    // The probe's other heroes may be active; pick this one through the hero switcher if needed.
    const engraver = page.locator('section[aria-labelledby="engrave-title"]');
    await engraver.waitFor();
    await engraver.scrollIntoViewIfNeeded();
    await engraver
      .getByRole('button', { name: /longsword/i })
      .first()
      .click();
    await engraver.locator('.engrave__detail').waitFor();
    // 3 Seals, a +10 Legendary ready to awaken: seal-wax would eat the reserve (warning).
    await engraver.getByRole('radio', { name: 'Unbowed' }).click();
    await engraver.locator('.engrave__warn').first().waitFor();
    await shoot(page, vp, 'engraver-warning', engraver);
    // Silver inlay instead: no warning.
    await engraver.getByRole('radio', { name: /Silver inlay/ }).click();
    await shoot(page, vp, 'engraver-quote', engraver);
    await engraver.getByRole('button', { name: /^Engrave for/ }).click();
    await page.getByText(/The engraver cuts/).waitFor();
    await shoot(page, vp, 'engraver-done', null, { notices: true });
    // The engraved item's tooltip at the Anvil.
    const anvil = page.locator('section[aria-labelledby="anvil-title"]');
    await anvil.scrollIntoViewIfNeeded();
    await anvil
      .getByRole('button', { name: /longsword/i })
      .first()
      .click();
    const tip = anvil.locator('.forge-work__item .tooltip');
    await tip.locator('.tooltip__engraving').waitFor();
    await shoot(page, vp, 'tooltip', tip);

    // The counter: offers, then a silver purchase (owned). Cosmetics belong to the account, so
    // the desktop pass shoots both widths of these two (the mobile pass finds them bought).
    if (vp.name === 'desktop') {
      const narrow = await context(browser, VIEWPORTS[1]);
      await narrow.ctx.addCookies(await probe.ctx.cookies());
      const counterAt = async (pg) => {
        await pg.goto(`${baseUrl}/#/forge`, { waitUntil: 'networkidle' });
        const c = pg.locator('section[aria-labelledby="exchange-title"]');
        await c.locator('.xoffer').first().waitFor();
        await c.scrollIntoViewIfNeeded();
        return c;
      };
      const counter = await counterAt(page);
      await shoot(page, vp, 'counter', counter);
      await shoot(narrow.page, VIEWPORTS[1], 'counter', await counterAt(narrow.page));
      await counter
        .locator('.xoffer', { hasText: 'Abbey-silver crest' })
        .getByRole('button', { name: 'Trade for it' })
        .click();
      await page.getByText(/is in your collection book/).waitFor();
      await counter.locator('.xoffer--owned').first().waitFor();
      await shoot(page, vp, 'counter-bought', counter);
      await shoot(page, vp, 'counter-bought-notice', null, { notices: true });
      await shoot(narrow.page, VIEWPORTS[1], 'counter-bought', await counterAt(narrow.page));
      await narrow.ctx.close();
    }

    // Everything bought (stock the rest; desktop only), and the not-enough engraver.
    if (vp.name === 'desktop') {
      await api(
        admin.ctx,
        'POST',
        `${heroUrl}/materials`,
        { mode: 'grant', materials: { gravewardenSeal: 9, abbeySilver: 44 }, ...reason },
        randomUUID(),
      );
      for (const id of [
        'title-colour.seal-wax',
        'title-colour.abbey-silver',
        'banner.silvered-seal',
        'crest.seal-wax',
      ]) {
        await api(
          probe.ctx,
          'POST',
          `/characters/${character.id}/exchange`,
          { cosmeticId: id },
          randomUUID(),
        ).catch(() => undefined);
      }
    }
    await page.reload({ waitUntil: 'networkidle' });
    const counter2 = page.locator('section[aria-labelledby="exchange-title"]');
    await counter2.locator('.xcounter__done').waitFor();
    await counter2.scrollIntoViewIfNeeded();
    await shoot(page, vp, 'counter-all', counter2);
    const engraver2 = page.locator('section[aria-labelledby="engrave-title"]');
    await engraver2.scrollIntoViewIfNeeded();
    await engraver2.getByRole('button', { name: /helm/i }).first().click();
    await engraver2.locator('.engrave__detail').waitFor();
    await engraver2.getByRole('radio', { name: /Silver inlay/ }).click();
    await engraver2.getByRole('button', { name: 'Not enough to pay' }).waitFor();
    await shoot(page, vp, 'engraver-short', engraver2);

    // The collection book with the exchange's styles worn.
    await api(
      probe.ctx,
      'POST',
      '/account/cosmetics/equip',
      {
        banner: 'banner.silvered-seal',
        crest: 'crest.seal-wax',
        titleColour: 'title-colour.abbey-silver',
      },
      randomUUID(),
    );
    await page.goto(`${baseUrl}/#/collection`, { waitUntil: 'networkidle' });
    await page.locator('main').waitFor();
    await page.waitForTimeout(500);
    await shoot(page, vp, 'book', page.locator('main'));

    // Loading and error (faked): the counter's request held, then failed.
    let hold;
    await page.route('**/api/characters/*/exchange', (route) => {
      hold = route;
    });
    await page.goto(`${baseUrl}/#/forge`, { waitUntil: 'domcontentloaded' });
    const loading = page.locator('section[aria-labelledby="exchange-title"]');
    await loading.getByText('Laying out the wares…').waitFor();
    await loading.scrollIntoViewIfNeeded();
    await shoot(page, vp, 'counter-loading', loading);
    await hold?.abort().catch(() => undefined);
    await page.unroute('**/api/characters/*/exchange');
    await page.route('**/api/characters/*/exchange', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'unavailable', message: 'down' } }),
      }),
    );
    await page.reload({ waitUntil: 'networkidle' });
    const failed = page.locator('section[aria-labelledby="exchange-title"]');
    await failed.getByText('The counter is shuttered.').waitFor();
    await failed.scrollIntoViewIfNeeded();
    await shoot(page, vp, 'counter-error', failed);
    await page.unroute('**/api/characters/*/exchange');
    await probe.ctx.close();

    // A new hero with nothing to engrave: the empty state.
    const fresh = await newHero(browser, vp, admin, 'x', 'hunter');
    await fresh.page.goto(`${baseUrl}/#/forge`, { waitUntil: 'networkidle' });
    const empty = fresh.page.locator('section[aria-labelledby="engrave-title"]');
    await empty.waitFor();
    const nothing = await empty.getByText('Nothing to engrave.').count();
    await empty.scrollIntoViewIfNeeded();
    await shoot(fresh.page, vp, nothing ? 'engraver-empty' : 'engraver-starter', empty);
    await fresh.ctx.close();
  }
} finally {
  await browser.close();
}
