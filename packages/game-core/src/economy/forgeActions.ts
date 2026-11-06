import type { ClassId } from '../classes.js';
import type { Rng } from '../rng.js';
import {
  affixPoolFor,
  findAffix,
  tiersForItemLevel,
  type AffixDefinition,
  type AffixTier,
} from '../items/affixes.js';
import { findItemBase, type ItemBaseDefinition } from '../items/bases.js';
import { MAX_UPGRADE_LEVEL, UPGRADE_IMPLICIT_BONUS } from '../items/model.js';
import { DEFAULT_LOOT_CONFIG, type LootConfig } from '../loot/config.js';
import {
  rollAffixValue,
  roundToStep,
  type GeneratedItem,
  type RolledAffix,
} from '../loot/generate.js';
import type { MaterialId } from '../world/materials.js';
import { DEFAULT_ECONOMY_CONFIG, type EconomyConfig } from './config.js';
import type { MaterialBundle } from './forge.js';

/**
 * The Forge's improvement paths (ticket 3.4, GDD §8.1): item upgrades +0…+10, affix reroll and affix
 * improvement. Pure rules and numbers; the server draws every random outcome from the item's own
 * server-side stream (``createRng(`${forge_secret}:${forge_counter}`)``, one draw stream per action)
 * and applies the result under the character and item locks. Numbers and their reasoning:
 * `docs/ECONOMY.md` (Forge upgrades).
 *
 * Costs are gold plus the item's own tier materials (the salvage table's units, so a tier-3 item
 * asks for iron ore) and soul shards for the upper steps. Everything scales with the item level
 * through `levelFactor` (item level 20 = × 1), so upgrading low-level gear stays cheap.
 */

/** One upgrade step, from `+n` to `+(n + 1)`. */
export interface UpgradeStepRule {
  /** Success chance of one attempt (0…1). */
  chance: number;
  /** Failures in a row after which the next attempt always succeeds (0 = never needed). */
  pity: number;
  /** Gold per attempt at item level 20 (× `levelFactor`). */
  gold: number;
  /** Tier-material units per attempt (× the tier's salvage materials). */
  units: number;
  /** Soul shards per attempt. */
  essence: number;
}

export interface ForgeActionConfig {
  /** `levelFactor(itemLevel) = (itemLevel + levelOffset) / levelDivisor`. */
  levelOffset: number;
  levelDivisor: number;
  /** Index `n` = the step from `+n` to `+(n + 1)`; length `MAX_UPGRADE_LEVEL`. */
  upgradeSteps: readonly UpgradeStepRule[];
  reroll: {
    /** Gold at item level 20 for the item's first reroll. */
    gold: number;
    /** Each earlier reroll of the same item adds this share of the first price. */
    growth: number;
    units: number;
    essence: number;
    /** Extra soul shards per earlier reroll, up to `essenceCap` in all. */
    essencePerReroll: number;
    essenceCap: number;
  };
  improve: {
    /** Improvements per affix (the cap; the value never leaves its tier's range either). */
    maxImprovements: number;
    /** Gold at item level 20 for an affix's first improvement; × (1 + improvements so far). */
    gold: number;
    units: number;
    essence: number;
    /** One improvement adds this share of the tier's range, rolled on the step grid. */
    minShare: number;
    maxShare: number;
  };
}

export const DEFAULT_FORGE_ACTION_CONFIG: ForgeActionConfig = {
  levelOffset: 5,
  levelDivisor: 25,
  upgradeSteps: [
    { chance: 1, pity: 0, gold: 50, units: 2, essence: 0 }, // +0 → +1
    { chance: 0.9, pity: 2, gold: 80, units: 3, essence: 0 },
    { chance: 0.8, pity: 2, gold: 120, units: 4, essence: 0 },
    { chance: 0.7, pity: 3, gold: 180, units: 5, essence: 0 },
    { chance: 0.6, pity: 3, gold: 260, units: 6, essence: 1 }, // +4 → +5
    // Ticket B.2: the gold of +5 → +10 doubled (was 380 / 540 / 760 / 1,050 / 1,400). Realistic
    // play earns 2–2.5 × the kill gold, and a +10 kit came within ~100 h (docs/ECONOMY.md).
    { chance: 0.5, pity: 4, gold: 760, units: 8, essence: 1 },
    { chance: 0.4, pity: 4, gold: 1080, units: 10, essence: 2 },
    { chance: 0.33, pity: 5, gold: 1520, units: 12, essence: 2 },
    { chance: 0.25, pity: 6, gold: 2100, units: 15, essence: 3 },
    { chance: 0.2, pity: 7, gold: 2800, units: 18, essence: 4 }, // +9 → +10
  ],
  reroll: { gold: 200, growth: 0.5, units: 3, essence: 2, essencePerReroll: 1, essenceCap: 12 },
  improve: { maxImprovements: 3, gold: 150, units: 4, essence: 1, minShare: 0.15, maxShare: 0.35 },
};

