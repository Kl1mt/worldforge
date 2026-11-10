// Phase 3 exit-criteria run (ticket 3.9, GDD §15 Phase 3) against the real server and UI. The API
// twin is apps/server/src/e2e/phase3-exit-criteria.test.ts. CI job `e2e-phase3`.
//
// One desktop session (1440) plays from a fresh account to the late game. The long grind (about
// 50–75 game hours) is driven from the page with the page's own session through the same public
// API the UI calls, like tools/e2e/phase2-exit.mjs: settle, equip better drops, keep valuable
// drops, sell junk, Tavern, upgrade worn gear at the Forge, travel. The first use of every Phase 3
// feature goes through the UI, with screenshots: the loot filter (Pack), an item lock (Pack), the
// Forge's upgrade, improve and rework, a targeted Abbey contract (Tavern, a ring), every crypt
// run including tiers II and III, and the Pack holding a valuable drop beyond its capacity (B.2).
// The run also needs a Legendary, a set piece, an upgrade failure and a pity-guaranteed upgrade,
// and fails if any request was rate limited (ticket 3.9: the per-account limits must not trip).
// After the run, CI stops the server and reconciles the telemetry with the audit log on its
// database (`pnpm report:telemetry -- --db playtest --reconcile`, E2E_DATA_DIR).
//
// Needs the e2e server with a fast farming clock (1 real second = 30 game minutes), the web dev
// server and a built game-core (for the item bases):
//   E2E_DATA_DIR=/tmp/wf-e2e E2E_TIME_SCALE=1800 OFFLINE_CAP_SECONDS=360000 \
//     pnpm --filter @worldforge/server e2e:serve
//   pnpm --filter @worldforge/web dev
//   pnpm --filter @worldforge/game-core build
//   node tools/e2e/phase3-exit.mjs [baseUrl] [outDir]
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
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-3');
const DESKTOP = { name: 'desktop', width: 1440, height: 900 };
const HERO = `Ysolde${Date.now()
  .toString(26)
  .replace(/\d/g, (d) => 'qrstuvwxyz'[d])
  .slice(-5)}`;
const PASSWORD = 'ashes-and-iron-42';
const BUDGET_MS = Number(process.env.E2E_BUDGET_SECONDS ?? 900) * 1000;
/** Real time between two visits: about 2 game hours at ×1800. */
const STEP_MS = Number(process.env.E2E_STEP_MS ?? 4000);
const CAPACITY = 60;
const AREA_ORDER = ['abandonedFields', 'crowwood', 'oldBurialGrounds', 'blackwater', 'sunkenAbbey'];
const BASES = Object.fromEntries(
  ITEM_BASES.map((b) => [b.id, { slot: b.slot, classes: b.classes, minItemLevel: b.minItemLevel }]),
);
/** Where each enemy lives and which areas yield each material (for quest objectives). */
const ENEMY_AREAS = {};
const MATERIAL_AREAS = {};
for (const a of AREAS) {
  for (const e of a.enemies) (ENEMY_AREAS[e.enemyId] ??= []).push(a.id);
  for (const m of a.materials) (MATERIAL_AREAS[m] ??= []).push(a.id);
}

const log = (text) => console.log(`[phase3] ${text}`);

async function shoot(page, name) {
  for (const close of await page.getByRole('button', { name: /^Dismiss: / }).all()) {
    await close.click().catch(() => undefined);
  }
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() =>
    Promise.all([...document.images].map((img) => img.decode().catch(() => undefined))),
  );
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: DESKTOP.width, height: Math.max(DESKTOP.height, height) });
  const file = `${outDir}/${name}-${DESKTOP.name}.png`;
  await page.screenshot({ path: file });
  await page.setViewportSize({ width: DESKTOP.width, height: DESKTOP.height });
  console.log(`saved ${file}`);
}

