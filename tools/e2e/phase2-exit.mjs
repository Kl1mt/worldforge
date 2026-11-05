// Phase 2 exit-criteria run (ticket 2.8, GDD §15 Phase 2) against the real server and UI: register
// → farm the Abandoned Fields → progress through several areas, equipping drops → gather materials
// and level a profession → story quests and a contract at the Tavern → buy, sell, salvage and craft
// once → the Nameless Crypt and the Gravewarden → the Sunken Abbey opens and is farmed. The API
// twin of this run is apps/server/src/e2e/phase2-exit-criteria.test.ts. CI job `e2e-phase2`.
//
// One desktop session (1440) plays the whole loop. The first use of every feature goes through the
// UI (map, inventory, Tavern, Merchant, Forge, crypt); the long grind in between (about 32 game
// hours with B.1's pacing) is driven from the page with the page's own session, through the same
// public API the UI calls: settle, equip better drops, turn in, take quests and contracts, sell
// junk, travel. A mobile context (390) of the same account then captures the map and the Abbey.
// Fails (exit 1) when a step does not happen.
//
// Needs the e2e server with a very fast farming clock (1 real second = 20 game minutes), the web dev
// server and a built game-core (for the item bases):
//   E2E_TIME_SCALE=1200 OFFLINE_CAP_SECONDS=360000 pnpm --filter @worldforge/server e2e:serve
//   pnpm --filter @worldforge/web dev
//   pnpm --filter @worldforge/game-core build
//   node tools/e2e/phase2-exit.mjs [baseUrl] [outDir]
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { AREAS, ITEM_BASES, RARITY_IDS } from '../../packages/game-core/dist/index.js';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require(process.env.PLAYWRIGHT_PATH ?? '/opt/node-tools/node_modules/playwright');
}

const baseUrl = process.argv[2] ?? 'http://localhost:5173';
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-2');
const DESKTOP = { name: 'desktop', width: 1440, height: 900 };
const MOBILE = { name: 'mobile', width: 390, height: 844 };
/** Character names are unique server-wide: a fresh one per run (letters only). */
const HERO = `Hedwig${Date.now()
  .toString(26)
  .replace(/\d/g, (d) => 'qrstuvwxyz'[d])
  .slice(-5)}`;
const PASSWORD = 'ashes-and-iron-42';
/** Real-time budget for the grind (CI timeout is higher). */
const BUDGET_MS = Number(process.env.E2E_BUDGET_SECONDS ?? 600) * 1000;
/** Real time between two visits: about 2 game hours at ×1200. */
const STEP_MS = Number(process.env.E2E_STEP_MS ?? 6000);
const AREA_ORDER = ['abandonedFields', 'crowwood', 'oldBurialGrounds', 'blackwater', 'sunkenAbbey'];
/** What the page-side bot needs from game-core: each base's slot kind, classes and level. */
const BASES = Object.fromEntries(
  ITEM_BASES.map((b) => [b.id, { slot: b.slot, classes: b.classes, minItemLevel: b.minItemLevel }]),
);

/** Where each enemy lives (first area in order), for story kill objectives. */
const ENEMY_AREA = {};
for (const a of AREAS) for (const e of a.enemies) ENEMY_AREA[e.enemyId] ??= a.id;

const log = (text) => console.log(`[exit] ${text}`);

async function shoot(page, vp, name) {
  // Level-up and quest notices are toasts; they would cover the screen being recorded.
  for (const close of await page.getByRole('button', { name: /^Dismiss: / }).all()) {
    await close.click().catch(() => undefined);
  }
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() =>
    Promise.all([...document.images].map((img) => img.decode().catch(() => undefined))),
  );
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

