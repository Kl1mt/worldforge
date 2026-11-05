import type { ClassId } from '../classes.js';
import { RARITY_IDS, type RarityId } from '../rarity.js';
import { createRng, type Rng } from '../rng.js';
import type { CoreStatId } from '../stats.js';
import { affixPoolFor, tiersForItemLevel, type AffixDefinition } from '../items/affixes.js';
import { findItemBase, getItemBase, type ItemBaseDefinition } from '../items/bases.js';
import {
  DEFAULT_LOOT_CONFIG,
  STANDARD_LOOT_TABLE,
  type LootConfig,
  type LootTableDefinition,
} from './config.js';

export interface RolledAffix {
  affixId: string;
  tier: number;
  value: number;
  /**
   * Forge state (Phase 3, data model v2; written from ticket 3.4, never by generation):
   * `improvements` = affix-improvement steps applied (the value stays within its tier's range);
   * `rerolled` = this affix replaced an earlier one by a reroll. Absent on freshly rolled affixes.
   */
  improvements?: number;
  rerolled?: boolean;
}

/** A generated item. Matches the persisted `item` columns (see docs/DATA_MODEL.md). */
export interface GeneratedItem {
  /** Per-item seed: `generateItem` with the same seed and inputs reproduces the item. */
  seed: number;
  baseId: string;
  rarityId: RarityId;
  itemLevel: number;
  affixes: RolledAffix[];
}

export interface LootDrop {
  gold: number;
  items: GeneratedItem[];
}

const MAX_SEED = 0xffffffff;

function assertLevel(level: number, name: string): void {
  if (!Number.isInteger(level) || level < 1) {
    throw new RangeError(`${name} must be a positive integer, got ${level}`);
  }
}

/** Rounds to the affix step without float noise (e.g. 0.035, not 0.035000000000000003). */
function roundToStep(value: number, step: number): number {
  const decimals = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
  return Number((Math.round(value / step) * step).toFixed(decimals));
}

export function rollItemLevel(
  sourceLevel: number,
  rng: Rng,
  config: LootConfig = DEFAULT_LOOT_CONFIG,
): number {
  assertLevel(sourceLevel, 'sourceLevel');
  const v = config.itemLevelVariance;
  const level = sourceLevel + (v > 0 ? rng.int(-v, v) : 0);
  return Math.min(config.maxItemLevel, Math.max(1, level));
}

export function rollRarity(rng: Rng, config: LootConfig = DEFAULT_LOOT_CONFIG): RarityId {
  return rng.weighted(RARITY_IDS, (id) => config.rarities[id].weight);
}

/** Bases of a table that can drop at the given item level. */
export function eligibleBases(
  table: LootTableDefinition,
  itemLevel: number,
): { base: ItemBaseDefinition; weight: number }[] {
  const result: { base: ItemBaseDefinition; weight: number }[] = [];
  for (const entry of table.entries) {
    const base = findItemBase(entry.baseId);
    if (base && entry.weight > 0 && base.minItemLevel <= itemLevel) {
      result.push({ base, weight: entry.weight });
    }
  }
  return result;
}

/**
 * Affix count for a rarity on a base: the rarity's count, capped by the base's class-free pool
 * (content tests keep every pool at least as large as the highest count).
 */
export function affixCountFor(
  base: ItemBaseDefinition,
  rarityId: RarityId,
  config: LootConfig = DEFAULT_LOOT_CONFIG,
): number {
  return Math.min(config.rarities[rarityId].affixCount, affixPoolFor(base).length);
}

/**
 * Tier weights for one roll (ticket 3.1): the tiers unlocked at `itemLevel` plus the rarity's
 * `affixLevelBonus`, each weighted `weight × (1 + bias)^(tier − 1)`.
 */
export function affixTierWeights(
  affix: AffixDefinition,
  itemLevel: number,
  levelBonus: number,
  bias: number,
): { tier: number; weight: number }[] {
  const factor = 1 + Math.max(0, bias);
  return tiersForItemLevel(affix, itemLevel, levelBonus).map((t) => ({
    tier: t.tier,
    weight: t.weight * factor ** (t.tier - 1),
  }));
}

function rollAffixValue(
  affix: AffixDefinition,
  itemLevel: number,
  levelBonus: number,
  bias: number,
  rng: Rng,
): RolledAffix {
  const weights = affixTierWeights(affix, itemLevel, levelBonus, bias);
  const picked = rng.weighted(weights, (t) => t.weight);
  const tier = affix.tiers.find((t) => t.tier === picked.tier)!;
  const steps = Math.round((tier.max - tier.min) / affix.step);
  const value = roundToStep(tier.min + rng.int(0, steps) * affix.step, affix.step);
  return { affixId: affix.id, tier: tier.tier, value };
}

export interface GenerateItemParams {
  seed: number;
  itemLevel: number;
  /** Fixed base; otherwise picked from `lootTable`. */
  baseId?: string;
  /** Fixed rarity; otherwise rolled from `config`. */
  rarityId?: RarityId;
  lootTable?: LootTableDefinition;
  /**
   * Class of the character the item is generated for (ticket 3.1). Enables that class's
   * class-flavoured affixes; without it they never roll. Part of the reproduction inputs.
   */
  classId?: ClassId;
}

