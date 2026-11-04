import { describe, expect, it } from 'vitest';
import type { MockItem } from '../mock/items';
import { compareItems, equippedCounterpart } from './compare';

const make = (over: Partial<MockItem>): MockItem => ({
  uid: 'x',
  icon: 'item.chainmail',
  name: 'X',
  baseType: 'X',
  rarity: 'common',
  slot: 'chest',
  itemLevel: 1,
  base: [],
  affixes: [],
  ...over,
});

describe('compareItems', () => {
  it('diffs totals in canonical stat order and drops zeroes', () => {
    const candidate = make({
      base: [{ stat: 'armor', value: 150 }],
      affixes: [
        { stat: 'health', value: 50 },
        { stat: 'critChance', value: 2 },
      ],
    });
    const equipped = make({
      base: [{ stat: 'armor', value: 100 }],
      affixes: [
        { stat: 'health', value: 50 },
        { stat: 'resistance', value: 9 },
      ],
    });
    expect(compareItems(candidate, equipped)).toEqual([
      { stat: 'critChance', value: 2 },
      { stat: 'armor', value: 50 },
      { stat: 'resistance', value: -9 },
    ]);
  });

  it('sums base and affix lines of the same stat and avoids float noise', () => {
    const candidate = make({
      base: [{ stat: 'attackSpeed', value: 1.1 }],
      affixes: [{ stat: 'attackSpeed', value: 0.2 }],
    });
    const equipped = make({ base: [{ stat: 'attackSpeed', value: 1.2 }] });
    expect(compareItems(candidate, equipped)).toEqual([{ stat: 'attackSpeed', value: 0.1 }]);
  });

  it('treats an empty slot as a pure gain', () => {
    const candidate = make({ affixes: [{ stat: 'health', value: 10 }] });
    expect(compareItems(candidate, undefined)).toEqual([{ stat: 'health', value: 10 }]);
  });
});

describe('equippedCounterpart', () => {
  it('maps rings to the first equipped ring slot', () => {
    const ring = make({ slot: 'ring', uid: 'r' });
    const worn = make({ slot: 'ring', uid: 'worn' });
    expect(equippedCounterpart(ring, { ring2: worn })?.uid).toBe('worn');
    expect(equippedCounterpart(ring, {})).toBeUndefined();
  });
});
