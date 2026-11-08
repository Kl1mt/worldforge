import { describe, expect, it } from 'vitest';
import { boardHref, boardLocation } from '../lib/route';
import { factorWords, ladderPath, rangeWords, recordWords, signed, standingWords } from './ladder';

describe('the arena ladder (ticket 5.6)', () => {
  it('builds the ladder request: no 1–9 bracket, a season only when named', () => {
    expect(ladderPath({ classId: null, bracket: null, season: null, cursor: null })).toBe(
      '/arena/ladder?limit=25',
    );
    expect(ladderPath({ classId: 'mage', bracket: '20-29', season: 3, cursor: 'abc' })).toBe(
      '/arena/ladder?limit=25&class=mage&bracket=20-29&season=3&cursor=abc',
    );
    expect(ladderPath({ classId: null, bracket: '1-9', season: 'current', cursor: null })).toBe(
      '/arena/ladder?limit=25',
    );
    expect(boardLocation(boardHref('arena', { season: 2 }))).toMatchObject({
      metric: 'arena',
      season: 2,
    });
  });

  it('writes a rating in plain words', () => {
    expect(standingWords({ standing: 'provisional', games: 3 }, 10)).toBe(
      'provisional — 7 more rated duels to be ranked',
    );
    expect(standingWords({ standing: 'provisional', games: 9 }, 10)).toBe(
      'provisional — 1 more rated duel to be ranked',
    );
    expect(standingWords({ standing: 'settling', games: 12 }, 10)).toBe('still settling');
    expect(standingWords({ standing: 'settled', games: 30 }, 10)).toBe('settled');
    expect(rangeWords({ low: 1380, high: 1660 })).toBe('likely 1,380–1,660');
    expect(recordWords({ wins: 4, losses: 2, draws: 0 })).toBe('4 won, 2 lost');
    expect(recordWords({ wins: 4, losses: 2, draws: 1 })).toBe('4 won, 2 lost, 1 drawn');
    expect([signed(16), signed(-8), signed(0)]).toEqual(['+16', '−8', '±0']);
  });

  it('explains the repeat-pair factor', () => {
    expect(factorWords(1)).toBeNull();
    expect(factorWords(0.5)).toContain('half');
    expect(factorWords(0.25)).toContain('a quarter');
    expect(factorWords(0)).toContain('nothing');
  });
});