async function closeDialog(page) {
  for (let i = 0; i < 3; i++) {
    const dlg = page.getByRole('dialog');
    if (!(await dlg.isVisible().catch(() => false))) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
}

/**
 * One client visit inside the page (the journey of apps/server/src/e2e/journey.ts): settle, equip
 * better drops, sell junk (never quest rewards, locked items, set pieces, Mythics or Void), the
 * Tavern (the UI takes the first targeted contract), upgrade worn gear, travel. Returns what the
 * Node side decides on. Every request that answers 429 waits `Retry-After` and is counted.
 */
async function visit(page, args) {
  return page.evaluate(async (a) => {
    const out = { limited: 0, upgrades: [], turnedIn: [], kills: 0 };
    const call = async (method, url, body, keyed = false) => {
      const key = keyed ? crypto.randomUUID() : null;
      for (;;) {
        const res = await fetch(url, {
          method,
          headers: {
            ...(body ? { 'content-type': 'application/json' } : {}),
            ...(key ? { 'idempotency-key': key } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (res.status === 429) {
          out.limited += 1;
          const wait = Number(res.headers.get('retry-after') ?? 1);
          await new Promise((r) => setTimeout(r, wait * 1000));
          continue;
        }
        return { status: res.status, body: await res.json().catch(() => null) };
      }
    };
    const get = (url) => call('GET', url);
    const post = (url, body, keyed) => call('POST', url, body, keyed);

    const roster = (await get('/api/characters')).body;
    const id = roster.activeCharacterId;
    const c = `/api/characters/${id}`;
    const settled = await post(`${c}/activity/settle`);
    let hero = roster.characters.find((x) => x.id === id);
    if (settled.status === 200) {
      hero = settled.body.character;
      const s = settled.body.summary;
      out.kills = s.kills;
      out.areaId = settled.body.activity?.areaId ?? null;
      out.filterSold = s.filtered?.sold ?? 0;
      out.overCapacity = s.itemsOverCapacity ?? 0;
    }

    // Equip better drops (rarity, item level, upgrades).
    const score = (i) => a.rarities.indexOf(i.rarityId) * 6 + i.itemLevel + i.upgradeLevel / 2;
    let inv = (await get(`${c}/inventory`)).body;
    for (const item of [...inv.inventory].sort((x, y) => score(y) - score(x))) {
      const base = a.bases[item.baseId];
      if (!base || !base.classes.includes(hero.classId) || base.minItemLevel > hero.level) continue;
      const slots = base.slot === 'ring' ? ['ring1', 'ring2'] : [base.slot];
      const worn = slots.map((s) => inv.equipped.find((e) => e.equippedSlot === s));
      const free = slots.find((_, n) => !worn[n]);
      const weakest = worn.filter(Boolean).sort((x, y) => score(x) - score(y))[0];
      const slot = free ?? (weakest && score(item) > score(weakest) ? weakest.equippedSlot : null);
      if (!slot) continue;
      const res = await post(`${c}/items/${item.id}/equip`, { slot });
      if (res.status === 200) inv = res.body;
    }
    const kept = (i) => i.locked || i.setId !== null || i.mythicId !== null || i.variant !== null;
    const valuable = (i) =>
      i.rarityId === 'legendary' || i.rarityId === 'mythic' || i.setId !== null;
    const all = [...inv.equipped, ...inv.inventory];
    out.legendary = all.some((i) => i.rarityId === 'legendary' && i.setId === null);
    out.setPiece = all.some((i) => i.setId !== null);
    // The first valuable drop in the pack, for the UI's lock (found in the pack grid by id: the
    // grid shows the newest first, and the tidy-up below can still sell items before it).
    out.packValuableId = inv.inventory.find((i) => valuable(i) && !i.locked)?.id ?? null;
    out.lockedIds = all.filter((i) => i.locked).map((i) => i.id);

    if (a.tidy) {
      const junk = inv.inventory.filter((i) => i.source !== 'quest' && !kept(i)).slice(0, -4);
      if (junk.length >= 20) {
        const res = await post(`${c}/merchant/sell`, { itemIds: junk.map((i) => i.id) }, true);
        if (res.status === 200) inv = res.body.inventory;
      }
    }
    out.pack = inv.inventory.length;

    // The Tavern.
    let board = (await get(`${c}/quests`)).body;
    for (const q of board.quests.filter((x) => x.status === 'ready')) {
      const res = await post(`${c}/quests/${q.id}/turn-in`, null, true);
      if (res.status === 200) {
        out.turnedIn.push({ kind: q.kind, questId: q.questId, item: res.body.reward.item });
      }
    }
    board = (await get(`${c}/quests`)).body;
    if (board.story.next && board.story.next.blockers.length === 0) {
      await post(`${c}/quests`, { kind: 'story', questId: board.story.next.questId });
      board = (await get(`${c}/quests`)).body;
    }
    // A targeted ring contract is left to the UI; keep a contract slot free for it, or the
    // other contracts taken on this visit can fill all of them first (the UI's button is then
    // disabled: "You carry three contracts already").
    const targetedRing =
      !a.targetedTaken &&
      board.contracts.offers.some((o) => !o.accepted && o.rewardSlots.includes('ring'));
    const reserved = targetedRing ? 1 : 0;
    for (const offer of board.contracts.offers) {
      if (offer.accepted || board.contracts.active + reserved >= board.contracts.maxActive)
        continue;
      if (offer.rewardSlots.length > 0 && !a.targetedTaken) continue; // left to the UI

      const rewardSlot = offer.rewardSlots.includes('ring') ? 'ring' : offer.rewardSlots[0];
      const res = await post(`${c}/quests`, {
        kind: 'contract',
        slot: offer.slot,
        ...(rewardSlot ? { rewardSlot } : {}),
      });
      if (res.status === 201) board = res.body;
    }
    out.targetedOffer = targetedRing && board.contracts.active < board.contracts.maxActive;

    // The Forge's sink: upgrade worn gear, lowest level first; an item it can't pay for (gold, or
    // its tier's materials) is skipped for this visit.
    if (a.upgrade) {
      const skip = new Set();
      for (let n = 0; n < 10; n++) {
        const target = [...inv.equipped]
          .filter((i) => i.upgradeLevel < 10 && !skip.has(i.id))
          .sort((x, y) => x.upgradeLevel - y.upgradeLevel)[0];
        if (!target) break;
        const res = await post(`${c}/forge/upgrade`, { itemId: target.id }, true);
        if (res.status !== 200) {
          skip.add(target.id);
          continue;
        }
        const o = res.body.outcome;
        out.upgrades.push({ success: o.success, guaranteed: o.guaranteed, fromLevel: o.fromLevel });
        inv = res.body.inventory;
      }
    }

    // Travel: an open story or (from the Abbey on) contract objective, else the highest area.
    const world = (await get(`${c}/world`)).body;
    const open = a.areaOrder.filter((x) => world.areas.find((y) => y.id === x)?.unlocked);
    out.open = open;
    const reachable = a.holdAbbey ? open.filter((x) => x !== 'sunkenAbbey') : open;
    const areasFor = (o) =>
      o.kind === 'kill'
        ? (a.enemyAreas[o.enemyId] ?? [])
        : o.kind === 'gather'
          ? (a.materialAreas[o.materialId] ?? [])
          : [];
    /** The deepest reachable area where an unfinished objective of these quests can be done. */
    const want = (kind) =>
      board.quests
        .filter((q) => q.kind === kind)
        .flatMap((q) => q.objectives.filter((o, n) => 'count' in o && q.progress[n] < o.count))
        .map((o) => [...reachable].reverse().find((x) => areasFor(o).includes(x)))
        .find(Boolean);
    const story = want('story');
    out.target = story ?? (a.followContracts ? want('contract') : undefined) ?? reachable.at(-1);
    out.cryptQuest = board.quests.some((q) => q.questId === 'theNamelessCrypt');
    const current = world.current?.pendingAreaId ?? world.current?.areaId ?? null;
    if (current && current !== out.target) await post(`${c}/activity`, { areaId: out.target });

    const dungeon = (await get(`${c}/dungeon`)).body;
    out.tierCleared = dungeon.dungeons[0].tierCleared;
    out.gravewarden = world.progress.gravewardenDefeated;
    hero = (await get(`${c}/activity`)).body.character;
    out.level = hero.level;
    out.gold = hero.gold;
    return out;
  }, args);
}

let failurePage = null;

async function main() {
  mkdirSync(outDir, { recursive: true });
  const browser = await playwright.chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: DESKTOP.width, height: DESKTOP.height },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  // A control that never appears fails the run instead of hanging it (crypt waits pass their own).
  page.setDefaultTimeout(30_000);
  failurePage = page;
  page.on('pageerror', (err) => console.error(`! page error: ${err.message}`));
  // Rate limiting of the app's own requests (the bot's are counted in `visit`).
  let appLimited = 0;
  page.on('response', (res) => {
    if (res.status() === 429) appLimited += 1;
  });
  const args = {
    bases: BASES,
    rarities: RARITY_IDS,
    areaOrder: AREA_ORDER,
    enemyAreas: ENEMY_AREAS,
    materialAreas: MATERIAL_AREAS,
    holdAbbey: false,
    tidy: true,
    upgrade: false,
    followContracts: false,
    targetedTaken: false,
  };
  const seen = {
    filter: false,
    filterSold: 0,
    locked: false,
    forgeUi: false,
    upgradeFailure: false,
    pity: false,
    upgrades: 0,
    targetedTaken: false,
    targeted: null,
    legendary: false,
    setPiece: false,
    overCapacity: 0,
    limited: 0,
  };
  const crypt = [];
  let state;

  // 1. Register and forge a hunter (the API run's default is a warrior).
  log('register');
  await page.goto(`${baseUrl}/#/register`, { waitUntil: 'networkidle' });
  await page.getByLabel('Email').fill(`p3-${Date.now().toString(36)}@graumark.test`);
  await page.getByLabel('Display name').fill(`Seeker ${String(Date.now()).slice(-6)}`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('heading', { name: 'Forge your first hero' }).waitFor();
  await page.getByLabel('Name', { exact: true }).fill(HERO);
  await page.getByRole('radio', { name: /^Hunter/ }).check({ force: true });
  await page.getByRole('button', { name: 'Forge hero' }).click();
  await page.waitForURL(/#\/hub/);
  const guide = page.locator('.guide').getByRole('button', { name: 'Close' });
  if (await guide.isVisible().catch(() => false)) await guide.click();
  await page.goto(`${baseUrl}/#/map`);
  await page.getByRole('button', { name: /^Abandoned Fields/ }).click();
  await page.getByRole('button', { name: 'Farm Abandoned Fields' }).click();
  await page.waitForURL(/#\/area/);

  /** A crypt run through the UI at a tier (1–3); returns whether the Gravewarden fell. */
  const cryptRun = async (tier) => {
    log(`crypt: tier ${tier} at level ${state.level} (UI)`);
    await page.goto(`${baseUrl}/#/crypt`);
    const depth = page.getByRole('radiogroup', { name: 'Depth' }).getByRole('radio');
    await depth.first().waitFor();
    await depth.nth(tier - 1).click();
    await page.getByRole('button', { name: /^Descend (into the crypt|to )/ }).click();
    await page.getByRole('button', { name: 'Claim the spoils' }).waitFor({ timeout: 120_000 });
    if (tier > 1) await shoot(page, `p3-crypt-tier${tier}-finished`);
    await page.getByRole('button', { name: 'Claim the spoils' }).click();
    await page.getByRole('button', { name: 'Descend again' }).waitFor();
    const after = await page.evaluate(async () => {
      const roster = await (await fetch('/api/characters')).json();
      const d = await (await fetch(`/api/characters/${roster.activeCharacterId}/dungeon`)).json();
      return d.dungeons[0].tierCleared;
    });
    const won = after >= tier;
    crypt.push({ tier, level: state.level, won });
    if (tier > 1) await shoot(page, `p3-crypt-tier${tier}-result`);
    await page.goto(`${baseUrl}/#/map`);
    await page.getByRole('button', { name: /^Abandoned Fields/ }).click();
    await page.getByRole('button', { name: 'Farm Abandoned Fields' }).click();
    await page.waitForURL(/#\/area/);
    return won;
  };

  const started = Date.now();
  let lastCryptLevel = { 1: 0, 2: 0, 3: 0 };
  let filling = false;
  for (;;) {
    if (Date.now() - started > BUDGET_MS) {
      throw new Error(`budget exceeded: ${JSON.stringify({ state, seen, crypt })}`);
    }
    await page.goto(`${baseUrl}/#/hub`);
    await closeDialog(page);
    await page.waitForTimeout(STEP_MS);
    state = await visit(page, args);
    await page.reload({ waitUntil: 'networkidle' });
    await closeDialog(page);
    seen.limited += state.limited;
    seen.filterSold += state.filterSold ?? 0;
    seen.legendary ||= state.legendary;
    seen.setPiece ||= state.setPiece;
    seen.upgrades += state.upgrades.length;
    seen.upgradeFailure ||= state.upgrades.some((u) => !u.success);
    seen.pity ||= state.upgrades.some((u) => u.success && u.guaranteed && u.fromLevel >= 1);
    seen.targeted ??= state.turnedIn.find((q) => q.kind === 'contract' && q.item)?.item ?? null;
    log(
      `level ${state.level} in ${state.areaId} → ${state.target}; gold ${state.gold}; pack ` +
        `${state.pack}; tier ${state.tierCleared}; ${JSON.stringify({ ...seen, targeted: !!seen.targeted })}`,
    );
    const abbey = state.open.includes('sunkenAbbey') && state.gravewarden;

    // The Phase 3 loop starts at the Abbey: filter, Forge, contracts, deeper crypt.
    if (abbey && !seen.filter) {
      log('Pack: loot filter, sell below rare (UI)');
      await page.goto(`${baseUrl}/#/inventory`);
      await page.getByRole('tab', { name: /Loot filter/ }).click();
      await page.getByRole('radio', { name: /^Sell/ }).check({ force: true });
      await page.getByRole('button', { name: 'Below Rare', exact: true }).click();
      await page.getByRole('button', { name: 'Save filter' }).click();
      // Saved: the button disables again (nothing left to save).
      await page.waitForFunction(() =>
        [...document.querySelectorAll('button')].some(
          (b) => b.textContent === 'Save filter' && b.disabled,
        ),
      );
      await shoot(page, 'p3-loot-filter');
      seen.filter = true;
      Object.assign(args, { upgrade: true, followContracts: true });
    }
    if (seen.filter && !seen.locked && state.packValuableId) {
      log('Pack: lock a valuable drop (UI)');
      const pack = () =>
        page.evaluate(async () => {
          const { activeCharacterId } = await (await fetch('/api/characters')).json();
          const res = await fetch(`/api/characters/${activeCharacterId}/inventory`);
          return (await res.json()).inventory;
        });
      // The item's place in the grid, in the grid's own order (newest first). The grid and the
      // pack read must agree on the pack (a settle can land in between), else read both again.
      const grid = page.locator('.stash__grid button.item-frame');
      let index = -1;
      for (let attempt = 0; attempt < 5 && index < 0; attempt++) {
        await page.goto(`${baseUrl}/#/inventory`);
        await page.getByRole('tab', { name: /^Items/ }).click();
        await grid.first().waitFor();
        const items = await pack();
        if ((await grid.count()) !== items.length) continue;
        const shown = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        index = shown.findIndex((i) => i.id === state.packValuableId);
        if (index < 0) break; // sold or gone since the visit; a later visit picks another
      }
      if (index < 0) {
        log('   the valuable drop left the pack; trying again after the next visit');
      } else {
        await grid.nth(index).click();
        const lock = page.getByRole('button', { name: 'Lock', exact: true });
        await lock.click();
        await page.getByRole('button', { name: 'Unlock', exact: true }).waitFor();
        const locked = (await pack()).find((i) => i.id === state.packValuableId);
        if (!locked?.locked) throw new Error('the UI locked another item than the valuable drop');
        await shoot(page, 'p3-pack-locked');
        seen.locked = true;
      }
    }
    if (seen.filter && !seen.forgeUi && state.gold >= 3000) {
      log('Forge: upgrade until a failure, improve, rework (UI)');
      await page.goto(`${baseUrl}/#/forge`);
      await page.getByRole('heading', { name: 'The Anvil' }).waitFor();
      await page.getByRole('list', { name: 'Worn items' }).getByRole('button').first().click();
      const strike = page.getByRole('button', { name: /^Strike for \+/ });
      for (let i = 0; i < 20 && !seen.upgradeFailure; i++) {
        if (!(await strike.isEnabled().catch(() => false))) break;
        await strike.click();
        const notice = page.getByText(/^The steel (takes it|resists)/).first();
        await notice.waitFor();
        if (/resists/.test(await notice.innerText())) {
          seen.upgradeFailure = true;
          await shoot(page, 'p3-forge-upgrade-failed');
        }
        seen.upgrades += 1;
        await page.waitForTimeout(300);
      }
      const improve = page.getByRole('button', { name: 'Improve', exact: true });
      if (
        await improve
          .first()
          .isEnabled()
          .catch(() => false)
      ) {
        await improve.first().click();
        await page.getByText(/^Honed: /).waitFor();
      }
      await page.getByRole('button', { name: 'Rework…' }).first().click();
      await page
        .getByRole('button', { name: /^Rework / })
        .first()
        .click();
      await page.getByText(/^Reworked: /).waitFor();
      await shoot(page, 'p3-forge-reworked');
      seen.forgeUi = true;
    }
    if (seen.filter && !seen.targetedTaken && state.targetedOffer) {
      log('Tavern: a targeted Abbey contract, ring (UI)');
      await page.goto(`${baseUrl}/#/tavern`);
      const note = page.locator('.note', { has: page.locator('.note__slots') }).first();
      await note.getByRole('radio', { name: 'Ring' }).click();
      await note.getByRole('button', { name: /^Take contract · ring/ }).click();
      await page.getByText('Taken').first().waitFor();
      await shoot(page, 'p3-tavern-targeted');
      seen.targetedTaken = true;
      args.targetedTaken = true;
    }

    // The crypt: tier I until the Gravewarden falls (from 13), then II from 18 and III from 21.
    const tier = !state.gravewarden
      ? state.level >= 13 && state.cryptQuest
        ? 1
        : 0
      : state.tierCleared === 1 && state.level >= 18
        ? 2
        : state.tierCleared === 2 && state.level >= 21
          ? 3
          : 0;
    if (tier && state.level > lastCryptLevel[tier]) {
      lastCryptLevel = { ...lastCryptLevel, [tier]: state.level };
      await cryptRun(tier);
    }

    const done =
      seen.filterSold > 0 &&
      seen.locked &&
      seen.forgeUi &&
      seen.upgradeFailure &&
      seen.pity &&
      seen.targeted &&
      seen.legendary &&
      seen.setPiece &&
      state.tierCleared >= 3;
    if (done && !filling) {
      log('Pack: filter off, let the pack fill (UI)');
      filling = true;
      args.tidy = false;
      await page.goto(`${baseUrl}/#/inventory`);
      await page.getByRole('tab', { name: /Loot filter/ }).click();
      await page.getByRole('button', { name: 'Turn off' }).click();
      await page.waitForTimeout(500);
    }
    if (filling && (state.overCapacity ?? 0) > 0 && state.pack <= CAPACITY) {
      // The first settlement after the filter is turned off can still belong to a visit that
      // started with it on and tidied the pack (CLAUDE.md: a switch's first settlement can finish
      // the previous cycle). Read the state again on the next visit instead of failing; the run's
      // budget still bounds the wait.
      log(`Pack: over-capacity drop on a tidied visit (pack ${state.pack}), waiting for the next`);
      continue;
    }
    if (filling && (state.overCapacity ?? 0) > 0) {
      seen.overCapacity = state.overCapacity;
      log('Pack: a valuable drop kept over capacity');
      await page.goto(`${baseUrl}/#/inventory`);
      await page.getByRole('tab', { name: /^Items/ }).click();
      await page.locator('.stash__grid button.item-frame').first().waitFor();
      await shoot(page, 'p3-pack-over-capacity');
      break;
    }
  }

  // Checks.
  if (seen.targeted?.rarityId !== 'epic') throw new Error('no targeted contract reward');
  if (BASES[seen.targeted.baseId]?.slot !== 'ring') throw new Error('targeted reward not a ring');
  if (!crypt.some((r) => r.tier === 2 && r.won) || !crypt.some((r) => r.tier === 3 && r.won)) {
    throw new Error(`crypt tiers II and III not both cleared: ${JSON.stringify(crypt)}`);
  }
  if (seen.limited + appLimited > 0) {
    throw new Error(`rate limited ${seen.limited} (bot) + ${appLimited} (app) times`);
  }
  console.log(
    JSON.stringify({
      realSeconds: Math.round((Date.now() - started) / 1000),
      level: state.level,
      crypt,
      seen: { ...seen, targeted: seen.targeted.baseId },
    }),
  );
  await browser.close();
}

main().catch(async (err) => {
  console.error(err);
  await failurePage
    ?.screenshot({ path: `${outDir}/p3-failure.png`, fullPage: true })
    .then(() => console.error(`saved ${outDir}/p3-failure.png`))
    .catch(() => undefined);
  process.exit(1);
});
