import { describe, expect, it } from 'vitest';
import { contractTitle, objectiveLabel, rewardParts, storyBlockerText } from './text';

describe('quest text', () => {
  it('labels objectives from content names', () => {
    expect(objectiveLabel({ kind: 'kill', enemyId: 'risenFarmhand', count: 12 })).toBe(
      'Slay 12 Risen Farmhands',
    );
    expect(objectiveLabel({ kind: 'gather', materialId: 'timber', count: 15 })).toBe(
      'Gather 15 Timber',
    );
    expect(objectiveLabel({ kind: 'kill', enemyId: 'carrionWolf', count: 2 })).toBe(
      'Slay 2 Carrion Wolves',
    );
    expect(objectiveLabel({ kind: 'reach', areaId: 'crowwood' })).toBe('Fight in Crowwood');
    expect(objectiveLabel({ kind: 'defeatBoss', bossId: 'gravewarden' })).toBe(
      'Defeat The Gravewarden',
    );
  });

  it('names contracts and rewards', () => {
    expect(contractTitle({ kind: 'kill', enemyId: 'carrionWolf', count: 25 })).toBe(
      'Bounty: Carrion Wolf',
    );
    expect(
      rewardParts({
        xp: 1800,
        gold: 320,
        materials: { soulShard: 10 },
        item: { baseId: 'grave-gold-ring', rarityId: 'rare', itemLevel: 11 },
      }),
    ).toEqual(['1,800 XP', '320 gold', '10 Soul Shard', 'Rare Grave-Gold Ring']);
    expect(storyBlockerText({ kind: 'level', required: 5 })).toBe('Reach level 5');
    expect(storyBlockerText({ kind: 'quest', questId: 'furrowsOfTheDead' })).toBe(
      'First finish “The Furrows of the Dead”',
    );
  });
});
