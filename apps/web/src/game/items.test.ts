import { describe, expect, it } from 'vitest';
import type { ItemDto } from './api';
import {
  canUse,
  compareItems,
  equippedBySlot,
  groupAffixes,
  setTracker,
  setTrackers,
  summaryItemView,
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
  effectRoll: null,
  setId: null,
  mythicId: null,
  locked: false,
  ...over,
});

describe('Legendary and Mythic display (ticket 3.2)', () => {
  it('shows the effect with its rolled numbers', () => {
    const v = toItemView(
      dto({ baseId: 'iron-ring', rarityId: 'legendary', effectId: 'tyrants-bane', effectRoll: 0 }),
    );
    expect(v.effect).toEqual({
      kind: 'legendary',
      name: 'Tyrant’s Bane',
      text: 'Deal 10 % more damage to bosses.',
    });
    expect(toItemView(dto({})).effect).toBeNull();
    expect(toItemView(dto({ effectId: 'gone', effectRoll: 1 })).effect).toBeNull();
  });

  it('names the Mythic and its signature, without a boss source line', () => {
    const v = toItemView(
      dto({
        baseId: 'widowmaker',
        rarityId: 'mythic',
        effectId: 'widows-kiss',
        mythicId: 'widowmaker',
      }),
    );
    expect(v.name).toBe('Widowmaker');
    expect(v.effect?.kind).toBe('mythic');
    expect(v.effect?.text).toContain('30 % more damage');
    expect(v.uniqueSource).toBeNull();
    expect(toItemView(dto({ baseId: 'gravewardens-cowl' })).uniqueSource).toContain('Gravewarden');
  });
});

describe('Void display (ticket 3.5)', () => {
  it('names the variant, scales base values and the effect, and is null where Void cannot be', () => {
    const plain = toItemView(
      dto({ baseId: 'iron-ring', rarityId: 'legendary', effectId: 'tyrants-bane', effectRoll: 0 }),
    );
    const v = toItemView(
      dto({
        baseId: 'iron-ring',
        rarityId: 'legendary',
        effectId: 'tyrants-bane',
        effectRoll: 0,
        variant: 'void',
      }),
    );
    expect(plain.variant).toBeNull();
    expect(v.variant).toEqual({ id: 'void', name: 'Void', implicitBonus: 0.1, effectBonus: 0.1 });
    expect(v.effect?.text).toBe('Deal 11 % more damage to bosses.');
    for (const [i, line] of v.base.entries()) {
      expect(line.value).toBeGreaterThanOrEqual(plain.base[i]!.value);
    }
    // A stray Void flag on an epic does nothing (game-core `activeVariant`).
    const epic = toItemView(dto({ baseId: 'iron-ring', rarityId: 'epic', variant: 'void' }));
    expect(epic.variant).toBeNull();
    expect(epic.base).toEqual(toItemView(dto({ baseId: 'iron-ring', rarityId: 'epic' })).base);
  });

  it('a Void set piece has no effect bonus and is still the same piece', () => {
    const v = toItemView(
      dto({
        baseId: 'vigil-gauntlets',
        rarityId: 'legendary',
        setId: 'drowned-vigil',
        variant: 'void',
      }),
    );
    expect(v.variant?.effectBonus).toBe(0);
    expect(v.setId).toBe('drowned-vigil');
  });

  it('summaries carry the variant for the drop moment', () => {
    expect(
      summaryItemView({
        id: 's',
        baseId: 'widowmaker',
        rarityId: 'mythic',
        itemLevel: 18,
        effectId: 'widows-kiss',
        mythicId: 'widowmaker',
        variant: 'void',
      }).variant?.name,
    ).toBe('Void');
    expect(
      summaryItemView({ id: 's', baseId: 'iron-ring', rarityId: 'legendary', itemLevel: 18 })
        .variant,
    ).toBeNull();
  });
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

describe('set pieces (ticket 3.3)', () => {
  const piece = (id: string, baseId: string, over: Partial<ItemDto> = {}) =>
    toItemView(dto({ id, baseId, rarityId: 'legendary', setId: 'drowned-vigil', ...over }));

  it('keeps the set id only when the base is a piece of that set', () => {
    expect(piece('a', 'vigil-helm').setId).toBe('drowned-vigil');
    // A set base is unique, but not a boss drop.
    expect(piece('a', 'vigil-helm').uniqueSource).toBeNull();
    expect(piece('b', 'vigil-helm', { setId: 'ashen-choir' }).setId).toBeNull();
    expect(piece('c', 'great-helm').setId).toBeNull();
    expect(toItemView(dto({ baseId: 'vigil-helm' })).setId).toBeNull();
  });

  it('tracks worn and packed pieces and lights the bonuses the server counts', () => {
    const worn = [
      piece('a', 'vigil-helm', { equippedSlot: 'head' }),
      piece('b', 'vigil-hauberk', { equippedSlot: 'chest' }),
      // A Void copy is the same piece (game-core counting ignores the variant).
      piece('c', 'vigil-gauntlets', { equippedSlot: 'hands', variant: 'void' }),
      piece('d', 'vigil-sabatons', { equippedSlot: 'feet' }),
    ];
    const pack = [piece('e', 'vigil-seal'), piece('f', 'vigil-helm')];
    const t = setTracker('drowned-vigil', worn, pack)!;
    expect(t.worn).toBe(4);
    expect(t.pieces.map((p) => [p.baseId, p.equipped, p.inPack])).toEqual([
      ['vigil-helm', true, false],
      ['vigil-hauberk', true, false],
      ['vigil-gauntlets', true, false],
      ['vigil-sabatons', true, false],
      ['vigil-oath-chain', false, false],
      ['vigil-seal', false, true],
    ]);
    expect(t.bonuses.map((b) => [b.pieces, b.active])).toEqual([
      [2, true],
      [4, true],
      [6, false],
    ]);
    expect(t.bonuses[0]!.text).toMatch(/25 %/);
    expect(setTracker('no-such-set', worn, pack)).toBeNull();
  });

  it('lists only the sets the hero owns a piece of', () => {
    expect(setTrackers([], [])).toEqual([]);
    const choir = toItemView(
      dto({ baseId: 'choir-band', rarityId: 'legendary', setId: 'ashen-choir' }),
    );
    expect(setTrackers([], [choir, piece('a', 'vigil-helm')]).map((t) => t.id)).toEqual([
      'drowned-vigil',
      'ashen-choir',
    ]);
  });

  it('names the set of a found piece in the return summary', () => {
    const v = summaryItemView({
      id: 'x',
      baseId: 'bloodmoon-fang',
      rarityId: 'legendary',
      itemLevel: 18,
      setId: 'bloodmoon-hunt',
    });
    expect(v).toMatchObject({ setName: 'The Bloodmoon Hunt', effectName: null });
  });
});
