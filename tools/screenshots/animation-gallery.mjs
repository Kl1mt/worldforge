// Ticket A.14c: the admin animation gallery at desktop (1440) and mobile (390), and its rules in a
// real browser:
// - a player opening `#/admin/animations` is sent home and never sees the gallery;
// - under automation the gallery is frozen (no `.scene-anim` root, nothing running) until Play;
// - after Play the sprites breathe, and a card's beat buttons play the scene's real animations;
// - with `prefers-reduced-motion: reduce`, Play forces motion on inside the gallery only;
// - the scene preview runs the real farming loop (filmed as frames `gallery-scene-NNN.png`; build
//   the GIF with tools/screenshots/scene_gif.py-style tooling below).
// Needs the e2e server with a seeded admin, and the web dev server:
//   E2E_SEED_ADMIN=castellan@graumark.test pnpm --filter @worldforge/server e2e:serve
//   pnpm --filter @worldforge/web dev
//   node tools/screenshots/animation-gallery.mjs [baseUrl] [outDir]
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
const ADMIN = process.env.E2E_SEED_ADMIN ?? 'castellan@graumark.test';
const FRAMES = Number(process.env.GALLERY_FRAMES ?? 90);
mkdirSync(outDir, { recursive: true });

let failed = false;
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  failed = true;
};

const browser = await playwright.chromium.launch();

async function context(vp, options = {}) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    ...options,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => fail(`page error @ ${vp.name}: ${e.message}`));
  return { ctx, page };
}

async function api(ctx, method, path, data) {
  const res = await ctx.request.fetch(`${baseUrl}/api${path}`, {
    method,
    ...(data ? { data } : {}),
  });
  if (!res.ok()) throw new Error(`${method} ${path}: ${res.status()} ${await res.text()}`);
  return res.status() === 204 ? null : res.json();
}

async function asAdmin(vp, options) {
  const c = await context(vp, options);
  await api(c.ctx, 'POST', '/auth/login', { email: ADMIN, password: PASSWORD });
  const { characters } = await api(c.ctx, 'GET', '/characters');
  if (characters.length === 0) {
    await api(c.ctx, 'POST', '/characters', {
      name: 'Ysolde',
      classId: 'warrior',
      appearance: { banner: 'dusk' },
    });
  }
  await api(c.ctx, 'POST', '/account/guide', { dismissed: true }).catch(() => undefined);
  await c.page.goto(`${baseUrl}/#/admin/animations`, { waitUntil: 'networkidle' });
  await c.page.locator('.anim-gallery').waitFor();
  return c;
}

const galleryState = (page) =>
  page.evaluate(() => {
    const root = document.querySelector('.anim-gallery');
    return {
      armed: root?.classList.contains('scene-anim') ?? false,
      forced: root?.classList.contains('scene-anim--forced') ?? false,
      running: (root?.getAnimations({ subtree: true }) ?? []).filter(
        (a) => a.playState === 'running',
      ).length,
    };
  });

// 1. A player never gets the gallery.
{
  const vp = { name: 'desktop', width: 1440, height: 900 };
  const { ctx, page } = await context(vp);
  const email = `gallery-player-${Date.now()}@graumark.test`;
  await api(ctx, 'POST', '/auth/register', {
    email,
    displayName: `Gallery ${String(Date.now()).slice(-5)}`,
    password: PASSWORD,
  });
  await api(ctx, 'POST', '/characters', {
    name: 'Tamsin',
    classId: 'mage',
    appearance: { banner: 'ash' },
  }).catch(() => undefined);
  await page.goto(`${baseUrl}/#/admin/animations`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !location.hash.startsWith('#/admin'));
  if ((await page.locator('.anim-gallery').count()) > 0) fail('a player sees the gallery');
  else console.log(`player: sent to ${await page.evaluate(() => location.hash)}, no gallery`);
  await ctx.close();
}

