import { isRarityId } from '../rarity.js';
import { affixPossibleOn, findAffix, tierUnlocked } from '../items/affixes.js';
import { findItemBase, type ItemBaseDefinition } from '../items/bases.js';
import { findMythic, mythicForBase } from '../items/mythics.js';
import { findSet, setForBase } from '../items/sets.js';
import { findItemVariant } from '../items/variants.js';
import { awakeningErrors } from '../items/awakening.js';
import { findEffect } from '../effects/registry.js';
import { EFFECT_ROLL_STEPS, legendaryEffectPossibleOn } from '../effects/resolve.js';
import { DEFAULT_LOOT_CONFIG, type LootConfig } from './config.js';
import { affixCountFor, type GeneratedItem } from './generate.js';

const EPSILON = 1e-9;

/**
 * Checks that an item could have been produced by the generator under `config`
 * (valid base, rarity, item level, affix count, affixes allowed for the slot, content tier and
 * some class that can use the base, tier unlocked at the item level plus the rarity's
 * `affixLevelBonus`, value in range and on the step grid). Returns a list of
 * problems; an empty list means the item is valid. Use it on anything not freshly rolled.
 */
export function validateItem(
  item: GeneratedItem,
  config: LootConfig = DEFAULT_LOOT_CONFIG,
): string[] {
  const errors: string[] = [];
  const base = findItemBase(item.baseId);
  if (!base) errors.push(`unknown base ${item.baseId}`);
  if (!isRarityId(item.rarityId)) errors.push(`unknown rarity ${String(item.rarityId)}`);
  if (!Number.isInteger(item.seed) || item.seed < 0 || item.seed > 0xffffffff) {
    errors.push(`invalid seed ${item.seed}`);
  }
  if (
    !Number.isInteger(item.itemLevel) ||
    item.itemLevel < 1 ||
    item.itemLevel > config.maxItemLevel
  ) {
    errors.push(`invalid item level ${item.itemLevel}`);
  } else if (base && item.itemLevel < base.minItemLevel) {
    errors.push(`item level ${item.itemLevel} below ${base.id} minimum ${base.minItemLevel}`);
  }
  if (!base || !isRarityId(item.rarityId)) return errors;

  const expected = affixCountFor(base, item.rarityId, config);
  if (item.affixes.length !== expected) {
    errors.push(`expected ${expected} affixes for ${item.rarityId}, got ${item.affixes.length}`);
  }

  const seen = new Set<string>();
  for (const rolled of item.affixes) {
    const affix = findAffix(rolled.affixId);
    if (!affix) {
      errors.push(`unknown affix ${rolled.affixId}`);
      continue;
    }
    if (seen.has(affix.id)) errors.push(`duplicate affix ${affix.id}`);
    seen.add(affix.id);
    if (!affix.slots.includes(base.slot)) {
      errors.push(`affix ${affix.id} not allowed on ${base.slot}`);
    } else if (!affixPossibleOn(affix, base)) {
      errors.push(`affix ${affix.id} not allowed on ${base.id} (class or content tier)`);
    }
    const tier = affix.tiers.find((t) => t.tier === rolled.tier);
    if (!tier) {
      errors.push(`affix ${affix.id} has no tier ${rolled.tier}`);
      continue;
    }
    const levelBonus = config.rarities[item.rarityId].affixLevelBonus;
    if (!tierUnlocked(tier, item.itemLevel, levelBonus)) {
      errors.push(`affix ${affix.id} tier ${tier.tier} needs item level ${tier.minItemLevel}`);
    }
    if (
      rolled.improvements !== undefined &&
      (!Number.isInteger(rolled.improvements) || rolled.improvements < 0)
    ) {
      errors.push(`affix ${affix.id} has invalid improvements ${rolled.improvements}`);
    }
    const v = rolled.value;
    const offGrid = Math.abs((v - tier.min) / affix.step - Math.round((v - tier.min) / affix.step));
    if (!Number.isFinite(v) || v < tier.min - EPSILON || v > tier.max + EPSILON || offGrid > 1e-6) {
      errors.push(
        `affix ${affix.id} value ${v} outside tier ${tier.tier} [${tier.min}, ${tier.max}]`,
      );
    }
  }
  errors.push(...variantErrors(item));
  // Ticket 6.5b: an awakening must be the shipped one, on an eligible item.
  errors.push(...awakeningErrors(item));
  errors.push(...setErrors(item, base));
  if (item.setId !== undefined) return errors;
  errors.push(...effectErrors(item, base));
  return errors;
}

