import { RARITY_IDS, type RarityId } from '../rarity.js';

/**
 * Achievements (ticket 4.2, GDD §5.3 "account-bound", docs/SOCIAL.md "Achievements").
 *
 * Account-bound, cosmetic only: an achievement never grants power. Each definition is data with
 * one typed criterion; the server collects `AchievementFacts` (from the character it just changed,
 * or from history for the backfill) and awards what `achievementsEarned` returns. Awarding is
 * at-most-once per account and achievement (the server's primary key).
 *
 * Adding one: append a definition (never reuse or rename an id: awarded rows keep it), give it an
 * icon asset id for the art ticket, and make sure its fact is collected by the server's
 * `characterFacts` and backfill. The backfill re-runs on deploy when the id list changes.
 */
export type AchievementCriterion =
  /** Owned an item of this rarity or rarer. */
  | { kind: 'itemRarity'; rarity: RarityId }
  /** An item reached this upgrade level (ticket 3.4, +0…+10). */
  | { kind: 'upgradeLevel'; level: number }
  /** A character reached this level. */
  | { kind: 'characterLevel'; level: number }
  /** The Gravewarden (the crypt boss, ticket 2.5) defeated. */
  | { kind: 'gravewardenDefeated' }
  /** The Nameless Crypt cleared at this tier or deeper (ticket 3.6). */
  | { kind: 'cryptTier'; tier: number }
  /** Every piece of one item set worn at once (ticket 3.3). */
  | { kind: 'fullSet' }
  /** Contracts turned in across the account's characters (ticket 2.4). */
  | { kind: 'contracts'; count: number }
  /** A story quest turned in. */
  | { kind: 'storyQuest'; questId: string }
  /** Ticket 4.6: contributed to this community project, which then completed. */
  | { kind: 'communityProject'; projectId: string }
  /** Earned the reward of this guild boss stage or a higher one (ticket 4.9). */
  | { kind: 'guildBossStage'; stage: number };

export type AchievementCriterionKind = AchievementCriterion['kind'];

export type AchievementCategory =
  'loot' | 'forge' | 'hero' | 'crypt' | 'quests' | 'guild' | 'world';

export interface AchievementDefinition {
  id: string;
  name: string;
  /** What it takes, as the player reads it. */
  description: string;
  category: AchievementCategory;
  criterion: AchievementCriterion;
  /** Icon asset id (art ticket A.8); the client shows a placeholder sigil until it exists. */
  assetId: string;
}

