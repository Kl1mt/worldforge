import type { EnemyId } from './enemies.js';

/** Farming areas (GDD §4.3). Phase 1 ships Abandoned Fields only. */
export const AREA_IDS = ['abandonedFields'] as const;

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
  enemies: readonly AreaEnemyEntry[];
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
    enemies: [
      { enemyId: 'risenFarmhand', weight: 50 },
      { enemyId: 'carrionWolf', weight: 35 },
      { enemyId: 'boneScarecrow', weight: 15 },
    ],
  },
];

export function isAreaId(value: unknown): value is AreaId {
  return typeof value === 'string' && (AREA_IDS as readonly string[]).includes(value);
}

export function getArea(id: AreaId): AreaDefinition {
  const def = AREAS.find((a) => a.id === id);
  if (!def) throw new Error(`Unknown area: ${id}`);
  return def;
}
