import type { WorldFlagId, WorldFlags } from '../world/projects.js';
import type { ForgeRecipe } from './config.js';

/**
 * Town upgrades (ticket 6.7, docs/ECONOMY.md "Town upgrades"): modest quality-of-life services a
 * completed community project opens for everyone, keyed on its world flag. Never power: an upgrade
 * may make a service cheaper or easier, never add stats, drops, odds or XP.
 *
 * The first: the **Forgeward bellows** (`forgewardRaised`): the Forge works the Tyrant's fire at
 * the outpost's beacon, so the Tyrantforged Work recipe costs 20 % less gold. Its other costs (the
 * Tyrant's Ember, ore and shards) are unchanged, so the ember still paces the recipe exactly as
 * before; only the gold sink shrinks (3,000 → 2,400 per craft).
 *
 * Ticket 8.2: the **lantern smithy** (`deepLanternsLit`): Crownforged Work 20 % less gold
 * (4,500 → 3,600); the crown shard, ore and shards unchanged.
 */

export interface TownUpgradeDefinition {
  /** Never rename or reuse. */
  id: string;
  name: string;
  /** What it does, as the player reads it. */
  description: string;
  /** The world flag that opens it. */
  flag: WorldFlagId;
  /** A Forge recipe whose gold price drops by `share` (0 < share < 1, rounded to whole gold). */
  forgeGoldDiscount?: { recipeId: string; share: number };
}

export const TOWN_UPGRADES: readonly TownUpgradeDefinition[] = [
  {
    id: 'forgewardBellows',
    name: 'The Forgeward bellows',
    description:
      'The Forge works the Tyrant’s fire at the outpost beacon: Tyrantforged Work costs 20 % less gold.',
    flag: 'forgewardRaised',
    forgeGoldDiscount: { recipeId: 'tyrantforgedWork', share: 0.2 },
  },
  {
    // Ticket 8.2: the lanterns of the deep. The same kind of service one region on: the crown
    // shard still paces the recipe exactly; only its gold sink shrinks (4,500 → 3,600).
    id: 'lanternSmithy',
    name: 'The lantern smithy',
    description:
      'The lantern-keepers’ smithy at the rim of the deep works crown-iron by lantern light: Crownforged Work costs 20 % less gold.',
    flag: 'deepLanternsLit',
    forgeGoldDiscount: { recipeId: 'crownforgedWork', share: 0.2 },
  },
];

/** The upgrades open under these flags. */
export function activeTownUpgrades(
  flags: Partial<WorldFlags> | null | undefined,
): TownUpgradeDefinition[] {
  return TOWN_UPGRADES.filter((u) => flags?.[u.flag] === true);
}

/**
 * The recipe as the town's upgrades price it: the same object when nothing applies (so every
 * other recipe, and this one without the flag, is untouched), else a copy with the lower gold.
 */
export function townPricedRecipe(
  recipe: ForgeRecipe,
  flags: Partial<WorldFlags> | null | undefined,
): ForgeRecipe {
  let gold = recipe.gold;
  for (const u of activeTownUpgrades(flags)) {
    const d = u.forgeGoldDiscount;
    if (d && d.recipeId === recipe.id) gold = Math.round(gold * (1 - d.share));
  }
  return gold === recipe.gold ? recipe : { ...recipe, gold };
}
