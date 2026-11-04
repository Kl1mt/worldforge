import type { AreaEnemyEntry } from './areas.js';
import type { EnemyId } from './enemies.js';
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
 * Dungeons (GDD §11.2). Data only in ticket 2.1; runs, rooms and the boss mechanic are ticket 2.5.
 */
export const DUNGEON_IDS = ['namelessCrypt'] as const;

export type DungeonId = (typeof DUNGEON_IDS)[number];

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
  /** The boss at the end of a run (an enemy of rank `boss`). */
  bossId: EnemyId;
  /** Boss level: the dungeon's top level. */
  bossLevel: number;
  /** Loot table rolled for room kills (`getLootTable`); boss loot is ticket 2.5. */
  lootTableId: string;
  /** Materials the boss drops. */
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
