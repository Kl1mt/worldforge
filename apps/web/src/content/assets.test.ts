import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLASS_IDS } from '@worldforge/game-core';
import { ASSETS, classPortrait } from './assets';

interface ManifestEntry {
  id: string;
  path: string;
  size: { width: number; height: number };
  facing?: string;
}

const manifest = JSON.parse(
  readFileSync(new URL('../../public/assets/manifest.json', import.meta.url), 'utf8'),
) as { assets: ManifestEntry[] };

describe('asset registry', () => {
  it('matches manifest.json entry for entry', () => {
    const registry = Object.entries(ASSETS).map(([id, a]) => ({
      id,
      path: a.path,
      size: { width: a.width, height: a.height },
      facing: 'facing' in a ? a.facing : undefined,
    }));
    const fromManifest = manifest.assets.map((m) => ({
      id: m.id,
      path: m.path,
      size: m.size,
      facing: m.facing,
    }));
    expect(registry).toEqual(fromManifest);
  });
});

describe('classPortrait', () => {
  it('has a portrait for every class', () => {
    for (const classId of CLASS_IDS) {
      expect(classPortrait(classId).path).toBe(`/assets/characters/${classId}.png`);
    }
  });
});
