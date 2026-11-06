import { describe, expect, it } from 'vitest';
import { RARITY_IDS } from '../rarity.js';
import { STORY_QUESTS } from '../quests/index.js';
import { DUNGEON_TIERS } from '../world/index.js';
import {
  ACHIEVEMENTS,
  CRITERION_FACT,
  MAX_SHOWN_ACHIEVEMENTS,
  achievementsEarned,
  findAchievement,
  isAchievementId,
  mergeAchievementFacts,
} from './definitions.js';

describe('achievement content', () => {
  it('has unique ids, names and asset ids, and valid criteria', () => {
    const ids = ACHIEVEMENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ACHIEVEMENTS.map((a) => a.name)).size).toBe(ids.length);
    expect(new Set(ACHIEVEMENTS.map((a) => a.assetId)).size).toBe(ids.length);
    for (const a of ACHIEVEMENTS) {
      expect(a.id).toMatch(/^[a-z][A-Za-z0-9]*$/);
      expect(a.assetId).toMatch(/^achievement\.[a-z0-9-]+$/);
      expect(a.description.length).toBeGreaterThan(0);
      const c = a.criterion;
      if (c.kind === 'itemRarity') expect(RARITY_IDS).toContain(c.rarity);
      if (c.kind === 'upgradeLevel') expect(c.level).toBeGreaterThanOrEqual(1);
      if (c.kind === 'upgradeLevel') expect(c.level).toBeLessThanOrEqual(10);
      if (c.kind === 'cryptTier') expect(DUNGEON_TIERS).toContain(c.tier);
      if (c.kind === 'storyQuest') expect(STORY_QUESTS.map((q) => q.id)).toContain(c.questId);
      expect(CRITERION_FACT[c.kind]).toBeDefined();
    }
    expect(MAX_SHOWN_ACHIEVEMENTS).toBeGreaterThanOrEqual(3);
    expect(isAchievementId('firstLegendary')).toBe(true);
    expect(isAchievementId('nope')).toBe(false);
    expect(findAchievement('cryptTier3')?.criterion).toEqual({ kind: 'cryptTier', tier: 3 });
  });
});

describe('achievementsEarned', () => {
  it('earns nothing from no facts', () => {
    expect(achievementsEarned({})).toEqual([]);
    expect(achievementsEarned({ maxRarity: null, maxUpgradeLevel: 0 })).toEqual([]);
  });

  it('counts a rarer item for the lesser rarity achievements', () => {
    expect(achievementsEarned({ maxRarity: 'rare' })).toEqual([]);
    expect(achievementsEarned({ maxRarity: 'epic' })).toEqual(['firstEpic']);
    expect(achievementsEarned({ maxRarity: 'legendary' })).toEqual(['firstEpic', 'firstLegendary']);
    expect(achievementsEarned({ maxRarity: 'mythic' })).toEqual([
      'firstEpic',
      'firstLegendary',
      'firstMythic',
    ]);
  });

  it('applies each threshold at the boundary', () => {
    expect(achievementsEarned({ maxUpgradeLevel: 4 })).toEqual([]);
    expect(achievementsEarned({ maxUpgradeLevel: 5 })).toEqual(['forgePlus5']);
    expect(achievementsEarned({ maxUpgradeLevel: 10 })).toEqual(['forgePlus5', 'forgePlus10']);
    expect(achievementsEarned({ maxCharacterLevel: 9 })).toEqual([]);
    expect(achievementsEarned({ maxCharacterLevel: 20 })).toEqual(['level10', 'level20']);
    expect(achievementsEarned({ contractsTurnedIn: 9 })).toEqual([]);
    expect(achievementsEarned({ contractsTurnedIn: 10 })).toEqual(['contracts10']);
    expect(achievementsEarned({ contractsTurnedIn: 50 })).toEqual(['contracts10', 'contracts50']);
    expect(achievementsEarned({ cryptTierCleared: 1 })).toEqual([]);
    expect(achievementsEarned({ cryptTierCleared: 3 })).toEqual(['cryptTier2', 'cryptTier3']);
    expect(achievementsEarned({ gravewardenDefeated: true })).toEqual(['gravewardenSlain']);
    expect(achievementsEarned({ fullSetWorn: true })).toEqual(['fullSet']);
    expect(achievementsEarned({ storyQuestsTurnedIn: ['furrowsOfTheDead'] })).toEqual([]);
    expect(achievementsEarned({ storyQuestsTurnedIn: ['theNamelessCrypt'] })).toEqual([
      'storyGraumark',
    ]);
  });

  it('merges facts by keeping the stronger value', () => {
    const merged = mergeAchievementFacts(
      { maxRarity: 'legendary', maxCharacterLevel: 12, storyQuestsTurnedIn: ['a'] },
      {
        maxRarity: 'epic',
        maxCharacterLevel: 20,
        fullSetWorn: false,
        storyQuestsTurnedIn: ['a', 'b'],
      },
    );
    expect(merged).toEqual({
      maxRarity: 'legendary',
      maxCharacterLevel: 20,
      fullSetWorn: false,
      storyQuestsTurnedIn: ['a', 'b'],
    });
    expect(mergeAchievementFacts({}, {})).toEqual({});
  });
});
