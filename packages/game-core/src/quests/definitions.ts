import type { ItemSlotKind } from '../items/bases.js';
import type { RarityId } from '../rarity.js';
import { AREAS, type AreaId } from '../world/areas.js';
import type { MaterialId } from '../world/materials.js';
import type { QuestObjective } from './objectives.js';

/** A fixed item a quest awards; rolled with a server seed at turn-in. */
export interface QuestItemReward {
  baseId: string;
  rarityId: RarityId;
  itemLevel: number;
}

/**
 * Ticket 3.6: an item for a slot the player chose when accepting (Abbey contracts). The base is
 * picked at turn-in among the table's bases of that slot the class can use, from the seed stored
 * at acceptance (`seed`; older rows: `targetedRewardSeed`).
 */
export interface QuestTargetedItemReward {
  slot: ItemSlotKind;
  rarityId: RarityId;
  itemLevel: number;
  /** Loot table whose bases (and affix tier bias) the item comes from. */
  lootTableId: string;
  /**
   * Ticket 3.9: the item's seed, drawn server-side at acceptance and stored with the quest row.
   * Server-only: client views strip it, so the reward can't be computed before it is granted.
   * Rows accepted before 3.9 have none and fall back to `targetedRewardSeed(questRowId)`.
   */
  seed?: number;
}

/** What turning a quest in grants. */
export interface QuestReward {
  xp: number;
  gold: number;
  materials: Partial<Record<MaterialId, number>>;
  item: QuestItemReward | QuestTargetedItemReward | null;
}

export function isTargetedItemReward(item: QuestReward['item']): item is QuestTargetedItemReward {
  return item !== null && 'slot' in item;
}

export const STORY_QUEST_IDS = [
  'furrowsOfTheDead',
  'wolvesAtTheFence',
  'theCrowwoodRoad',
  'whatTheCrowsGuard',
  'theNamelessCrypt',
] as const;

export type StoryQuestId = (typeof STORY_QUEST_IDS)[number];

/** A quest of the Graumark story chain (GDD §11.1). Each can be completed once per character. */
export interface StoryQuestDefinition {
  id: StoryQuestId;
  name: string;
  /** Who posts it on the notice board. */
  giver: string;
  /** The notice text. */
  description: string;
  /** Minimum character level to accept it. */
  level: number;
  /** Quest that must be turned in first (the chain order). */
  after: StoryQuestId | null;
  objectives: readonly QuestObjective[];
  reward: QuestReward;
}

/**
 * The Graumark story chain: from the fields to the crypt (rewards rescaled in ticket B.1). XP
 * rewards are a fraction of a level at the quest's level (`xpToNextLevel`: 700 · level², ticket B.1).
 */
