import {
  AREAS,
  CLASS_IDS,
  CLASS_STAT_PROFILES,
  DUNGEONS,
  GUILD_BOSSES,
  getClass,
  getEnemy,
  type ClassId,
  type EnemyId,
} from '@worldforge/game-core';
import {
  ASSETS,
  classAttackSheet,
  classPortrait,
  enemyAttackSheet,
  findSprite,
  type SpriteAsset,
} from '../content/assets';

/**
 * Ticket A.14c: the admin animation gallery's catalogue. Every hero class, every enemy (by the
 * area, dungeon or event it appears in, plus registered art not placed in the game yet) and every
 * area backdrop, from game-core content and the asset registry only: no player data, no requests.
 */

export interface GalleryHero {
  key: string;
  classId: ClassId;
  name: string;
  still: SpriteAsset;
  sheet: SpriteAsset | null;
  /** Attacks per second at level 1: paces the scene preview like the real loop. */
  attackSpeed: number;
}

export interface GalleryEnemy {
  /** Unique within its group. */
  key: string;
  name: string;
  assetId: string;
  still: SpriteAsset | null;
  sheet: SpriteAsset | null;
  boss: boolean;
}

export interface GalleryBackdrop {
  assetId: string;
  sprite: SpriteAsset | null;
}

export interface GalleryGroup {
  id: string;
  title: string;
  /** "Levels 1–6", "Dungeon", "Not yet placed"… */
  note: string;
  backdrops: GalleryBackdrop[];
  enemies: GalleryEnemy[];
}

export interface GalleryCatalogue {
  heroes: GalleryHero[];
  groups: GalleryGroup[];
}

const enemyEntry = (id: EnemyId, boss = false): GalleryEnemy => {
  const def = getEnemy(id);
  return {
    key: def.id,
    name: def.name,
    assetId: def.assetId,
    still: findSprite(def.assetId),
    sheet: enemyAttackSheet(def.assetId),
    boss: boss || def.rank === 'boss',
  };
};

const backdrop = (assetId: string): GalleryBackdrop => ({ assetId, sprite: findSprite(assetId) });

/** `enemy.forge-tyrant` → "Forge Tyrant". */
export function nameFromAssetId(assetId: string): string {
  return assetId
    .replace(/^[a-z-]+\./, '')
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Registered still sprites of a kind (`enemy`, `area`), without frame sheets. */
function registered(kind: 'enemy' | 'area'): string[] {
  return Object.keys(ASSETS).filter((id) => id.startsWith(`${kind}.`) && !id.endsWith('-attack'));
}

export function galleryCatalogue(): GalleryCatalogue {
  const heroes: GalleryHero[] = CLASS_IDS.map((classId) => ({
    key: classId,
    classId,
    name: getClass(classId).name,
    still: classPortrait(classId),
    sheet: classAttackSheet(classId),
    attackSpeed: CLASS_STAT_PROFILES[classId].base.attackSpeed,
  }));

  const groups: GalleryGroup[] = [];
  for (const area of AREAS) {
    groups.push({
      id: `area:${area.id}`,
      title: area.name,
      note: `Levels ${area.minLevel}–${area.maxLevel}`,
      backdrops: [backdrop(area.assetId)],
      enemies: area.enemies.map((e) => enemyEntry(e.enemyId)),
    });
  }
  for (const dungeon of DUNGEONS) {
    const foes = dungeon.enemies.map((e) => enemyEntry(e.enemyId));
    groups.push({
      id: `dungeon:${dungeon.id}`,
      title: dungeon.name,
      note: 'Dungeon',
      backdrops: [backdrop(dungeon.assetId)],
      enemies: [...foes, enemyEntry(dungeon.bossId, true)],
    });
  }
  groups.push({
    id: 'guild-boss',
    title: 'Guild boss',
    note: 'Weekly event',
    backdrops: [],
    enemies: GUILD_BOSSES.map((b) => ({ ...enemyEntry(b.enemyId, true), key: b.id, name: b.name })),
  });

  // Registered art the game doesn't place yet (e.g. the Forge Tyrant, waiting for ticket 6.2),
  // and backdrops no area or dungeon uses (the arena, …).
  const shownEnemies = new Set(groups.flatMap((g) => g.enemies.map((e) => e.assetId)));
  const shownBackdrops = new Set(groups.flatMap((g) => g.backdrops.map((b) => b.assetId)));
  const unplaced = registered('enemy').filter((id) => !shownEnemies.has(id));
  const otherBackdrops = registered('area').filter((id) => !shownBackdrops.has(id));
  if (unplaced.length > 0 || otherBackdrops.length > 0) {
    groups.push({
      id: 'unplaced',
      title: 'Not yet placed',
      note: 'Registered art the game does not use in a fight yet',
      backdrops: otherBackdrops.map(backdrop),
      enemies: unplaced.map((assetId) => {
        const still = findSprite(assetId);
        return {
          key: assetId,
          name: nameFromAssetId(assetId),
          assetId,
          still,
          sheet: enemyAttackSheet(assetId),
          boss: (still?.width ?? 64) > 64,
        };
      }),
    });
  }
  return { heroes, groups };
}

/** Every distinct image the gallery draws (for its loading and error states). */
export function galleryImages(catalogue: GalleryCatalogue): string[] {
  const paths = new Set<string>();
  for (const h of catalogue.heroes) {
    paths.add(h.still.path);
    if (h.sheet) paths.add(h.sheet.path);
  }
  for (const g of catalogue.groups) {
    for (const b of g.backdrops) if (b.sprite) paths.add(b.sprite.path);
    for (const e of g.enemies) {
      if (e.still) paths.add(e.still.path);
      if (e.sheet) paths.add(e.sheet.path);
    }
  }
  return [...paths];
}

/** Case-insensitive filter on names, group titles and asset ids; empty groups drop out. */
export function filterCatalogue(catalogue: GalleryCatalogue, query: string): GalleryCatalogue {
  const q = query.trim().toLowerCase();
  if (!q) return catalogue;
  const hit = (...texts: string[]) => texts.some((t) => t.toLowerCase().includes(q));
  return {
    heroes: catalogue.heroes.filter((h) => hit(h.name, h.classId)),
    groups: catalogue.groups
      .map((g) =>
        hit(g.title)
          ? g
          : {
              ...g,
              backdrops: g.backdrops.filter((b) => hit(b.assetId)),
              enemies: g.enemies.filter((e) => hit(e.name, e.assetId)),
            },
      )
      .filter((g) => g.enemies.length > 0 || g.backdrops.length > 0),
  };
}

/** The gallery's playback speeds and sprite scales. */
export const GALLERY_SPEEDS = [0.25, 0.5, 1] as const;
export const GALLERY_SCALES = [1, 2, 4] as const;
