import type { ClassId, CoreStatId } from '@worldforge/game-core';

export interface MockCharacter {
  name: string;
  classId: ClassId;
  level: number;
  xp: number;
  xpToNext: number;
  gold: number;
  health: { current: number; max: number };
  resource: { current: number; max: number };
  stats: Record<CoreStatId, number>;
}

export const CHARACTER: MockCharacter = {
  name: 'Edric Vael',
  classId: 'warrior',
  level: 12,
  xp: 6840,
  xpToNext: 9200,
  gold: 1284,
  health: { current: 842, max: 1046 },
  resource: { current: 62, max: 100 },
  stats: {
    health: 1046,
    physicalDamage: 58,
    magicDamage: 0,
    attackSpeed: 1.25,
    critChance: 10.5,
    critDamage: 183,
    armor: 270,
    resistance: 15,
  },
};
