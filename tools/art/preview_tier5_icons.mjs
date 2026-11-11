// Contact sheet for art ticket A.17 (the ten tier-5 item icons of the Hollow Reach).
//
// Usage (from the repo root): node tools/art/preview_tier5_icons.mjs
//
// Writes art/preview-tier5-icons.png: the ten icons at ×1 and ×2 next to their tier-4
// counterparts, then each icon inside every rarity frame, Void and Prismatic. The frames use the
// game's own stylesheets (tokens, base, item-frame) and `ItemFrame`'s markup, so they match the
// UI (still: the shimmer and the motes at rest). Spends no generations.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require(process.env.PLAYWRIGHT_PATH ?? '/opt/node-tools/node_modules/playwright');
}

const ROOT = resolve(import.meta.dirname, '../..');
const ASSETS = `${ROOT}/apps/web/public/assets`;
const OUT = `${ROOT}/art/preview-tier5-icons.png`;

// Tier-5 base (ticket 8.1) → its tier-4 counterpart (same slot and class weapon).
const PAIRS = [
  ['hollowsteel-greatblade', 'cinderforged-blade'],
  ['pale-choir-stave', 'emberheart-scepter'],
  ['reachstalker-longbow', 'slagbone-bow'],
  ['hollow-aegis', 'obsidian-bulwark'],
  ['hollowknight-helm', 'revenant-visage'],
  ['titanhusk-cuirass', 'ashplate-hauberk'],
  ['palebone-gauntlets', 'slagiron-gauntlets'],
  ['reachwalker-sabatons', 'cinderstride-greaves'],
  ['requiem-locket', 'ember-reliquary'],
  ['hollow-signet', 'wispfire-band'],
];
const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];

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
  .replace(
    /url\('\/assets\/overlays\/([a-z-]+\.png)'\)/g,
    (_, f) => `url('${data(`${ASSETS}/overlays/${f}`)}')`,
  );

const img = (name, scale) =>
  `<img class="pixel" src="${icon(name)}" width="${32 * scale}" height="${32 * scale}" alt="">`;

/** `ItemFrame`'s markup for a still icon (as in `preview_prismatic.mjs`). */
function frame(name, rarity, scale, variant = null) {
  const size = 32 * scale;
  const src = icon(name);
  const classes = ['item-frame', `rarity-${rarity}`];
  if (variant) classes.push(`item-frame--${variant}`);
  const mask = `width:${size}px;height:${size}px;mask-image:url('${src}');-webkit-mask-image:url('${src}')`;
  const prism =
    variant === 'prismatic'
      ? `<span class="item-frame__prism-ring"></span>` +
        ['tint', 'sheen']
          .map(
            (l) => `<span class="item-frame__prism item-frame__prism--${l}" style="${mask}"></span>`,
          )
          .join('')
      : '';
  const box = `width:${size}px;height:${size}px`;
  const voidLayers =
    variant === 'void'
      ? `<span class="item-frame__void-motes" style="${box}"></span>` +
        `<span class="item-frame__void-edge" style="${box}"><span class="item-frame__void-edge-fill" style="mask-image:url('${src}');-webkit-mask-image:url('${src}')"></span></span>`
      : '';
  const mark = variant
    ? `<span class="item-frame__variant">${variant === 'void' ? '◇' : '✧'}</span>`
    : '';
  return `<span class="${classes.join(' ')}" style="--px:${scale}px">${voidLayers}${img(name, scale)}${prism}${mark}</span>`;
}

const cell = (inner) => `<td><div class="c">${inner}</div></td>`;
const row = (head, cells) => `<tr><th>${head}</th>${cells.join('')}</tr>`;

const rows = [
  `<tr><th></th>${PAIRS.map(([n5, n4]) => `<td class="l">${n5}<br><span class="dim">vs ${n4}</span></td>`).join('')}</tr>`,
  row('tier 4 ×1', PAIRS.map(([, n4]) => cell(img(n4, 1)))),
  row('tier 5 ×1', PAIRS.map(([n5]) => cell(img(n5, 1)))),
  row('tier 4 ×2', PAIRS.map(([, n4]) => cell(img(n4, 2)))),
  row('tier 5 ×2', PAIRS.map(([n5]) => cell(img(n5, 2)))),
  ...RARITIES.map((r) => row(`${r} ×2`, PAIRS.map(([n5]) => cell(frame(n5, r, 2))))),
  row('Void (legendary) ×2', PAIRS.map(([n5]) => cell(frame(n5, 'legendary', 2, 'void')))),
  row('Prismatic (legendary) ×2', PAIRS.map(([n5]) => cell(frame(n5, 'legendary', 2, 'prismatic')))),
  row('Prismatic (mythic) ×2', PAIRS.map(([n5]) => cell(frame(n5, 'mythic', 2, 'prismatic')))),
  row('Void (rare) ×1', PAIRS.map(([n5]) => cell(frame(n5, 'rare', 1, 'void')))),
  row('Prismatic (epic) ×1', PAIRS.map(([n5]) => cell(frame(n5, 'epic', 1, 'prismatic')))),
  row('epic ×1', PAIRS.map(([n5]) => cell(frame(n5, 'epic', 1)))),
];

const html = `<!doctype html><html><head><style>${css}
body { margin: 0; padding: 16px; background: var(--ink-850, #1b1512); color: #c8baa0;
  font: 13px/1.3 'DejaVu Sans', sans-serif; display: inline-block; }
h1 { font-size: 15px; margin: 0 0 10px; font-weight: 600; }
table { border-collapse: separate; border-spacing: 10px 8px; }
th { text-align: right; font-weight: 500; color: #978c7e; white-space: nowrap; }
td { text-align: center; vertical-align: middle; }
.c { display: grid; place-items: center; min-width: 96px; min-height: 40px; }
.l { font-size: 11px; color: #c8baa0; }
.dim { color: #978c7e; }
</style></head><body>
<h1>A.17 tier-5 item icons (the Hollow Reach): next to tier 4, and inside every rarity frame, Void and Prismatic</h1>
<table>${rows.join('\n')}</table></body></html>`;

const browser = await playwright.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'load' });
await page.locator('body').screenshot({ path: OUT, animations: 'disabled' });
await browser.close();
console.log(`wrote ${OUT}`);
