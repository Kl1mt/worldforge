import { describe, expect, it } from 'vitest';
import { EMPTY_LOOT_FILTER } from '@worldforge/game-core';
import { describeFiltered, describeRules } from './lootFilter';

describe('loot filter wording (ticket 3.7)', () => {
  it('describes what the filter did', () => {
    expect(describeFiltered(undefined)).toBe('');
    expect(describeFiltered({ sold: 0, salvaged: 0, gold: 0, materials: {} })).toBe('');
    expect(describeFiltered({ sold: 1, salvaged: 0, gold: 4, materials: {} })).toBe(
      'sold 1 drop for 4 gold',
    );
    expect(describeFiltered({ sold: 2, salvaged: 3, gold: 9, materials: { timber: 3 } })).toBe(
      'sold 2 drops and salvaged 3 drops for 9 gold and 3 Timber',
    );
  });

  it('describes the rules in one sentence', () => {
    expect(describeRules(null)).toMatch(/^Off\./);
    expect(describeRules(EMPTY_LOOT_FILTER)).toMatch(/^Off\./);
    expect(describeRules({ ...EMPTY_LOOT_FILTER, belowRarity: 'rare' })).toBe(
      'Salvages drops below Rare.',
    );
    expect(
      describeRules({
        ...EMPTY_LOOT_FILTER,
        action: 'sell',
        belowRarity: 'epic',
        wantedAffixes: ['gold-find'],
      }),
    ).toBe('Sells drops below Epic, or drops without Gold Find.');
  });
});
