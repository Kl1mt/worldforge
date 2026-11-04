import type { ClassId } from '../classes.js';
import type { RarityId } from '../rarity.js';
import { createRng } from '../rng.js';
import {
  ITEM_BASES,
  ITEM_SLOT_KINDS,
  canClassUseItem,
  type ItemBaseDefinition,
  type ItemSlotKind,
} from '../items/bases.js';
import { DEFAULT_LOOT_CONFIG } from '../loot/config.js';
import { generateItem, type GeneratedItem } from '../loot/generate.js';
import type { MaterialId } from '../world/materials.js';
import { DEFAULT_ECONOMY_CONFIG, type EconomyConfig, type ForgeRecipe } from './config.js';
import { sellPrice } from './merchant.js';

export type MaterialBundle = Partial<Record<MaterialId, number>>;

export interface SalvageYield {
  gold: number;
  materials: MaterialBundle;
}

function addTo(bundle: MaterialBundle, materialId: MaterialId, n: number): void {
  if (n > 0) bundle[materialId] = (bundle[materialId] ?? 0) + n;
}

/**
 * What salvaging an item at the forge gives: the tier's materials × the rarity's units, an essence
 * (soul shards) for rare and better items, and a little gold (a quarter of the sell price). Items
 * whose base left the content salvage as tier 1.
 */
export function salvageYield(
  item: Pick<GeneratedItem, 'baseId' | 'rarityId' | 'itemLevel'>,
  config: EconomyConfig = DEFAULT_ECONOMY_CONFIG,
): SalvageYield {
  const tier = ITEM_BASES.find((b) => b.id === item.baseId)?.tier ?? 1;
  const units = config.salvage.rarityUnits[item.rarityId];
  const materials: MaterialBundle = {};
  for (const m of config.salvage.tierMaterials[tier])
    addTo(materials, m.materialId, m.quantity * units);
  const essence = config.salvage.essence;
  addTo(materials, essence.materialId, essence.byRarity[item.rarityId] ?? 0);
  return {
    gold: Math.max(1, Math.round(sellPrice(item, config) * config.salvage.goldFraction)),
    materials,
  };
}

/** Sums several salvage yields. */
export function sumYields(yields: readonly SalvageYield[]): SalvageYield {
  const total: SalvageYield = { gold: 0, materials: {} };
  for (const y of yields) {
    total.gold += y.gold;
    for (const [id, n] of Object.entries(y.materials) as [MaterialId, number][]) {
      addTo(total.materials, id, n);
    }
  }
  return total;
}

function recipeBases(recipe: ForgeRecipe, classId: ClassId, slot: ItemSlotKind) {
  return ITEM_BASES.filter(
    (b) => b.tier === recipe.tier && b.slot === slot && canClassUseItem(b, classId),
  );
}

/** Slot kinds the recipe can make for the class, in canonical order. */
export function recipeSlots(recipe: ForgeRecipe, classId: ClassId): ItemSlotKind[] {
  return ITEM_SLOT_KINDS.filter((slot) => recipeBases(recipe, classId, slot).length > 0);
}

export type CraftBlocker =
  | { kind: 'level'; required: number }
  | { kind: 'gold'; required: number; held: number }
  | { kind: 'material'; materialId: MaterialId; required: number; held: number };

/** Unmet requirements of a recipe in a stable order (level, gold, materials); empty = craftable. */
export function craftBlockers(
  recipe: ForgeRecipe,
  character: { level: number; gold: number },
  held: MaterialBundle,
): CraftBlocker[] {
  const blockers: CraftBlocker[] = [];
  if (character.level < recipe.level) blockers.push({ kind: 'level', required: recipe.level });
  if (character.gold < recipe.gold) {
    blockers.push({ kind: 'gold', required: recipe.gold, held: character.gold });
  }
  for (const m of recipe.materials) {
    const have = held[m.materialId] ?? 0;
    if (have < m.quantity) {
      blockers.push({
        kind: 'material',
        materialId: m.materialId,
        required: m.quantity,
        held: have,
      });
    }
  }
  return blockers;
}

export interface CraftParams {
  recipe: ForgeRecipe;
  classId: ClassId;
  level: number;
  slot: ItemSlotKind;
  /** Server-chosen random seed; stored on the item, so the craft is reproducible. */
  seed: number;
}

/**
 * Crafts one item: a base of the recipe's tier in the chosen slot, usable by the class, at the
 * character's level (raised to the base's minimum item level, capped by the loot config), with a
 * rarity from the recipe's weights. Returns `null` when the recipe makes nothing for that slot.
 */
export function craftItem(params: CraftParams): GeneratedItem | null {
  const { recipe, classId, slot } = params;
  const bases = recipeBases(recipe, classId, slot);
  if (bases.length === 0) return null;
  const rng = createRng(params.seed >>> 0);
  const rarities = Object.entries(recipe.rarities) as [RarityId, number][];
  const rarityId = rng.weighted(rarities, ([, w]) => w)[0];
  const lowest = Math.min(...bases.map((b) => b.minItemLevel));
  const itemLevel = Math.min(DEFAULT_LOOT_CONFIG.maxItemLevel, Math.max(params.level, lowest));
  const eligible: ItemBaseDefinition[] = bases.filter((b) => b.minItemLevel <= itemLevel);
  const base = rng.pick(eligible);
  return generateItem({ seed: rng.int(0, 0xffffffff), itemLevel, baseId: base.id, rarityId });
}
