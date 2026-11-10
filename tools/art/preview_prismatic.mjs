// Contact sheet and shimmer GIF for art ticket A.12 (the Prismatic treatment).
//
// Usage (from the repo root):
//   node tools/art/preview_prismatic.mjs              writes art/preview-prismatic.png
//   node tools/art/preview_prismatic.mjs --gif <dir>  also writes <dir>/prismatic-shimmer.gif
//
// The sheet shows icons of tiers 1–4, Mythics and set pieces inside the Legendary, Mythic and set
// (Legendary-rarity) frames, each plain, Void and Prismatic, at ×2 and ×1. The frames use the
// game's own stylesheets (tokens, item-frame, base) and the markup of `ItemFrame`, so they match the
// UI. The GIF steps the real CSS animations frame by frame (one art pixel of the sweep per frame).
// Spends no generations. Needs Python 3 with Pillow for the GIF.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require(process.env.PLAYWRIGHT_PATH ?? '/opt/node-tools/node_modules/playwright');
}

const ROOT = resolve(import.meta.dirname, '../..');
const ASSETS = `${ROOT}/apps/web/public/assets`;
const OUT = `${ROOT}/art/preview-prismatic.png`;
const gifAt = process.argv.indexOf('--gif');
const GIF_DIR = gifAt > 0 ? resolve(process.argv[gifAt + 1] ?? '.') : null;

const TIERED = [
  ['longsword', 'tier 1'],
  ['leather-jerkin', 'tier 1'],
  ['bastard-sword', 'tier 2'],
  ['barbute', 'tier 2'],
  ['knights-greatsword', 'tier 3'],
  ['knights-plate', 'tier 3'],
  ['cinderforged-blade', 'tier 4'],
  ['ashplate-hauberk', 'tier 4'],
  ['emberheart-scepter', 'tier 4'],
  ['wispfire-band', 'tier 4'],
];
const MYTHICS = [
  ['crown-of-the-hollow-king', 'Mythic'],
  ['heart-of-the-abyss', 'Mythic'],
  ['ring-of-endless-hunger', 'Mythic'],
  ['widowmaker', 'Mythic'],
];
const SETS = [
  ['vigil-helm', 'set'],
  ['vigil-hauberk', 'set'],
  ['bloodmoon-fang', 'set'],
  ['bloodmoon-grips', 'set'],
  ['choir-cowl', 'set'],
  ['choir-censer-chain', 'set'],
];

const data = (path) => `data:image/png;base64,${readFileSync(path).toString('base64')}`;
const icon = (name) => data(`${ASSETS}/items/${name}.png`);

// The app's order: component styles first, then base.css (`main.tsx`), whose `.rarity-*` win.
const css = [
  'apps/web/src/styles/tokens.css',
  'apps/web/src/components/item-frame.css',
  'apps/web/src/styles/base.css',
]
  .map((f) => readFileSync(`${ROOT}/${f}`, 'utf8'))
  .join('\n')
  .replace(/url\('\/assets\/overlays\/([a-z-]+\.png)'\)/g, (_, f) => `url('${data(`${ASSETS}/overlays/${f}`)}')`);

/** `ItemFrame`'s markup for a still icon. */
function frame(name, rarity, scale, variant = null, motion = false) {
  const size = 32 * scale;
  const src = icon(name);
  const classes = ['item-frame', `rarity-${rarity}`];
  if (variant) classes.push(`item-frame--${variant}`);
  if (variant === 'prismatic' && motion) classes.push('item-frame--shimmer-forced');
  const img = `<img class="pixel" src="${src}" width="${size}" height="${size}" alt="">`;
  const mask = `width:${size}px;height:${size}px;mask-image:url('${src}');-webkit-mask-image:url('${src}')`;
  const prism =
    variant === 'prismatic'
      ? `<span class="item-frame__prism-ring"></span>` +
        ['tint', 'sheen']
          .map((l) => `<span class="item-frame__prism item-frame__prism--${l}" style="${mask}"></span>`)
          .join('')
      : '';
  const mark = variant
    ? `<span class="item-frame__variant">${variant === 'void' ? '◇' : '✧'}</span>`
    : '';
  return `<span class="${classes.join(' ')}" style="--px:${scale}px">${img}${prism}${mark}</span>`;
}

const cell = (inner) => `<td><div class="c">${inner}</div></td>`;
const head = (icons) =>
  `<tr><th></th>${icons.map(([n, t]) => `<td class="l">${n}<br><span class="dim">${t}</span></td>`).join('')}</tr>`;
