// Captures the ticket 5.1 UI: the Standing panel on the character screen (the four leaderboard
// scores and their breakdown), at desktop (1440) and mobile (390) widths, plus its empty, loading
// and error states.
// Needs `pnpm build` (for game-core's dist), `pnpm --filter @worldforge/server e2e:serve` and
// `pnpm --filter @worldforge/web dev`.
// Auth and the hero are real. A level-22 kit cannot be farmed in a screenshot run, so for the
// geared shots the script shows the hero at level 22 with the items below (game-core
// `generateItem`, one of them forged) and answers `GET …/scores` with game-core's own
// `computeScores` on exactly that state: the numbers are what the server computes for it.
// Display only: nothing is written to the server. The fresh-hero shot uses the real server answer.
//   node tools/screenshots/standing.mjs [baseUrl] [outDir]
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require(process.env.PLAYWRIGHT_PATH ?? '/opt/node-tools/node_modules/playwright');
}
const core = await import(pathToFileURL(resolve('packages/game-core/dist/index.js')).href);

const baseUrl = process.argv[2] ?? 'http://localhost:5173';
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-5');
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

const LEVEL = 22;
const EXPERIENCE = 214_500;
const PROGRESS = { gravewardenDefeated: true, cryptTierCleared: 2 };

/** A hunter's late-game kit at item level 21: epics +5, Legendaries (one Void), a forged ring. */
function kit() {
  const plan = [
    ['weapon', 'legendary', 6, 'void'],
    ['head', 'epic', 5],
    ['chest', 'legendary', 4],
    ['hands', 'epic', 5],
    ['feet', 'epic', 3],
    ['neck', 'rare', 2],
    ['ring1', 'epic', 5],
    ['ring2', 'epic', 0, null, true],
  ];
  let seed = 501;
  return plan.map(([slot, rarityId, upgradeLevel, variant, forged]) => {
    const kind = slot.startsWith('ring') ? 'ring' : slot;
    const base = core.ITEM_BASES.filter(
      (b) =>
        !b.unique && b.slot === kind && b.minItemLevel <= 21 && core.canClassUseItem(b, 'hunter'),
    ).sort((a, b) => b.tier - a.tier)[0];
    const item = core.generateItem({
      seed: seed++,
      itemLevel: 21,
      baseId: base.id,
      rarityId,
      classId: 'hunter',
    });
    const affixes = forged
      ? item.affixes.map((a) => ({ ...a, value: a.value * 30 }))
      : item.affixes;
    return {
      id: `00000000-0000-7000-8000-${String(seed).padStart(12, '0')}`,
      baseId: item.baseId,
      rarityId: item.rarityId,
      itemLevel: item.itemLevel,
      affixes,
      seed: item.seed,
      equippedSlot: slot,
      source: 'area:sunkenAbbey',
      createdAt: new Date().toISOString(),
      upgradeLevel,
      variant: variant ?? null,
      effectId: item.effectId ?? null,
      effectRoll: item.effectRoll ?? null,
      setId: item.setId ?? null,
      mythicId: item.mythicId ?? null,
      locked: false,
    };
  });
}

const items = kit();
const scores = core.computeScores({
  classId: 'hunter',
  level: LEVEL,
  experience: EXPERIENCE,
  equipment: items.map((i) => ({ ...i, slot: i.equippedSlot })),
  progress: PROGRESS,
  world: core.NO_WORLD_FLAGS,
  guildBossStage: 2,
});
const stats = core.deriveEquippedStats(
  'hunter',
  LEVEL,
  items.filter((i) => core.checkEquipment('hunter', [{ ...i, slot: i.equippedSlot }])[0].equipped),
);

async function shoot(page, vp, name, locator) {
  await page.evaluate(() => document.fonts.ready);
  const file = `${outDir}/${name}-${vp.name}.png`;
  await locator.screenshot({ path: file, style: '.bottombar { display: none !important; }' });
  console.log(`saved ${file}`);
}

