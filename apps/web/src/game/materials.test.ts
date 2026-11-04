import { describe, expect, it } from 'vitest';
import { MATERIAL_IDS } from '@worldforge/game-core';
import { materialCounts, materialView, professionName } from './materials';

describe('materialView', () => {
  it('has art and a source line for every material', () => {
    for (const id of MATERIAL_IDS) {
      const v = materialView(id);
      expect(v.sprite, id).not.toBeNull();
      expect(v.source.length).toBeGreaterThan(0);
    }
    expect(materialView('timber').source).toBe('Woodcutting');
    expect(materialView('soulShard').source).toBe('Dropped by the undead');
    expect(professionName('mining')).toBe('Mining');
  });

  it('turns summary counts into rows, skipping zeros and unknown ids', () => {
    const rows = materialCounts({ ironOre: 3, timber: 0, bogus: 9 } as Record<string, number>);
    expect(rows.map((r) => [r.material.id, r.quantity])).toEqual([['ironOre', 3]]);
    expect(materialCounts(undefined)).toEqual([]);
  });
});
