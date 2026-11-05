import { describe, expect, it } from 'vitest';
import type { ItemDto } from './api';
import {
  canUse,
  compareItems,
  equippedBySlot,
  groupAffixes,
  targetSlot,
  toItemView,
} from './items';

const dto = (over: Partial<ItemDto>): ItemDto => ({
  id: 'i1',
  baseId: 'longsword-notched',
  rarityId: 'common',
  itemLevel: 1,
  affixes: [],
  equippedSlot: null,
  source: 'farming',
  createdAt: '2026-11-04T12:00:00.000Z',
  upgradeLevel: 0,
  variant: null,
  effectId: null,
  setId: null,
  mythicId: null,
  locked: false,
  ...over,
});

describe('toItemView', () => {
  it('names, icons and implicit stats come from game-core content', () => {
    const item = toItemView(
      dto({
        rarityId: 'rare',
        itemLevel: 11,
        affixes: [{ affixId: 'crit-chance', tier: 1, value: 0.02 }],
      }),
    );
    expect(item).toMatchObject({
      name: 'Notched Longsword',
      icon: 'item.longsword-notched',
      slot: 'weapon',
      rarity: 'rare',
      // (4 + 1.4 × 10) × 1.2 rare multiplier
      base: [{ stat: 'physicalDamage', value: Math.round(18 * 1.2) }],
      affixes: [{ stat: 'critChance', value: 0.02 }],
    });
    expect(canUse(item, 'warrior')).toBe(true);
    expect(canUse(item, 'mage')).toBe(false);
  });

  it('marks the boss-exclusive bases as unique boss drops', () => {
    for (const baseId of ['gravewardens-cowl', 'seal-of-the-nameless', 'wardens-bone-chain']) {
      expect(toItemView(dto({ baseId, itemLevel: 15 })).uniqueSource).toBe(
        'The Gravewarden of The Nameless Crypt',
      );
    }
    expect(toItemView(dto({})).uniqueSource).toBeNull();
  });

  it('degrades gracefully for a base or affix that left the content', () => {
    const item = toItemView(
      dto({ baseId: 'gone', affixes: [{ affixId: 'gone', tier: 1, value: 3 }] }),
    );
    expect(item).toMatchObject({ icon: null, slot: null, base: [], affixes: [] });
    expect(canUse(item, 'warrior')).toBe(false);
  });
});

describe('compareItems', () => {
  it('diffs totals in canonical stat order, drops zeroes, adds gold find last', () => {
    const candidate = {
      base: [{ stat: 'armor' as const, value: 150 }],
      affixes: [
        { stat: 'goldFind' as const, value: 0.05 },
        { stat: 'health' as const, value: 50 },
        { stat: 'critChance' as const, value: 0.02 },
      ],
    };
    const equipped = {
      base: [{ stat: 'armor' as const, value: 100 }],
      affixes: [
        { stat: 'health' as const, value: 50 },
        { stat: 'resistance' as const, value: 9 },
      ],
    };
    expect(compareItems(candidate, equipped)).toEqual([
      { stat: 'critChance', value: 0.02 },
      { stat: 'armor', value: 50 },
      { stat: 'resistance', value: -9 },
      { stat: 'goldFind', value: 0.05 },
    ]);
  });

  it('avoids float noise and treats an empty slot as a pure gain', () => {
    const a = {
      base: [{ stat: 'attackSpeed' as const, value: 1.1 }],
      affixes: [{ stat: 'attackSpeed' as const, value: 0.2 }],
    };
    const b = { base: [{ stat: 'attackSpeed' as const, value: 1.2 }], affixes: [] };
    expect(compareItems(a, b)).toEqual([{ stat: 'attackSpeed', value: 0.1 }]);
    expect(compareItems(b, undefined)).toEqual([{ stat: 'attackSpeed', value: 1.2 }]);
  });
});

describe('ticket 3.1 affixes', () => {
  it('groups affixes into offence, defence and utility, in that order', () => {
    const item = toItemView(
      dto({
        baseId: 'iron-ring',
        rarityId: 'epic',
        itemLevel: 12,
        affixes: [
          { affixId: 'xp-gain', tier: 1, value: 0.03 },
          { affixId: 'health', tier: 1, value: 10 },
          { affixId: 'crit-chance', tier: 1, value: 0.01 },
        ],
      }),
    );
    expect(groupAffixes(item.affixes).map((g) => [g.group, g.lines.map((l) => l.stat)])).toEqual([
      ['offence', ['critChance']],
      ['defence', ['health']],
      ['utility', ['xpGain']],
    ]);
  });

  it('names class affixes by their own label', () => {
    const item = toItemView(
      dto({ affixes: [{ affixId: 'rage-heavy-strike', tier: 1, value: 0.08 }] }),
    );
    expect(item.affixes).toEqual([
      { stat: 'skillDamage', value: 0.08, label: 'Rage-fuelled Heavy Strike damage' },
    ]);
  });

  it('compares the new secondary modifiers after the core stats', () => {
    const candidate = {
      base: [],
      affixes: [
        { stat: 'itemFind' as const, value: 0.05 },
        { stat: 'bossDamage' as const, value: 0.07 },
      ],
    };
    const equipped = { base: [], affixes: [{ stat: 'itemFind' as const, value: 0.08 }] };
    expect(compareItems(candidate, equipped)).toEqual([
      { stat: 'itemFind', value: -0.03 },
      { stat: 'bossDamage', value: 0.07 },
    ]);
  });
});

describe('targetSlot', () => {
  it('mirrors the server: the only slot, or the first free ring slot', () => {
    const ring = toItemView(dto({ id: 'r', baseId: 'brass-ring' }));
    const worn = toItemView(dto({ id: 'w', baseId: 'iron-ring', equippedSlot: 'ring1' }));
    expect(targetSlot(ring, {})).toBe('ring1');
    expect(targetSlot(ring, equippedBySlot([worn]))).toBe('ring2');
    const both = toItemView(dto({ id: 'w2', baseId: 'iron-ring', equippedSlot: 'ring2' }));
    expect(targetSlot(ring, equippedBySlot([worn, both]))).toBe('ring1');
    expect(targetSlot(toItemView(dto({})), {})).toBe('weapon');
  });
});
