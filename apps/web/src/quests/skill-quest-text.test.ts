import { describe, expect, it } from 'vitest';
import { materialsText, questTitle, skillQuestCostText, skillQuestRewardParts } from './text';

/** Ticket 9.3: the skill quests' words on the Tavern board. */
describe('skill quest text', () => {
  it('names the quest, what it takes and what it pays', () => {
    expect(questTitle('skill', 'theTyrantsLesson')).toBe('The Tyrant’s Lesson');
    expect(questTitle('skill', 'nope')).toBe('Skill quest');
    expect(skillQuestCostText({ gravewardenSeal: 2 })).toBe(
      'Bring 2 Gravewarden’s Seals (given up at the turn-in)',
    );
    expect(materialsText({ tyrantsEmber: 1 })).toBe('1 Tyrant’s Ember');
    expect(skillQuestCostText({})).toBe('');
    expect(
      skillQuestRewardParts(
        { name: 'Forgebreaker', kind: 'active' },
        { baseId: 'masters-ember-band', rarityId: 'legendary' },
      ),
    ).toEqual(['the skill Forgebreaker', 'Legendary Ember Band of the Masters']);
    expect(
      skillQuestRewardParts(
        { name: 'Kindling', kind: 'passive' },
        { baseId: 'masters-hollow-torc', rarityId: 'legendary' },
      ),
    ).toEqual(['the passive Kindling', 'Legendary Hollow Torc of the Masters']);
  });
});
