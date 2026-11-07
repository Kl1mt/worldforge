import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACHIEVEMENTS, CLASS_IDS, GUILD_EMBLEMS } from '@worldforge/game-core';
import { ASSETS, classPortrait, findSprite } from './assets';

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

describe('heraldry art (A.8)', () => {
  /**
   * Achievements whose icons are still to be drawn (an art follow-up); the UI shows the wax-seal
   * placeholder for them. Remove an id as soon as its icon lands (A.9 drew the 4.6 project deeds).
   */
  const AWAITING_ART = new Set<string>([]);

  it('has a 32×32 icon for every achievement', () => {
    for (const a of ACHIEVEMENTS) {
      if (AWAITING_ART.has(a.id)) {
        expect(findSprite(a.assetId), a.id).toBeNull();
        continue;
      }
      expect(findSprite(a.assetId), a.id).toMatchObject({ width: 32, height: 32 });
    }
  });

  it('has a 32×32 charge for every guild emblem', () => {
    for (const e of GUILD_EMBLEMS) {
      expect(findSprite(e.assetId), e.id).toMatchObject({ width: 32, height: 32 });
    }
  });

  it('returns null for an unknown id, so the UI falls back to its placeholder', () => {
    expect(findSprite('achievement.not-drawn-yet')).toBeNull();
    expect(findSprite('toString')).toBeNull();
  });
});
