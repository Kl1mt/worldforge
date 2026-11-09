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
 * Farming areas of Graumark (GDD §4.3), in progression order. Ids are a shared contract with the
 * art tickets (`docs/ROADMAP.md`, Phase 2 content contract).
 */
export const AREA_IDS = [
  'abandonedFields',
  'crowwood',
  'oldBurialGrounds',
  'blackwater',
  'sunkenAbbey',
  // Ticket 4.8: the top-end region, opened for everyone by the community (world flag).
  'ashenPass',
  // Ticket 6.1: the Cinderwastes beyond the Pass, first area.
  'ashfallVerge',
] as const;

export type AreaId = (typeof AREA_IDS)[number];

export interface AreaEnemyEntry {
  enemyId: EnemyId;
  /** Relative spawn weight (non-negative). */
  weight: number;
}

export interface AreaDefinition {
  id: AreaId;
  name: string;
  region: string;
  /** One line of flavour for the area screen. */
  description: string;
  /** Asset id of the backdrop in the asset manifest. */
  assetId: string;
  /** Inclusive enemy level range. */
  minLevel: number;
  maxLevel: number;
  unlock: UnlockRule;
  enemies: readonly AreaEnemyEntry[];
  /** Materials gathered here (yields: `DEFAULT_PROFESSION_CONFIG.areas`, ticket 2.3). */
  materials: readonly MaterialId[];
  /** Loot table rolled for kills here (`getLootTable`). */
  lootTableId: string;
}

export const AREAS: readonly AreaDefinition[] = [
  {
    id: 'abandonedFields',
    name: 'Abandoned Fields',
    region: 'Graumark',
    description:
      'Fallow land below the old reeve’s farm. The dead still walk the furrows they ploughed in life.',
    assetId: 'area.abandoned-fields',
    minLevel: 1,
    maxLevel: 6,
    unlock: { level: 1 },
    enemies: [
      { enemyId: 'risenFarmhand', weight: 50 },
      { enemyId: 'carrionWolf', weight: 35 },
      { enemyId: 'boneScarecrow', weight: 15 },
    ],
    materials: ['timber', 'ashwort'],
    lootTableId: 'abandonedFields',
  },
  {
    id: 'crowwood',
    name: 'Crowwood',
    region: 'Graumark',
    description:
      'A black-barked forest where the crows grew wrong. Cutthroats camp under its eaves.',
    assetId: 'area.crowwood',
    minLevel: 5,
    maxLevel: 10,
    unlock: { level: 5 },
    enemies: [
      { enemyId: 'banditCutthroat', weight: 55 },
      { enemyId: 'corruptedCrow', weight: 45 },
    ],
    materials: ['timber', 'rawHide'],
    lootTableId: 'crowwood',
  },
  {
    id: 'oldBurialGrounds',
    name: 'Old Burial Grounds',
    region: 'Graumark',
    description: 'Crooked headstones in a standing mist. Something has been digging, from below.',
    assetId: 'area.old-burial-grounds',
    minLevel: 9,
    maxLevel: 14,
    unlock: { level: 9 },
    enemies: [
      { enemyId: 'risenSkeleton', weight: 55 },
      { enemyId: 'graveCrawler', weight: 45 },
    ],
    materials: ['soulShard'],
    lootTableId: 'oldBurialGrounds',
  },
  {
    id: 'blackwater',
    name: 'Blackwater',
    region: 'Graumark',
    description: 'A marsh of dead trees and still, black water that gives nothing back.',
    assetId: 'area.blackwater',
    minLevel: 13,
    maxLevel: 18,
    unlock: { level: 13 },
    enemies: [
      { enemyId: 'drownedThrall', weight: 60 },
      { enemyId: 'bogHorror', weight: 40 },
    ],
    materials: ['ashwort', 'ironOre'],
    lootTableId: 'blackwater',
  },
  {
    id: 'sunkenAbbey',
    name: 'Sunken Abbey',
    region: 'Graumark',
    description:
      'The abbey sank into the marsh with its knights still at prayer. They have stopped praying.',
    assetId: 'area.sunken-abbey',
    minLevel: 17,
    maxLevel: 22,
    unlock: { level: 17, gravewardenDefeated: true },
    enemies: [
      { enemyId: 'fallenKnight', weight: 55 },
      { enemyId: 'abbeyWraith', weight: 45 },
    ],
    materials: ['ironOre', 'abbeySilver'],
    lootTableId: 'sunkenAbbey',
  },
  {
    // Ticket 4.8. Closed for everyone until the community clears the pass (project
    // `clearAshenPass`, world flag `ashenPassCleared`, docs/COMMUNITY.md). Its range starts two
    // levels above the Abbey's top: crypt tier III (21–24) bridges the gap.
    id: 'ashenPass',
    name: 'The Ashen Pass',
    region: 'Graumark',
    description:
      'The old road over the mountains, burnt to the rock. The watchtowers still burn, and something keeps them lit.',
    assetId: 'area.ashen-pass',
    minLevel: 24,
    maxLevel: 28,
    unlock: { level: 24, gravewardenDefeated: true, worldFlag: 'ashenPassCleared' },
    enemies: [
      { enemyId: 'ashWraith', weight: 30 },
      { enemyId: 'cinderHound', weight: 30 },
      { enemyId: 'pyreCultist', weight: 25 },
      { enemyId: 'emberGolem', weight: 15 },
    ],
    materials: ['ironOre', 'soulShard'],
    lootTableId: 'ashenPass',
  },
  {
    // Ticket 6.1: the first area of the Cinderwastes (GDD §15 Phase 6), past the Ashen Warden's
    // watchtower. Open to heroes of level 28 who slew the Warden (which the Pass's world flag
    // already guards). Seam for ticket 6.7: its community project adds `worldFlag` here (and a
    // flag id in `WORLD_FLAG_IDS`); every server path already passes the world flags.
    id: 'ashfallVerge',
    name: 'The Ashfall Verge',
    region: 'The Cinderwastes',
    description:
      'Beyond the Warden’s tower the ash never stops falling. Slag rivers glow under it, and the dead march out of the glow.',
    assetId: 'area.cinderwastes',
    minLevel: 28,
    maxLevel: 34,
    unlock: { level: 28, ashenWardenDefeated: true },
    enemies: [
      { enemyId: 'cinderRevenant', weight: 30 },
      { enemyId: 'slagHound', weight: 30 },
      { enemyId: 'emberWisp', weight: 25 },
      { enemyId: 'ashColossus', weight: 15 },
    ],
    materials: ['ironOre', 'soulShard'],
    lootTableId: 'ashfallVerge',
  },
];

const AREAS_BY_ID = new Map(AREAS.map((a) => [a.id, a]));

export function isAreaId(value: unknown): value is AreaId {
  return typeof value === 'string' && (AREA_IDS as readonly string[]).includes(value);
}

export function getArea(id: AreaId): AreaDefinition {
  const def = AREAS_BY_ID.get(id);
  if (!def) throw new Error(`Unknown area: ${id}`);
  return def;
}

/** Whether the character may farm the area. The server must check this (ticket 2.2). */
export function isAreaUnlocked(
  areaId: AreaId,
  character: UnlockCharacter,
  progress: WorldProgress,
): boolean {
  return isUnlocked(getArea(areaId).unlock, character, progress);
}

/** Unmet unlock conditions of the area; empty when unlocked. */
export function areaUnlockBlockers(
  areaId: AreaId,
  character: UnlockCharacter,
  progress: WorldProgress,
): UnlockBlocker[] {
  return unlockBlockers(getArea(areaId).unlock, character, progress);
}
