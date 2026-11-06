import type { AreaEnemyEntry } from './areas.js';
import type { EnemyId } from './enemies.js';
import type { RarityId } from '../rarity.js';
import type { MaterialId } from './materials.js';
import {
  isUnlocked,
  unlockBlockers,
  type UnlockBlocker,
  type UnlockCharacter,
  type UnlockRule,
  type WorldProgress,
} from './unlocks.js';

/**
 * Dungeons (GDD §11.2). Data from ticket 2.1; rooms, the boss mechanic and boss loot are ticket 2.5
 * (rules in `src/dungeon/`).
 */
export const DUNGEON_IDS = ['namelessCrypt'] as const;

export type DungeonId = (typeof DUNGEON_IDS)[number];

/** One room of a run: this many enemies from `DungeonDefinition.enemies`, fought one after another. */
export interface DungeonRoom {
  enemies: number;
}

/**
 * The boss's enrage timer (ticket 2.5): from `atMs` into the fight its hits deal
 * `damageMultiplier` × damage and come `attackSpeedMultiplier` × as often. A hero who cannot kill
 * the boss before then rarely survives long after.
 *
 * Ticket 3.6: `atMs` is a window. Each run draws its enrage moment from it (whole seconds, from its
 * own seed stream), so a hero who needs about as long as the window's middle wins some runs and
 * loses others: the entry is a curve instead of a cliff (docs/DUNGEONS.md, "Tiers and balance").
 */
export interface BossEnrage {
  atMs: { min: number; max: number };
  damageMultiplier: number;
  attackSpeedMultiplier: number;
}

/** One run's enrage: the moment drawn from `BossEnrage.atMs`. */
export interface ResolvedEnrage {
  atMs: number;
  damageMultiplier: number;
  attackSpeedMultiplier: number;
}

/** What the boss drops on a kill while boss loot is off cooldown (ticket 2.5). */
export interface DungeonBossLoot {
  /** Loot table of the boss items (`getLootTable`); its `focus` is the tier's loot focus. */
  lootTableId: string;
  /** Items rolled from it per kill. */
  items: number;
  /** Rarity weights for boss items (better odds than ordinary kills). */
  rarityWeights: Readonly<Record<RarityId, number>>;
  /** Gold range of the boss's purse. */
  gold: { min: number; max: number };
}

export const DUNGEON_TIERS = [1, 2, 3] as const;
export type DungeonTier = (typeof DUNGEON_TIERS)[number];

/** Multipliers on an enemy's health and damage (a deeper tier's boss is more than a level up). */
export interface EnemyScale {
  health: number;
  damage: number;
}

/**
 * One difficulty tier of a dungeon (ticket 3.6). Every tier reuses the dungeon's rooms, enemies,
 * boss and art; a tier is only numbers and loot.
 */
export interface DungeonTierDefinition {
  tier: DungeonTier;
  /** "Tier I", … */
  name: string;
  /** Inclusive enemy level range of the rooms. */
  minLevel: number;
  maxLevel: number;
  /**
   * Character level and progress needed. Tier n > 1 also needs tier n − 1 cleared
   * (`WorldProgress.cryptTierCleared`).
   */
  unlock: UnlockRule;
  /** Boss level: the tier's top level. */
  bossLevel: number;
  /** Multipliers on the boss's stats at `bossLevel` (absent = 1). */
  bossScale?: EnemyScale;
  /** A boss fight that lasts longer is lost. */
  bossMaxFightMs: number;
  bossEnrage: BossEnrage;
  bossLoot: DungeonBossLoot;
  /** Loot table rolled for room kills (`getLootTable`; its `focus` is the tier's loot focus). */
  lootTableId: string;
}

export interface DungeonDefinition {
  id: DungeonId;
  name: string;
  region: string;
  description: string;
  /** Asset id of the backdrop in the asset manifest. */
  assetId: string;
  /** Room enemies, picked by weight. */
  enemies: readonly AreaEnemyEntry[];
  /** Rooms before the boss, in order. */
  rooms: readonly DungeonRoom[];
  /** Walk into each room and into the boss chamber (out-of-combat regeneration applies). */
  travelMs: number;
  /** The boss at the end of a run (an enemy of rank `boss`). */
  bossId: EnemyId;
  /** Materials the boss always drops (one each) while boss loot is off cooldown. */
  bossDrops: readonly MaterialId[];
  /**
   * Hours until boss loot can drop again for the same character (counted from run start). One
   * cooldown for all tiers (ticket 3.6): the player chooses which tier's hoard to take.
   */
  bossLootCooldownHours: number;
  /** Difficulty tiers, in order (ticket 3.6). Tier I is the Phase 2 crypt. */
  tiers: readonly DungeonTierDefinition[];
}

