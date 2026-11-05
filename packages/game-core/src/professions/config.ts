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
 * Ticket B.1 numbers (targets and reasoning: `docs/ECONOMY.md`). A cycle is one search + fight, about
 * 550–600 an hour, so a common node at 0.06 yields ~35 units an hour — a Forge recipe's worth in
 * roughly an hour. The flat XP curve makes every profession level cost 0.5–2.5 h: a 3 h window
 * gives +3–4 levels from 1; level 10 takes ~10–15 h in a matching area, 25 ~45–60 h, 50 ~110–150 h.
 */
export const DEFAULT_PROFESSION_CONFIG: ProfessionConfig = {
  maxLevel: 50,
  xpBase: 230,
  xpExponent: 0.7,
  xpPerUnit: { common: 15, uncommon: 20, rare: 50, epic: 100, legendary: 200, mythic: 400 },
  bonusUnitsPerLevel: 0.02,
  areas: {
    abandonedFields: {
      yields: [
        { materialId: 'timber', chance: 0.06 },
        { materialId: 'ashwort', chance: 0.05 },
      ],
      undeadDrops: [],
    },
    crowwood: {
      yields: [
        { materialId: 'timber', chance: 0.06 },
        { materialId: 'rawHide', chance: 0.05 },
      ],
      undeadDrops: [],
    },
    oldBurialGrounds: {
      yields: [],
      undeadDrops: [{ materialId: 'soulShard', chance: 0.03 }],
    },
    blackwater: {
      yields: [
        { materialId: 'ashwort', chance: 0.06 },
        { materialId: 'ironOre', chance: 0.05 },
      ],
      undeadDrops: [],
    },
    sunkenAbbey: {
      yields: [
        { materialId: 'ironOre', chance: 0.06 },
        { materialId: 'abbeySilver', chance: 0.008 },
      ],
      undeadDrops: [],
    },
  },
};
