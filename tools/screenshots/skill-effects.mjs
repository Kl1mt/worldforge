// Ticket A.18: the skill icons and effect animations in the admin animation gallery, desktop
// (1440) and mobile (390), checked in a real browser:
// - every class card shows its twelve skill icons, each loaded at 32 px;
// - "Cast" plays the class's cast flash (and its sparks) on the hero's effect layer;
// - each tick button plays its tick on the target's effect layer (and its motes);
// - the resource meter's Fill and Spend play the gain and spend slices; Soul Fragments are pips;
// - the scene preview with "Skills" on runs the real loop with casts and ticks;
// - stills of each class card mid-cast and mid-tick, and frames of the scene preview for a GIF.
// Needs the e2e server with a seeded admin, and the web dev server:
//   E2E_SEED_ADMIN=castellan@graumark.test pnpm --filter @worldforge/server e2e:serve
//   pnpm --filter @worldforge/web dev
//   node tools/screenshots/skill-effects.mjs [baseUrl] [outDir]
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
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-9');
const PASSWORD = 'ashes-and-iron-42';
const ADMIN = process.env.E2E_SEED_ADMIN ?? 'castellan@graumark.test';
const FRAMES = Number(process.env.SKILL_FRAMES ?? 60);
mkdirSync(outDir, { recursive: true });

let failed = false;
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  failed = true;
};

const browser = await playwright.chromium.launch();

async function api(ctx, method, path, data) {
  const res = await ctx.request.fetch(`${baseUrl}/api${path}`, {
    method,
    ...(data ? { data } : {}),
  });
  if (!res.ok()) throw new Error(`${method} ${path}: ${res.status()} ${await res.text()}`);
  return res.status() === 204 ? null : res.json();
}

async function asAdmin(vp) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => fail(`page error @ ${vp.name}: ${e.message}`));
  await api(ctx, 'POST', '/auth/login', { email: ADMIN, password: PASSWORD });
  const { characters } = await api(ctx, 'GET', '/characters');
  if (characters.length === 0) {
    await api(ctx, 'POST', '/characters', {
      name: 'Ysolde',
      classId: 'warrior',
      appearance: { banner: 'dusk' },
    });
  }
  await api(ctx, 'POST', '/account/guide', { dismissed: true }).catch(() => undefined);
  await page.goto(`${baseUrl}/#/admin/animations`, { waitUntil: 'networkidle' });
  await page.locator('.anim-gallery').waitFor();
  await page.waitForFunction(() => !document.querySelector('.anim-gallery__loading'));
  return { ctx, page };
}

/** Names of the animations running on an element and its pseudo-elements. */
/** The A.18 effects (cast, tick, sparks, motes) running under an element. */
const EFFECT = /^scene-anim-(cast|tick|motes)/;

/** Pauses the effects under `locator` (pseudo-elements included) at `ms`, for a still. */
const freezeAt = (locator, ms) =>
  locator.evaluate(
    (el, [t, re]) => {
      for (const a of el.getAnimations({ subtree: true })) {
        if (!new RegExp(re).test(a.animationName)) continue;
        a.pause();
        a.currentTime = t;
      }
    },
    [ms, EFFECT.source],
  );

/** Ends the frozen effects, so the next still starts clean. */
const release = (locator) =>
  locator.evaluate((el, re) => {
    for (const a of el.getAnimations({ subtree: true })) {
      if (new RegExp(re).test(a.animationName)) a.cancel();
    }
  }, EFFECT.source);

const animationsOn = (locator) =>
  locator.evaluate((el) =>
    document
      .getAnimations()
      .filter((a) => a.effect?.target === el)
      .map((a) => `${a.animationName}${a.effect.pseudoElement ?? ''}`),
  );

