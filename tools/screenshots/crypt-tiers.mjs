// Captures the ticket 3.6 UI: the crypt door with the depth (tier) choice and its loot focus, a
// tier III run at the enraged Gravewarden, the reckoning of a first tier II clear, and an Abbey
// contract's reward-slot choice in the Tavern, at desktop (1440) and mobile (390) widths.
// Needs `pnpm --filter @worldforge/server e2e:serve`, `pnpm --filter @worldforge/web dev` and a
// built game-core (`pnpm build`).
// Auth and the hero are real. A fresh e2e hero is level 1 and cannot reach the deeper tiers
// within a screenshot run, so the script rewrites the display responses: the hero's level and
// crypt progress, and the run views, which are real game-core simulations (`simulateDungeonRun`
// and `dungeonRunProgress` with the seeds below). Display only: nothing is written to the server.
//   node tools/screenshots/crypt-tiers.mjs [baseUrl] [outDir]
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
const core = await import(
  pathToFileURL(resolve(import.meta.dirname, '../../packages/game-core/dist/index.js')).href
);

const baseUrl = process.argv[2] ?? 'http://localhost:5173';
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-3');
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

/** A Legendary kit (one item per slot, both rings) of the best bases a warrior can wear. */
function legendaryKit(itemLevel) {
  const rng = core.createRng(`shot-kit:${itemLevel}`);
  const bases = core.ITEM_BASES.filter(
    (b) => !b.unique && b.minItemLevel <= itemLevel && core.canClassUseItem(b, 'warrior'),
  ).sort((a, b) => b.tier - a.tier || b.minItemLevel - a.minItemLevel);
  const taken = new Set();
  const out = [];
  for (const base of bases) {
    if (taken.has(base.slot)) continue;
    taken.add(base.slot);
    for (let i = 0; i < (base.slot === 'ring' ? 2 : 1); i++) {
      out.push(
        core.generateItem({
          seed: rng.int(0, 2 ** 31),
          itemLevel,
          baseId: base.id,
          rarityId: 'legendary',
          classId: 'warrior',
        }),
      );
    }
  }
  return out;
}

const startedAt = Date.now() - 60_000;
/** A run view as the server sends it, revealed up to `elapsedMs`. */
function runView(characterId, tier, level, seed, elapsedMs) {
  const run = core.simulateDungeonRun({
    dungeonId: 'namelessCrypt',
    tier,
    character: { classId: 'warrior', level, xp: 0 },
    equipment: legendaryKit(level - 1),
    seed,
    bossLootEligible: true,
    inventoryCount: 0,
  });
  const at = typeof elapsedMs === 'function' ? elapsedMs(run) : elapsedMs;
  return {
    sim: run,
    view: {
      id: '0190f000-0000-7000-8000-000000036000',
      characterId,
      dungeonId: 'namelessCrypt',
      tier,
      startedAt: new Date(startedAt).toISOString(),
      endsAt: new Date(startedAt + run.durationMs).toISOString(),
      now: new Date(startedAt + at).toISOString(),
      bossLootEligible: true,
      progress: core.dungeonRunProgress(run, at),
    },
  };
}

async function shoot(page, vp, name, locator) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() =>
    Promise.all([...document.images].map((img) => img.decode().catch(() => undefined))),
  );
  const file = `${outDir}/${name}-${vp.name}.png`;
  if (locator) await locator.screenshot({ path: file });
  else await page.screenshot({ path: file, fullPage: true });
  console.log(`saved ${file}`);
}

