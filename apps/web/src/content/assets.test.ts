import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACHIEVEMENTS,
  CLASS_IDS,
  GUILD_EMBLEMS,
  ITEM_BASES,
  PRESTIGE_METRICS,
  getArea,
  getEnemy,
} from '@worldforge/game-core';
import {
  ART_STAND_INS,
  ASSETS,
  SEASON_FRAME_TIERS,
  SEASON_FRAME_WINDOW,
  arenaBackdrop,
  classPortrait,
  findSprite,
  seasonFrameAsset,
  titleBadgeAsset,
  type SpriteAsset,
} from './assets';

interface ManifestEntry {
  id: string;
  path: string;
  size: { width: number; height: number };
  facing?: string;
  window?: { x: number; y: number; width: number; height: number };
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

describe('Cinderwastes stand-ins (ticket 6.1)', () => {
  it('shows a tinted existing sprite for every fixed Cinderwastes name until its art lands', () => {
    const names = [
      'area.cinderwastes',
      'enemy.cinder-revenant',
      'enemy.ash-colossus',
      'enemy.ember-wisp',
      'enemy.slag-hound',
    ];
    for (const id of names) {
      const sprite = findSprite(id);
      expect(sprite, id).not.toBeNull();
      // Registered art wins; otherwise the stand-in is drawn with the ember tint.
      if (!Object.hasOwn(ASSETS, id)) expect(sprite!.tint, id).toBe('cinder');
    }
    // Every content name of the Verge resolves (the area, its foes and its tier-4 icons).
    const verge = getArea('ashfallVerge');
    expect(findSprite(verge.assetId)).not.toBeNull();
    for (const e of verge.enemies)
      expect(findSprite(getEnemy(e.enemyId).assetId), e.enemyId).not.toBeNull();
    for (const b of ITEM_BASES.filter((x) => x.tier === 4))
      expect(findSprite(b.icon), b.id).not.toBeNull();
    // Stand-ins point at registered art only.
    for (const [id, target] of Object.entries(ART_STAND_INS)) {
      expect(Object.hasOwn(ASSETS, target), `${id} → ${target}`).toBe(true);
    }
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

describe('season prestige art (A.10)', () => {
  /** The manifest entry for a sprite, and the file it names under public/. */
  const resolve = (sprite: SpriteAsset) => {
    const entry = manifest.assets.find((m) => m.path === sprite.path);
    const file = new URL(`../../public${sprite.path}`, import.meta.url);
    return { entry, exists: existsSync(file) };
  };

  // The names ticket 5.3 (frames, badges) and 5.5 (arena) build on: keep them stable.
  it('resolves every season frame, best tier first, to a 64×64 file with the shared window', () => {
    expect(SEASON_FRAME_TIERS).toEqual(['champion', 'exalted', 'renowned', 'veteran']);
    for (const tier of SEASON_FRAME_TIERS) {
      const frame = seasonFrameAsset(tier);
      expect(frame.path).toBe(`/assets/frames/season-frame-${tier}.png`);
      const { entry, exists } = resolve(frame);
      expect(exists, tier).toBe(true);
      expect(entry, tier).toMatchObject({ size: { width: 64, height: 64 } });
      expect(entry?.window, tier).toEqual(SEASON_FRAME_WINDOW);
    }
  });

  it('keeps the frame window centred and inside the frame', () => {
    const { x, y, width, height } = SEASON_FRAME_WINDOW;
    expect(x * 2 + width).toBe(64);
    expect(y * 2 + height).toBe(64);
  });

  it('resolves a 32×32 title badge for every leaderboard metric', () => {
    const names = {
      level: 'title-badge-level',
      gearScore: 'title-badge-gear-score',
      power: 'title-badge-power',
      pveProgress: 'title-badge-pve-progress',
      arena: 'title-badge-power',
    };
    for (const metric of PRESTIGE_METRICS) {
      const badge = titleBadgeAsset(metric);
      expect(badge.path).toBe(`/assets/badges/${names[metric]}.png`);
      const { entry, exists } = resolve(badge);
      expect(exists, metric).toBe(true);
      expect(entry, metric).toMatchObject({ size: { width: 32, height: 32 } });
    }
  });

  it('resolves the arena backdrop at the area backdrop size', () => {
    const arena = arenaBackdrop();
    expect(arena.path).toBe('/assets/areas/arena.png');
    const { entry, exists } = resolve(arena);
    expect(exists).toBe(true);
    expect(entry).toMatchObject({ size: { width: 384, height: 216 } });
    expect(entry?.size).toEqual(resolve(ASSETS['area.ashen-pass']).entry?.size);
  });
});
