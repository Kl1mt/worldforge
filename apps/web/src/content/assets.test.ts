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
  classAttackSheet,
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
  frames?: number;
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
      frames: 'frames' in a ? a.frames : undefined,
    }));
    const fromManifest = manifest.assets.map((m) => ({
      id: m.id,
      path: m.path,
      size: m.size,
      facing: m.facing,
      frames: m.frames,
    }));
    expect(registry).toEqual(fromManifest);
  });
});

describe('Cinderwastes stand-ins (ticket 6.1)', () => {
  it('resolves every Cinderwastes name: A.11’s art, and tinted stand-ins for the tier-4 icons', () => {
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
      // A.11 drew them: the real art, untinted.
      expect(Object.hasOwn(ASSETS, id), id).toBe(true);
      expect(sprite!.tint, id).toBeUndefined();
    }
    // Every content name of the Verge resolves (the area, its foes and its tier-4 icons).
    const verge = getArea('ashfallVerge');
    expect(findSprite(verge.assetId)).not.toBeNull();
    for (const e of verge.enemies)
      expect(findSprite(getEnemy(e.enemyId).assetId), e.enemyId).not.toBeNull();
    for (const b of ITEM_BASES.filter((x) => x.tier === 4))
      expect(findSprite(b.icon), b.id).not.toBeNull();
    // Stand-ins (the tier-4 icons) point at registered art only, and only for art still missing.
    for (const [id, target] of Object.entries(ART_STAND_INS)) {
      expect(Object.hasOwn(ASSETS, target), `${id} → ${target}`).toBe(true);
      expect(Object.hasOwn(ASSETS, id), `${id} is drawn now: remove its stand-in`).toBe(false);
      expect(findSprite(id)!.tint, id).toBe('cinder');
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

describe('hero attack frames (A.14)', () => {
  /** Width and height from a PNG's IHDR chunk. */
  const pngSize = (path: string) => {
    const buf = readFileSync(new URL(`../../public${path}`, import.meta.url));
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  };

  it('has an 8-frame 128 px sheet for every class, one row wide', () => {
    for (const classId of CLASS_IDS) {
      const sheet = classAttackSheet(classId);
      expect(sheet, classId).toMatchObject({ width: 128, height: 128, frames: 8 });
      expect(pngSize(sheet!.path)).toEqual({ width: 128 * 8, height: 128 });
    }
  });

  it('starts every sheet on the class portrait, so the loop rests on the familiar pose', () => {
    // Frame 0 is pasted from the portrait; same palette and outline (tools/art/hero_frames.py).
    for (const classId of CLASS_IDS) {
      expect(classAttackSheet(classId)!.path).toBe(`/assets/characters/${classId}-attack.png`);
      expect(classPortrait(classId).frames).toBeUndefined();
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

describe('Cinderwastes art (A.11)', () => {
  /** Width and height from a PNG's IHDR chunk. */
  const pngSize = (path: string) => {
    const bytes = readFileSync(new URL(`../../public${path}`, import.meta.url));
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  };

  // The names tickets 6.1 (area, enemies) and 6.2 (deeper area, region boss) build on: keep them.
  const ART = {
    'area.cinderwastes': 'area.ashen-pass',
    'area.cinder-depths': 'area.ashen-pass',
    'enemy.cinder-revenant': 'enemy.cinder-hound',
    'enemy.ash-colossus': 'enemy.ember-golem',
    'enemy.ember-wisp': 'enemy.ash-wraith',
    'enemy.slag-hound': 'enemy.cinder-hound',
    'enemy.forge-tyrant': 'enemy.ashen-warden',
  } as const;

  it('resolves every name to a manifest entry and a file the size of its Ashen Pass peer', () => {
    for (const [id, peer] of Object.entries(ART)) {
      const sprite = findSprite(id);
      expect(sprite, id).not.toBeNull();
      const entry = manifest.assets.find((m) => m.id === id);
      expect(entry?.path, id).toBe(sprite?.path);
      expect(existsSync(new URL(`../../public${entry?.path}`, import.meta.url)), id).toBe(true);
      expect(pngSize(entry!.path), id).toEqual(entry?.size);
      const peerSprite = findSprite(peer);
      expect(entry?.size, id).toEqual({ width: peerSprite?.width, height: peerSprite?.height });
    }
  });

  it('faces the hero without mirroring, so a later animation pass can reuse the sprites', () => {
    for (const id of Object.keys(ART).filter((k) => k.startsWith('enemy.'))) {
      expect(findSprite(id)?.facing, id).not.toBe('right');
    }
  });
});