export const DUNGEONS: readonly DungeonDefinition[] = [
  {
    id: 'namelessCrypt',
    name: 'The Nameless Crypt',
    region: 'Graumark',
    description:
      'No one remembers whose crypt it was. Its warden remembers everyone who tried to leave.',
    assetId: 'area.nameless-crypt',
    enemies: [
      { enemyId: 'cryptGhoul', weight: 55 },
      { enemyId: 'boneAcolyte', weight: 45 },
    ],
    rooms: [{ enemies: 2 }, { enemies: 2 }, { enemies: 2 }, { enemies: 2 }],
    travelMs: 20_000,
    bossId: 'gravewarden',
    bossDrops: ['gravewardenSeal'],
    bossLootCooldownHours: 20,
    tiers: [
      {
        tier: 1,
        name: 'Tier I',
        minLevel: 12,
        maxLevel: 16,
        unlock: { level: 12 },
        bossLevel: 16,
        bossMaxFightMs: 150_000,
        bossEnrage: {
          atMs: { min: 30_000, max: 70_000 },
          damageMultiplier: 1.8,
          attackSpeedMultiplier: 1.4,
        },
        bossLoot: {
          lootTableId: 'gravewarden',
          items: 2,
          rarityWeights: {
            common: 0,
            uncommon: 3000,
            rare: 3500,
            epic: 1800,
            legendary: 250,
            mythic: 20,
          },
          gold: { min: 120, max: 180 },
        },
        lootTableId: 'namelessCrypt',
      },
      {
        tier: 2,
        name: 'Tier II',
        minLevel: 18,
        maxLevel: 21,
        unlock: { level: 18, cryptTierCleared: 1 },
        bossLevel: 21,
        bossScale: { health: 1.8, damage: 1.3 },
        bossMaxFightMs: 150_000,
        bossEnrage: {
          atMs: { min: 30_000, max: 70_000 },
          damageMultiplier: 1.8,
          attackSpeedMultiplier: 1.4,
        },
        bossLoot: {
          lootTableId: 'gravewardenII',
          items: 2,
          rarityWeights: {
            common: 0,
            uncommon: 2000,
            rare: 3500,
            epic: 2400,
            legendary: 350,
            mythic: 30,
          },
          gold: { min: 260, max: 380 },
        },
        lootTableId: 'namelessCryptII',
      },
      {
        tier: 3,
        name: 'Tier III',
        minLevel: 21,
        maxLevel: 24,
        unlock: { level: 21, cryptTierCleared: 2 },
        bossLevel: 24,
        bossScale: { health: 2.4, damage: 1.5 },
        bossMaxFightMs: 150_000,
        bossEnrage: {
          atMs: { min: 30_000, max: 70_000 },
          damageMultiplier: 1.8,
          attackSpeedMultiplier: 1.4,
        },
        bossLoot: {
          lootTableId: 'gravewardenIII',
          items: 2,
          rarityWeights: {
            common: 0,
            uncommon: 1000,
            rare: 3500,
            epic: 3000,
            legendary: 500,
            mythic: 45,
          },
          gold: { min: 420, max: 600 },
        },
        lootTableId: 'namelessCryptIII',
      },
    ],
  },
];

const DUNGEONS_BY_ID = new Map(DUNGEONS.map((d) => [d.id, d]));

export function isDungeonId(value: unknown): value is DungeonId {
  return typeof value === 'string' && (DUNGEON_IDS as readonly string[]).includes(value);
}

export function getDungeon(id: DungeonId): DungeonDefinition {
  const def = DUNGEONS_BY_ID.get(id);
  if (!def) throw new Error(`Unknown dungeon: ${id}`);
  return def;
}

export function isDungeonTier(value: unknown): value is DungeonTier {
  return typeof value === 'number' && (DUNGEON_TIERS as readonly number[]).includes(value);
}

/** A tier of a dungeon (ticket 3.6). */
export function getDungeonTier(id: DungeonId, tier: DungeonTier = 1): DungeonTierDefinition {
  const def = getDungeon(id).tiers.find((t) => t.tier === tier);
  if (!def) throw new Error(`Unknown tier ${tier} of dungeon ${id}`);
  return def;
}

/** Whether a dungeon tier is open to a character (tier I: the dungeon's own unlock). */
export function isDungeonUnlocked(
  dungeonId: DungeonId,
  character: UnlockCharacter,
  progress: WorldProgress,
  tier: DungeonTier = 1,
): boolean {
  return isUnlocked(getDungeonTier(dungeonId, tier).unlock, character, progress);
}

export function dungeonUnlockBlockers(
  dungeonId: DungeonId,
  character: UnlockCharacter,
  progress: WorldProgress,
  tier: DungeonTier = 1,
): UnlockBlocker[] {
  return unlockBlockers(getDungeonTier(dungeonId, tier).unlock, character, progress);
}
