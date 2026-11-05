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
 */
export interface BossEnrage {
  atMs: number;
  damageMultiplier: number;
  attackSpeedMultiplier: number;
}

/** What the boss drops on a kill while boss loot is off cooldown (ticket 2.5). */
export interface DungeonBossLoot {
  /** Loot table of the boss items (`getLootTable`). */
  lootTableId: string;
  /** Items rolled from it per kill. */
  items: number;
  /** Rarity weights for boss items (better odds than ordinary kills). */
  rarityWeights: Readonly<Record<RarityId, number>>;
  /** Gold range of the boss's purse. */
  gold: { min: number; max: number };
  /** Hours until boss loot can drop again for the same character (counted from run start). */
  cooldownHours: number;
}

export interface DungeonDefinition {
  id: DungeonId;
  name: string;
  region: string;
  description: string;
  /** Asset id of the backdrop in the asset manifest. */
  assetId: string;
  /** Inclusive enemy level range of the rooms. */
  minLevel: number;
  maxLevel: number;
  unlock: UnlockRule;
  /** Room enemies, picked by weight. */
  enemies: readonly AreaEnemyEntry[];
  /** Rooms before the boss, in order. */
  rooms: readonly DungeonRoom[];
  /** Walk into each room and into the boss chamber (out-of-combat regeneration applies). */
  travelMs: number;
  /** A boss fight that lasts longer is lost. */
  bossMaxFightMs: number;
  bossEnrage: BossEnrage;
  bossLoot: DungeonBossLoot;
  /** The boss at the end of a run (an enemy of rank `boss`). */
  bossId: EnemyId;
  /** Boss level: the dungeon's top level. */
  bossLevel: number;
  /** Loot table rolled for room kills (`getLootTable`). */
  lootTableId: string;
  /** Materials the boss always drops (one each) while boss loot is off cooldown. */
  bossDrops: readonly MaterialId[];
}

export const DUNGEONS: readonly DungeonDefinition[] = [
  {
    id: 'namelessCrypt',
    name: 'The Nameless Crypt',
    region: 'Graumark',
    description:
      'No one remembers whose crypt it was. Its warden remembers everyone who tried to leave.',
    assetId: 'area.nameless-crypt',
    minLevel: 12,
    maxLevel: 16,
    unlock: { level: 12 },
    enemies: [
      { enemyId: 'cryptGhoul', weight: 55 },
      { enemyId: 'boneAcolyte', weight: 45 },
    ],
    rooms: [{ enemies: 2 }, { enemies: 2 }, { enemies: 2 }, { enemies: 2 }],
    travelMs: 20_000,
    bossMaxFightMs: 150_000,
    bossEnrage: { atMs: 45_000, damageMultiplier: 1.8, attackSpeedMultiplier: 1.4 },
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
      cooldownHours: 20,
    },
    bossId: 'gravewarden',
    bossLevel: 16,
    lootTableId: 'namelessCrypt',
    bossDrops: ['gravewardenSeal'],
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

export function isDungeonUnlocked(
  dungeonId: DungeonId,
  character: UnlockCharacter,
  progress: WorldProgress,
): boolean {
  return isUnlocked(getDungeon(dungeonId).unlock, character, progress);
}

export function dungeonUnlockBlockers(
  dungeonId: DungeonId,
  character: UnlockCharacter,
  progress: WorldProgress,
): UnlockBlocker[] {
  return unlockBlockers(getDungeon(dungeonId).unlock, character, progress);
}