const VARIANTS = [
  [null, 'plain'],
  ['void', 'Void'],
  ['prismatic', 'Prismatic'],
];
function block(title, icons, rarity) {
  const rows = [`<tr><td class="h" colspan="${icons.length + 1}">${title}</td></tr>`, head(icons)];
  for (const scale of [2, 1]) {
    for (const [variant, label] of VARIANTS) {
      rows.push(
        `<tr><th>${label} ×${scale}</th>${icons.map(([n]) => cell(frame(n, rarity, scale, variant))).join('')}</tr>`,
      );
    }
  }
  return rows.join('\n');
}

const page = (body, extra = '') => `<!doctype html><html><head><style>${css}
body { margin: 0; padding: 16px; background: var(--ink-850, #1b1512); color: #c8baa0;
  font: 13px/1.3 'DejaVu Sans', sans-serif; display: inline-block; }
h1 { font-size: 15px; margin: 0 0 6px; font-weight: 600; }
p { margin: 0 0 8px; color: #978c7e; max-width: 1100px; }
table { border-collapse: separate; border-spacing: 10px 6px; }
th { text-align: right; font-weight: 500; color: #978c7e; white-space: nowrap; }
td { text-align: center; vertical-align: middle; }
td.h { text-align: left; padding-top: 10px; font-weight: 600; color: #c8baa0; }
.c { display: grid; place-items: center; min-width: 96px; min-height: 40px; }
.l { font-size: 11px; color: #c8baa0; }
.dim { color: #978c7e; }
${extra}
</style></head><body>${body}</body></html>`;

const sheet = page(`<h1>A.12 Prismatic & Void: icons of tiers 1–4, Mythics and set pieces, plain, Void and Prismatic</h1>
<p>Prismatic keeps the art's colour under a stepped opal tint with an opal hairline and ✧; Void drains it, edges it in voidlight inside a dark rift with ◇. Still frames (the sweep's rest position, which is also the reduced-motion look). Set pieces are Legendary-rarity, so they share the Legendary frame.</p>
<table>
${block('Legendary frame', TIERED, 'legendary')}
${block('Mythic frame', TIERED, 'mythic')}
${block('Mythic items (Mythic frame)', MYTHICS, 'mythic')}
${block('Set pieces (Legendary-rarity frame)', SETS, 'legendary')}
</table>`);

const browser = await playwright.chromium.launch();
const tab = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
await tab.setContent(sheet, { waitUntil: 'load' });
await tab.locator('body').screenshot({ path: OUT });
console.log(`wrote ${OUT}`);

if (GIF_DIR) {
  // One row: plain, Void and Prismatic of a few icons at ×3, animations stepped by hand.
  const icons = ['cinderforged-blade', 'knights-plate', 'crown-of-the-hollow-king', 'vigil-helm', 'wispfire-band'];
  const row = (variant, rarity) =>
    `<tr><th>${variant ?? 'plain'}</th>${icons.map((n) => cell(frame(n, rarity, 3, variant, true))).join('')}</tr>`;
  const html = page(
    `<table>${row(null, 'legendary')}${row('void', 'legendary')}${row('prismatic', 'legendary')}${row('prismatic', 'mythic')}</table>`,
    '.c { min-width: 112px; }',
  );
  await tab.setContent(html, { waitUntil: 'load' });
  mkdirSync(GIF_DIR, { recursive: true });
  const frames = mkdtempSync(join(GIF_DIR, 'prism-frames-'));
  const STEP = 100; // ms: one art pixel of the sweep
  const COUNT = 192; // two sweeps = one full palette drift, so the GIF loops seamlessly
  for (let i = 0; i < COUNT; i++) {
    await tab.evaluate((t) => {
      for (const a of document.getAnimations()) {
        a.pause();
        a.currentTime = t;
      }
    }, i * STEP + 1);
    await tab.locator('table').screenshot({ path: join(frames, `${String(i).padStart(3, '0')}.png`) });
  }
  const gif = join(GIF_DIR, 'prismatic-shimmer.gif');
  execFileSync('python3', [
    '-c',
    `import sys, glob
from PIL import Image
files = sorted(glob.glob(sys.argv[1] + '/*.png'))
imgs = [Image.open(f).convert('RGB') for f in files]
# One shared palette from a montage of frames (no dithering): the opal tint survives the 256
# colours and the GIF stays small.
picks = imgs[:: max(1, len(imgs) // 12)]
w, h = imgs[0].size
montage = Image.new('RGB', (w, h * len(picks)))
for i, im in enumerate(picks):
    montage.paste(im, (0, h * i))
palette = montage.quantize(colors=255, method=Image.Quantize.MEDIANCUT)
out = [im.quantize(palette=palette, dither=Image.Dither.NONE) for im in imgs]
out[0].save(sys.argv[2], save_all=True, append_images=out[1:], duration=${STEP}, loop=0, optimize=True)`,
    frames,
    gif,
  ]);
  rmSync(frames, { recursive: true });
  console.log(`wrote ${gif}`);
}
await browser.close();