/** Tickets 3.5, 6.4: a variant must be known and allowed on the item's rarity (Void, Prismatic: Legendary, Mythic). */
function variantErrors(item: GeneratedItem): string[] {
  const id: unknown = item.variant;
  if (id === undefined || id === null) return [];
  const variant = findItemVariant(id);
  if (!variant) return [`unknown variant ${String(id)}`];
  return variant.rarities.includes(item.rarityId)
    ? []
    : [`variant ${variant.id} on a ${item.rarityId} item`];
}

/**
 * Ticket 3.3: a set base must carry its set, and a set piece is a Legendary on one of its set's
 * bases, without an effect of its own. (Void, ticket 3.5, is a column of its own and changes none
 * of this: a Void piece is the same piece.)
 */
function setErrors(item: GeneratedItem, base: ItemBaseDefinition): string[] {
  const errors: string[] = [];
  const baseSet = setForBase(base.id);
  if (item.setId === undefined) {
    if (baseSet) errors.push(`set base ${base.id} without its set ${baseSet.id}`);
    return errors;
  }
  const set = findSet(item.setId);
  if (!set) return [`unknown set ${item.setId}`];
  if (!set.pieces.includes(base.id)) errors.push(`set ${set.id} has no piece ${base.id}`);
  if (item.rarityId !== 'legendary') errors.push(`set piece ${base.id} is ${item.rarityId}`);
  if (item.effectId !== undefined || item.effectRoll !== undefined || item.mythicId !== undefined) {
    errors.push(`set piece ${base.id} carries an effect`);
  }
  return errors;
}

/**
 * Ticket 3.2: a Legendary's effect must be a Legendary effect possible on its base with a roll on
 * the grid; a Mythic base must carry its named Mythic and signature. Legendaries and Mythics from
 * before 3.2 have no effect and stay valid (stat-only).
 */
function effectErrors(item: GeneratedItem, base: ItemBaseDefinition): string[] {
  const errors: string[] = [];
  const mythic = item.mythicId !== undefined ? findMythic(item.mythicId) : undefined;
  const baseMythic = mythicForBase(base.id);
  if (item.mythicId !== undefined && !mythic) errors.push(`unknown mythic ${item.mythicId}`);
  if (baseMythic && item.mythicId !== baseMythic.id) {
    errors.push(`mythic base ${base.id} without its mythic ${baseMythic.id}`);
  }
  if (mythic) {
    if (item.rarityId !== 'mythic') errors.push(`mythic ${mythic.id} is ${item.rarityId}`);
    if (mythic.baseId !== base.id) errors.push(`mythic ${mythic.id} on base ${base.id}`);
    if (item.effectId !== mythic.effectId) {
      errors.push(`mythic ${mythic.id} needs effect ${mythic.effectId}`);
    }
    if (item.effectRoll !== undefined) errors.push(`mythic ${mythic.id} has an effect roll`);
    return errors;
  }
  if (item.effectId === undefined) {
    if (item.effectRoll !== undefined) errors.push('effect roll without an effect');
    return errors;
  }
  const effect = findEffect(item.effectId);
  if (!effect) return [...errors, `unknown effect ${item.effectId}`];
  if (item.rarityId !== 'legendary') errors.push(`effect ${effect.id} on a ${item.rarityId} item`);
  if (!legendaryEffectPossibleOn(effect, base)) {
    errors.push(`effect ${effect.id} not allowed on ${base.id}`);
  }
  const roll = item.effectRoll;
  if (
    roll === undefined ||
    !Number.isFinite(roll) ||
    roll < 0 ||
    roll > 1 ||
    Math.abs(roll * EFFECT_ROLL_STEPS - Math.round(roll * EFFECT_ROLL_STEPS)) > 1e-6
  ) {
    errors.push(`effect ${effect.id} has invalid roll ${String(roll)}`);
  }
  return errors;
}
