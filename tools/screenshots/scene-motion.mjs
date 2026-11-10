// Ticket A.14: films the fight scene's motion at desktop (1440) and mobile (390) and checks the
// motion switches in a real browser:
// - with the local override `worldforge.sceneMotion = on`, the farming scene runs the loop (the
//   hero swings, foes flash, fall and rise) until at least 5 foes fell and rose, and every beat is
//   checked to run its own animation on its layer (A.14b) — saved as frames `scene-<vp>-NNN.png` and a
//   timing file `scene-<vp>.json` (build the GIF and strip with tools/screenshots/scene_gif.py);
// - without it (automation: `navigator.webdriver`), and with `prefers-reduced-motion: reduce`,
//   the scene is static (no `.scene-anim` root, no running animation on the sprites).
// Needs the e2e server and the web dev server:
//   OFFLINE_CAP_SECONDS=1800 pnpm --filter @worldforge/server e2e:serve
//   pnpm --filter @worldforge/web dev
//   node tools/screenshots/scene-motion.mjs [baseUrl] [outDir]
import { mkdirSync, writeFileSync } from 'node:fs';
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
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-6');
const PASSWORD = 'ashes-and-iron-42';
const FRAMES = Number(process.env.SCENE_FRAMES ?? 60);
/** A.14b: film until at least this many foes fell (and rose), to show the scene stays in sync. */
const MIN_KILLS = Number(process.env.SCENE_KILLS ?? 5);
const MAX_FRAMES = 400;
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, hero: 'Edda', className: 'Warrior' },
  { name: 'mobile', width: 390, height: 844, hero: 'Wren', className: 'Hunter' },
];
mkdirSync(outDir, { recursive: true });

const browser = await playwright.chromium.launch();
let failed = false;
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  failed = true;
};

/** Hero names are unique and letters only: each run and each context gets its own suffix. */
const heroName = (vp) =>
  vp.hero +
  Array.from(
    { length: 4 },
    () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)],
  ).join('');

