import { describe, expect, it } from 'vitest';
import { bonusWords, questWeeks, talliesLine, timeLeft, trackLines, weekOpens } from './text';
import type { EventView } from './api';

const event: EventView = {
  number: 1,
  definitionId: 'harvestOfBones',
  name: 'Harvest of Bones',
  tagline: '',
  giver: '',
  description: '',
  tallyName: 'bone tallies',
  modifier: { name: '', description: '' },
  quests: [],
  track: [
    {
      tier: 1,
      tallies: 10,
      cosmetic: {
        id: 'banner.x',
        kind: 'banner',
        name: 'Banner',
        description: '',
        shownToday: false,
      },
    },
    {
      tier: 2,
      tallies: 25,
      cosmetic: {
        id: 'title-colour.y',
        kind: 'titleColour',
        name: 'Bone-white',
        description: '',
        shownToday: false,
      },
    },
    {
      tier: 3,
      tallies: 50,
      cosmetic: { id: 'title.z', kind: 'title', name: 'Reaper', description: '', shownToday: true },
    },
  ],
  startsAt: '2030-01-07T00:00:00Z',
  endsAt: '2030-01-14T00:00:00Z',
  status: 'active',
  weeks: 1,
  week: 1,
  source: 'manual',
};

describe('event words', () => {
  it('time left', () => {
    expect(timeLeft('2030-01-14T00:00:00Z', '2030-01-07T00:00:00Z')).toBe('7 days left');
    expect(timeLeft('2030-01-14T00:00:00Z', '2030-01-13T19:00:00Z')).toBe('5 hours left');
    expect(timeLeft('2030-01-14T00:00:00Z', '2030-01-13T23:00:00Z')).toBe('1 hour left');
    expect(timeLeft('2030-01-14T00:00:00Z', '2030-01-13T23:59:00Z')).toBe('less than an hour left');
    expect(timeLeft('2030-01-14T00:00:00Z', '2030-01-15T00:00:00Z')).toBe('less than an hour left');
  });

  it('the track, tier by tier', () => {
    const lines = trackLines(event, {
      tallies: 30,
      granted: [{ tier: 1, cosmeticId: 'banner.x', grantedAt: '' }],
    });
    expect(lines.map((l) => l.state)).toEqual(['granted', 'reached', 'open']);
    expect(lines[0]!.where).toContain('collection book');
    expect(lines[2]!.where).toContain('profile');
    expect(trackLines(event, null).map((l) => l.state)).toEqual(['open', 'open', 'open']);
    expect(talliesLine(event, { tallies: 70, granted: [] })).toBe('50 of 50 bone tallies');
    expect(talliesLine(event, null)).toBe('0 of 50 bone tallies');
  });

  it('ticket 8.3: quests by week, the weeks to come with their day; bonus words', () => {
    const q = (id: string, week: number) => ({
      id,
      name: id,
      description: '',
      target: 1,
      tallies: 1,
      week,
      minLevel: null,
      opensAt: new Date(Date.UTC(2030, 0, 7 + (week - 1) * 7)).toISOString(),
    });
    const groups = questWeeks({ week: 2, quests: [q('a', 1), q('b', 1), q('c', 2), q('d', 3)] });
    expect(groups.map((g) => [g.week, g.state, g.quests.map((x) => x.index)])).toEqual([
      [1, 'past', [0, 1]],
      [2, 'now', [2]],
      [3, 'later', [3]],
    ]);
    expect(weekOpens(groups[2]!.opensAt)).toMatch(/^Opens \w+day \d+ January$/);
    // A one-week event is one group.
    expect(questWeeks({ week: 1, quests: [q('a', 1), q('b', 1)] })).toHaveLength(1);
    const name = (id: string) => (id === 'ironOre' ? 'Iron Ore' : id);
    expect(bonusWords({ ironOre: 3 }, name)).toBe('3 extra Iron Ore');
    expect(bonusWords({ ironOre: 0 }, name)).toBe('');
    // The new keepsake kinds have their own words.
    const lines = trackLines(
      {
        ...event,
        track: [
          {
            tier: 1,
            tallies: 5,
            cosmetic: {
              id: 'appearance.x',
              kind: 'appearance',
              name: 'A',
              description: '',
              shownToday: true,
            },
          },
          {
            tier: 2,
            tallies: 9,
            cosmetic: {
              id: 'crest.x',
              kind: 'crest',
              name: 'C',
              description: '',
              shownToday: true,
            },
          },
        ],
      },
      null,
    );
    expect(lines.map((l) => l.kind)).toEqual(['Hero appearance', 'Crest style']);
    expect(lines[0]!.where).toContain('heroes');
  });
});
