import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACHIEVEMENTS,
  AREAS,
  CLASS_IDS,
  GUILD_EMBLEMS,
  ITEM_BASES,
  PRESTIGE_METRICS,
  getArea,
  getEnemy,
  getMaterial,
} from '@worldforge/game-core';
import {
  ART_STAND_INS,
  ART_VARIANTS,
  heroicSprite,
  ASSETS,
  SEASON_FRAME_TIERS,
  SEASON_FRAME_WINDOW,
  arenaBackdrop,
  classAttackSheet,
  enemyAttackSheet,
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
  lead?: number;
  window?: { x: number; y: number; width: number; height: number };
  kind?: string;
  slot?: string;
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
      lead: 'lead' in a ? a.lead : undefined,
    }));
    const fromManifest = manifest.assets.map((m) => ({
      id: m.id,
      path: m.path,
      size: m.size,
      facing: m.facing,
      frames: m.frames,
      lead: m.lead,
    }));
    expect(registry).toEqual(fromManifest);
  });
});

describe('Cinderwastes art (tickets 6.1, A.11, A.15)', () => {
  it('resolves every Cinderwastes name to its own art, untinted', () => {
    const names = [
      'area.cinderwastes',
      'enemy.cinder-revenant',
      'enemy.ash-colossus',
      'enemy.ember-wisp',
      'enemy.slag-hound',
    ];
    const verge = getArea('ashfallVerge');
    names.push(verge.assetId, ...verge.enemies.map((e) => getEnemy(e.enemyId).assetId));
    for (const id of names) {
      expect(Object.hasOwn(ASSETS, id), id).toBe(true);
      expect(findSprite(id)!.tint, id).toBeUndefined();
    }
  });

  it('gives every tier-4 base its own 32×32 icon file (A.15), not a tinted tier-3 one', () => {
    const tier4 = ITEM_BASES.filter((b) => b.tier === 4);
    expect(tier4).toHaveLength(10);
    const files = new Set<string>();
    const lowerTierFiles = new Set(
      ITEM_BASES.filter((b) => b.tier < 4).map((b) => findSprite(b.icon)?.path),
    );
    for (const base of tier4) {
      expect(base.icon, base.id).toBe(`item.${base.id}`);
      const sprite = findSprite(base.icon);
      expect(sprite, base.id).toMatchObject({
        path: `/assets/items/${base.id}.png`,
        width: 32,
        height: 32,
      });
      expect(sprite!.tint, base.id).toBeUndefined();
      expect(lowerTierFiles.has(sprite!.path), base.id).toBe(false);
      files.add(sprite!.path);

      const entry = manifest.assets.find((m) => m.id === base.icon);
      expect(entry, base.id).toMatchObject({ kind: 'item', slot: base.slot });
      const file = new URL(`../../public${sprite!.path}`, import.meta.url);
      expect(existsSync(file), base.id).toBe(true);
      const buf = readFileSync(file);
      expect({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }, base.id).toEqual({
        width: 32,
        height: 32,
      });
    }
    expect(files.size).toBe(tier4.length);
  });

  it('draws the Cinder Depths’ foes and the Tyrant’s ember as ember variants (ticket 6.2)', () => {
    const depths = getArea('cinderDepths');
    expect(findSprite(depths.assetId)!.tint).toBeUndefined();
    for (const e of depths.enemies) {
      const id = getEnemy(e.enemyId).assetId;
      expect(Object.hasOwn(ASSETS, id), `${id} has no file of its own`).toBe(false);
      const sprite = findSprite(id)!;
      expect(sprite.tint, id).toBe('ember');
      expect(sprite.path, id).toBe(ASSETS[ART_VARIANTS[id]!].path);
      // Its attack frames are its Verge kin's, where that foe has them.
      const kin = enemyAttackSheet(ART_VARIANTS[id]!);
      expect(enemyAttackSheet(id)?.path ?? null, id).toBe(kin?.path ?? null);
    }
    for (const target of Object.values(ART_VARIANTS))
      expect(Object.hasOwn(ASSETS, target), target).toBe(true);
    // The region boss has his own art (A.11), untinted.
    const tyrant = getEnemy('forgeTyrant');
    expect(findSprite(tyrant.assetId)).toEqual(ASSETS['enemy.forge-tyrant']);
    expect(findSprite(getMaterial('tyrantsEmber').icon)!.tint).toBe('ember');
  });

  it('keeps the ember-tinted stand-in only as a fallback for art still missing', () => {
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

describe('enemy attack frames (A.14b)', () => {
  const pngSize = (path: string) => {
    const buf = readFileSync(new URL(`../../public${path}`, import.meta.url));
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  };
  /** Frames that missed the bar after the regeneration; they keep the code animation. */
  // Ticket 6.2: the Depths' mastiff and wisp are drawn as the slag hound and ember wisp (no frames).
  const NO_FRAMES = new Set([
    'enemy.cinder-hound',
    'enemy.slag-hound',
    'enemy.ember-wisp',
    'enemy.slag-mastiff',
    'enemy.ashflame-wisp',
  ]);

  it('has a left-facing 8-frame sheet for every common enemy of the areas, bosses excepted', () => {
    const ids = new Set(AREAS.flatMap((a) => a.enemies.map((e) => getEnemy(e.enemyId).assetId)));
    // Every early, Pass and Verge enemy is covered, but for the recorded misses.
    expect(ids.size).toBeGreaterThanOrEqual(17);
    for (const id of ids) {
      const sheet = enemyAttackSheet(id);
      if (NO_FRAMES.has(id) || id === 'enemy.abbey-wraith') {
        expect(sheet, id).toBeNull();
        continue;
      }
      const still = findSprite(id)!;
      expect(sheet, id).toMatchObject({ frames: 8, facing: 'left', height: still.height });
      // The frame is the still plus its strike room.
      expect(sheet!.width - (sheet!.lead ?? 0), id).toBe(still.width);
      expect(pngSize(sheet!.path), id).toEqual({ width: sheet!.width * 8, height: still.height });
    }
  });

  it('gives bosses no frames: they keep the code animation', () => {
    for (const id of ['enemy.gravewarden', 'enemy.ashen-warden', 'enemy.forge-tyrant']) {
      expect(enemyAttackSheet(id), id).toBeNull();
    }
  });
});

describe('heraldry art (A.8)', () => {
  /**
   * Achievements whose icons are still to be drawn (an art follow-up); the UI shows the wax-seal
   * placeholder for them. Remove an id as soon as its icon lands (A.9 drew the 4.6 project deeds).
   */
  // Ticket 6.7: the Forgeward Outpost's mark shows the wax-seal placeholder until its icon is drawn.
  const AWAITING_ART = new Set<string>(['forgewardBuilder']);

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

describe('the Heroic treatment (ticket 6.3)', () => {
  it('draws the crypt’s own art tinted, never new art', () => {
    for (const id of ['area.nameless-crypt', 'enemy.gravewarden', 'enemy.crypt-ghoul'] as const) {
      const plain = findSprite(id)!;
      const heroic = heroicSprite(plain);
      expect(heroic.path).toBe(plain.path);
      expect([heroic.width, heroic.height]).toEqual([plain.width, plain.height]);
      expect(heroic.tint).toBe('heroic');
      expect(plain.tint).toBeUndefined();
    }
  });
});