/**
 * Generates one item from its own seed. Returns `null` if the loot table has no base
 * that can drop at this item level.
 */
export function generateItem(
  params: GenerateItemParams,
  config: LootConfig = DEFAULT_LOOT_CONFIG,
): GeneratedItem | null {
  assertLevel(params.itemLevel, 'itemLevel');
  const seed = params.seed >>> 0;
  const itemLevel = Math.min(config.maxItemLevel, params.itemLevel);
  const rng = createRng(seed);

  let base: ItemBaseDefinition;
  if (params.baseId !== undefined) {
    base = getItemBase(params.baseId);
  } else {
    const candidates = eligibleBases(params.lootTable ?? STANDARD_LOOT_TABLE, itemLevel);
    if (candidates.length === 0) return null;
    base = rng.weighted(candidates, (c) => c.weight).base;
  }

  const rarityId = params.rarityId ?? rollRarity(rng, config);
  const rarity = config.rarities[rarityId];
  const bias = rarity.affixTierBias + (params.lootTable?.affixTierBias ?? 0);

  // Distinct affixes, picked by weight without replacement.
  const pool = [...affixPoolFor(base, params.classId)];
  const affixes: RolledAffix[] = [];
  for (let n = affixCountFor(base, rarityId, config); n > 0 && pool.length > 0; n--) {
    const affix = rng.weighted(pool, (a) => a.weight);
    pool.splice(pool.indexOf(affix), 1);
    affixes.push(rollAffixValue(affix, itemLevel, rarity.affixLevelBonus, bias, rng));
  }

  return { seed, baseId: base.id, rarityId, itemLevel, affixes };
}

export interface RollLootParams {
  rng: Rng;
  /** Level of the defeated enemy / area. */
  sourceLevel: number;
  lootTable?: LootTableDefinition;
  /** Gold find bonus as a fraction (0.1 = +10 %), supplied by the server's stat system. */
  goldFind?: number;
  /**
   * Item find bonus as a fraction (ticket 3.1, already capped): the item drop chance becomes
   * `min(1, itemDropChance × (1 + itemFind))`. Callers give every kill its own RNG stream, so the
   * bonus never shifts another kill's rolls.
   */
  itemFind?: number;
  /** Class of the character the loot is for (enables class affixes, see `GenerateItemParams`). */
  classId?: ClassId;
}

/** Rolls the loot for one kill: gold and at most one item. */
export function rollLoot(
  params: RollLootParams,
  config: LootConfig = DEFAULT_LOOT_CONFIG,
): LootDrop {
  const { rng, sourceLevel } = params;
  assertLevel(sourceLevel, 'sourceLevel');
  const table = params.lootTable ?? STANDARD_LOOT_TABLE;

  const gold = rng.chance(config.gold.dropChance)
    ? rollGoldAmount(sourceLevel, rng, config, params.goldFind ?? 0)
    : 0;

  const items: GeneratedItem[] = [];
  const itemFind = Number.isFinite(params.itemFind) ? Math.max(0, params.itemFind ?? 0) : 0;
  if (rng.chance(Math.min(1, table.itemDropChance * (1 + itemFind)))) {
    const rolled = rollItemLevel(sourceLevel, rng, config);
    const itemLevel = table.itemLevel
      ? Math.min(table.itemLevel.max, Math.max(table.itemLevel.min, rolled))
      : rolled;
    const seed = rng.int(0, MAX_SEED);
    const item = generateItem(
      {
        seed,
        itemLevel,
        lootTable: table,
        ...(params.classId !== undefined ? { classId: params.classId } : {}),
      },
      config,
    );
    if (item) items.push(item);
  }
  return { gold, items };
}

export function rollGoldAmount(
  sourceLevel: number,
  rng: Rng,
  config: LootConfig = DEFAULT_LOOT_CONFIG,
  goldFind = 0,
): number {
  assertLevel(sourceLevel, 'sourceLevel');
  const { min, max, growthPerLevel } = config.gold;
  const base = rng.int(min, max) * (1 + growthPerLevel * (sourceLevel - 1));
  const bonus = Number.isFinite(goldFind) ? Math.max(0, goldFind) : 0;
  return Math.max(1, Math.round(base * (1 + bonus)));
}

export interface ItemStatValue {
  stat: CoreStatId;
  value: number;
}

/** Implicit stats of an item: the base's stats scaled by item level and rarity. */
export function getImplicitStats(
  item: Pick<GeneratedItem, 'baseId' | 'rarityId' | 'itemLevel'>,
  config: LootConfig = DEFAULT_LOOT_CONFIG,
): ItemStatValue[] {
  const base = getItemBase(item.baseId);
  const mult = config.rarities[item.rarityId].statMultiplier;
  return base.stats.map((s) => ({
    stat: s.stat,
    value: Math.round((s.base + s.perLevel * (item.itemLevel - 1)) * mult),
  }));
}
