import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  VARIANT_PREVIEW_ICONS,
  VARIANT_PREVIEW_ROWS,
  VariantPreview,
} from '../admin/VariantPreview';
import { findSprite } from '../content/assets';
import type { VariantView } from '../game/items';
import { ItemFrame } from './ItemFrame';
import { shimmerClass, variantTreatment } from './itemVariant';

const variant = (id: string): VariantView => ({
  id: id as VariantView['id'],
  name: id === 'void' ? 'Void' : 'Prismatic',
  implicitBonus: 0.1,
  effectBonus: 0,
  affixBonus: 0,
});
const item = (v: VariantView | null) => ({
  icon: 'item.cinderforged-blade',
  name: 'Cinderforged Blade',
  rarity: 'legendary' as const,
  variant: v,
});
const frame = (v: VariantView | null, scale = 2) =>
  renderToStaticMarkup(<ItemFrame item={item(v)} scale={scale} />);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('variant treatment (ticket A.12)', () => {
  it('is chosen by the variant id only', () => {
    expect(variantTreatment('void')).toBe('void');
    expect(variantTreatment('prismatic')).toBe('prismatic');
    expect(variantTreatment(null)).toBeNull();
    expect(variantTreatment(undefined)).toBeNull();
    expect(variantTreatment('radiant')).toBeNull();
  });

  it('draws Prismatic with its own layers and mark, never Void’s', () => {
    const html = frame(variant('prismatic'));
    expect(html).toContain('item-frame--prismatic');
    expect(html).not.toContain('item-frame--void');
    expect(html).toContain('✧');
    expect(html).not.toContain('◇');
    expect(html.match(/item-frame__prism item-frame__prism--/g)).toHaveLength(2);
    expect(html).toContain('item-frame__prism-ring');
    // The accessible name keeps the variant word before the rarity, like Void.
    expect(html).toContain('aria-label="Cinderforged Blade, Prismatic legendary"');
  });

  it('draws Void with its own moving layers behind the icon, never Prismatic’s', () => {
    const html = frame(variant('void'));
    expect(html).toContain('item-frame--void');
    expect(html).toContain('◇');
    expect(html).not.toContain('item-frame__prism');
    // A.12b: the motes and the breathing edge come before the icon (drawn behind it).
    const motes = html.indexOf('item-frame__void-motes');
    const edge = html.indexOf('item-frame__void-edge"');
    const icon = html.indexOf('<img');
    expect(motes).toBeGreaterThan(-1);
    expect(edge).toBeGreaterThan(motes);
    expect(icon).toBeGreaterThan(edge);
    const path = findSprite('item.cinderforged-blade')!.path;
    expect(html).toContain(`mask-image:url(&quot;${path}&quot;)`);
    for (const layer of ['item-frame__void-motes', 'item-frame__void-edge']) {
      expect(html).toMatch(
        new RegExp(`class="${layer}" aria-hidden="true" style="width:64px;height:64px"`),
      );
    }
  });

  it('draws a plain item without variant classes or layers', () => {
    const html = frame(null);
    expect(html).not.toMatch(/item-frame--(void|prismatic|shimmer)/);
    expect(html).not.toContain('item-frame__prism');
    expect(html).not.toContain('item-frame__void');
    expect(html).not.toContain('item-frame__variant');
  });

  it('sizes the overlays to the sprite at its integer scale and clips them to its alpha', () => {
    const path = findSprite('item.cinderforged-blade')!.path;
    for (const [scale, px] of [
      [1, 32],
      [2, 64],
      [2.6, 64],
      [3, 96],
    ] as const) {
      const html = frame(variant('prismatic'), scale);
      const layers = html.match(/<span class="item-frame__prism item-frame__prism--[^"]+"[^>]*>/g)!;
      expect(layers).toHaveLength(2);
      for (const l of layers) {
        expect(l).toContain(`width:${px}px;height:${px}px`);
        expect(l).toContain(`mask-image:url(&quot;${path}&quot;)`);
        expect(l).toContain('aria-hidden="true"');
      }
      // Same box as the icon itself, so nothing moves.
      expect(html).toContain(`width="${px}" height="${px}"`);
    }
  });

  it('draws no overlay where the art is missing', () => {
    const html = renderToStaticMarkup(
      <ItemFrame item={{ ...item(variant('prismatic')), icon: null }} />,
    );
    expect(html).toContain('item-frame--prismatic');
    expect(html).not.toContain('item-frame__prism');
  });
});

