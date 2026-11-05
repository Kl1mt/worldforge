import type { RarityId } from '../rarity.js';
import type { ItemVariantId } from './model.js';

/**
 * Item variants (ticket 3.5, GDD §7.5): a modifier layered on an item's rarity and identity, not a
 * rarity tier. Only Void exists in Phase 3 (Prismatic is deferred) and an item has at most one
 * variant (no stacking). The bonus is small and data:
 * - `implicitBonus`: added to the item's implicit (base) stat bonus, next to its upgrade level
 *   (`getImplicitStats`): + 10 % base values. Affixes are untouched.
 * - `effectStrength`: the `EffectInstance.strength` of the item's own effect (a Legendary effect or
 *   a Mythic signature, `itemEffectInstances`): magnitudes × 1.1, never thresholds, stack counts or
 *   decay, and still under the registry's caps. Set pieces have no effect of their own; their set
 *   bonus is the set's and is unchanged (a Void piece counts as the same piece, `wornSets`).
 */
export interface ItemVariantDefinition {
  id: ItemVariantId;
  name: string;
  /** Rarities the variant can exist on (set pieces are Legendary-rarity). */
  rarities: readonly RarityId[];
  implicitBonus: number;
  effectStrength: number;
}

export const ITEM_VARIANTS: readonly ItemVariantDefinition[] = [
  {
    id: 'void',
    name: 'Void',
    rarities: ['legendary', 'mythic'],
    implicitBonus: 0.1,
    effectStrength: 1.1,
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
