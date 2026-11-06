import {
  getArea,
  getEnemy,
  getMaterial,
  getStoryQuest,
  isStoryQuestId,
  type MaterialId,
  type QuestObjective,
  type QuestReward,
  type StoryBlocker,
} from '@worldforge/game-core';
import { findItemBase, isTargetedItemReward } from '@worldforge/game-core';
import { slotName } from '../game/items';
import { formatNumber } from '../lib/format';

/** The objective as a line on a notice, e.g. "Slay 12 Risen Farmhands". */
export function objectiveLabel(o: QuestObjective): string {
  switch (o.kind) {
    case 'kill': {
      const name = getEnemy(o.enemyId).name;
      return `Slay ${formatNumber(o.count)} ${o.count === 1 ? name : plural(name)}`;
    }
    case 'gather':
      return `Gather ${formatNumber(o.count)} ${getMaterial(o.materialId).name}`;
    case 'reach':
      return `Fight in ${getArea(o.areaId).name}`;
    case 'defeatBoss':
      return `Defeat ${getEnemy(o.bossId).name}`;
  }
}

export function objectiveTarget(o: QuestObjective): number {
  return o.kind === 'kill' || o.kind === 'gather' ? o.count : 1;
}

function plural(name: string): string {
  if (/[^aeiou]y$/i.test(name)) return `${name.slice(0, -1)}ies`;
  if (/(s|x|ch|sh)$/i.test(name)) return `${name}es`;
  if (/[^f]f$/i.test(name)) return `${name.slice(0, -1)}ves`;
  return `${name}s`;
}

/** Display name of an accepted quest or contract. */
export function questTitle(
  kind: 'story' | 'contract',
  questId: string,
  objective?: QuestObjective,
): string {
  if (kind === 'story' && isStoryQuestId(questId)) return getStoryQuest(questId).name;
  if (objective) return contractTitle(objective);
  return 'Contract';
}

/** A contract's heading from its objective. */
export function contractTitle(o: QuestObjective): string {
  switch (o.kind) {
    case 'kill':
      return `Bounty: ${getEnemy(o.enemyId).name}`;
    case 'gather':
      return `Wanted: ${getMaterial(o.materialId).name}`;
    default:
      return 'Contract';
  }
}

/** Reward parts in display order, e.g. ["120 XP", "40 gold", "5 Ashwort", "Rare Grave-Gold Ring"]. */
export function rewardParts(r: QuestReward): string[] {
  const parts = [`${formatNumber(r.xp)} XP`, `${formatNumber(r.gold)} gold`];
  for (const [id, n] of Object.entries(r.materials) as [MaterialId, number][]) {
    if (n > 0) parts.push(`${formatNumber(n)} ${getMaterial(id).name}`);
  }
  if (r.item) {
    const rarity = r.item.rarityId[0]!.toUpperCase() + r.item.rarityId.slice(1);
    if (isTargetedItemReward(r.item)) {
      // Ticket 3.6: the slot chosen when the contract was taken.
      parts.push(`${rarity} ${slotName(r.item.slot).toLowerCase()} (lv ${r.item.itemLevel})`);
    } else {
      const base = findItemBase(r.item.baseId);
      parts.push(`${rarity} ${base?.name ?? 'item'}`);
    }
  }
  return parts;
}

/** Why a story notice cannot be taken yet. */
export function storyBlockerText(b: StoryBlocker): string {
  return b.kind === 'level'
    ? `Reach level ${b.required}`
    : `First finish “${getStoryQuest(b.questId).name}”`;
}