/** The essence material the Forge asks for (the salvage essence: soul shards). */
const essenceOf = (economy: EconomyConfig): MaterialId => economy.salvage.essence.materialId;

/** Cost multiplier of an item level: `(itemLevel + 5) / 25` by default (level 20 = × 1). */
export function levelFactor(
  itemLevel: number,
  config: ForgeActionConfig = DEFAULT_FORGE_ACTION_CONFIG,
): number {
  return (Math.max(1, itemLevel) + config.levelOffset) / config.levelDivisor;
}

/** Gold and materials one forge action costs. */
export interface ForgeCost {
  gold: number;
  materials: MaterialBundle;
}

function addTo(bundle: MaterialBundle, id: MaterialId, n: number): void {
  if (n > 0) bundle[id] = (bundle[id] ?? 0) + n;
}

function costFor(
  base: Pick<ItemBaseDefinition, 'tier'>,
  itemLevel: number,
  gold: number,
  units: number,
  essence: number,
  config: ForgeActionConfig,
  economy: EconomyConfig,
): ForgeCost {
  const materials: MaterialBundle = {};
  for (const m of economy.salvage.tierMaterials[base.tier]) {
    addTo(materials, m.materialId, m.quantity * units);
  }
  addTo(materials, essenceOf(economy), essence);
  return { gold: Math.max(1, Math.round(gold * levelFactor(itemLevel, config))), materials };
}

/** The per-item forge state the rules read: the item plus its upgrade and reroll counters. */
export type ForgeItem = Pick<GeneratedItem, 'baseId' | 'rarityId' | 'itemLevel' | 'affixes'> & {
  upgradeLevel: number;
  upgradePity: number;
  rerollCount: number;
};

/** Why the Forge refuses an action on an item (nothing is paid or drawn). */
export type ForgeRefusal =
  | 'unknown_base'
  | 'max_upgrade'
  | 'no_such_affix'
  | 'unknown_affix'
  | 'improvement_cap'
  | 'affix_at_max';

export type ForgeCheck<T> = { ok: true; value: T } | { ok: false; reason: ForgeRefusal };

const refuse = (reason: ForgeRefusal) => ({ ok: false as const, reason });

/* ------------------------------------------------------------------------------------------------
 * Upgrades
 * --------------------------------------------------------------------------------------------- */

/** The rule of the next upgrade step of an item at `upgradeLevel`, or null at the top. */
export function upgradeStepRule(
  upgradeLevel: number,
  config: ForgeActionConfig = DEFAULT_FORGE_ACTION_CONFIG,
): UpgradeStepRule | null {
  if (upgradeLevel >= MAX_UPGRADE_LEVEL) return null;
  return config.upgradeSteps[Math.max(0, upgradeLevel)] ?? null;
}

/** What the next upgrade attempt costs, its odds and the pity progress. */
export interface UpgradeQuote {
  fromLevel: number;
  toLevel: number;
  chance: number;
  /** Failures since the last success / the failures that guarantee the next attempt. */
  pity: number;
  pityThreshold: number;
  /** True when this attempt cannot fail (pity reached, or a certain step). */
  guaranteed: boolean;
  cost: ForgeCost;
  /** Implicit-stat bonus now and after a success (fractions). */
  bonusNow: number;
  bonusNext: number;
}