/** Closes the return summary or any other dialog a settle opened. */
async function closeDialog(page) {
  for (let i = 0; i < 3; i++) {
    const dlg = page.getByRole('dialog');
    if (!(await dlg.isVisible().catch(() => false))) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
}

/**
 * One client visit, run inside the page with its session: settle, equip what beats the worn gear,
 * turn in ready quests, take the next story quest and free contract slots, sell junk, and travel to
 * where an unfinished story kill objective's enemy lives (else the highest open area; the Sunken
 * Abbey only once `holdAbbey` is off). `ui` leaves the Tavern to the UI.
 * Returns the state the Node side decides on.
 */
async function visit(page, { bases, rarities, areaOrder, enemyArea, ui, holdAbbey }) {
  return page.evaluate(
    async ({ bases, rarities, areaOrder, enemyArea, ui, holdAbbey }) => {
      const json = async (res) => ({
        status: res.status,
        body: await res.json().catch(() => null),
      });
      const get = async (url) => json(await fetch(url));
      const post = async (url, body, keyed = false) =>
        json(
          await fetch(url, {
            method: 'POST',
            headers: {
              ...(body ? { 'content-type': 'application/json' } : {}),
              ...(keyed ? { 'idempotency-key': crypto.randomUUID() } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          }),
        );
      const roster = (await get('/api/characters')).body;
      const id = roster.activeCharacterId;
      const c = `/api/characters/${id}`;
      const settled = await post(`${c}/activity/settle`);
      let hero = roster.characters.find((x) => x.id === id);
      const out = { settle: settled.status, kills: 0, deaths: 0, turnedIn: [] };
      if (settled.status === 200) {
        hero = settled.body.character;
        out.kills = settled.body.summary.kills;
        out.deaths = settled.body.summary.deaths;
        out.areaId = settled.body.activity?.areaId ?? null;
      }

      // Equip better drops.
      const score = (i) => rarities.indexOf(i.rarityId) * 6 + i.itemLevel;
      let inv = (await get(`${c}/inventory`)).body;
      for (const item of [...inv.inventory].sort((a, b) => score(b) - score(a))) {
        const base = bases[item.baseId];
        if (!base || !base.classes.includes(hero.classId) || base.minItemLevel > hero.level)
          continue;
        const slots = base.slot === 'ring' ? ['ring1', 'ring2'] : [base.slot];
        const worn = slots.map((s) => inv.equipped.find((e) => e.equippedSlot === s));
        const free = slots.find((_, n) => !worn[n]);
        const weakest = worn.filter(Boolean).sort((a, b) => score(a) - score(b))[0];
        const slot =
          free ?? (weakest && score(item) > score(weakest) ? weakest.equippedSlot : null);
        if (!slot) continue;
        const res = await post(`${c}/items/${item.id}/equip`, { slot });
        if (res.status === 200) inv = res.body;
      }

      // Sell junk (keep a few for the Merchant and Forge screens).
      const junk = inv.inventory.filter((i) => i.source !== 'quest').slice(0, -6);
      if (junk.length >= 8) {
        await post(`${c}/merchant/sell`, { itemIds: junk.map((i) => i.id) }, true);
      }

      // The Tavern (the UI does the first turn-in and the first contract itself).
      let board = (await get(`${c}/quests`)).body;
      if (!ui) {
        for (const q of board.quests.filter((x) => x.status === 'ready')) {
          const res = await post(`${c}/quests/${q.id}/turn-in`, null, true);
          if (res.status === 200) out.turnedIn.push(`${q.kind}:${q.questId}`);
        }
        board = (await get(`${c}/quests`)).body;
        if (board.story.next && board.story.next.blockers.length === 0) {
          await post(`${c}/quests`, { kind: 'story', questId: board.story.next.questId });
        }
        board = (await get(`${c}/quests`)).body;
        for (const offer of board.contracts.offers) {
          if (offer.accepted || board.contracts.active >= board.contracts.maxActive) continue;
          const res = await post(`${c}/quests`, { kind: 'contract', slot: offer.slot });
          if (res.status === 201) board = res.body;
        }
      }

      // Travel (not while in the crypt).
      const world = (await get(`${c}/world`)).body;
      const open = areaOrder.filter((a) => world.areas.find((x) => x.id === a)?.unlocked);
      out.open = open;
      out.progress = world.progress;
      const storyQuests = board.quests.filter((q) => q.kind === 'story');
      out.cryptQuest = storyQuests.some((q) => q.questId === 'theNamelessCrypt');
      out.readyStory = storyQuests.filter((q) => q.status === 'ready').map((q) => q.questId);
      // The first trip to the Sunken Abbey goes through the map (UI); until then stay before it.
      const reachable = holdAbbey ? open.filter((a) => a !== 'sunkenAbbey') : open;
      let target = reachable[reachable.length - 1];
      for (const q of storyQuests) {
        q.objectives.forEach((o, n) => {
          if (o.kind !== 'kill' || q.progress[n] >= o.count) return;
          const area = enemyArea[o.enemyId];
          if (area && open.includes(area)) target = area;
        });
      }
      out.target = target;
      const current = world.current?.pendingAreaId ?? world.current?.areaId ?? null;
      if (current && current !== target) {
        await post(`${c}/activity`, { areaId: target });
      }
      const mats = (await get(`${c}/materials`)).body;
      out.materials = mats.materials.length;
      out.profession = Math.max(...mats.professions.map((p) => p.level));
      hero = (await get(`${c}/activity`)).body.character;
      out.level = hero.level;
      out.gold = hero.gold;
      out.inventory = inv.inventory.length;
      return out;
    },
    { bases, rarities, areaOrder, enemyArea, ui, holdAbbey },
  );
}

/** The page to capture when a step fails. */
let failurePage = null;

async function main() {
  mkdirSync(outDir, { recursive: true });
  const browser = await playwright.chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: DESKTOP.width, height: DESKTOP.height },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  failurePage = page;
  page.on('pageerror', (err) => console.error(`! page error: ${err.message}`));
  const args = {
    bases: BASES,
    rarities: RARITY_IDS,
    areaOrder: AREA_ORDER,
    enemyArea: ENEMY_AREA,
    ui: false,
    holdAbbey: true,
  };
  const done = { equipped: false, turnIn: false, contract: false, buy: false, sell: false };
  Object.assign(done, { salvage: false, craft: false });
  const crypt = [];
  const story = [];
  let state;

  // 1. Register and forge a warrior.
  log('register');
  await page.goto(`${baseUrl}/#/register`, { waitUntil: 'networkidle' });
  await page.getByLabel('Email').fill(`exit-${Date.now().toString(36)}@graumark.test`);
  await page.getByLabel('Display name').fill(`Pilgrim ${String(Date.now()).slice(-6)}`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('heading', { name: 'Forge your first hero' }).waitFor();
  await page.getByLabel('Name', { exact: true }).fill(HERO);
  await page.getByRole('radio', { name: /^Warrior/ }).check({ force: true });
  await page.getByRole('button', { name: 'Forge hero' }).click();
  await page.waitForURL(/#\/hub/);
  const guide = page.locator('.guide').getByRole('button', { name: 'Close' });
  if (await guide.isVisible().catch(() => false)) await guide.click();

  // 2. Take the first story quest at the Tavern, then farm the Fields from the map.
  log('Tavern: first story quest');
  await page.goto(`${baseUrl}/#/tavern`);
  await page.getByRole('button', { name: 'Take the quest' }).click();
  await page.locator('.entry').first().waitFor();
  log('map: farm the Abandoned Fields');
  await page.goto(`${baseUrl}/#/map`);
  await page.getByRole('button', { name: /^Abandoned Fields/ }).click();
  await page.getByRole('button', { name: 'Farm Abandoned Fields' }).click();
  await page.waitForURL(/#\/area/);
  await page.locator('.log__loot').first().waitFor({ timeout: 60_000 });

  // 3. Equip the first usable drop in the Pack (UI).
  log('Pack: equip a drop');
  await page.goto(`${baseUrl}/#/inventory`);
  const sockets = page.locator('.stash__grid button.item-frame');
  await sockets.first().waitFor();
  const equip = page.getByRole('button', { name: 'Equip', exact: true });
  for (let i = 0; i < (await sockets.count()); i++) {
    await sockets.nth(i).click();
    if (await equip.isEnabled()) {
      await equip.click();
      await page.locator('.pack__notice--ok').waitFor();
      done.equipped = true;
      break;
    }
  }
  if (!done.equipped) throw new Error('no usable drop to equip');

  // 4. The grind, with the first use of each town feature through the UI.
  const started = Date.now();
  let gravewarden = false;
  let lastCryptLevel = 0;
  let abbeyLockedBeforeBoss = false;
  let abbeyFarmed = false;
  for (;;) {
    if (Date.now() - started > BUDGET_MS)
      throw new Error(`budget exceeded: ${JSON.stringify(state)}`);
    await page.goto(`${baseUrl}/#/hub`);
    await closeDialog(page);
    await page.waitForTimeout(STEP_MS); // ~2 game hours on the ×1200 clock
    state = await visit(page, { ...args, ui: !done.turnIn || !done.contract });
    // The visit changed the pack and quests behind the app's back: reload its view of them.
    await page.reload({ waitUntil: 'networkidle' });
    await closeDialog(page);
    story.push(...state.turnedIn.filter((q) => q.startsWith('story:')));
    log(
      `level ${state.level} in ${state.areaId} → ${state.target}; gold ${state.gold}; ` +
        `materials ${state.materials}, best profession ${state.profession}; pack ${state.inventory}`,
    );

    if (!done.turnIn && state.readyStory.length > 0) {
      log('Tavern: turn in (UI)');
      await page.goto(`${baseUrl}/#/tavern`);
      await page.getByRole('button', { name: 'Turn in' }).first().click();
      await page
        .getByText(/Collect|turned in|reward/i)
        .first()
        .waitFor()
        .catch(() => undefined);
      await page.waitForTimeout(500);
      await shoot(page, DESKTOP, 'exit-tavern-paid');
      story.push(`story:${state.readyStory[0]}`);
      done.turnIn = true;
    }
    if (!done.contract) {
      log('Tavern: take a contract (UI)');
      await page.goto(`${baseUrl}/#/tavern`);
      await page.getByRole('button', { name: 'Take contract' }).first().click();
      await page.waitForTimeout(500);
      done.contract = true;
    }
    if (!done.sell || (!done.buy && state.gold >= 200)) {
      // Like a player: clear the commons out of the (by now full) pack, then shop.
      log('Merchant: sell the commons, buy one (UI)');
      await page.goto(`${baseUrl}/#/merchant`);
      const panel = page.locator('.shop__panel', { has: page.locator('#sell-title') });
      await panel.locator('.picker__grid button').first().waitFor();
      await panel.getByRole('button', { name: 'All common' }).click();
      await panel.getByRole('button', { name: 'Sell', exact: true }).click();
      await page.getByText(/^Sold /).waitFor();
      done.sell = true;
      const buy = page.getByRole('button', { name: /^Buy / });
      await buy.first().waitFor();
      for (let i = 0; i < (await buy.count()) && state.gold >= 200; i++) {
        if (await buy.nth(i).isEnabled()) {
          await buy.nth(i).click();
          await page.getByText(/^Bought /).waitFor();
          done.buy = true;
          await shoot(page, DESKTOP, 'exit-merchant');
          break;
        }
      }
    }
    if (!done.salvage || !done.craft) {
      await page.goto(`${baseUrl}/#/forge`);
      await page.getByRole('heading', { name: 'Commissions' }).waitFor();
      const picker = page.locator('.shop__panel', { has: page.locator('#salvage-title') });
      if (await picker.locator('.picker__grid button').count()) {
        log('Forge: salvage up to uncommon (UI)');
        await picker.getByRole('button', { name: 'Up to uncommon' }).click();
        await picker.getByRole('button', { name: /^Salvage \d+$/ }).click();
        await page.getByText(/^Broken down for /).waitFor();
        done.salvage = true;
      }
    }
    if (!done.craft && done.salvage) {
      await page.goto(`${baseUrl}/#/forge`);
      await page.getByRole('heading', { name: 'Commissions' }).waitFor();
      const chest = page.getByRole('radio', { name: 'Chest' }).first();
      await chest.click();
      const forge = page.getByRole('button', { name: /^Forge chest/ }).first();
      if (await forge.isEnabled()) {
        log('Forge: craft (UI)');
        await forge.click();
        await page.getByText(/^The smith hands you/).waitFor();
        await shoot(page, DESKTOP, 'exit-forge-crafted');
        done.craft = true;
      }
    }

    if (!gravewarden && state.level >= 13 && state.cryptQuest && state.level > lastCryptLevel) {
      abbeyLockedBeforeBoss ||= !state.open.includes('sunkenAbbey');
      lastCryptLevel = state.level;
      log(`crypt: descend at level ${state.level} (UI)`);
      await page.goto(`${baseUrl}/#/crypt`);
      await page.getByRole('button', { name: 'Descend into the crypt' }).click();
      await page.getByRole('button', { name: 'Claim the spoils' }).waitFor({ timeout: 120_000 });
      await shoot(page, DESKTOP, 'exit-crypt-finished');
      await page.getByRole('button', { name: 'Claim the spoils' }).click();
      await page.getByRole('button', { name: 'Descend again' }).waitFor();
      const result = await page.evaluate(async () => {
        const roster = await (await fetch('/api/characters')).json();
        const w = await (await fetch(`/api/characters/${roster.activeCharacterId}/world`)).json();
        return { defeated: w.progress.gravewardenDefeated === true };
      });
      crypt.push({ level: state.level, bossDefeated: result.defeated });
      await shoot(page, DESKTOP, 'exit-crypt-result');
      gravewarden = result.defeated;
      // Back to the fields (the next visit travels on).
      await page.goto(`${baseUrl}/#/map`);
      await page.getByRole('button', { name: /^Abandoned Fields/ }).click();
      await page.getByRole('button', { name: 'Farm Abandoned Fields' }).click();
      await page.waitForURL(/#\/area/);
    }

    if (gravewarden && state.open.includes('sunkenAbbey') && !abbeyFarmed) {
      log('map: travel to the Sunken Abbey (UI)');
      await page.goto(`${baseUrl}/#/map`);
      await page.getByRole('button', { name: /^Sunken Abbey/ }).click();
      await page.getByRole('button', { name: 'Travel to Sunken Abbey' }).click();
      await page.waitForURL(/#\/area/);
      await page
        .getByRole('heading', { name: 'Sunken Abbey', exact: true })
        .waitFor({ timeout: 60_000 });
      await page.waitForTimeout(6000);
      await closeDialog(page);
      await shoot(page, DESKTOP, 'exit-area-abbey');
      state = await visit(page, { ...args, ui: true, holdAbbey: false });
      if (state.areaId !== 'sunkenAbbey' || state.kills === 0) {
        throw new Error(`did not farm the Abbey: ${JSON.stringify(state)}`);
      }
      abbeyFarmed = true;
    }
    if (abbeyFarmed && Object.values(done).every(Boolean)) break;
  }

  // 5. Checks: every Phase 2 exit criterion was met.
  if (!abbeyLockedBeforeBoss) throw new Error('the Sunken Abbey was not locked before the boss');
  if (state.materials < 3 || state.profession < 2) throw new Error('no gathering progress');
  const stories = new Set(story);
  if (stories.size < 4) throw new Error(`too few story quests turned in: ${[...stories]}`);

  // 6. The map with the crypt and every area open (retakes the stale map-desktop.png), at both sizes.
  log('map screenshots');
  await page.goto(`${baseUrl}/#/map`);
  await page.getByRole('button', { name: /^The Nameless Crypt/ }).click();
  await page.waitForTimeout(500);
  await shoot(page, DESKTOP, 'map');
  const mobile = await browser.newContext({
    viewport: { width: MOBILE.width, height: MOBILE.height },
    deviceScaleFactor: 1,
    storageState: await ctx.storageState(),
  });
  const m = await mobile.newPage();
  await m.goto(`${baseUrl}/#/map`, { waitUntil: 'networkidle' });
  // A new tab is a return: the summary dialog opens first.
  await m
    .getByRole('dialog')
    .waitFor({ timeout: 10_000 })
    .catch(() => undefined);
  await closeDialog(m);
  await m.getByRole('button', { name: /^The Nameless Crypt/ }).click();
  await m.waitForTimeout(500);
  await shoot(m, MOBILE, 'map');
  await m.goto(`${baseUrl}/#/area`);
  await m.getByRole('heading', { name: 'Sunken Abbey', exact: true }).waitFor();
  await m.waitForTimeout(4000);
  await closeDialog(m);
  await shoot(m, MOBILE, 'exit-area-abbey');

  console.log(
    JSON.stringify({
      realSeconds: Math.round((Date.now() - started) / 1000),
      level: state.level,
      crypt,
      story: [...stories],
      done,
    }),
  );
  await browser.close();
}

main().catch(async (err) => {
  console.error(err);
  await failurePage
    ?.screenshot({ path: `${outDir}/exit-failure.png`, fullPage: true })
    .then(() => console.error(`saved ${outDir}/exit-failure.png`))
    .catch(() => undefined);
  process.exit(1);
});
