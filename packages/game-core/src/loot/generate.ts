import type { ClassId } from '../classes.js';
import { RARITY_IDS, type RarityId } from '../rarity.js';
import { createRng, type Rng } from '../rng.js';
import type { CoreStatId } from '../stats.js';
import { affixPoolFor, tiersForItemLevel, type AffixDefinition } from '../items/affixes.js';
import { findItemBase, getItemBase, type ItemBaseDefinition } from '../items/bases.js';
import { mythicForBase, mythicPool, type MythicItemDefinition } from '../items/mythics.js';
import { setForBase, setPiecePool, type SetDefinition } from '../items/sets.js';
import { upgradeImplicitBonus, type ItemVariantId } from '../items/model.js';
import type { ItemAwakening } from '../items/awakening-state.js';
import { activeVariant } from '../items/variants.js';
import { EFFECT_ROLL_STEPS, legendaryEffectPool } from '../effects/resolve.js';
import type { EffectDefinition } from '../effects/types.js';
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
   * Ticket 3.5: the item's variant (`ITEM_VARIANTS`). Rolled last, only on a Legendary or Mythic
   * (set pieces included) from a table with `voidChance` (Void) or, when that roll failed,
   * `prismaticChance` (Prismatic, ticket 6.4). Absent otherwise.
   */
  variant?: ItemVariantId;
  /**
   * Ticket 6.5b: the item's awakening (`items/awakening.ts`). Never rolled: only the Forge's
   * awaken action (and the admin grant on test accounts) writes it. Absent otherwise.
   */
  awakening?: ItemAwakening;
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

export function rollRarity(
  rng: Rng,
  config: LootConfig = DEFAULT_LOOT_CONFIG,
  legendaryWeight = 1,
): RarityId {
  return rng.weighted(RARITY_IDS, (id) =>
    id === 'legendary' ? config.rarities[id].weight * legendaryWeight : config.rarities[id].weight,
  );
}

/** Bases of a table that can drop at the given item level. */
export function eligibleBases(
  table: LootTableDefinition,
  itemLevel: number,
): { base: ItemBaseDefinition; weight: number }[] {
  const result: { base: ItemBaseDefinition; weight: number }[] = [];
  const focus = table.focus;
  const extra = table.modifierFocus;
  for (const entry of table.entries) {
    const base = findItemBase(entry.baseId);
    if (base && entry.weight > 0 && base.minItemLevel <= itemLevel) {
      // Ticket 3.6: a slot-group focus reweights the bases; the pick is still one draw.
      const focused = focus?.slots?.includes(base.slot) === true;
      let weight = focused ? entry.weight * (focus!.slotWeight ?? 1) : entry.weight;
      // Ticket 6.3: the week's boss modifier reweights on top (absent: the same number).
      if (extra?.slots?.includes(base.slot) === true) weight *= extra.slotWeight ?? 1;
      result.push({ base, weight });
    }
  }
  return result;
}

/**
 * Ticket 3.6: the set pieces a set-piece roll from `table` picks from: the pieces of the table's
 * focused sets, or every piece when it has no set focus (or none of the focused pieces fits).
 */
export function focusedSetPieces(
  table: LootTableDefinition,
  itemLevel: number,
  classId?: ClassId,
): string[] {
  const pieces = setPiecePool(itemLevel, classId);
  const sets = table.focus?.sets;
  if (!sets || sets.length === 0) return pieces;
  const focused = pieces.filter((id) => sets.includes(setForBase(id)?.id ?? ''));
  return focused.length > 0 ? focused : pieces;
}

/** Ticket 3.6: a Legendary effect's weight in `table` (an effect-family focus multiplies it). */
export function focusedEffectWeight(
  table: LootTableDefinition,
  effect: Pick<EffectDefinition, 'id' | 'weight'>,
): number {
  const w = effect.weight ?? 0;
  const focus = table.focus;
  const focused = focus?.effects?.includes(effect.id) === true ? w * (focus.effectWeight ?? 1) : w;
  // Ticket 6.3: the week's boss modifier's effect family, on top (absent: the same number).
  const extra = table.modifierFocus;
  return extra?.effects?.includes(effect.id) === true
    ? focused * (extra.effectWeight ?? 1)
    : focused;
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

  let rarityId = params.rarityId ?? rollRarity(rng, config, table.legendaryWeight ?? 1);
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
    const pieces = focusedSetPieces(table, itemLevel, params.classId);
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
      item.effectId = rng.weighted(effects, (e) => focusedEffectWeight(table, e)).id;
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
  // Prismatic (ticket 6.4): never with Void (one variant per item). One more draw after a failed
  // Void roll, only from a table with a Prismatic chance (Ashen-tier content and newer), so every
  // item of every other table, and every Void roll, stays exactly as before.
  const prismaticChance =
    params.baseId === undefined && item.variant === undefined
      ? effectivePrismaticChance(table, config)
      : 0;
  if (
    prismaticChance > 0 &&
    activeVariant({ rarityId, variant: 'prismatic' }) &&
    rng.chance(prismaticChance)
  ) {
    item.variant = 'prismatic';
  }
  return item;
}

/**
 * Ticket 6.4: the chance that a Legendary or Mythic (set pieces included) from this table that is
 * not Void becomes Prismatic: the table's `prismaticChance`, never above the config's
 * `maxPrismaticChance`.
 */
export function effectivePrismaticChance(
  table: LootTableDefinition,
  config: LootConfig = DEFAULT_LOOT_CONFIG,
): number {
  const chance = table.prismaticChance ?? 0;
  if (!Number.isFinite(chance) || chance <= 0) return 0;
  return Math.min(chance, Math.max(0, config.maxPrismaticChance ?? 0));
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
    ? rollGoldAmount(sourceLevel, rng, config, params.goldFind ?? 0, table.goldMultiplier)
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
  /** Ticket 4.8: the loot table's `goldMultiplier` (no extra draw; 1 = the plain roll). */
  multiplier = 1,
): number {
  assertLevel(sourceLevel, 'sourceLevel');
  const { min, max, growthPerLevel } = config.gold;
  const base = rng.int(min, max) * (1 + growthPerLevel * (sourceLevel - 1)) * multiplier;
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
  // Upgrade (3.4) and Void (3.5) bonuses add up; both are 0 on a plain item (and on Prismatic).
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
