import { isRarityId } from '../rarity.js';
import { findAffix } from '../items/affixes.js';
import { findItemBase } from '../items/bases.js';
import { DEFAULT_LOOT_CONFIG, type LootConfig } from './config.js';
import { affixCountFor, type GeneratedItem } from './generate.js';

const EPSILON = 1e-9;

/**
 * Checks that an item could have been produced by the generator under `config`
 * (valid base, rarity, item level, affix count, affixes allowed for the slot, tier
 * unlocked at the item level, value in range and on the step grid). Returns a list of
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
    }
    const tier = affix.tiers.find((t) => t.tier === rolled.tier);
    if (!tier) {
      errors.push(`affix ${affix.id} has no tier ${rolled.tier}`);
      continue;
    }
    if (tier.minItemLevel > item.itemLevel) {
      errors.push(`affix ${affix.id} tier ${tier.tier} needs item level ${tier.minItemLevel}`);
    }
    const v = rolled.value;
    const offGrid = Math.abs((v - tier.min) / affix.step - Math.round((v - tier.min) / affix.step));
    if (!Number.isFinite(v) || v < tier.min - EPSILON || v > tier.max + EPSILON || offGrid > 1e-6) {
      errors.push(
        `affix ${affix.id} value ${v} outside tier ${tier.tier} [${tier.min}, ${tier.max}]`,
      );
    }
  }
  return errors;
}