export const ACHIEVEMENTS: readonly AchievementDefinition[] = [
  {
    id: 'firstEpic',
    name: 'Violet Omen',
    description: 'Find an Epic item.',
    category: 'loot',
    criterion: { kind: 'itemRarity', rarity: 'epic' },
    assetId: 'achievement.first-epic',
  },
  {
    id: 'firstLegendary',
    name: 'Ember in the Ash',
    description: 'Find a Legendary item.',
    category: 'loot',
    criterion: { kind: 'itemRarity', rarity: 'legendary' },
    assetId: 'achievement.first-legendary',
  },
  {
    id: 'firstMythic',
    name: 'Blood Relic',
    description: 'Find a Mythic item.',
    category: 'loot',
    criterion: { kind: 'itemRarity', rarity: 'mythic' },
    assetId: 'achievement.first-mythic',
  },
  {
    id: 'fullSet',
    name: 'Whole Again',
    description: 'Wear every piece of one item set at once.',
    category: 'loot',
    criterion: { kind: 'fullSet' },
    assetId: 'achievement.full-set',
  },
  {
    id: 'forgePlus5',
    name: 'Tempered',
    description: 'Upgrade an item to +5 at the forge.',
    category: 'forge',
    criterion: { kind: 'upgradeLevel', level: 5 },
    assetId: 'achievement.forge-plus-5',
  },
  {
    id: 'forgePlus10',
    name: 'Anvil-Sworn',
    description: 'Upgrade an item to +10 at the forge.',
    category: 'forge',
    criterion: { kind: 'upgradeLevel', level: 10 },
    assetId: 'achievement.forge-plus-10',
  },
  {
    id: 'level10',
    name: 'Seasoned',
    description: 'Reach level 10 with a hero.',
    category: 'hero',
    criterion: { kind: 'characterLevel', level: 10 },
    assetId: 'achievement.level-10',
  },
  {
    id: 'level20',
    name: 'Veteran of Graumark',
    description: 'Reach level 20 with a hero.',
    category: 'hero',
    criterion: { kind: 'characterLevel', level: 20 },
    assetId: 'achievement.level-20',
  },
  {
    id: 'gravewardenSlain',
    name: 'Warden Unmade',
    description: 'Defeat the Gravewarden in the Nameless Crypt.',
    category: 'crypt',
    criterion: { kind: 'gravewardenDefeated' },
    assetId: 'achievement.gravewarden-slain',
  },
  {
    id: 'cryptTier2',
    name: 'Deeper Still',
    description: 'Clear the Nameless Crypt at tier II.',
    category: 'crypt',
    criterion: { kind: 'cryptTier', tier: 2 },
    assetId: 'achievement.crypt-tier-2',
  },
  {
    id: 'cryptTier3',
    name: 'The Bottom of the Dark',
    description: 'Clear the Nameless Crypt at tier III.',
    category: 'crypt',
    criterion: { kind: 'cryptTier', tier: 3 },
    assetId: 'achievement.crypt-tier-3',
  },
  {
    id: 'storyGraumark',
    name: 'Graumark Remembers',
    description: 'Finish the Graumark story: turn in “The Nameless Crypt”.',
    category: 'quests',
    criterion: { kind: 'storyQuest', questId: 'theNamelessCrypt' },
    assetId: 'achievement.story-graumark',
  },
  {
    id: 'contracts10',
    name: 'For Hire',
    description: 'Turn in 10 contracts.',
    category: 'quests',
    criterion: { kind: 'contracts', count: 10 },
    assetId: 'achievement.contracts-10',
  },
  {
    id: 'contracts50',
    name: 'Sellsword of the Board',
    description: 'Turn in 50 contracts.',
    category: 'quests',
    criterion: { kind: 'contracts', count: 50 },
    assetId: 'achievement.contracts-50',
  },
  // Ticket 4.9: the weekly guild boss (earned with a stage's reward, docs/GUILD_BOSS.md).
  {
    id: 'guildBossFirstStage',
    name: 'Shoulder to Shoulder',
    description: 'Fight the guild boss and see your guild crack it (its first stage).',
    category: 'guild',
    criterion: { kind: 'guildBossStage', stage: 1 },
    assetId: 'achievement.guild-boss-first-stage',
  },
  {
    id: 'guildBossLaidToRest',
    name: 'Laid to Rest',
    description: 'Fight the guild boss in a week your guild breaks its last stage.',
    category: 'guild',
    criterion: { kind: 'guildBossStage', stage: 5 },
    assetId: 'achievement.guild-boss-laid-to-rest',
  },
  // Ticket 4.6: community projects (awarded to every contributor when the project completes).
  {
    id: 'warehouseRestorer',
    name: 'Mender of Graumark',
    description: 'Help restore the Graumark Warehouse.',
    category: 'world',
    criterion: { kind: 'communityProject', projectId: 'restoreWarehouse' },
    assetId: 'achievement.warehouse-restorer',
  },
  {
    id: 'ashenPassBreaker',
    name: 'Through the Ash',
    description: 'Help clear the Ashen Pass.',
    category: 'world',
    criterion: { kind: 'communityProject', projectId: 'clearAshenPass' },
    assetId: 'achievement.ashen-pass-breaker',
  },
  // Ticket 6.7: the Forgeward Outpost (icon awaiting art: the wax-seal placeholder until then).
  {
    id: 'forgewardBuilder',
    name: 'Keeper of the Forgeward',
    description: 'Help rebuild the Forgeward Outpost.',
    category: 'world',
    criterion: { kind: 'communityProject', projectId: 'forgewardOutpost' },
    assetId: 'achievement.forgeward-builder',
  },
];

export type AchievementId = string;

export const ACHIEVEMENT_IDS: readonly string[] = ACHIEVEMENTS.map((a) => a.id);

const BY_ID = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));

export function findAchievement(id: string): AchievementDefinition | undefined {
  return BY_ID.get(id);
}

export function isAchievementId(value: unknown): value is AchievementId {
  return typeof value === 'string' && BY_ID.has(value);
}

/** How many earned achievements a player may pick to show on their profile. */
export const MAX_SHOWN_ACHIEVEMENTS = 5;

/**
 * What the server knows when it checks achievements. Every field is optional: a fact that was not
 * collected (`undefined`) never earns anything, so a hook can pass only what its event changed.
 */
