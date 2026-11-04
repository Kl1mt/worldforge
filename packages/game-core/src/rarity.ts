/** Item rarities, ordered from most common to rarest (GDD §7.2). */
export const RARITY_IDS = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'] as const;

export type RarityId = (typeof RARITY_IDS)[number];

export interface RarityDefinition {
  id: RarityId;
  name: string;
  /** Zero-based position in the rarity order; higher is rarer. */
  tier: number;
  /** Colour convention name. Concrete colour values belong to the design system (ticket 0.3). */
  color: 'grey' | 'green' | 'blue' | 'purple' | 'orange' | 'red';
}

export const RARITIES: readonly RarityDefinition[] = [
  { id: 'common', name: 'Common', tier: 0, color: 'grey' },
  { id: 'uncommon', name: 'Uncommon', tier: 1, color: 'green' },
  { id: 'rare', name: 'Rare', tier: 2, color: 'blue' },
  { id: 'epic', name: 'Epic', tier: 3, color: 'purple' },
  { id: 'legendary', name: 'Legendary', tier: 4, color: 'orange' },
  { id: 'mythic', name: 'Mythic', tier: 5, color: 'red' },
];

export function isRarityId(value: unknown): value is RarityId {
  return typeof value === 'string' && (RARITY_IDS as readonly string[]).includes(value);
}

/** Negative if `a` is more common than `b`, positive if rarer, 0 if equal. */
export function compareRarity(a: RarityId, b: RarityId): number {
  return RARITY_IDS.indexOf(a) - RARITY_IDS.indexOf(b);
}
