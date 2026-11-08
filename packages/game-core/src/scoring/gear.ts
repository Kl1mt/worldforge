import type { ClassId } from '../classes.js';
import { RARITIES, type RarityId } from '../rarity.js';
import { EQUIPMENT_SLOTS, type EquipmentSlotId } from '../slots.js';
import { ITEM_BASES, canClassUseItem, findItemBase } from '../items/bases.js';
import { activeVariant } from '../items/variants.js';
import { findAffix } from '../items/affixes.js';
import { checkEquipment, type ItemRejection, type ScoredItem } from './equipment.js';
import { FORMULA_VERSIONS, type Score, type ScoreLine } from './types.js';

/**
 * Gear Score (ticket 5.1, docs/LEADERBOARDS.md): the quality of what the hero wears, and nothing
 * else (GDD §10.2: not the build's strength; that is Character Power). Per equipped item:
 *
 *   points = itemLevel × 10 × rarity weight × (1 + upgrade × 4 %) × (Void ? 1.1 : 1) × hands
 *
 * rounded per item and summed. `hands` is 2 for the weapon of a class that cannot use an
 * off-hand (its weapon takes both hands), else 1, so every class can reach the same total. An
 * item that fails `checkEquipment` (forged, invalid, in the wrong slot) counts 0. Every factor
 * grows with the item, so a strictly better item never lowers the score.
 */
export interface GearScoreWeights {
  perItemLevel: number;
  rarity: Readonly<Record<RarityId, number>>;
  perUpgradeLevel: number;
  variant: Readonly<Record<string, number>>;
}

export const GEAR_SCORE_WEIGHTS: Readonly<GearScoreWeights> = {
  perItemLevel: 10,
  rarity: { common: 1, uncommon: 1.15, rare: 1.3, epic: 1.5, legendary: 1.75, mythic: 2 },
  perUpgradeLevel: 0.04,
  variant: { void: 1.1 },
};

/**
 * Ticket B.4, Gear Score version 2: the **magic quality** of a kit, the tie-breaker between equal
 * scores. Every affix of a counted item scores 0–100: how far up its affix's tiers it rolled
 * (`100 × (tier − 1 + position within the tier's range) ÷ number of tiers`, so the best roll of
 * the top tier is 100 and every affix has the same scale), counted twice on a two-handed weapon
 * like the item. The total does not change the score's value: it orders heroes whose items are
 * equally good by item level, rarity, upgrades and Void (on a realistic season, about one in ten
 * heroes reaches the ceiling of the best kit by the fourth week and all of them tied; the
 * Forge's rerolls and improvements now move them, docs/LEADERBOARDS.md "Balance pass").
 */
export function affixQuality(affix: { affixId: string; tier: number; value: number }): number {
  const def = findAffix(affix.affixId);
  const band = def?.tiers.find((t) => t.tier === affix.tier);
  if (!def || !band || def.tiers.length === 0) return 0;
  const span = band.max - band.min;
  const position = span > 0 ? Math.min(1, Math.max(0, (affix.value - band.min) / span)) : 1;
  return Math.round((100 * (affix.tier - 1 + position)) / def.tiers.length);
}

/** Whether a class can use any off-hand base (only the warrior's shields today). */
export function classUsesOffhand(classId: ClassId): boolean {
  return ITEM_BASES.some((b) => b.slot === 'offhand' && canClassUseItem(b, classId));
}

/** How many hands an item in this slot stands for (the two-handed rule above). */
export function slotHands(classId: ClassId, slot: EquipmentSlotId): number {
  return slot === 'weapon' && !classUsesOffhand(classId) ? 2 : 1;
}

export interface GearItemScore {
  points: number;
  itemLevel: number;
  rarityWeight: number;
  upgradeFactor: number;
  variantFactor: number;
  hands: number;
}

/** The points of one valid item (no checks: use `gearScore`, which checks first). */
export function gearItemPoints(
  item: Pick<ScoredItem, 'itemLevel' | 'rarityId' | 'upgradeLevel' | 'variant'>,
  hands = 1,
  weights: GearScoreWeights = GEAR_SCORE_WEIGHTS,
): GearItemScore {
  const rarityWeight = weights.rarity[item.rarityId];
  const upgradeFactor = 1 + weights.perUpgradeLevel * (item.upgradeLevel ?? 0);
  const variant = activeVariant(item);
  const variantFactor = variant ? (weights.variant[variant.id] ?? 1) : 1;
  const points = Math.round(
    item.itemLevel * weights.perItemLevel * rarityWeight * upgradeFactor * variantFactor * hands,
  );
  return { points, itemLevel: item.itemLevel, rarityWeight, upgradeFactor, variantFactor, hands };
}

const REJECTION_TEXT: Record<ItemRejection, string> = {
  invalid_item: 'Does not count: this item failed the server’s item check.',
  invalid_upgrade: 'Does not count: its upgrade level is not valid.',
  wrong_slot: 'Does not count: it does not fit this slot or class.',
  duplicate_slot: 'Does not count: more than one item in this slot.',
};

const rarityName = (id: RarityId) => RARITIES.find((r) => r.id === id)?.name ?? id;

export function gearScore(classId: ClassId, equipment: readonly ScoredItem[]): Score {
  const checked = checkEquipment(classId, equipment);
  const lines: ScoreLine[] = [];
  let total = 0;
  let quality = 0;
  for (const c of checked) {
    const base = findItemBase(c.item.baseId);
    const label = base?.name ?? 'Unknown item';
    if (!c.equipped || !c.slot) {
      lines.push({
        id: c.item.slot,
        label,
        detail: REJECTION_TEXT[c.rejection!],
        points: 0,
        counted: false,
        reason: c.rejection!,
      });
      continue;
    }
    const s = gearItemPoints(c.equipped, slotHands(classId, c.slot));
    const parts = [`Item level ${s.itemLevel}`, rarityName(c.equipped.rarityId)];
    if (c.equipped.upgradeLevel) parts.push(`+${c.equipped.upgradeLevel}`);
    if (s.variantFactor !== 1) parts.push('Void');
    if (s.hands === 2) parts.push('both hands');
    const magic = c.equipped.affixes.reduce((sum, a) => sum + affixQuality(a), 0) * s.hands;
    if (c.equipped.affixes.length > 0) parts.push(`magic quality ${magic}`);
    lines.push({ id: c.slot, label, detail: parts.join(' · '), points: s.points, counted: true });
    total += s.points;
    quality += magic;
  }
  const order = (id: string) => EQUIPMENT_SLOTS.findIndex((s) => s.id === id);
  lines.sort((a, b) => order(a.id) - order(b.id));
  return {
    metric: 'gearScore',
    formulaVersion: FORMULA_VERSIONS.gearScore,
    value: total,
    // Version 2 (B.4): equal scores are ordered by the kit's magic quality.
    sortKey: [total, quality],
    summary: `The quality of your equipped items: item level, rarity, upgrades and Void. Not how well they work together; that is Character Power. Between equal scores, the better-rolled magic properties rank higher (magic quality ${quality}).`,
    lines,
  };
}