export function quoteUpgrade(
  item: ForgeItem,
  config: ForgeActionConfig = DEFAULT_FORGE_ACTION_CONFIG,
  economy: EconomyConfig = DEFAULT_ECONOMY_CONFIG,
): ForgeCheck<UpgradeQuote> {
  const base = findItemBase(item.baseId);
  if (!base) return refuse('unknown_base');
  const step = upgradeStepRule(item.upgradeLevel, config);
  if (!step) return refuse('max_upgrade');
  return {
    ok: true,
    value: {
      fromLevel: item.upgradeLevel,
      toLevel: item.upgradeLevel + 1,
      chance: step.chance,
      pity: item.upgradePity,
      pityThreshold: step.pity,
      guaranteed: step.chance >= 1 || item.upgradePity >= step.pity,
      cost: costFor(base, item.itemLevel, step.gold, step.units, step.essence, config, economy),
      bonusNow: UPGRADE_IMPLICIT_BONUS[item.upgradeLevel] ?? 0,
      bonusNext: UPGRADE_IMPLICIT_BONUS[item.upgradeLevel + 1] ?? 0,
    },
  };
}

export interface UpgradeOutcome {
  success: boolean;
  /** The pity counter made this attempt succeed (or the step is certain). */
  guaranteed: boolean;
  /** The roll in [0, 1) drawn for the attempt (audit). */
  roll: number;
  upgradeLevel: number;
  upgradePity: number;
}

/**
 * One upgrade attempt. Always draws exactly one roll, so the stream's use does not depend on the
 * pity. Success raises the level by one and resets the pity; failure keeps the level (an item is
 * never destroyed or downgraded, GDD §8.1) and counts one more failure.
 */
export function attemptUpgrade(
  item: Pick<ForgeItem, 'upgradeLevel' | 'upgradePity'>,
  rng: Rng,
  config: ForgeActionConfig = DEFAULT_FORGE_ACTION_CONFIG,
): UpgradeOutcome {
  const step = upgradeStepRule(item.upgradeLevel, config);
  if (!step) throw new RangeError(`no upgrade above +${item.upgradeLevel}`);
  const roll = rng.next();
  const guaranteed = step.chance >= 1 || item.upgradePity >= step.pity;
  const success = guaranteed || roll < step.chance;
  return success
    ? { success, guaranteed, roll, upgradeLevel: item.upgradeLevel + 1, upgradePity: 0 }
    : {
        success,
        guaranteed,
        roll,
        upgradeLevel: item.upgradeLevel,
        upgradePity: item.upgradePity + 1,
      };
}

/** Expected (mean) attempts of one step from a pity of 0: `Σ_{k=0}^{pity} (1 − chance)^k`. */
export function expectedAttempts(step: UpgradeStepRule): number {
  if (step.chance >= 1) return 1;
  let sum = 0;
  for (let k = 0; k <= step.pity; k++) sum += (1 - step.chance) ** k;
  return sum;
}

/** Upgrade spending from `+from` to `+to` (exact means, and the pity-capped worst case). */
export interface UpgradePathCost {
  expected: { gold: number; materials: MaterialBundle; attempts: number };
  worst: { gold: number; materials: MaterialBundle; attempts: number };
}