describe('Prismatic motion (ticket A.12)', () => {
  it('moves in a normal browser, stays still under automation unless overridden', () => {
    expect(shimmerClass('auto', { automated: false, override: null })).toBe('item-frame--shimmer');
    expect(shimmerClass('auto', { automated: true, override: null })).toBe('');
    expect(shimmerClass('auto', { automated: true, override: 'on' })).toBe('item-frame--shimmer');
    expect(shimmerClass('auto', { automated: false, override: 'off' })).toBe('');
    expect(shimmerClass('still', { automated: false, override: null })).toBe('');
    expect(shimmerClass('forced', { automated: true, override: null })).toBe(
      'item-frame--shimmer-forced',
    );
  });

  it('reads navigator.webdriver when the frame renders, for both variants', () => {
    for (const id of ['prismatic', 'void']) {
      vi.stubGlobal('navigator', { webdriver: true });
      expect(frame(variant(id))).not.toContain('item-frame--shimmer');
      vi.stubGlobal('navigator', { webdriver: false });
      expect(frame(variant(id))).toContain('item-frame--shimmer');
    }
  });
});

describe('Prismatic stylesheet (ticket A.12)', () => {
  const css = readFileSync(new URL('./item-frame.css', import.meta.url), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  // Top-level rules and the reduced-motion blocks (Void's and Prismatic's), as [selector, body].
  const blocks = [
    ...css.matchAll(/@media \(prefers-reduced-motion: no-preference\) \{([\s\S]*?\})\s*\}/g),
  ];
  const outside = blocks.reduce((rest, b) => rest.replace(b[0], ''), css);
  const rules = (src: string) =>
    [...src.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1]!.trim(), m[2]!] as const);
  const prismRules = rules(outside).filter(([sel]) => /prism/.test(sel));

  it('animates the sweep only under no-preference, or when the gallery forces it', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const block of blocks) {
      for (const [sel, body] of rules(block[1]!)) {
        // Ticket 6.5b: the awakened ember glow follows the same rule.
        if (/animation:/.test(body)) expect(sel).toMatch(/^\.item-frame--(shimmer|ember) /);
      }
    }
    for (const [sel, body] of rules(outside)) {
      if (/animation:/.test(body)) expect(sel).toMatch(/^\.item-frame--(shimmer|ember)-forced /);
    }
    // Whole art pixels only: every Prismatic animation steps.
    for (const m of css.matchAll(/animation: item-prism-[a-z]+ [\d.]+s ([^;]+);/g)) {
      expect(m[1]).toMatch(/^steps\(\d+\) infinite$/);
    }
  });

  it('never changes the frame’s box, and never blurs', () => {
    for (const [sel, body] of prismRules) {
      expect(body, sel).not.toMatch(/blur\(/);
      if (/^\.item-frame--prismatic$/.test(sel)) {
        expect(body).not.toMatch(/\b(width|height|padding|margin|border(-width)?)\s*:/);
      }
    }
    const ring = prismRules.find(([sel]) => sel === '.item-frame__prism-ring');
    expect(ring?.[1]).toMatch(/position: absolute;/);
    const layers = prismRules.find(([sel]) =>
      /\.item-frame__prism\s*$/.test(sel.split(',').at(-1)!),
    );
    expect(layers?.[0]).toContain('.item-frame--prismatic > .pixel');
    expect(layers?.[1]).toMatch(/grid-area: 1 \/ 1;/);
    expect(prismRules.find(([sel]) => sel === '.item-frame__prism')?.[1]).toMatch(
      /image-rendering: pixelated;/,
    );
  });
});