async function hashIs(page, hash) {
  for (let i = 0; i < 100; i++) {
    if (new URL(page.url()).hash.startsWith(hash)) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`never reached ${hash} (at ${page.url()})`);
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
        displayName: `Delver ${String(Date.now()).slice(-6)}`,
        password: 'ashes-and-iron-42',
      },
    });
    if (!reg.ok()) throw new Error(`register failed: ${reg.status()}`);
    const page = await context.newPage();

    // The scenario the dungeon responses show (see the header).
    let scene = { level: 20, cleared: 1, run: null };
    const levelUp = (c) => ({ ...c, level: scene.level });
    await page.route('**/api/characters', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const response = await route.fetch();
      const body = await response.json();
      body.characters = body.characters.map(levelUp);
      await route.fulfill({ response, json: body });
    });
    await page.route('**/api/characters/*/dungeon', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const response = await route.fetch();
      const body = await response.json();
      body.character = levelUp(body.character);
      body.dungeons = body.dungeons.map((d) => ({
        ...d,
        tierCleared: scene.cleared,
        tiers: d.tiers.map((t) => {
          const def = core.getDungeonTier('namelessCrypt', t.tier);
          const blockers = core.dungeonUnlockBlockers(
            'namelessCrypt',
            { level: scene.level },
            { gravewardenDefeated: scene.cleared > 0, cryptTierCleared: scene.cleared },
            t.tier,
          );
          return { ...t, unlocked: blockers.length === 0, blockers, bossLevel: def.bossLevel };
        }),
      }));
      body.dungeons = body.dungeons.map((d) => ({
        ...d,
        unlocked: d.tiers[0].unlocked,
        blockers: d.tiers[0].blockers,
      }));
      body.run = scene.run;
      await route.fulfill({ response, json: body });
    });
    await page.route('**/api/characters/*/dungeon/settle', (route) =>
      route.fulfill({ json: { run: scene.run } }),
    );

    await page.goto(`${baseUrl}/#/area`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Forge your first hero' }).waitFor();
    const suffix = Array.from({ length: 4 }, () =>
      String.fromCharCode(97 + Math.floor(Math.random() * 26)),
    ).join('');
    await page
      .getByLabel('Name', { exact: true })
      .fill(`${vp.name === 'desktop' ? 'Aldric' : 'Brann'}${suffix}`);
    await page.getByRole('radio', { name: /^Warrior/ }).check({ force: true });
    await page.getByRole('radio', { name: 'Ember' }).check({ force: true });
    await page.getByRole('button', { name: 'Forge hero' }).click();
    await hashIs(page, '#/hub');
    const characterId = (await (await context.request.get(`${baseUrl}/api/characters`)).json())
      .characters[0].id;

    // 1. The door: tier II open (tier I cleared), tier III barred by level and progress.
    await page.goto(`${baseUrl}/#/crypt`);
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.crypt-tiers').waitFor();
    await shoot(page, vp, 'crypt-tiers-door', page.locator('.crypt-door'));
    await shoot(page, vp, 'crypt-tiers-screen');

    // 2. A tier III run at its entry (level 21, Legendary kit) just after the warden enraged.
    scene = { level: 21, cleared: 2, run: null };
    const boss = runView(characterId, 3, 21, 'shot-tier3:3', (r) => {
      const fight = r.encounters.at(-1);
      return Math.min(fight.endMs - 500, fight.startMs + r.enrageAtMs + 3_000);
    });
    scene.run = boss.view;
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.crypt-hud__enraged').waitFor();
    await shoot(page, vp, 'crypt-tier3-enraged');

    // 3. The reckoning of a first tier II clear (level 20): tier III opens from level 21.
    scene = { level: 20, cleared: 1, run: null };
    const t2 = runView(characterId, 2, 20, 'shot-tier2:1', (r) => r.durationMs + 1_000);
    scene.run = t2.view;
    const r = t2.sim;
    await page.route('**/api/characters/*/dungeon/claim', async (route) => {
      scene = { level: 20, cleared: 2, run: null };
      const character = (await (await context.request.get(`${baseUrl}/api/characters`)).json())
        .characters[0];
      await route.fulfill({
        json: {
          character: levelUp(character),
          result: {
            runId: t2.view.id,
            dungeonId: 'namelessCrypt',
            tier: 2,
            outcome: r.outcome,
            durationMs: r.durationMs,
            roomsCleared: r.roomsCleared,
            totalRooms: r.totalRooms,
            kills: r.kills,
            xpGained: r.xpGained,
            levelsGained: r.levelsGained,
            goldGained: r.goldLooted,
            goldSalvaged: 0,
            items: r.items.map((i, n) => ({
              id: `0190f000-0000-7000-8000-0000000362${String(n).padStart(2, '0')}`,
              baseId: i.baseId,
              rarityId: i.rarityId,
              itemLevel: i.itemLevel,
              ...(i.effectId ? { effectId: i.effectId } : {}),
              ...(i.mythicId ? { mythicId: i.mythicId } : {}),
              ...(i.setId ? { setId: i.setId } : {}),
              ...(i.variant ? { variant: i.variant } : {}),
            })),
            itemsSalvaged: 0,
            materials: r.materials,
            bossDefeated: r.bossDefeated,
            bossLoot: r.bossLoot,
            firstBossKill: false,
            firstTierClear: r.bossDefeated,
            questEvents: r.questEvents,
          },
        },
      });
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Claim the spoils' }).click();
    await page.locator('.reckoning').waitFor();
    await shoot(page, vp, 'crypt-tier2-reckoning', page.locator('.reckoning'));

    // 4. The Tavern: an Abbey contract offers a choice of reward slot (level 20).
    await page.route('**/api/characters/*/quests', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const response = await route.fetch();
      const body = await response.json();
      const template = core.findContractTemplate('slay.fallenKnight');
      const offer = {
        slot: 0,
        templateId: template.id,
        objective: template.objective,
        reward: core.contractReward(template, 20),
        accepted: false,
        rewardSlots: core.targetedRewardSlots('warrior', 20),
        targetedReward: { rarityId: 'epic', itemLevel: core.targetedRewardItemLevel(20) },
      };
      body.contracts.offers = [offer, ...body.contracts.offers.slice(1)];
      await route.fulfill({ response, json: body });
    });
    await page.goto(`${baseUrl}/#/tavern`);
    await page.reload({ waitUntil: 'networkidle' });
    const slip = page.locator('.note--slip').first();
    await slip.locator('.note__slots').waitFor();
    await slip.getByRole('radio', { name: 'Neck' }).click();
    await shoot(page, vp, 'tavern-abbey-contract-slot', slip);
    await context.close();
  }
} finally {
  await browser.close();
}
