import { describe, expect, it } from 'vitest';
import type { ReturnSummary } from './api';
import {
  CHRONICLE_LIMIT,
  appendChronicle,
  chronicleEntries,
  isWorthAReturnDialog,
} from './chronicle';

const summary = (over: Partial<ReturnSummary> = {}): ReturnSummary => ({
  since: '2026-11-04T12:00:00.000Z',
  until: '2026-11-04T12:00:10.000Z',
  settlements: 1,
  simulatedMs: 10_000,
  cappedMs: 0,
  kills: 0,
  deaths: 0,
  xpGained: 0,
  levelsGained: 0,
  goldGained: 0,
  goldSalvaged: 0,
  itemsGained: 0,
  itemsSalvaged: 0,
  items: [],
  ...over,
});

describe('chronicleEntries', () => {
  it('shows nothing for a quiet settlement', () => {
    expect(chronicleEntries(summary(), 1)).toEqual([]);
  });

  it('turns a settlement into log lines, newest (level-up) first', () => {
    const lines = chronicleEntries(
      summary({
        kills: 3,
        xpGained: 42,
        goldGained: 12,
        goldSalvaged: 4,
        levelsGained: 1,
        itemsGained: 1,
        itemsSalvaged: 1,
        items: [{ id: 'a', baseId: 'chainmail', rarityId: 'rare', itemLevel: 3 }],
      }),
      7,
    );
    expect(lines.map((l) => l.kind)).toEqual(['level', 'note', 'loot', 'gold', 'kill']);
    expect(lines[2]).toMatchObject({ item: 'Chainmail', rarity: 'rare' });
    expect(lines[3]).toMatchObject({ amount: 8 }); // salvage gold is reported separately
    expect(new Set(lines.map((l) => l.id)).size).toBe(lines.length);
  });

  it('reports capped time and items beyond the listed ones', () => {
    const items = Array.from({ length: 8 }, (_, i) => ({
      id: `i${i}`,
      baseId: 'iron-ring',
      rarityId: 'common' as const,
      itemLevel: 1,
    }));
    const lines = chronicleEntries(summary({ cappedMs: 3_600_000, itemsGained: 8, items }), 1);
    expect(lines.filter((l) => l.kind === 'loot')).toHaveLength(6);
    expect(lines.some((l) => l.kind === 'note' && l.text.startsWith('2 more'))).toBe(true);
    expect(lines.at(-1)).toMatchObject({ kind: 'note', text: expect.stringContaining('1 h') });
  });
});

describe('appendChronicle', () => {
  it('prepends and trims', () => {
    const old = Array.from({ length: CHRONICLE_LIMIT }, (_, i) => ({
      id: `o${i}`,
      at: '',
      kind: 'gold' as const,
      amount: i,
    }));
    const next = appendChronicle(old, [{ id: 'n', at: '', kind: 'gold', amount: 99 }]);
    expect(next).toHaveLength(CHRONICLE_LIMIT);
    expect(next[0]!.id).toBe('n');
  });
});

describe('isWorthAReturnDialog', () => {
  it('needs a real absence with something credited or capped', () => {
    expect(isWorthAReturnDialog(summary())).toBe(false);
    const away = { since: '2026-11-04T11:00:00.000Z', until: '2026-11-04T12:00:00.000Z' };
    expect(isWorthAReturnDialog(summary(away))).toBe(true);
    expect(isWorthAReturnDialog(summary({ ...away, simulatedMs: 0 }))).toBe(false);
    expect(isWorthAReturnDialog(summary({ ...away, simulatedMs: 0, cappedMs: 5 }))).toBe(true);
  });
});
