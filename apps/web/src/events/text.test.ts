import { describe, expect, it } from 'vitest';
import { talliesLine, timeLeft, trackLines } from './text';
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
});
