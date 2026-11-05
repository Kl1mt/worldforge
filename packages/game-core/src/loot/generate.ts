import type { ClassId } from '../classes.js';
import { RARITY_IDS, type RarityId } from '../rarity.js';
import { createRng, type Rng } from '../rng.js';
import type { CoreStatId } from '../stats.js';
import { affixPoolFor, tiersForItemLevel, type AffixDefinition } from '../items/affixes.js';
import { findItemBase, getItemBase, type ItemBaseDefinition } from '../items/bases.js';
import { mythicForBase, mythicPool, type MythicItemDefinition } from '../items/mythics.js';
import { setForBase, setPiecePool, type SetDefinition } from '../items/sets.js';
import { upgradeImplicitBonus, type ItemVariantId } from '../items/model.js';
import { activeVariant } from '../items/variants.js';
import { EFFECT_ROLL_STEPS, legendaryEffectPool } from '../effects/resolve.js';
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
  /**
   * Ticket 3.2: the Legendary effect or Mythic signature (effect registry id), the Legendary's
   * rolled strength as a position in its ranges (0…1 on a 0.05 grid; absent on Mythics, whose
   * signature is fixed) and the named Mythic. Absent on every other item.
   */
  effectId?: string;
  effectRoll?: number;
  mythicId?: string;
  /**
   * Ticket 3.3: the set of a set piece (`ITEM_SETS`). A set piece is a Legendary-rarity item on its
   * set's fixed base, without an effect of its own. Absent on every other item.
   */
  setId?: string;
  /**
   * Ticket 3.5: the item's variant (`ITEM_VARIANTS`; only `void`). Rolled last, only on a
   * Legendary or Mythic (set pieces included) from a table with `voidChance`. Absent otherwise.
   */
  variant?: ItemVariantId;
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
export function roundToStep(value: number, step: number): number {
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

/**
 * Rolls one affix: a tier from the unlocked tiers' weights, then a value on the step grid inside
 * it. Generation and the Forge's reroll (ticket 3.4) share it.
 */
export function rollAffixValue(
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
  const table = params.lootTable ?? STANDARD_LOOT_TABLE;

  let base: ItemBaseDefinition;
  if (params.baseId !== undefined) {
    base = getItemBase(params.baseId);
  } else {
    const candidates = eligibleBases(table, itemLevel);
    if (candidates.length === 0) return null;
    base = rng.weighted(candidates, (c) => c.weight).base;
  }

  let rarityId = params.rarityId ?? rollRarity(rng, config);
  // Mythics (ticket 3.2) are named items. A Mythic base is always its Mythic; a Mythic roll picks
  // a named Mythic in a late-game table and becomes a Legendary anywhere else. An explicitly
  // requested Mythic rarity without a named Mythic stays a stat-only Mythic (the Phase 1 rule).
  let mythic: MythicItemDefinition | undefined = mythicForBase(base.id);
  if (mythic) {
    rarityId = 'mythic';
  } else if (rarityId === 'mythic' && params.baseId === undefined) {
    const pool = table.mythics ? mythicPool(itemLevel, params.classId) : [];
    if (pool.length > 0) {
      mythic = rng.weighted(pool, (m) => m.weight);
      base = getItemBase(mythic.baseId);
    } else if (params.rarityId === undefined) {
      rarityId = 'legendary';
    }
  }
  // Set pieces (ticket 3.3) are named items too. A set base is always its set's piece; in a table
  // with `setShare`, that share of Legendary rolls becomes a set piece. The extra draw happens only
  // on a Legendary roll there, so every other item rolls exactly as before.
  let set: SetDefinition | undefined = mythic ? undefined : setForBase(base.id);
  if (set) {
    rarityId = 'legendary';
  } else if (
    !mythic &&
    rarityId === 'legendary' &&
    params.baseId === undefined &&
    (table.setShare ?? 0) > 0
  ) {
    const pieces = setPiecePool(itemLevel, params.classId);
    if (pieces.length > 0 && rng.chance(table.setShare!)) {
      base = getItemBase(pieces[rng.int(0, pieces.length - 1)]!);
      set = setForBase(base.id);
    }
  }
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

  const item: GeneratedItem = { seed, baseId: base.id, rarityId, itemLevel, affixes };
  if (mythic) {
    item.effectId = mythic.effectId;
    item.mythicId = mythic.id;
  } else if (set) {
    item.setId = set.id;
  } else if (rarityId === 'legendary') {
    // Drawn after everything else, so the rest of the item rolls exactly as before ticket 3.2.
    const effects = legendaryEffectPool(base, params.classId);
    if (effects.length > 0) {
      item.effectId = rng.weighted(effects, (e) => e.weight ?? 0).id;
      item.effectRoll = rng.int(0, EFFECT_ROLL_STEPS) / EFFECT_ROLL_STEPS;
    }
  }
  // Void (ticket 3.5): the last draw, only for a Legendary or Mythic rolled from a table with a
  // Void chance, so every item rolls exactly as before and only those few items draw once more.
  // Requested bases (forge, quests, merchant) never become Void.
  const voidChance = params.baseId === undefined ? effectiveVoidChance(table, config) : 0;
  if (voidChance > 0 && activeVariant({ rarityId, variant: 'void' }) && rng.chance(voidChance)) {
    item.variant = 'void';
  }
  return item;
}

/**
 * Ticket 3.5: the chance that a Legendary or Mythic (set pieces included) from this table is
 * Void: the table's `voidChance`, never above the config's `maxVoidChance`.
 */
export function effectiveVoidChance(
  table: LootTableDefinition,
  config: LootConfig = DEFAULT_LOOT_CONFIG,
): number {
  const chance = table.voidChance ?? 0;
  if (!Number.isFinite(chance) || chance <= 0) return 0;
  return Math.min(chance, Math.max(0, config.maxVoidChance ?? 0));
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
  item: Pick<GeneratedItem, 'baseId' | 'rarityId' | 'itemLevel'> & UpgradeLevelField,
  config: LootConfig = DEFAULT_LOOT_CONFIG,
): ItemStatValue[] {
  const base = getItemBase(item.baseId);
  const mult = config.rarities[item.rarityId].statMultiplier;
  // Upgrade (3.4) and Void (3.5) bonuses add up; both are 0 on a plain item.
  const bonus = upgradeImplicitBonus(item.upgradeLevel) + (activeVariant(item)?.implicitBonus ?? 0);
  return base.stats.map((s) => {
    const raw = (s.base + s.perLevel * (item.itemLevel - 1)) * mult;
    // +0 keeps the exact pre-3.4 expression (no extra float operation), so every number holds.
    return { stat: s.stat, value: Math.round(bonus === 0 ? raw : raw * (1 + bonus)) };
  });
}

/**
 * Ticket 3.4: the item's upgrade level (`item_instances.upgrade_level`). Optional on everything
 * that prices an item's stats; absent or null = +0. Ticket 3.5 adds the `variant` column: a Void
 * Legendary or Mythic gets its variant's implicit bonus; absent or null = none.
 */
export interface UpgradeLevelField {
  upgradeLevel?: number | null;
  variant?: ItemVariantId | null;
}
