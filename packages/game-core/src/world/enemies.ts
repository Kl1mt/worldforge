import type { DamageType } from '../classes.js';

/** Enemy archetypes (GDD §4.3, §6.1). Stats scale linearly with enemy level. */
export const ENEMY_IDS = ['risenFarmhand', 'carrionWolf', 'boneScarecrow'] as const;

export type EnemyId = (typeof ENEMY_IDS)[number];

export interface EnemyDefinition {
  id: EnemyId;
  name: string;
  /** Asset id in `apps/web/public/assets/manifest.json`. */
  assetId: string;
  damageType: DamageType;
  /** Attacks per second. */
  attackSpeed: number;
  health: { base: number; perLevel: number };
  damage: { base: number; perLevel: number };
  armor: { base: number; perLevel: number };
  resistance: { base: number; perLevel: number };
  /** Experience awarded on kill, before the level-difference factor. */
  xp: { base: number; perLevel: number };
}

export const ENEMIES: readonly EnemyDefinition[] = [
  {
    id: 'risenFarmhand',
    name: 'Risen Farmhand',
    assetId: 'enemy.undead-farmer',
    damageType: 'physical',
    attackSpeed: 0.8,
    health: { base: 60, perLevel: 14 },
    damage: { base: 6, perLevel: 1.6 },
    armor: { base: 10, perLevel: 2 },
    resistance: { base: 5, perLevel: 1 },
    xp: { base: 12, perLevel: 3 },
  },
  {
    id: 'carrionWolf',
    name: 'Carrion Wolf',
    assetId: 'enemy.wolf',
    damageType: 'physical',
    attackSpeed: 1.3,
    health: { base: 45, perLevel: 10 },
    damage: { base: 5, perLevel: 1.3 },
    armor: { base: 6, perLevel: 1 },
    resistance: { base: 6, perLevel: 1 },
    xp: { base: 11, perLevel: 3 },
  },
  {
    id: 'boneScarecrow',
    name: 'Bone Scarecrow',
    assetId: 'enemy.skeletal-scarecrow',
    damageType: 'magic',
    attackSpeed: 0.6,
    health: { base: 85, perLevel: 18 },
    damage: { base: 8, perLevel: 2 },
    armor: { base: 14, perLevel: 2.5 },
    resistance: { base: 14, perLevel: 1.5 },
    xp: { base: 18, perLevel: 4 },
  },
];

export function isEnemyId(value: unknown): value is EnemyId {
  return typeof value === 'string' && (ENEMY_IDS as readonly string[]).includes(value);
}

export function getEnemy(id: EnemyId): EnemyDefinition {
  const def = ENEMIES.find((e) => e.id === id);
  if (!def) throw new Error(`Unknown enemy: ${id}`);
  return def;
}
