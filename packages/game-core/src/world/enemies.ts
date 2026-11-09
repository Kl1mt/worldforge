import type { DamageType } from '../classes.js';

/**
 * Enemy archetypes (GDD §4.3, §6.1). Ids are a shared contract with the art tickets
 * (`docs/ROADMAP.md`, Phase 2 content contract). Stats scale linearly with enemy level.
 */
export const ENEMY_IDS = [
  // Abandoned Fields.
  'risenFarmhand',
  'carrionWolf',
  'boneScarecrow',
  // Crowwood.
  'banditCutthroat',
  'corruptedCrow',
  // Old Burial Grounds.
  'risenSkeleton',
  'graveCrawler',
  // Blackwater.
  'drownedThrall',
  'bogHorror',
  // Sunken Abbey.
  'fallenKnight',
  'abbeyWraith',
  // The Nameless Crypt (dungeon).
  'cryptGhoul',
  'boneAcolyte',
  'gravewarden',
  // The Ashen Pass (ticket 4.8; appended so earlier ids keep their order).
  'ashWraith',
  'cinderHound',
  'pyreCultist',
  'emberGolem',
  // The Warden's Watch (ticket 4.8).
  'ashenWarden',
  // The Ashfall Verge, the Cinderwastes (ticket 6.1).
  'cinderRevenant',
  'slagHound',
  'emberWisp',
  'ashColossus',
] as const;

export type EnemyId = (typeof ENEMY_IDS)[number];

/** `normal` enemies fill area and dungeon rosters; a `boss` ends a dungeon. */
export type EnemyRank = 'normal' | 'boss';

export interface ScaledStat {
  base: number;
  perLevel: number;
}

export interface EnemyDefinition {
  id: EnemyId;
  name: string;
  /** Asset id in `apps/web/public/assets/manifest.json` (`enemy.<kebab-case id>` for Phase 2). */
  assetId: string;
  /** Damage family: which defense (armor or resistance) mitigates its hits. */
  damageType: DamageType;
  /** Undead drop `soulShard` in combat (ticket 2.3). */
  undead: boolean;
  rank: EnemyRank;
  /** Attacks per second. */
  attackSpeed: number;
  health: ScaledStat;
  damage: ScaledStat;
  armor: ScaledStat;
  resistance: ScaledStat;
  /** Experience awarded on kill, before the level-difference factor. */
  xp: ScaledStat;
}

