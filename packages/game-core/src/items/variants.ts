import type { RarityId } from '../rarity.js';
import type { ItemStatId } from '../stats.js';
import type { ItemVariantId } from './model.js';

/**
 * Item variants (ticket 3.5, GDD §7.5): a modifier layered on an item's rarity and identity, not a
 * rarity tier. Void (3.5) and Prismatic (6.4); an item has at most one variant (no stacking: the
 * `variant` column holds one value, and a Prismatic roll is only made when the Void roll failed).
 * The bonus is small and data:
 * - `implicitBonus`: added to the item's implicit (base) stat bonus, next to its upgrade level
 *   (`getImplicitStats`): + 10 % base values. Affixes are untouched.
 * - `effectStrength`: the `EffectInstance.strength` of the item's own effect (a Legendary effect or
 *   a Mythic signature, `itemEffectInstances`): magnitudes × 1.1, never thresholds, stack counts or
 *   decay, and still under the registry's caps. Set pieces have no effect of their own; their set
 *   bonus is the set's and is unchanged (a Void piece counts as the same piece, `wornSets`).
 * - `affixBonus` (ticket 6.4, Prismatic): multiplies the values of the item's combat affixes
 *   (`AFFIX_BONUS_STATS`) when its stats are read (`itemStatContribution`, `itemSecondaryModifiers`).
 *   Stored values never change, so validation, the Forge's caps and magic quality read the rolled
 *   numbers. Find affixes (gold, items, XP, resources) are never amplified: the economy is
 *   unchanged. Void puts its bonus into base values and the effect; Prismatic into the affixes,
 *   so the better of the two depends on the item's affixes and the build (docs/EFFECTS.md).
 */
export interface ItemVariantDefinition {
  id: ItemVariantId;
  name: string;
  /** Rarities the variant can exist on (set pieces are Legendary-rarity). */
  rarities: readonly RarityId[];
  implicitBonus: number;
  effectStrength: number;
  /** Ticket 6.4: the factor on the item's combat affix values (1 = none). */
  affixBonus: number;
}

/**
 * Ticket 6.4: the stats a variant's `affixBonus` amplifies: every core stat but crit chance, and
 * the two combat secondaries. Gold, item, XP and resource find are left out (the economy is
 * unchanged). Crit chance is left out because it multiplies with crit damage and the crit-scaling
 * effects (Mana Surge, Emberbrand, Starfall): with it, the best Prismatic crit builds beat the best
 * Void builds at the boss by up to 10 % (docs/EFFECTS.md "Prismatic balance").
 */
export const AFFIX_BONUS_STATS: ReadonlySet<ItemStatId> = new Set<ItemStatId>([
  'health',
  'physicalDamage',
  'magicDamage',
  'attackSpeed',
  'critDamage',
  'armor',
  'resistance',
  'bossDamage',
  'skillDamage',
]);

/** Ticket 6.4: Prismatic's factor on combat affix values (balanced against Void, B.2 search). */
export const PRISMATIC_AFFIX_BONUS = 1.1;

export const ITEM_VARIANTS: readonly ItemVariantDefinition[] = [
  {
    id: 'void',
    name: 'Void',
    rarities: ['legendary', 'mythic'],
    implicitBonus: 0.1,
    effectStrength: 1.1,
    affixBonus: 1,
  },
  {
    // Ticket 6.4: rarer than Void, never with it, from Ashen-tier content on (docs/EFFECTS.md).
    id: 'prismatic',
    name: 'Prismatic',
    rarities: ['legendary', 'mythic'],
    implicitBonus: 0,
    effectStrength: 1,
    affixBonus: PRISMATIC_AFFIX_BONUS,
  },
];

const VARIANTS_BY_ID = new Map(ITEM_VARIANTS.map((v) => [v.id, v]));

export function findItemVariant(id: unknown): ItemVariantDefinition | undefined {
  return typeof id === 'string' ? VARIANTS_BY_ID.get(id as ItemVariantId) : undefined;
}

/** Item fields a variant reads (the `variant` and `rarity_id` columns). */
export interface VariantCarrier {
  rarityId: RarityId;
  variant?: ItemVariantId | null;
}

/**
 * The variant that applies to an item: its variant when known and allowed on its rarity, else
 * none. A variant on any other item (never generated, `validateItem` rejects it) does nothing, so
 * an item without a valid variant always gives exactly its pre-3.5 numbers.
 */
export function activeVariant(item: VariantCarrier): ItemVariantDefinition | undefined {
  if (item.variant === null || item.variant === undefined) return undefined;
  const variant = findItemVariant(item.variant);
  return variant && variant.rarities.includes(item.rarityId) ? variant : undefined;
}

/**
 * Ticket 6.4: an affix value as the item's variant reads it. Without an active variant with an
 * `affixBonus`, or for a stat it leaves out, this is the stored value itself (no float operation).
 * Flat stats round to whole points, fractions to 4 decimals.
 */
export function variantAffixValue(
  variant: ItemVariantDefinition | undefined,
  stat: ItemStatId,
  value: number,
  step: number,
): number {
  if (!variant || variant.affixBonus === 1 || !AFFIX_BONUS_STATS.has(stat)) return value;
  const raised = value * variant.affixBonus;
  return step >= 1 ? Math.round(raised) : Math.round(raised * 10_000) / 10_000;
}