export const STORY_QUESTS: readonly StoryQuestDefinition[] = [
  {
    id: 'furrowsOfTheDead',
    name: 'The Furrows of the Dead',
    giver: 'Old Reeve Hadric',
    description:
      'The farmhands I buried last winter are back in the fields, still swinging their scythes. Put them down again — gently, if you can.',
    level: 1,
    after: null,
    objectives: [{ kind: 'kill', enemyId: 'risenFarmhand', count: 12 }],
    reward: { xp: 600, gold: 40, materials: {}, item: null },
  },
  {
    id: 'wolvesAtTheFence',
    name: 'Wolves at the Fence',
    giver: 'Old Reeve Hadric',
    description:
      'Carrion wolves follow the dead like gulls follow a plough. Thin the pack and bring timber to mend the palisade.',
    level: 2,
    after: 'furrowsOfTheDead',
    objectives: [
      { kind: 'kill', enemyId: 'carrionWolf', count: 10 },
      { kind: 'gather', materialId: 'timber', count: 15 },
    ],
    reward: { xp: 1800, gold: 70, materials: { ashwort: 5 }, item: null },
  },
  {
    id: 'theCrowwoodRoad',
    name: 'The Crowwood Road',
    giver: 'Captain Ysolde of the Watch',
    description:
      'No wagon has come through Crowwood in a month. Find the cutthroats who hold the road and break their camp.',
    level: 5,
    after: 'wolvesAtTheFence',
    objectives: [
      { kind: 'reach', areaId: 'crowwood' },
      { kind: 'kill', enemyId: 'banditCutthroat', count: 15 },
    ],
    reward: { xp: 10000, gold: 160, materials: { rawHide: 6 }, item: null },
  },
  {
    id: 'whatTheCrowsGuard',
    name: 'What the Crows Guard',
    giver: 'Sister Maud, gravekeeper',
    description:
      'The bandits were paid in grave-gold. Someone is emptying the Old Burial Grounds. Walk among the stones and bring me what the dead leave behind.',
    level: 9,
    after: 'theCrowwoodRoad',
    objectives: [
      { kind: 'reach', areaId: 'oldBurialGrounds' },
      { kind: 'kill', enemyId: 'risenSkeleton', count: 15 },
      { kind: 'gather', materialId: 'soulShard', count: 8 },
    ],
    reward: {
      xp: 30000,
      gold: 320,
      materials: {},
      item: { baseId: 'grave-gold-ring', rarityId: 'rare', itemLevel: 11 },
    },
  },
  {
    id: 'theNamelessCrypt',
    name: 'The Nameless Crypt',
    giver: 'Sister Maud, gravekeeper',
    description:
      'The shards all hum toward the same hill. Below it lies a crypt no map names, and a warden that will not let its dead rest. End it.',
    level: 12,
    after: 'whatTheCrowsGuard',
    objectives: [{ kind: 'defeatBoss', bossId: 'gravewarden' }],
    reward: {
      xp: 60000,
      gold: 900,
      materials: { soulShard: 10 },
      item: { baseId: 'raven-talisman', rarityId: 'epic', itemLevel: 16 },
    },
  },
];

const STORY_BY_ID = new Map(STORY_QUESTS.map((q) => [q.id, q]));

export function isStoryQuestId(value: unknown): value is StoryQuestId {
  return typeof value === 'string' && (STORY_QUEST_IDS as readonly string[]).includes(value);
}

export function getStoryQuest(id: StoryQuestId): StoryQuestDefinition {
  const def = STORY_BY_ID.get(id);
  if (!def) throw new Error(`Unknown story quest: ${id}`);
  return def;
}

/** A repeatable contract posted on the notice board (GDD §6.4). */
export interface ContractTemplate {
  /** Stable id, e.g. `slay.risenFarmhand` or `gather.timber`. */
  id: string;
  /** The area the contract sends the hero to (its unlock gates the contract). */
  areaId: AreaId;
  objective: QuestObjective;
  /** Reward multiplier (1 = a standard contract). */
  rewardScale: number;
}

/** Kills per contract. */
export const CONTRACT_KILLS = 25;
/** Units per gathering contract, by material (rarer materials need fewer). */
const CONTRACT_GATHER: Partial<Record<MaterialId, number>> = {
  timber: 20,
  ashwort: 20,
  rawHide: 20,
  ironOre: 20,
  soulShard: 10,
  abbeySilver: 3,
};

/**
 * Contract templates, derived from the area content: one kill contract per area enemy and one
 * gathering contract per material, at the first area that yields it.
 */
export const CONTRACT_TEMPLATES: readonly ContractTemplate[] = (() => {
  const templates: ContractTemplate[] = [];
  const seenMaterials = new Set<MaterialId>();
  for (const area of AREAS) {
    for (const { enemyId } of area.enemies) {
      templates.push({
        id: `slay.${enemyId}`,
        areaId: area.id,
        objective: { kind: 'kill', enemyId, count: CONTRACT_KILLS },
        rewardScale: 1,
      });
    }
    for (const materialId of area.materials) {
      const count = CONTRACT_GATHER[materialId];
      if (count === undefined || seenMaterials.has(materialId)) continue;
      seenMaterials.add(materialId);
      templates.push({
        id: `gather.${materialId}`,
        areaId: area.id,
        objective: { kind: 'gather', materialId, count },
        rewardScale: materialId === 'abbeySilver' ? 1.5 : 1,
      });
    }
  }
  return templates;
})();

const CONTRACTS_BY_ID = new Map(CONTRACT_TEMPLATES.map((t) => [t.id, t]));

export function findContractTemplate(id: string): ContractTemplate | undefined {
  return CONTRACTS_BY_ID.get(id);
}