for (const vp of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  const { ctx, page } = await asAdmin(vp);
  // 2. Frozen under automation until Play.
  await page.waitForFunction(() => !document.querySelector('.anim-gallery__loading'));
  const before = await galleryState(page);
  if (before.armed || before.running > 0) fail(`${vp.name}: the gallery moves before Play`);
  await page.screenshot({ path: `${outDir}/a14c-gallery-frozen-${vp.name}.png` });
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector('.anim-gallery')
      ?.getAnimations({ subtree: true })
      .some((a) => a.playState === 'running'),
  );
  const after = await galleryState(page);
  console.log(`${vp.name}: before Play ${JSON.stringify(before)}, after ${JSON.stringify(after)}`);

  // 3. A card's beats: the farmhand attacks with its frames, the wolf takes a heavy hit.
  const farmhand = page.locator('.anim-gallery__card', { hasText: 'Risen Farmhand' }).first();
  await farmhand.getByRole('button', { name: 'Attack' }).click();
  const attacking = await farmhand
    .locator('.pixel-sheet__strip')
    .evaluate((el) => el.getAnimations().map((a) => a.animationName));
  if (!attacking.includes('scene-anim-sheet'))
    fail(`${vp.name}: the farmhand's frames did not play`);
  const wolf = page.locator('.anim-gallery__card', { hasText: 'Carrion Wolf' }).first();
  await wolf.getByRole('button', { name: 'Heavy hit' }).click();
  const hit = await wolf
    .locator('.scene-anim__hit')
    .evaluate((el) => el.getAnimations().map((a) => a.animationName));
  if (!hit.includes('scene-anim-hit')) fail(`${vp.name}: the wolf's hit did not play`);
  await page.screenshot({
    path: `${outDir}/a14c-gallery-${vp.name}.png`,
    fullPage: vp.name === 'mobile' ? false : false,
  });

  // 4. Scene preview: the real loop, filmed (desktop) or shot (mobile).
  const preview = page.locator('.anim-gallery__preview');
  await preview.scrollIntoViewIfNeeded();
  await preview.getByRole('button', { name: 'Run the fight' }).click();
  const stage = preview.locator('.scene__stage');
  await page
    .locator('.anim-gallery__preview .scene-anim__act.scene-anim--strike')
    .waitFor({ state: 'attached' });
  if (vp.name === 'desktop') {
    const times = [];
    const t0 = Date.now();
    for (let i = 0; i < FRAMES; i++) {
      await stage.screenshot({ path: `${outDir}/scene-gallery-${String(i).padStart(3, '0')}.png` });
      times.push(Date.now() - t0);
    }
    writeFileSync(`${outDir}/scene-gallery.json`, JSON.stringify({ times }));
    console.log(`desktop: filmed ${FRAMES} frames of the scene preview (${times.at(-1)} ms)`);
  }
  await preview.screenshot({ path: `${outDir}/a14c-gallery-preview-${vp.name}.png` });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  if (overflow) fail(`${vp.name}: horizontal overflow`);
  await ctx.close();
}

// 5. Reduced motion: frozen, then forced on inside the gallery by Play.
{
  const vp = { name: 'desktop', width: 1440, height: 900 };
  const { ctx, page } = await asAdmin(vp, { reducedMotion: 'reduce' });
  const before = await galleryState(page);
  if (before.running > 0) fail('reduced motion: the gallery moves before Play');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector('.anim-gallery')
      ?.getAnimations({ subtree: true })
      .some((a) => a.playState === 'running'),
  );
  const after = await galleryState(page);
  if (!after.forced) fail('reduced motion: Play did not force motion on');
  // Outside the gallery nothing is forced: the class lives on the gallery root only.
  const forcedRoots = await page.locator('.scene-anim--forced').count();
  if (forcedRoots !== 1) fail(`reduced motion: ${forcedRoots} forced roots`);
  console.log(
    `reduced motion: before ${JSON.stringify(before)}, after Play ${JSON.stringify(after)}`,
  );
  await ctx.close();
}

await browser.close();
if (failed) process.exit(1);
console.log('animation gallery: all checks passed');