for (const vp of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  const { ctx, page } = await asAdmin(vp);
  if ((await page.locator('.anim-gallery__alert').count()) > 0) {
    fail(`${vp.name}: ${await page.locator('.anim-gallery__alert').innerText()}`);
  }
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  // Scale ×2 on desktop so the effects read in a still; ×1 on the phone.
  await page
    .getByRole('radiogroup', { name: 'Scale' })
    .getByRole('radio', { name: vp.name === 'desktop' ? '×2' : '×1' })
    .click();

  const cards = page.locator('.anim-gallery__skill-card');
  const count = await cards.count();
  if (count !== 4) fail(`${vp.name}: ${count} skill cards`);
  for (let i = 0; i < count; i++) {
    const card = cards.nth(i);
    const name = (await card.locator('.anim-gallery__skill-class').innerText()).split(' ')[0];
    await card.scrollIntoViewIfNeeded();
    // Icons: twelve, all loaded at 32 px.
    const icons = await card
      .locator('.anim-gallery__skill-icons img')
      .evaluateAll((imgs) => imgs.map((im) => [im.complete, im.naturalWidth, im.naturalHeight]));
    if (icons.length !== 12 || icons.some(([ok, w, h]) => !ok || w !== 32 || h !== 32)) {
      fail(`${vp.name} ${name}: icons ${JSON.stringify(icons)}`);
    }
    // The cast flash and its sparks.
    await card.getByRole('button', { name: 'Cast', exact: true }).click();
    const heroFx = card.locator('.scene-anim__actor--hero .scene-anim__fx');
    const cast = await animationsOn(heroFx);
    if (!cast.includes('scene-anim-cast') || !cast.includes('scene-anim-cast-sparks::after')) {
      fail(`${vp.name} ${name}: cast plays ${cast.join(', ')}`);
    }
    await freezeAt(card.locator('.anim-gallery__skill-stage'), 200); // the flare, second ring
    await card.screenshot({ path: `${outDir}/a18-cast-${name.toLowerCase()}-${vp.name}.png` });
    await release(card.locator('.anim-gallery__skill-stage'));
    // A tick of each kind on the target.
    const foeFx = card.locator('.scene-anim__actor--foe .scene-anim__fx');
    for (const dot of ['Burn', 'Bleed', 'Shadow']) {
      await card.getByRole('button', { name: `${dot} tick` }).click();
      const tick = await animationsOn(foeFx);
      const motes = `scene-anim-motes-${dot.toLowerCase()}::after`;
      if (!tick.includes('scene-anim-tick') || !tick.includes(motes)) {
        fail(`${vp.name} ${name}: ${dot} tick plays ${tick.join(', ')}`);
      }
    }
    // The resource meter: fill, then spend.
    const meter = card.locator('.resource-meter');
    // Spend first (a full Mana bar can't fill), then fill, then spend: both moves always show.
    await card.getByRole('button', { name: 'Spend', exact: true }).click();
    await card.getByRole('button', { name: 'Fill', exact: true }).click();
    const fill = await meter.evaluate((el) =>
      el.getAnimations({ subtree: true }).map((a) => a.animationName),
    );
    await card.getByRole('button', { name: 'Spend', exact: true }).click();
    const spend = await meter.evaluate((el) =>
      el.getAnimations({ subtree: true }).map((a) => a.animationName),
    );
    const pips = (await meter.locator('.resource-meter__pip').count()) > 0;
    const want = pips
      ? ['resource-pip-spend', 'resource-pip-gain']
      : ['resource-spend', 'resource-gain'];
    if (!spend.includes(want[0]) || !fill.includes(want[1])) {
      fail(`${vp.name} ${name}: meter spend ${spend.join(', ')}, fill ${fill.join(', ')}`);
    }
    const own = { Warrior: 'Bleed', Mage: 'Burn', Hunter: 'Bleed', Warlock: 'Shadow' }[name];
    await card.getByRole('button', { name: `${own} tick` }).click();
    await freezeAt(card.locator('.anim-gallery__skill-stage'), 80);
    await card.screenshot({ path: `${outDir}/a18-tick-${name.toLowerCase()}-${vp.name}.png` });
    await release(card.locator('.anim-gallery__skill-stage'));
    console.log(
      `${vp.name} ${name}: 12 icons, cast ${cast.length} anims, meter ${want.join(' / ')}`,
    );
  }

  // The scene preview with skills: casts and ticks in the real loop.
  const preview = page.locator('.anim-gallery__preview');
  await preview.scrollIntoViewIfNeeded();
  await preview.getByLabel('Hero').selectOption('warlock');
  await preview.getByRole('button', { name: 'Run the fight' }).click();
  await page.locator('.anim-gallery__preview .scene-anim__fx.scene-anim--cast').waitFor({
    state: 'attached',
    timeout: 20_000,
  });
  await page
    .locator('.anim-gallery__preview .scene-anim__fx.scene-anim--tick-shadow')
    .waitFor({ state: 'attached', timeout: 20_000 });
  console.log(`${vp.name}: the scene preview casts and ticks shadow`);
  if (vp.name === 'desktop') {
    const stage = preview.locator('.scene__stage');
    const times = [];
    const t0 = Date.now();
    for (let i = 0; i < FRAMES; i++) {
      await stage.screenshot({
        path: `${outDir}/a18-scene-${String(i).padStart(3, '0')}.png`,
        scale: 'css',
      });
      times.push(Date.now() - t0);
    }
    writeFileSync(`${outDir}/a18-scene.json`, JSON.stringify({ times }));
    console.log(`desktop: filmed ${FRAMES} frames of the scene preview (${times.at(-1)} ms)`);
  }
  await page.locator('.anim-gallery__skills').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${outDir}/a18-gallery-${vp.name}.png` });
  // Nothing of A.18 sticks out of a phone's width (the older Variants table is not ours: it
  // scrolls the page sideways on phones on its own).
  const wide = await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '.anim-gallery__skills *, .anim-gallery__preview .anim-gallery__pickers *',
      ),
    ]
      // A frame sheet's strip is wider than its clipped window by design.
      .filter((el) => !el.classList.contains('pixel-sheet__strip'))
      .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
      .map((el) => String(el.className)),
  );
  if (wide.length > 0) fail(`${vp.name}: wider than the screen: ${wide.slice(0, 5).join(' | ')}`);
  await ctx.close();
}

await browser.close();
if (failed) process.exit(1);
