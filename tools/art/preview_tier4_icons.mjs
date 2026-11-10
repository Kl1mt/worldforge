// Contact sheet for art ticket A.15 (the ten tier-4 item icons).
//
// Usage (from the repo root): node tools/art/preview_tier4_icons.mjs
//
// Writes art/preview-tier4-icons.png: the ten icons at ×1 and ×2 next to their tier-3
// counterparts, then each icon inside every rarity frame and the Void treatment. The frames use
// the game's own stylesheets (tokens, base, item-frame), so they match the UI. Spends no
// generations.
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
const ITEMS = `${ROOT}/apps/web/public/assets/items`;
const OUT = `${ROOT}/art/preview-tier4-icons.png`;

// Tier-4 base → its tier-3 counterpart (the icon 6.1 showed ember-tinted until A.15).
const PAIRS = [
  ['cinderforged-blade', 'knights-greatsword'],
  ['emberheart-scepter', 'drowned-crozier'],
  ['slagbone-bow', 'horn-recurve'],
  ['obsidian-bulwark', 'tower-shield'],
  ['revenant-visage', 'great-helm'],
  ['ashplate-hauberk', 'knights-plate'],
  ['slagiron-gauntlets', 'plated-gauntlets'],
  ['cinderstride-greaves', 'plate-sabatons'],
  ['ember-reliquary', 'abbey-pendant'],
  ['wispfire-band', 'abbey-signet'],
];
const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];

// The app's order: component styles first, then base.css (`main.tsx`), whose `.rarity-*` win.
const css = [
  'apps/web/src/styles/tokens.css',
  'apps/web/src/components/item-frame.css',
  'apps/web/src/styles/base.css',
]
  .map((f) => readFileSync(`${ROOT}/${f}`, 'utf8'))
  .join('\n');
const src = (name) =>
  `data:image/png;base64,${readFileSync(`${ITEMS}/${name}.png`).toString('base64')}`;
const img = (name, scale) =>
  `<img class="pixel" src="${src(name)}" width="${32 * scale}" height="${32 * scale}" alt="">`;
const frame = (name, rarity, scale, isVoid = false) =>
  `<span class="item-frame rarity-${rarity}${isVoid ? ' item-frame--void' : ''}" style="--px:${scale}px">${img(name, scale)}${isVoid ? '<span class="item-frame__variant">◇</span>' : ''}</span>`;

const cell = (inner, label = '') =>
  `<td><div class="c">${inner}</div>${label ? `<div class="l">${label}</div>` : ''}</td>`;
const row = (head, cells) => `<tr><th>${head}</th>${cells.join('')}</tr>`;

const rows = [
  `<tr><th></th>${PAIRS.map(([n4, n3]) => `<td class="l">${n4}<br><span class="dim">vs ${n3}</span></td>`).join('')}</tr>`,
  row('tier 3 ×1', PAIRS.map(([, n3]) => cell(img(n3, 1)))),
  row('tier 4 ×1', PAIRS.map(([n4]) => cell(img(n4, 1)))),
  row('tier 3 ×2', PAIRS.map(([, n3]) => cell(img(n3, 2)))),
  row('tier 4 ×2', PAIRS.map(([n4]) => cell(img(n4, 2)))),
  ...RARITIES.map((r) => row(`${r} ×2`, PAIRS.map(([n4]) => cell(frame(n4, r, 2))))),
  row('Void (legendary) ×2', PAIRS.map(([n4]) => cell(frame(n4, 'legendary', 2, true)))),
  row('Void (rare) ×1', PAIRS.map(([n4]) => cell(frame(n4, 'rare', 1, true)))),
  row('epic ×1', PAIRS.map(([n4]) => cell(frame(n4, 'epic', 1)))),
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
<h1>A.15 tier-4 item icons (the Cinderwastes): next to tier 3, and inside every rarity frame and Void</h1>
<table>${rows.join('\n')}</table></body></html>`;

const browser = await playwright.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'load' });
await page.locator('body').screenshot({ path: OUT });
await browser.close();
console.log(`wrote ${OUT}`);