export function upgradePathCost(
  item: Pick<ForgeItem, 'baseId' | 'itemLevel'>,
  from: number,
  to: number,
  config: ForgeActionConfig = DEFAULT_FORGE_ACTION_CONFIG,
  economy: EconomyConfig = DEFAULT_ECONOMY_CONFIG,
): UpgradePathCost {
  const base = findItemBase(item.baseId) ?? { tier: 1 as const };
  const out: UpgradePathCost = {
    expected: { gold: 0, materials: {}, attempts: 0 },
    worst: { gold: 0, materials: {}, attempts: 0 },
  };
  for (let n = Math.max(0, from); n < Math.min(to, MAX_UPGRADE_LEVEL); n++) {
    const step = config.upgradeSteps[n]!;
    const one = costFor(base, item.itemLevel, step.gold, step.units, step.essence, config, economy);
    const mean = expectedAttempts(step);
    const most = step.chance >= 1 ? 1 : step.pity + 1;
    for (const [bucket, k] of [
      [out.expected, mean],
      [out.worst, most],
    ] as const) {
      bucket.attempts += k;
      bucket.gold += one.gold * k;
      for (const [id, q] of Object.entries(one.materials) as [MaterialId, number][]) {
        bucket.materials[id] = (bucket.materials[id] ?? 0) + q * k;
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------
 * Affix reroll and improvement
 * --------------------------------------------------------------------------------------------- */

function affixAt(
  item: ForgeItem,
  index: number,
): ForgeCheck<{ rolled: RolledAffix; affix: AffixDefinition; base: ItemBaseDefinition }> {
  const base = findItemBase(item.baseId);
  if (!base) return refuse('unknown_base');
  if (!Number.isInteger(index) || index < 0 || index >= item.affixes.length) {
    return refuse('no_such_affix');
  }
  const rolled = item.affixes[index]!;
  const affix = findAffix(rolled.affixId);
  if (!affix) return refuse('unknown_affix');
  return { ok: true, value: { rolled, affix, base } };
}

/**
 * The affixes a reroll of affix `index` can produce: the base's pool for the class, without the
 * affixes the item keeps (no duplicates) and without the replaced one (a reroll always changes the
 * affix), unless nothing else is left. Each with the tiers the item level unlocks for its rarity.
 */
export function rerollOptions(
  item: ForgeItem,
  index: number,
  classId: ClassId,
  loot: LootConfig = DEFAULT_LOOT_CONFIG,
): ForgeCheck<{ affix: AffixDefinition; weight: number; tiers: readonly AffixTier[] }[]> {
  const at = affixAt(item, index);
  if (!at.ok) return at;
  const kept = new Set(item.affixes.filter((_, i) => i !== index).map((a) => a.affixId));
  const pool = affixPoolFor(at.value.base, classId).filter((a) => !kept.has(a.id));
  const fresh = pool.filter((a) => a.id !== at.value.rolled.affixId);
  const options = fresh.length > 0 ? fresh : pool;
  const levelBonus = loot.rarities[item.rarityId].affixLevelBonus;
  return {
    ok: true,
    value: options.map((affix) => ({
      affix,
      weight: affix.weight,
      tiers: tiersForItemLevel(affix, item.itemLevel, levelBonus),
    })),
  };
}

export function quoteReroll(
  item: ForgeItem,
  config: ForgeActionConfig = DEFAULT_FORGE_ACTION_CONFIG,
  economy: EconomyConfig = DEFAULT_ECONOMY_CONFIG,
): ForgeCheck<ForgeCost> {
  const base = findItemBase(item.baseId);
  if (!base) return refuse('unknown_base');
  const r = config.reroll;
  const n = Math.max(0, item.rerollCount);
  return {
    ok: true,
    value: costFor(
      base,
      item.itemLevel,
      r.gold * (1 + r.growth * n),
      r.units,
      Math.min(r.essenceCap, r.essence + r.essencePerReroll * n),
      config,
      economy,
    ),
  };
}

/**
 * Rerolls affix `index`: a new affix from `rerollOptions` (weighted), with a tier and value rolled
 * as generation does for the item's level and rarity, marked `rerolled`. The others are kept as
 * they are (improvements included); the new affix starts without improvements.
 */
export function rerollAffix(
  item: ForgeItem,
  index: number,
  classId: ClassId,
  rng: Rng,
  loot: LootConfig = DEFAULT_LOOT_CONFIG,
): ForgeCheck<RolledAffix[]> {
  const options = rerollOptions(item, index, classId, loot);
  if (!options.ok) return options;
  const { affix } = rng.weighted(options.value, (o) => o.weight);
  const rarity = loot.rarities[item.rarityId];
  const rolled = rollAffixValue(
    affix,
    item.itemLevel,
    rarity.affixLevelBonus,
    rarity.affixTierBias,
    rng,
  );
  const affixes = item.affixes.map((a) => ({ ...a }));
  affixes[index] = { ...rolled, rerolled: true };
  return { ok: true, value: affixes };
}

/** The value range of a rolled affix's tier, or null for an unknown affix or tier. */
export function affixTierRange(rolled: RolledAffix): { min: number; max: number } | null {
  const tier = findAffix(rolled.affixId)?.tiers.find((t) => t.tier === rolled.tier);
  return tier ? { min: tier.min, max: tier.max } : null;
}

/** What improving affix `index` would do: its range, the cap, the cost and the possible gain. */
export interface ImproveQuote {
  affixId: string;
  tier: number;
  value: number;
  min: number;
  max: number;
  improvements: number;
  maxImprovements: number;
  /** The value range one improvement can reach (`[low, high]`, both ≤ `max`). */
  next: { low: number; high: number };
  cost: ForgeCost;
}

function improveGain(tier: AffixTier, affix: AffixDefinition, config: ForgeActionConfig) {
  const steps = Math.round((tier.max - tier.min) / affix.step);
  const low = Math.max(1, Math.ceil(steps * config.improve.minShare - 1e-9));
  const high = Math.max(low, Math.round(steps * config.improve.maxShare));
  return { low, high };
}

export function quoteImprove(
  item: ForgeItem,
  index: number,
  config: ForgeActionConfig = DEFAULT_FORGE_ACTION_CONFIG,
  economy: EconomyConfig = DEFAULT_ECONOMY_CONFIG,
): ForgeCheck<ImproveQuote> {
  const at = affixAt(item, index);
  if (!at.ok) return at;
  const { rolled, affix, base } = at.value;
  const tier = affix.tiers.find((t) => t.tier === rolled.tier);
  if (!tier) return refuse('unknown_affix');
  const done = rolled.improvements ?? 0;
  const imp = config.improve;
  if (done >= imp.maxImprovements) return refuse('improvement_cap');
  if (rolled.value >= tier.max - 1e-9) return refuse('affix_at_max');
  const gain = improveGain(tier, affix, config);
  const reach = (k: number) =>
    roundToStep(Math.min(tier.max, rolled.value + k * affix.step), affix.step);
  return {
    ok: true,
    value: {
      affixId: affix.id,
      tier: tier.tier,
      value: rolled.value,
      min: tier.min,
      max: tier.max,
      improvements: done,
      maxImprovements: imp.maxImprovements,
      next: { low: reach(gain.low), high: reach(gain.high) },
      cost: costFor(
        base,
        item.itemLevel,
        imp.gold * (1 + done),
        imp.units * (1 + done),
        imp.essence + done,
        config,
        economy,
      ),
    },
  };
}

/**
 * Improves affix `index` by a rolled 15–35 % of its tier's range (on the step grid, at least one
 * step), never above the tier's maximum, and counts the improvement. Refused at the cap or at the
 * maximum.
 */
export function improveAffix(
  item: ForgeItem,
  index: number,
  rng: Rng,
  config: ForgeActionConfig = DEFAULT_FORGE_ACTION_CONFIG,
): ForgeCheck<RolledAffix[]> {
  const quote = quoteImprove(item, index, config);
  if (!quote.ok) return quote;
  const rolled = item.affixes[index]!;
  const affix = findAffix(rolled.affixId)!;
  const tier = affix.tiers.find((t) => t.tier === rolled.tier)!;
  const gain = improveGain(tier, affix, config);
  const k = rng.int(gain.low, gain.high);
  const value = roundToStep(Math.min(tier.max, rolled.value + k * affix.step), affix.step);
  const affixes = item.affixes.map((a) => ({ ...a }));
  affixes[index] = { ...rolled, value, improvements: (rolled.improvements ?? 0) + 1 };
  return { ok: true, value: affixes };
}

/** Unmet costs in a stable order (gold, then materials); empty = affordable. */
export type ForgeBlocker =
  | { kind: 'gold'; required: number; held: number }
  | { kind: 'material'; materialId: MaterialId; required: number; held: number };

export function forgeCostBlockers(
  cost: ForgeCost,
  gold: number,
  held: MaterialBundle,
): ForgeBlocker[] {
  const out: ForgeBlocker[] = [];
  if (gold < cost.gold) out.push({ kind: 'gold', required: cost.gold, held: gold });
  for (const [materialId, required] of Object.entries(cost.materials) as [MaterialId, number][]) {
    const have = held[materialId] ?? 0;
    if (have < required) out.push({ kind: 'material', materialId, required, held: have });
  }
  return out;
}
