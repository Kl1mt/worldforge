import {
  ACTIVE_SKILLS,
  AREAS,
  CLASS_IDS,
  PASSIVE_SKILLS,
  RESOURCE_RULES,
  CLASS_STAT_PROFILES,
  DUNGEONS,
  GUILD_BOSSES,
  getClass,
  getEnemy,
  type ClassId,
  type EnemyId,
  type ResourceId,
} from '@worldforge/game-core';
import {
  ASSETS,
  classAttackSheet,
  classPortrait,
  enemyAttackSheet,
  findSprite,
  heroicSprite,
  skillIcon,
  type SpriteAsset,
} from '../content/assets';
import { sceneSkillOf, type SceneSkill } from '../scene/sceneLoop';

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
    // Ticket 6.3: a Heroic tier draws the same art with the Heroic treatment.
    for (const tier of dungeon.tiers.filter((t) => t.heroic)) {
      const treat = (x: SpriteAsset | null) => (x ? heroicSprite(x) : null);
      groups.push({
        id: `dungeon:${dungeon.id}:${tier.tier}`,
        title: `${dungeon.name} · ${tier.name}`,
        note: `Dungeon · Heroic treatment (levels ${tier.minLevel}–${tier.maxLevel})`,
        backdrops: [{ assetId: dungeon.assetId, sprite: treat(findSprite(dungeon.assetId)) }],
        enemies: [...foes, enemyEntry(dungeon.bossId, true)].map((e) => ({
          ...e,
          still: treat(e.still),
          sheet: treat(e.sheet),
        })),
      });
    }
  }
  groups.push({
    id: 'guild-boss',
    title: 'Guild boss',
    note: 'Weekly event',
    backdrops: [],
    enemies: GUILD_BOSSES.map((b) => ({ ...enemyEntry(b.enemyId, true), key: b.id, name: b.name })),
  });

  // Registered art the game doesn't place yet (the Forge Tyrant was, until ticket 6.2), and
  // backdrops no area or dungeon uses (the arena, …).
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

/* ── Skills (ticket A.18) ─────────────────────────────────────────────── */

export interface GallerySkill {
  id: string;
  name: string;
  kind: 'core' | 'spender' | 'passive';
  /** "Lv 12", "Forge Tyrant", "Hollow Sovereign". */
  unlock: string;
  icon: SpriteAsset | null;
}

export interface GallerySkillClass {
  classId: ClassId;
  name: string;
  resource: ResourceId;
  /** The class's core skill with damage over time (Rend, Scorch, Serrated Arrow, Agony). */
  dotSkill: SceneSkill;
  skills: GallerySkill[];
}

function unlockLabel(unlock: { level: number; deed?: string }): string {
  if (unlock.deed === 'forgeTyrantSkillLearned') return 'Forge Tyrant';
  if (unlock.deed) return 'Hollow Sovereign';
  return `Lv ${unlock.level}`;
}

/** Every class's twelve skills (`docs/SKILLS.md` order) with their icons, from game-core only. */
export function gallerySkills(): GallerySkillClass[] {
  return CLASS_IDS.map((classId) => {
    const actives = ACTIVE_SKILLS.filter((s) => s.classId === classId);
    const passives = PASSIVE_SKILLS.filter((s) => s.classId === classId);
    const dot = actives.find((s) => s.kind === 'core' && s.dot) ?? actives[0]!;
    return {
      classId,
      name: getClass(classId).name,
      resource: getClass(classId).resource,
      dotSkill: sceneSkillOf(dot),
      skills: [
        ...actives.map((s) => ({
          id: s.id,
          name: s.name,
          kind: s.kind,
          unlock: unlockLabel(s.unlock),
          icon: skillIcon(s.id),
        })),
        ...passives.map((s) => ({
          id: s.id,
          name: s.name,
          kind: 'passive' as const,
          unlock: unlockLabel(s.unlock),
          icon: skillIcon(s.id),
        })),
      ],
    };
  });
}

/**
 * A.18: a sample of each resource moving, for the gallery's meters (cosmetic, not the fight's
 * rules): each step it gains `gain`, or spends `cost` once it can (Soul Burn spends every fragment).
 * From game-core: the Warrior's Shield Slam (50 Rage) on +4 Rage a blow given and taken, the
 * Mage's Arcane Bolt (30 Mana) on +3 a second, the Hunter's Quick Shot (25 Focus) on +15 an
 * unhit pulse, the Warlock's Soul Burn on +1 a curse pulse.
 */
export const RESOURCE_SAMPLES: Readonly<
  Record<ClassId, { gain: number; cost: number; all?: boolean }>
> = {
  warrior: { gain: 8, cost: 50 },
  mage: { gain: 6, cost: 30 },
  hunter: { gain: 15, cost: 25 },
  warlock: { gain: 1, cost: 3, all: true },
};

/** The sample's starting value: the class's own start of a fight (`RESOURCE_RULES`). */
export function sampleStart(classId: ClassId): number {
  const r = RESOURCE_RULES[classId];
  return r.start === 'full' ? r.max : r.start;
}

/** The sample's next value. A step after a spend always gains, so both moves show. */
export function nextSampleValue(classId: ClassId, value: number, spentLast: boolean): number {
  const { gain, cost, all } = RESOURCE_SAMPLES[classId];
  const max = RESOURCE_RULES[classId].max;
  if (!spentLast && value >= cost) return all ? 0 : value - cost;
  return Math.min(max, value + gain);
}

/** A.18: the target of the gallery's ticks: the first foe with art (null without any). */
export function skillTarget(
  catalogue: GalleryCatalogue,
): { name: string; sprite: SpriteAsset } | null {
  for (const g of catalogue.groups) {
    const e = g.enemies.find((x) => x.still);
    if (e?.still) return { name: e.name, sprite: e.still };
  }
  return null;
}
