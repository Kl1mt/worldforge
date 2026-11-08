import { describe, expect, it } from 'vitest';
import { arenaDuelFromHash, arenaFriendFromHash, arenaHref, parseRoute } from '../lib/route';
import { duelLogLines, type DuelView } from './arena';

describe('arena routes (ticket 5.5)', () => {
  it('parses the arena, a duel and a friend', () => {
    const id = '0190f0a0-1234-7abc-8def-0123456789ab';
    expect(parseRoute('#/arena')).toBe('arena');
    expect(parseRoute(arenaHref({ duel: id }))).toBe('arena');
    expect(arenaDuelFromHash(arenaHref({ duel: id }))).toBe(id);
    expect(arenaDuelFromHash('#/arena/duel/not-a-uuid')).toBeNull();
    expect(arenaFriendFromHash(arenaHref({ friend: 'k7x2m' }))).toBe('k7x2m');
    expect(arenaFriendFromHash('#/arena')).toBeNull();
    expect(arenaHref()).toBe('#/arena');
  });
});

describe('duelLogLines', () => {
  it('writes the server log in plain words, from the viewer side', () => {
    const duel = {
      you: 'defender',
      events: [
        {
          t: 0,
          type: 'start',
          initiative: 'challenger',
          health: { challenger: 100, defender: 90 },
        },
        {
          t: 800,
          type: 'attack',
          side: 'challenger',
          damage: 30,
          crit: true,
          skill: false,
          health: 60,
        },
        { t: 900, type: 'thorns', side: 'defender', damage: 4, health: 96 },
        {
          t: 1200,
          type: 'attack',
          side: 'defender',
          damage: 96,
          crit: false,
          skill: true,
          health: 0,
        },
        { t: 1200, type: 'defeat', side: 'challenger' },
        { t: 1200, type: 'end', outcome: 'defender', reason: 'defeat' },
      ],
    } as unknown as Pick<DuelView, 'events' | 'you' | 'challenger' | 'defender'>;
    const lines = duelLogLines(duel, { challenger: 'Brannoc', defender: 'Ysolde' });
    expect(lines.map((l) => l.tone)).toEqual(['plain', 'them', 'you', 'you', 'end', 'end']);
    expect(lines[1]!.text).toBe('Brannoc strikes for 30 (critical). Ysolde: 60 left.');
    expect(lines[3]!.text).toContain('uses the class skill');
    expect(lines.at(-1)!.text).toBe('Ysolde wins.');
  });
});