export interface AchievementFacts {
  /** The rarest item rarity owned (or ever owned, for the backfill). */
  maxRarity?: RarityId | null;
  maxUpgradeLevel?: number;
  maxCharacterLevel?: number;
  gravewardenDefeated?: boolean;
  /** The deepest crypt tier cleared (`cryptTierCleared`). */
  cryptTierCleared?: number;
  /** Some character wears every piece of one set. */
  fullSetWorn?: boolean;
  contractsTurnedIn?: number;
  storyQuestsTurnedIn?: readonly string[];
  /** The highest guild boss stage whose reward the account earned (ticket 4.9). */
  guildBossStage?: number;
  /** Ticket 4.6: completed community projects the account contributed to. */
  communityProjects?: readonly string[];
}

/** The fact a criterion reads (for collecting only what is needed). */
export const CRITERION_FACT: Record<AchievementCriterionKind, keyof AchievementFacts> = {
  itemRarity: 'maxRarity',
  upgradeLevel: 'maxUpgradeLevel',
  characterLevel: 'maxCharacterLevel',
  gravewardenDefeated: 'gravewardenDefeated',
  cryptTier: 'cryptTierCleared',
  fullSet: 'fullSetWorn',
  contracts: 'contractsTurnedIn',
  storyQuest: 'storyQuestsTurnedIn',
  guildBossStage: 'guildBossStage',
  communityProject: 'communityProjects',
};

export function criterionMet(c: AchievementCriterion, f: AchievementFacts): boolean {
  switch (c.kind) {
    case 'itemRarity':
      return f.maxRarity != null && RARITY_IDS.indexOf(f.maxRarity) >= RARITY_IDS.indexOf(c.rarity);
    case 'upgradeLevel':
      return (f.maxUpgradeLevel ?? 0) >= c.level;
    case 'characterLevel':
      return (f.maxCharacterLevel ?? 0) >= c.level;
    case 'gravewardenDefeated':
      return f.gravewardenDefeated === true;
    case 'cryptTier':
      return (f.cryptTierCleared ?? 0) >= c.tier;
    case 'fullSet':
      return f.fullSetWorn === true;
    case 'contracts':
      return (f.contractsTurnedIn ?? 0) >= c.count;
    case 'storyQuest':
      return f.storyQuestsTurnedIn?.includes(c.questId) ?? false;
    case 'guildBossStage':
      return (f.guildBossStage ?? 0) >= c.stage;
    case 'communityProject':
      return f.communityProjects?.includes(c.projectId) ?? false;
  }
}

/** The achievement ids these facts earn, in definition order. Pure; the server dedupes. */
export function achievementsEarned(facts: AchievementFacts): string[] {
  return ACHIEVEMENTS.filter((a) => criterionMet(a.criterion, facts)).map((a) => a.id);
}

/** Merges two fact sets, keeping the stronger value of each field. */
export function mergeAchievementFacts(a: AchievementFacts, b: AchievementFacts): AchievementFacts {
  const max = (x?: number, y?: number) =>
    x === undefined ? y : y === undefined ? x : Math.max(x, y);
  const rarer = (x?: RarityId | null, y?: RarityId | null) =>
    x == null ? y : y == null ? x : RARITY_IDS.indexOf(x) >= RARITY_IDS.indexOf(y) ? x : y;
  const or = (x?: boolean, y?: boolean) =>
    x === undefined && y === undefined ? undefined : !!x || !!y;
  const out: AchievementFacts = {};
  const set = <K extends keyof AchievementFacts>(k: K, v: AchievementFacts[K] | undefined) => {
    if (v !== undefined) out[k] = v;
  };
  set('maxRarity', rarer(a.maxRarity, b.maxRarity));
  set('maxUpgradeLevel', max(a.maxUpgradeLevel, b.maxUpgradeLevel));
  set('maxCharacterLevel', max(a.maxCharacterLevel, b.maxCharacterLevel));
  set('gravewardenDefeated', or(a.gravewardenDefeated, b.gravewardenDefeated));
  set('cryptTierCleared', max(a.cryptTierCleared, b.cryptTierCleared));
  set('fullSetWorn', or(a.fullSetWorn, b.fullSetWorn));
  set('contractsTurnedIn', max(a.contractsTurnedIn, b.contractsTurnedIn));
  set('guildBossStage', max(a.guildBossStage, b.guildBossStage));
  if (a.storyQuestsTurnedIn || b.storyQuestsTurnedIn) {
    set('storyQuestsTurnedIn', [
      ...new Set([...(a.storyQuestsTurnedIn ?? []), ...(b.storyQuestsTurnedIn ?? [])]),
    ]);
  }
  if (a.communityProjects || b.communityProjects) {
    set('communityProjects', [
      ...new Set([...(a.communityProjects ?? []), ...(b.communityProjects ?? [])]),
    ]);
  }
  return out;
}
