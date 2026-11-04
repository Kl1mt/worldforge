import type { RarityId } from '../rarity.js';
import type { ItemTier } from '../items/bases.js';
import type { MaterialId } from '../world/materials.js';

/**
 * Merchant and forge numbers (ticket 2.6, GDD §4.2, §8). First pass; tune in B.1. All prices
 * are integer gold. Invariants (checked in tests): buying is always dearer than selling, and
 * salvaging always pays less gold than selling, so no buy → sell / salvage loop makes gold.
 */
export interface EconomyConfig {
  /** Sell price: `round((sellBase + sellPerItemLevel · itemLevel) · rarity)`, at least 1. */
  sellBase: number;
  sellPerItemLevel: number;
  rarityMultiplier: Readonly<Record<RarityId, number>>;
  merchant: {
    /** Offers per unlocked area and day. */
    offersPerArea: number;
    /** Buy price = sell price × this. */
    buyMarkup: number;
    /** Rarity weights of stock ("basic gear": common and uncommon only). */
    stockRarities: Readonly<Partial<Record<RarityId, number>>>;
  };
  salvage: {
    /** Salvage gold = `round(sellPrice · goldFraction)`, at least 1. */
    goldFraction: number;
    /** Materials every item of a tier yields (multiplied by `rarityUnits`). */
    tierMaterials: Readonly<
      Record<ItemTier, readonly { materialId: MaterialId; quantity: number }[]>
    >;
    rarityUnits: Readonly<Record<RarityId, number>>;
    /** Extra essence for rare and better items. */
    essence: { materialId: MaterialId; byRarity: Readonly<Partial<Record<RarityId, number>>> };
  };
}

export const DEFAULT_ECONOMY_CONFIG: EconomyConfig = {
  sellBase: 3,
  sellPerItemLevel: 1,
  rarityMultiplier: { common: 1, uncommon: 2, rare: 4, epic: 8, legendary: 16, mythic: 32 },
  merchant: {
    offersPerArea: 2,
    buyMarkup: 5,
    stockRarities: { common: 3, uncommon: 1 },
  },
  salvage: {
    goldFraction: 0.25,
    tierMaterials: {
      1: [{ materialId: 'timber', quantity: 1 }],
      2: [
        { materialId: 'rawHide', quantity: 1 },
        { materialId: 'timber', quantity: 1 },
      ],
      3: [{ materialId: 'ironOre', quantity: 2 }],
    },
    rarityUnits: { common: 1, uncommon: 1, rare: 2, epic: 3, legendary: 4, mythic: 5 },
    essence: { materialId: 'soulShard', byRarity: { rare: 1, epic: 2, legendary: 3, mythic: 4 } },
  },
};

export interface MaterialCost {
  materialId: MaterialId;
  quantity: number;
}

/** A forge recipe: tier-appropriate gear in a slot the player picks (Phase 2 scope). */
export interface ForgeRecipe {
  id: string;
  name: string;
  description: string;
  tier: ItemTier;
  /** Character level needed. */
  level: number;
  gold: number;
  materials: readonly MaterialCost[];
  /** Rarity weights of the crafted item (never common: crafting beats a plain drop). */
  rarities: Readonly<Partial<Record<RarityId, number>>>;
}

const CRAFT_RARITIES = { uncommon: 70, rare: 25, epic: 5 } as const;

export const FORGE_RECIPES: readonly ForgeRecipe[] = [
  {
    id: 'fieldsmithWork',
    name: 'Fieldsmith’s Work',
    description: 'Plain gear hammered from field timber and bound with ashwort fibre.',
    tier: 1,
    level: 1,
    gold: 25,
    materials: [
      { materialId: 'timber', quantity: 10 },
      { materialId: 'ashwort', quantity: 5 },
    ],
    rarities: CRAFT_RARITIES,
  },
  {
    id: 'marchwardenWork',
    name: 'Marchwarden’s Work',
    description: 'Hide-wrapped kit for the woods and the graves, quenched with a soul shard.',
    tier: 2,
    level: 9,
    gold: 120,
    materials: [
      { materialId: 'rawHide', quantity: 8 },
      { materialId: 'timber', quantity: 8 },
      { materialId: 'soulShard', quantity: 2 },
    ],
    rarities: CRAFT_RARITIES,
  },
  {
    id: 'knightlyWork',
    name: 'Knightly Work',
    description: 'Iron forged in the old abbey manner, tempered in ashwort and soul-cold water.',
    tier: 3,
    level: 15,
    gold: 400,
    materials: [
      { materialId: 'ironOre', quantity: 10 },
      { materialId: 'soulShard', quantity: 5 },
      { materialId: 'ashwort', quantity: 6 },
    ],
    rarities: CRAFT_RARITIES,
  },
];

export function findForgeRecipe(id: string): ForgeRecipe | undefined {
  return FORGE_RECIPES.find((r) => r.id === id);
}
