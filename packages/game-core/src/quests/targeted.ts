import { canClassUseItem, ITEM_SLOT_KINDS, type ItemSlotKind } from '../items/bases.js';
import type { ClassId } from '../classes.js';
import { getLootTable } from '../loot/config.js';
import { eligibleBases, generateItem, type GeneratedItem } from '../loot/generate.js';
import type { RarityId } from '../rarity.js';
import { createRng } from '../rng.js';
import type { ContractTemplate, QuestTargetedItemReward } from './definitions.js';

/**
 * Targeted contract rewards (ticket 3.6, docs/QUESTS.md). Abbey contracts let the player choose
 * the slot of a reward item when accepting, so they can plan toward a build instead of farming
 * blind. The item is an Epic of the contract's level from the Abbey's bases.
 */
export const TARGETED_CONTRACT_REWARD: {
  areaIds: readonly string[];
  rarityId: RarityId;
  lootTableId: string;
} = {
  areaIds: ['sunkenAbbey'],
  rarityId: 'epic',
  lootTableId: 'sunkenAbbey',
};

/** Whether a contract offers a choice of reward slot. */
export function offersRewardSlot(template: Pick<ContractTemplate, 'areaId'>): boolean {
  return TARGETED_CONTRACT_REWARD.areaIds.includes(template.areaId);
}

/** The reward item's level: the character's level, clamped to the table's item levels. */
export function targetedRewardItemLevel(level: number): number {
  const range = getLootTable(TARGETED_CONTRACT_REWARD.lootTableId).itemLevel;
  return range ? Math.min(range.max, Math.max(range.min, level)) : level;
}

/** Bases a targeted reward for this slot, class and level can be. */
function targetedBases(
  lootTableId: string,
  slot: ItemSlotKind,
  itemLevel: number,
  classId: ClassId,
) {
  return eligibleBases(getLootTable(lootTableId), itemLevel).filter(
    (c) => c.base.slot === slot && !c.base.unique && canClassUseItem(c.base, classId),
  );
}

/** The slots a character can choose for a targeted reward at its level (stable order). */
export function targetedRewardSlots(classId: ClassId, level: number): ItemSlotKind[] {
  const itemLevel = targetedRewardItemLevel(level);
  return ITEM_SLOT_KINDS.filter(
    (slot) =>
      targetedBases(TARGETED_CONTRACT_REWARD.lootTableId, slot, itemLevel, classId).length > 0,
  );
}

/** The reward item a targeted contract accepted with `slot` at `level` grants. */
export function targetedItemReward(slot: ItemSlotKind, level: number): QuestTargetedItemReward {
  return {
    slot,
    rarityId: TARGETED_CONTRACT_REWARD.rarityId,
    itemLevel: targetedRewardItemLevel(level),
    lootTableId: TARGETED_CONTRACT_REWARD.lootTableId,
  };
}

/**
 * The legacy seed of a targeted reward (ticket 3.6): derived from the quest row id. The row id is
 * client-visible and this derivation is public, so a player could compute the reward item before
 * turning the contract in. Since ticket 3.9 the server stores a random seed with the reward at
 * acceptance (`QuestTargetedItemReward.seed`); this remains only for rows accepted before that.
 */
export function targetedRewardSeed(questRowId: string): number {
  return createRng(`contract-reward:${questRowId}`).int(0, 0xffffffff);
}

/**
 * Generates a targeted reward item: a base of the chosen slot the class can use (weighted like the
 * table), then the item from its own seed, with the table's affix tier bias. Deterministic in the
 * seed. Null if no base fits (never for a slot from `targetedRewardSlots`).
 */
export function generateTargetedItem(
  reward: QuestTargetedItemReward,
  seed: number,
  classId: ClassId,
): GeneratedItem | null {
  const bases = targetedBases(reward.lootTableId, reward.slot, reward.itemLevel, classId);
  if (bases.length === 0) return null;
  const rng = createRng(seed >>> 0);
  const base = rng.weighted(bases, (b) => b.weight).base;
  return generateItem({
    seed: rng.int(0, 0xffffffff),
    itemLevel: reward.itemLevel,
    baseId: base.id,
    rarityId: reward.rarityId,
    lootTable: getLootTable(reward.lootTableId),
    classId,
  });
}
