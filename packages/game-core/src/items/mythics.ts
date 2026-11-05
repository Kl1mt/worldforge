import type { ClassId } from '../classes.js';
import { canClassUseItem, getItemBase } from './bases.js';

/**
 * Named Mythic items (ticket 3.2, GDD §7.2): extremely rare long-term chase items with a fixed
 * base (stronger implicit stats, `unique`), a fixed signature effect from the effect registry and
 * the Mythic rarity's five affixes. They only drop where a loot table allows Mythics
 * (`LootTableDefinition.mythics`: the Sunken Abbey and the Gravewarden's hoard); a Mythic rarity
 * roll anywhere else becomes a Legendary.
 */
export interface MythicItemDefinition {
  /** Also the `mythic_id` column and the base id. */
  id: string;
  baseId: string;
  /** Signature effect (`kind: 'mythic'`). */
  effectId: string;
  /** Pick weight among the Mythics the character can use. */
  weight: number;
}

export const MYTHIC_ITEMS: readonly MythicItemDefinition[] = [
  {
    id: 'crown-of-the-hollow-king',
    baseId: 'crown-of-the-hollow-king',
    effectId: 'hollow-majesty',
    weight: 1,
  },
  {
    id: 'gravecallers-edge',
    baseId: 'gravecallers-edge',
    effectId: 'gravecallers-hunger',
    weight: 1,
  },
  { id: 'starfall-sceptre', baseId: 'starfall-sceptre', effectId: 'starfall', weight: 1 },
  { id: 'widowmaker', baseId: 'widowmaker', effectId: 'widows-kiss', weight: 1 },
  { id: 'heart-of-the-abyss', baseId: 'heart-of-the-abyss', effectId: 'abyssal-rot', weight: 1 },
  {
    id: 'ring-of-endless-hunger',
    baseId: 'ring-of-endless-hunger',
    effectId: 'endless-hunger',
    weight: 1,
  },
];

const MYTHICS_BY_ID = new Map(MYTHIC_ITEMS.map((m) => [m.id, m]));
const MYTHICS_BY_BASE = new Map(MYTHIC_ITEMS.map((m) => [m.baseId, m]));

export function findMythic(id: string): MythicItemDefinition | undefined {
  return MYTHICS_BY_ID.get(id);
}

/** The named Mythic whose fixed base this is, if any. */
export function mythicForBase(baseId: string): MythicItemDefinition | undefined {
  return MYTHICS_BY_BASE.get(baseId);
}

/**
 * Mythics that can drop at an item level, for a class (only Mythics whose base it can use) or,
 * without a class, all of them.
 */
export function mythicPool(itemLevel: number, classId?: ClassId): MythicItemDefinition[] {
  return MYTHIC_ITEMS.filter((m) => {
    const base = getItemBase(m.baseId);
    return (
      m.weight > 0 &&
      base.minItemLevel <= itemLevel &&
      (classId === undefined || canClassUseItem(base, classId))
    );
  });
}