async function hashIs(page, hash) {
  for (let i = 0; i < 100; i++) {
    if (new URL(page.url()).hash.startsWith(hash)) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`never reached ${hash} (at ${page.url()})`);
}

/** Shows the hero at level 22 wherever a response carries it. */
function lift(body) {
  const up = (c) =>
    c && typeof c === 'object' && 'classId' in c
      ? { ...c, level: LEVEL, experience: EXPERIENCE }
      : c;
  if (Array.isArray(body?.characters)) body.characters = body.characters.map(up);
  if (body?.character) body.character = up(body.character);
  return body;
}

mkdirSync(outDir, { recursive: true });
const browser = await playwright.chromium.launch();
try {
  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
    });
    const stamp = `${vp.name}${Date.now()}`;
    const reg = await context.request.post(`${baseUrl}/api/auth/register`, {
      data: {
        email: `${stamp}@graumark.test`,
        displayName: `Seeker ${String(Date.now()).slice(-6)}`,
        password: 'ashes-and-iron-42',
      },
    });
    if (!reg.ok()) throw new Error(`register failed: ${reg.status()}`);
    const page = await context.newPage();

    await page.goto(`${baseUrl}/#/character`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Forge your first hero' }).waitFor();
    const suffix = Array.from({ length: 4 }, () =>
      String.fromCharCode(97 + Math.floor(Math.random() * 26)),
    ).join('');
    await page
      .getByLabel('Name', { exact: true })
      .fill(`${vp.name === 'desktop' ? 'Isolde' : 'Wren'}${suffix}`);
    await page.getByRole('radio', { name: /^Hunter/ }).check({ force: true });
    await page.getByRole('radio', { name: 'Moss' }).check({ force: true });
    await page.getByRole('button', { name: 'Forge hero' }).click();
    await hashIs(page, '#/hub');

    // 1. A fresh hero: the real server answer (nothing equipped, the first field reached).
    await page.goto(`${baseUrl}/#/character`, { waitUntil: 'networkidle' });
    const panel = page.locator('section.standing');
    await panel.locator('.standing__list').waitFor();
    await panel.locator('summary', { hasText: 'Gear Score' }).click();
    await shoot(page, vp, 'standing-fresh', panel);

    // 2. Loading and error states.
    await page.route('**/api/characters/*/scores', async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.fulfill({
        status: 503,
        json: {
          error: { code: 'unavailable', message: 'The server is busy. Try again in a moment.' },
        },
      });
    });
    await page.reload();
    await panel.getByRole('status').waitFor();
    if (vp.name === 'desktop') await shoot(page, vp, 'standing-loading', panel);
    await panel.getByRole('alert').waitFor();
    await shoot(page, vp, 'standing-error', panel);
    await page.unroute('**/api/characters/*/scores');

    // 3. The geared hero (display only; scores from game-core for exactly this state).
    await page.route('**/api/characters', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: lift(await response.json()) });
    });
    await page.route('**/api/characters/*/activity', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: lift(await response.json()) });
    });
    await page.route('**/api/characters/*/inventory', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: { ...body, equipped: items, stats } });
    });
    await page.route('**/api/characters/*/scores', (route) => route.fulfill({ json: { scores } }));
    await page.reload({ waitUntil: 'networkidle' });
    await panel.locator('.standing__list').waitFor();
    await shoot(page, vp, 'standing', panel);
    await panel.locator('summary', { hasText: 'Gear Score' }).click();
    await shoot(page, vp, 'standing-gear', panel);
    await panel.locator('summary', { hasText: 'Gear Score' }).click();
    await panel.locator('summary', { hasText: 'Character Power' }).click();
    await shoot(page, vp, 'standing-power', panel);
    await panel.locator('summary', { hasText: 'Character Power' }).click();
    await panel.locator('summary', { hasText: 'PvE Progress' }).click();
    await panel.locator('summary', { hasText: 'Character Level' }).click();
    await shoot(page, vp, 'standing-progress', panel);
    await context.close();
  }
} finally {
  await browser.close();
}