describe('Void motion stylesheet (ticket A.12b)', () => {
  const css = readFileSync(new URL('./item-frame.css', import.meta.url), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  const blocks = [
    ...css.matchAll(/@media \(prefers-reduced-motion: no-preference\) \{([\s\S]*?\})\s*\}/g),
  ];
  const outside = blocks.reduce((rest, b) => rest.replace(b[0], ''), css);
  const rules = (src: string) =>
    [...src.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1]!.trim(), m[2]!] as const);
  const find = (src: string, sel: string) => rules(src).find(([s]) => s === sel)?.[1];

  it('keeps the still Void exactly the 3.5 look: static edge on the icon, moving layers hidden', () => {
    expect(find(outside, '.item-frame--void > img')).toMatch(
      /saturate\(0\.4\) brightness\(0\.9\) drop-shadow/,
    );
    const hidden = rules(outside).find(([s]) =>
      /^\.item-frame__void-motes,\s*\.item-frame__void-edge$/.test(s),
    );
    expect(hidden?.[1]).toMatch(/display: none;/);
    // Only the motion gates show the layers or take the edge off the icon.
    for (const [sel, body] of [...rules(outside), ...blocks.flatMap((b) => rules(b[1]!))]) {
      if (/display: block;/.test(body)) {
        for (const part of sel.split(',').map((p) => p.trim())) {
          if (/__void-(motes|edge)$/.test(part)) expect(part).toMatch(/item-frame--shimmer/);
        }
      }
      if (/void.*> \.pixel$/.test(sel) && !/drop-shadow/.test(body)) {
        expect(sel).toMatch(/item-frame--shimmer/);
      }
    }
  });

  it('moves in whole art pixels: stepped timing, integer transforms, no blur', () => {
    const anims = [...css.matchAll(/animation: (item-void-[a-z]+) ([\d.]+)s ([^;]+);/g)];
    expect(anims.length).toBe(4);
    for (const [, name, , timing] of anims) {
      expect(timing).toMatch(
        name === 'item-void-motes' ? /^steps\(16\) infinite$/ : /^step-end infinite$/,
      );
    }
    const breath = css.slice(css.indexOf('@keyframes item-void-breath'));
    const body = breath.slice(0, breath.indexOf('@keyframes item-void-motes'));
    for (const m of body.matchAll(/transform: ([^;]+);/g)) {
      expect(m[1]).toMatch(/^(none|translateX\(var\(--px, 1px\)\))$/);
    }
    for (const [sel, b] of rules(css).filter(([sel]) => /void/.test(sel))) {
      expect(b, sel).not.toMatch(/blur\(/);
    }
    expect(find(outside, '.item-frame__void-motes')).toMatch(/image-rendering: pixelated;/);
    // The layers share the icon's grid cell: no layout change.
    const cell = rules(outside).find(
      ([s]) => s.includes('.item-frame__void-motes') && s.includes('> .pixel'),
    );
    expect(cell?.[1]).toMatch(/grid-area: 1 \/ 1;/);
  });
});

describe('gallery Variants section (ticket A.12)', () => {
  it('shows every rarity and a set piece, plain, Void and Prismatic', () => {
    const html = renderToStaticMarkup(<VariantPreview scale={2} shimmer="forced" />);
    const cells = VARIANT_PREVIEW_ICONS.length * VARIANT_PREVIEW_ROWS.length;
    expect(html.match(/class="item-frame /g)).toHaveLength(cells);
    // Ticket 6.5b: each variant row again awakened, and a plain awakened row.
    const n = VARIANT_PREVIEW_ICONS.length;
    expect(html.match(/item-frame--prismatic/g)).toHaveLength(2 * n);
    expect(html.match(/item-frame--void/g)).toHaveLength(2 * n);
    // Both variants move after Play (A.12b: Void too), in the plain and the awakened rows.
    expect(html.match(/item-frame--shimmer-forced/g)).toHaveLength(4 * n);
    expect(html.match(/item-frame--awakened/g)).toHaveLength(3 * n);
    expect(html.match(/item-frame--ember-forced/g)).toHaveLength(3 * n);
    for (const r of ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic']) {
      expect(html).toContain(`rarity-${r}`);
    }
    for (const c of VARIANT_PREVIEW_ICONS) expect(findSprite(c.icon), c.icon).not.toBeNull();
  });

  it('stays still until Play', () => {
    const html = renderToStaticMarkup(<VariantPreview scale={1} shimmer="still" />);
    expect(html).not.toContain('item-frame--shimmer');
    expect(html).not.toContain('item-frame--ember');
  });
});