async function newHero(page, vp) {
  vp.current = heroName(vp);
  const email = `scene-${vp.name}-${Date.now()}@example.test`;
  await page.goto(`${baseUrl}/#/register`, { waitUntil: 'networkidle' });
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Display name').fill(`Scene ${String(Date.now()).slice(-6)}`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('heading', { name: 'Forge your first hero' }).waitFor();
  await page.getByLabel('Name', { exact: true }).fill(vp.current);
  await page.getByRole('radio', { name: new RegExp(`^${vp.className}`) }).check({ force: true });
  await page.getByRole('button', { name: 'Forge hero' }).click();
  await page.waitForFunction(() => /#\/(area|hub)/.test(location.hash));
  return email;
}

/** Whether anything in the scene is animating right now. */
const sceneState = (page) =>
  page.evaluate(() => {
    const ground = document.querySelector('.scene__ground');
    const running = document
      .getAnimations()
      .filter((a) => a.effect?.target && ground?.contains(a.effect.target)).length;
    return { root: ground?.classList.contains('scene-anim') ?? false, running };
  });

for (const vp of VIEWPORTS) {
  // 1. Filmed run: the override on.
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  const page = await context.newPage();
  page.on('pageerror', (e) => fail(`page error: ${e.message}`));
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  await newHero(page, vp);
  await page.evaluate(() => localStorage.setItem('worldforge.sceneMotion', 'on'));
  await page.goto(`${baseUrl}/#/area`);
  await page.reload();
  await page.getByRole('button', { name: 'Farm Abandoned Fields' }).click();
  await page.getByRole('button', { name: new RegExp(`^Call ${vp.current} back`) }).waitFor();
  const stage = page.locator('.scene__stage');
  // Top of the viewport, clear of the phone's fixed bottom navigation.
  await stage.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  // Wait (by state, not time) for the first swing.
  await page
    .locator('.scene-anim__actor--hero .scene-anim__act.scene-anim--strike')
    .waitFor({ state: 'attached' });
  const state = await sceneState(page);
  if (!state.root || state.running === 0) fail(`${vp.name}: the farming scene does not move`);

  // A.14b sync probe: every time the driver sets a beat class on a layer, check 60 ms later that
  // this layer runs that beat's own animation (the A.14 desync was finished classes piling up
  // and the stylesheet's order picking an old animation over the new one).
  await page.evaluate(() => {
    const want = {
      'scene-anim--strike': /lunge-right|lean/,
      'scene-anim--lunge': /lunge-left|lean-left/,
      'scene-anim--hit': /scene-anim-hit/,
      'scene-anim--hurt': /hurt/,
      'scene-anim--glow': /glow/,
      'scene-anim--down': /fall/,
      'scene-anim--rise': /rise/,
    };
    const probe = { beats: 0, wrong: [], kills: 0, rises: 0 };
    window.__sceneProbe = probe;
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        const el = m.target;
        const before = new Set((m.oldValue ?? '').split(' '));
        for (const cls of el.classList) {
          if (!want[cls] || before.has(cls)) continue;
          if (cls === 'scene-anim--down') probe.kills++;
          if (cls === 'scene-anim--rise') probe.rises++;
          setTimeout(() => {
            if (!el.classList.contains(cls)) return; // replaced by a newer beat on this layer
            probe.beats++;
            const names = el
              .getAnimations()
              .filter((a) => a.effect?.target === el)
              .map((a) => a.animationName);
            if (!names.some((n) => want[cls].test(n))) probe.wrong.push(`${cls}: [${names}]`);
          }, 60);
        }
      }
    });
    for (const el of document.querySelectorAll(
      '.scene-anim__fade, .scene-anim__act, .scene-anim__hit',
    )) {
      observer.observe(el, {
        attributes: true,
        attributeFilter: ['class'],
        attributeOldValue: true,
      });
    }
  });

  const before = requests.length;
  const times = [];
  const t0 = Date.now();
  let frame = 0;
  for (;;) {
    await stage.screenshot({
      path: `${outDir}/scene-${vp.name}-${String(frame).padStart(3, '0')}.png`,
    });
    times.push(Date.now() - t0);
    frame++;
    const { rises } = await page.evaluate(() => window.__sceneProbe);
    if ((frame >= FRAMES && rises >= MIN_KILLS) || frame >= MAX_FRAMES) break;
  }
  const probe = await page.evaluate(() => window.__sceneProbe);
  console.log(
    `${vp.name}: ${probe.kills} falls, ${probe.rises} rises, ${probe.beats} beats checked, ${probe.wrong.length} wrong`,
  );
  if (probe.rises < MIN_KILLS) fail(`${vp.name}: only ${probe.rises} respawns while filming`);
  if (probe.wrong.length > 0) fail(`${vp.name}: beats out of sync: ${probe.wrong.join('; ')}`);
  // For the record: the only API calls while filming are the client's 8-second settles (the
  // animation itself makes none; apps/web/src/scene/sceneDriver.test.ts checks that).
  const api = requests.slice(before).filter((u) => u.includes('/api/'));
  console.log(`${vp.name}: ${api.length} API calls in ${Date.now() - t0} ms of filming`);
  writeFileSync(`${outDir}/scene-${vp.name}.json`, JSON.stringify({ times }, null, 2));
  console.log(`saved ${frame} frames for ${vp.name} (${times.at(-1)} ms)`);

  // 2. Same session without the override: automation → static.
  await page.evaluate(() => localStorage.removeItem('worldforge.sceneMotion'));
  await page.reload();
  await page.locator('.scene__stage').waitFor();
  const off = await sceneState(page);
  if (off.root || off.running > 0) fail(`${vp.name}: the scene moves under automation`);
  await context.close();

  // 3. Reduced motion, override on: still static.
  const reduced = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    reducedMotion: 'reduce',
  });
  const rp = await reduced.newPage();
  await newHero(rp, vp);
  await rp.evaluate(() => localStorage.setItem('worldforge.sceneMotion', 'on'));
  await rp.goto(`${baseUrl}/#/area`);
  await rp.reload();
  await rp.getByRole('button', { name: 'Farm Abandoned Fields' }).click();
  await rp.getByRole('button', { name: new RegExp(`^Call ${vp.current} back`) }).waitFor();
  const still = await sceneState(rp);
  if (still.root || still.running > 0) fail(`${vp.name}: the scene moves with reduced motion`);
  else console.log(`${vp.name}: static under automation and with reduced motion`);
  await reduced.close();
}

await browser.close();
if (failed) process.exit(1);