export const ENEMIES: readonly EnemyDefinition[] = [
  // — Abandoned Fields (levels 1–6). Damage tuned in ticket B.1 (targets: `docs/COMBAT.md`); each later
  // area hits harder than the previous one at the same level.
  {
    id: 'risenFarmhand',
    name: 'Risen Farmhand',
    assetId: 'enemy.undead-farmer',
    damageType: 'physical',
    undead: true,
    rank: 'normal',
    attackSpeed: 0.8,
    health: { base: 60, perLevel: 14 },
    damage: { base: 5.3, perLevel: 1.45 },
    armor: { base: 10, perLevel: 2 },
    resistance: { base: 5, perLevel: 1 },
    xp: { base: 12, perLevel: 3 },
  },
  {
    id: 'carrionWolf',
    name: 'Carrion Wolf',
    assetId: 'enemy.wolf',
    damageType: 'physical',
    undead: false,
    rank: 'normal',
    attackSpeed: 1.3,
    health: { base: 45, perLevel: 10 },
    damage: { base: 4.4, perLevel: 1.15 },
    armor: { base: 6, perLevel: 1 },
    resistance: { base: 6, perLevel: 1 },
    xp: { base: 11, perLevel: 3 },
  },
  {
    id: 'boneScarecrow',
    name: 'Bone Scarecrow',
    assetId: 'enemy.skeletal-scarecrow',
    damageType: 'magic',
    undead: true,
    rank: 'normal',
    attackSpeed: 0.6,
    health: { base: 85, perLevel: 18 },
    damage: { base: 7, perLevel: 1.8 },
    armor: { base: 14, perLevel: 2.5 },
    resistance: { base: 14, perLevel: 1.5 },
    xp: { base: 18, perLevel: 4 },
  },
  // — Crowwood (levels 5–10).
  {
    id: 'banditCutthroat',
    name: 'Bandit Cutthroat',
    assetId: 'enemy.bandit-cutthroat',
    damageType: 'physical',
    undead: false,
    rank: 'normal',
    attackSpeed: 1.1,
    health: { base: 60, perLevel: 14 },
    damage: { base: 5.5, perLevel: 1.4 },
    armor: { base: 10, perLevel: 2.2 },
    resistance: { base: 6, perLevel: 1.2 },
    xp: { base: 13, perLevel: 3.2 },
  },
  {
    id: 'corruptedCrow',
    name: 'Corrupted Crow',
    assetId: 'enemy.corrupted-crow',
    damageType: 'magic',
    undead: false,
    rank: 'normal',
    attackSpeed: 1.4,
    health: { base: 40, perLevel: 10 },
    damage: { base: 4.9, perLevel: 1.46 },
    armor: { base: 5, perLevel: 1 },
    resistance: { base: 10, perLevel: 1.6 },
    xp: { base: 12, perLevel: 3 },
  },
  // — Old Burial Grounds (levels 9–14).
  {
    id: 'risenSkeleton',
    name: 'Risen Skeleton',
    assetId: 'enemy.risen-skeleton',
    damageType: 'physical',
    undead: true,
    rank: 'normal',
    attackSpeed: 0.9,
    health: { base: 65, perLevel: 15 },
    damage: { base: 7.6, perLevel: 2.18 },
    armor: { base: 12, perLevel: 2.6 },
    resistance: { base: 6, perLevel: 1.2 },
    xp: { base: 14, perLevel: 3.4 },
  },
  {
    id: 'graveCrawler',
    name: 'Grave Crawler',
    assetId: 'enemy.grave-crawler',
    damageType: 'physical',
    undead: true,
    rank: 'normal',
    attackSpeed: 1.2,
    health: { base: 55, perLevel: 13 },
    damage: { base: 6.5, perLevel: 1.8 },
    armor: { base: 8, perLevel: 1.6 },
    resistance: { base: 8, perLevel: 1.6 },
    xp: { base: 13, perLevel: 3.2 },
  },
  // — Blackwater (levels 13–18).
  {
    id: 'drownedThrall',
    name: 'Drowned Thrall',
    assetId: 'enemy.drowned-thrall',
    damageType: 'physical',
    undead: true,
    rank: 'normal',
    attackSpeed: 0.8,
    health: { base: 75, perLevel: 16 },
    damage: { base: 8.5, perLevel: 2.21 },
    armor: { base: 10, perLevel: 2.2 },
    resistance: { base: 8, perLevel: 1.5 },
    xp: { base: 15, perLevel: 3.6 },
  },
  {
    id: 'bogHorror',
    name: 'Bog Horror',
    assetId: 'enemy.bog-horror',
    damageType: 'magic',
    undead: false,
    rank: 'normal',
    attackSpeed: 0.7,
    health: { base: 85, perLevel: 17 },
    damage: { base: 10.5, perLevel: 2.63 },
    armor: { base: 12, perLevel: 2.4 },
    resistance: { base: 12, perLevel: 2 },
    xp: { base: 18, perLevel: 4 },
  },
  // — Sunken Abbey (levels 17–22).
  {
    id: 'fallenKnight',
    name: 'Fallen Knight',
    assetId: 'enemy.fallen-knight',
    damageType: 'physical',
    undead: true,
    rank: 'normal',
    attackSpeed: 0.8,
    health: { base: 80, perLevel: 17 },
    damage: { base: 10.1, perLevel: 2.7 },
    armor: { base: 16, perLevel: 3 },
    resistance: { base: 8, perLevel: 1.6 },
    xp: { base: 17, perLevel: 3.8 },
  },
  {
    id: 'abbeyWraith',
    name: 'Abbey Wraith',
    assetId: 'enemy.abbey-wraith',
    damageType: 'magic',
    undead: true,
    rank: 'normal',
    attackSpeed: 0.9,
    health: { base: 60, perLevel: 14 },
    damage: { base: 11.9, perLevel: 3.04 },
    armor: { base: 6, perLevel: 1.2 },
    resistance: { base: 14, perLevel: 2.4 },
    xp: { base: 16, perLevel: 3.8 },
  },
  // — The Nameless Crypt (dungeon, levels 12–16). Room rules and the boss mechanic are ticket 2.5.
  {
    id: 'cryptGhoul',
    name: 'Crypt Ghoul',
    assetId: 'enemy.crypt-ghoul',
    damageType: 'physical',
    undead: true,
    rank: 'normal',
    attackSpeed: 1.1,
    health: { base: 70, perLevel: 15 },
    damage: { base: 7.2, perLevel: 2 },
    armor: { base: 9, perLevel: 2 },
    resistance: { base: 8, perLevel: 1.5 },
    xp: { base: 16, perLevel: 3.6 },
  },
  {
    id: 'boneAcolyte',
    name: 'Bone Acolyte',
    assetId: 'enemy.bone-acolyte',
    damageType: 'magic',
    undead: true,
    rank: 'normal',
    attackSpeed: 0.7,
    health: { base: 65, perLevel: 14 },
    damage: { base: 10.4, perLevel: 2.6 },
    armor: { base: 8, perLevel: 1.6 },
    resistance: { base: 14, perLevel: 2.2 },
    xp: { base: 17, perLevel: 3.8 },
  },
  {
    id: 'gravewarden',
    name: 'The Gravewarden',
    assetId: 'enemy.gravewarden',
    damageType: 'physical',
    undead: true,
    rank: 'boss',
    attackSpeed: 0.6,
    health: { base: 880, perLevel: 176 },
    damage: { base: 4, perLevel: 0.86 },
    armor: { base: 20, perLevel: 3.5 },
    resistance: { base: 14, perLevel: 2.5 },
    xp: { base: 600, perLevel: 160 },
  },
  // — The Ashen Pass (levels 24–28, ticket 4.8; docs/WORLD.md "The Ashen Pass"). The top-end area:
  // tuned against Phase 3 gear (rares +5 upward), not commons. Health grows faster per level than in
  // Graumark, so late-game builds need several blows again (the Abbey's one-shot breakpoint).
  {
    id: 'ashWraith',
    name: 'Ash Wraith',
    assetId: 'enemy.ash-wraith',
    damageType: 'magic',
    undead: true,
    rank: 'normal',
    attackSpeed: 1,
    health: { base: 50, perLevel: 32 },
    damage: { base: 7.9, perLevel: 2.28 },
    armor: { base: 6, perLevel: 1.3 },
    resistance: { base: 16, perLevel: 2.8 },
    xp: { base: 24, perLevel: 5.7 },
  },
  {
    id: 'cinderHound',
    name: 'Cinder Hound',
    assetId: 'enemy.cinder-hound',
    damageType: 'physical',
    undead: false,
    rank: 'normal',
    attackSpeed: 1.4,
    health: { base: 40, perLevel: 27 },
    damage: { base: 5.6, perLevel: 1.66 },
    armor: { base: 10, perLevel: 2 },
    resistance: { base: 10, perLevel: 2 },
    xp: { base: 23, perLevel: 5.4 },
  },
  {
    id: 'pyreCultist',
    name: 'Pyre Cultist',
    assetId: 'enemy.pyre-cultist',
    damageType: 'magic',
    undead: false,
    rank: 'normal',
    attackSpeed: 0.8,
    health: { base: 56, perLevel: 34 },
    damage: { base: 9.2, perLevel: 2.61 },
    armor: { base: 8, perLevel: 1.6 },
    resistance: { base: 18, perLevel: 3 },
    xp: { base: 26, perLevel: 5.9 },
  },
  {
    id: 'emberGolem',
    name: 'Ember Golem',
    assetId: 'enemy.ember-golem',
    damageType: 'physical',
    undead: false,
    rank: 'normal',
    attackSpeed: 0.6,
    health: { base: 96, perLevel: 45 },
    damage: { base: 11.8, perLevel: 3.28 },
    armor: { base: 24, perLevel: 4.2 },
    resistance: { base: 12, perLevel: 2 },
    xp: { base: 32, perLevel: 7.3 },
  },
  // — The Warden's Watch (ticket 4.8): the Ashen Pass's boss, fought alone at the top of the
  // watchtower (a boss-only dungeon run, docs/DUNGEONS.md "The Warden's Watch").
  {
    id: 'ashenWarden',
    name: 'The Ashen Warden',
    assetId: 'enemy.ashen-warden',
    damageType: 'magic',
    undead: true,
    rank: 'boss',
    attackSpeed: 0.7,
    health: { base: 1900, perLevel: 460 },
    damage: { base: 8, perLevel: 1.6 },
    armor: { base: 30, perLevel: 4.5 },
    resistance: { base: 20, perLevel: 2.5 },
    xp: { base: 600, perLevel: 105 },
  },
  // — The Ashfall Verge (ticket 6.1), the first area of the Cinderwastes beyond the Ashen Pass
  // (levels 28–34, docs/WORLD.md). Tuned against the Pass's best gear: more health per level than
  // the Pass, a little more damage, and one foe for each defence (armour, resistance, burst, bulk).
  // The revenant: an armoured undead knight (soul shards), steady physical blows.
  {
    id: 'cinderRevenant',
    name: 'Cinder Revenant',
    assetId: 'enemy.cinder-revenant',
    damageType: 'physical',
    undead: true,
    rank: 'normal',
    attackSpeed: 0.9,
    health: { base: 96, perLevel: 58 },
    damage: { base: 12.2, perLevel: 3.51 },
    armor: { base: 20, perLevel: 3.8 },
    resistance: { base: 12, perLevel: 2.2 },
    xp: { base: 38, perLevel: 9.08 },
  },
  // The hound: fast, light, hunts in packs (many small physical bites).
  {
    id: 'slagHound',
    name: 'Slag Hound',
    assetId: 'enemy.slag-hound',
    damageType: 'physical',
    undead: false,
    rank: 'normal',
    attackSpeed: 1.5,
    health: { base: 74, perLevel: 48 },
    damage: { base: 8.1, perLevel: 2.43 },
    armor: { base: 14, perLevel: 2.6 },
    resistance: { base: 10, perLevel: 2 },
    xp: { base: 34, perLevel: 8.25 },
  },
  // The wisp: frail and quick, magic fire, warded against spells.
  {
    id: 'emberWisp',
    name: 'Ember Wisp',
    assetId: 'enemy.ember-wisp',
    damageType: 'magic',
    undead: false,
    rank: 'normal',
    attackSpeed: 1.3,
    health: { base: 58, perLevel: 38 },
    damage: { base: 8.6, perLevel: 2.56 },
    armor: { base: 6, perLevel: 1.2 },
    resistance: { base: 22, perLevel: 3.6 },
    xp: { base: 33, perLevel: 7.98 },
  },
  // The colossus: slow and huge, heavy armour, crushing physical blows.
  {
    id: 'ashColossus',
    name: 'Ash Colossus',
    assetId: 'enemy.ash-colossus',
    damageType: 'physical',
    undead: false,
    rank: 'normal',
    attackSpeed: 0.5,
    health: { base: 192, perLevel: 86 },
    damage: { base: 20.2, perLevel: 5.67 },
    armor: { base: 30, perLevel: 5 },
    resistance: { base: 14, perLevel: 2.4 },
    xp: { base: 50, perLevel: 11.55 },
  },
];

const ENEMIES_BY_ID = new Map(ENEMIES.map((e) => [e.id, e]));

export function isEnemyId(value: unknown): value is EnemyId {
  return typeof value === 'string' && (ENEMY_IDS as readonly string[]).includes(value);
}

export function getEnemy(id: EnemyId): EnemyDefinition {
  const def = ENEMIES_BY_ID.get(id);
  if (!def) throw new Error(`Unknown enemy: ${id}`);
  return def;
}
