import type { RarityId } from '../rarity.js';
import type { AreaId } from '../world/areas.js';
import type { MaterialId } from '../world/materials.js';

/** A gatherable node in an area: rolled once per gathering cycle. */
export interface GatheringYield {
  materialId: MaterialId;
  /** Chance per gathering cycle to find the material (0..1). */
  chance: number;
}

/** A material dropped by undead kills in an area (`EnemyDefinition.undead`). */
export interface UndeadDrop {
  materialId: MaterialId;
  /** Chance per undead kill (0..1). */
  chance: number;
}

export interface AreaGathering {
  yields: readonly GatheringYield[];
  undeadDrops: readonly UndeadDrop[];
}

export interface ProfessionConfig {
  /** Highest profession level. */
  maxLevel: number;
  /** XP to advance from level `l`: `round(xpBase · l^xpExponent)`. */
  xpBase: number;
  xpExponent: number;
  /** Profession XP per gathered unit, by the material's rarity. */
  xpPerUnit: Readonly<Record<RarityId, number>>;
  /**
   * Extra units per find for each level above 1 (0.02 → +0.98 at level 50). The whole part is
   * always added; the fraction is the chance of one more unit.
   */
  bonusUnitsPerLevel: number;
  /** Per-area yields and undead drops. Areas without an entry yield nothing. */
  areas: Readonly<Partial<Record<AreaId, AreaGathering>>>;
}

/**
 * First-pass numbers (ticket 2.3; tune in B.1). A cycle is one search + fight; a level-1 hero runs
 * a few hundred cycles in the 3 h offline cap, so a common node at 0.3 yields roughly a hundred
 * units per cap.
 */
export const DEFAULT_PROFESSION_CONFIG: ProfessionConfig = {
  maxLevel: 50,
  xpBase: 20,
  xpExponent: 1.5,
  xpPerUnit: { common: 10, uncommon: 15, rare: 40, epic: 80, legendary: 160, mythic: 320 },
  bonusUnitsPerLevel: 0.02,
  areas: {
    abandonedFields: {
      yields: [
        { materialId: 'timber', chance: 0.3 },
        { materialId: 'ashwort', chance: 0.25 },
      ],
      undeadDrops: [],
    },
    crowwood: {
      yields: [
        { materialId: 'timber', chance: 0.35 },
        { materialId: 'rawHide', chance: 0.3 },
      ],
      undeadDrops: [],
    },
    oldBurialGrounds: {
      yields: [],
      undeadDrops: [{ materialId: 'soulShard', chance: 0.25 }],
    },
    blackwater: {
      yields: [
        { materialId: 'ashwort', chance: 0.35 },
        { materialId: 'ironOre', chance: 0.25 },
      ],
      undeadDrops: [],
    },
    sunkenAbbey: {
      yields: [
        { materialId: 'ironOre', chance: 0.3 },
        { materialId: 'abbeySilver', chance: 0.04 },
      ],
      undeadDrops: [],
    },
  },
};
