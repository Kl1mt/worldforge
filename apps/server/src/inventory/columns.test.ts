import { describe, expect, it } from 'vitest';
import { generateItem, getLootTable } from '@worldforge/game-core';
import { itemEffectColumns } from './columns.js';

describe('itemEffectColumns', () => {
  it('persists the rolled variant (ticket 3.5) next to effect and set, null when absent', () => {
    const abbey = getLootTable('sunkenAbbey');
    let found = false;
    for (let seed = 0; seed < 5_000 && !found; seed++) {
      const item = generateItem({ seed, itemLevel: 20, lootTable: abbey, rarityId: 'legendary' })!;
      const cols = itemEffectColumns(item);
      expect(cols.variant).toBe(item.variant ?? null);
      if (item.variant) {
        expect(cols.variant).toBe('void');
        found = true;
      }
    }
    expect(found).toBe(true);
    const plain = generateItem({ seed: 1, itemLevel: 5, baseId: 'iron-ring', rarityId: 'rare' })!;
    expect(itemEffectColumns(plain)).toEqual({
      effectId: null,
      effectRoll: null,
      mythicId: null,
      setId: null,
      variant: null,
    });
  });
});
