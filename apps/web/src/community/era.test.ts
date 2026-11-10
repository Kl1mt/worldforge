import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WORLD_ERA_IDS } from '@worldforge/game-core';

/** Ticket 6.7: every era has its town treatment (tint and banners), scoped to `hub-era`. */
describe('era styles', () => {
  const css = readFileSync(new URL('./era.css', import.meta.url), 'utf8');

  it('tints the town and hangs banners for every era', () => {
    for (const id of WORLD_ERA_IDS) {
      const block = css.match(new RegExp(`\\.hub-era--${id} \\{([^}]*)\\}`));
      expect(block, id).not.toBeNull();
      expect(block![1], id).toContain('--hub-era-tint');
      expect(block![1], id).toContain('--hub-era-banner');
    }
  });

  it('keeps every selector in its own namespace', () => {
    // Every rule's selector (top level or in a media query) is a `hub-era` class.
    const selectors = [...css.matchAll(/^\s*([.#a-z][^{;]*)\{\s*$/gm)].map((m) => m[1]!.trim());
    expect(selectors.length).toBeGreaterThan(10);
    for (const s of selectors) expect(s, s).toMatch(/^\.hub-era/);
  });
});
