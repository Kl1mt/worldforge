import { describe, expect, it } from 'vitest';
import type { ItemDto } from '../game/api';
import { equippedBySlot, toItemView, type ItemView } from '../game/items';
import {
  DEFAULT_ITEM_QUERY,
  activeFilterCount,
  applyItemQuery,
  loadItemQuery,
  matchesItemQuery,
  parseItemQuery,
  saveItemQuery,
  scoreOverWorn,
  type ItemQuery,
} from './query';

// Derived from the wall clock: `toItemView` reads holds against it (CLAUDE.md "Dates").
const NOW = Date.now();

let n = 0;
const dto = (over: Partial<ItemDto>): ItemDto => {
  n += 1;
  return {
    id: `item-${String(n).padStart(3, '0')}`,
    baseId: 'longsword-notched',
    rarityId: 'common',
    itemLevel: 5,
    affixes: [],
    equippedSlot: null,
    source: 'farming',
    createdAt: new Date(NOW - n * 60_000).toISOString(),
    upgradeLevel: 0,
    variant: null,
    effectId: null,
    effectRoll: null,
    setId: null,
    mythicId: null,
    locked: false,
    binding: 'account',
    bindingReason: 'rarity',
    tradeable: false,
    ...over,
  };
};
const view = (over: Partial<ItemDto>) => toItemView(dto(over));
const q = (over: Partial<ItemQuery>): ItemQuery => ({ ...DEFAULT_ITEM_QUERY, ...over });
const ids = (items: readonly ItemView[]) => items.map((i) => i.id);

const sword = view({ rarityId: 'rare', itemLevel: 12 });
const ring = view({ baseId: 'iron-ring', rarityId: 'epic', itemLevel: 9, locked: true });
const legend = view({
  baseId: 'iron-ring',
  rarityId: 'legendary',
  itemLevel: 20,
  effectId: 'tyrants-bane',
  effectRoll: 0,
  variant: 'void',
  binding: 'equip',
  bindingReason: 'fresh',
  tradeable: true,
});
const vigil = view({
  baseId: 'vigil-helm',
  rarityId: 'legendary',
  itemLevel: 18,
  setId: 'drowned-vigil',
});
const held = view({
  rarityId: 'uncommon',
  itemLevel: 3,
  holdUntil: new Date(NOW + 3_600_000).toISOString(),
});
const released = view({ rarityId: 'uncommon', holdUntil: new Date(NOW - 1000).toISOString() });
const awake = view({
  baseId: 'iron-ring',
  rarityId: 'legendary',
  itemLevel: 25,
  effectId: 'tyrants-bane',
  effectRoll: 0.5,
  variant: 'prismatic',
  awakening: { option: 'effect', effectStrength: 1.1 },
  awakenedAt: new Date(NOW - 86_400_000).toISOString(),
});
const all = [sword, ring, legend, vigil, held, released, awake];

describe('inventory search (ticket 8.5)', () => {
  it('finds items by name, affix, effect, set, variant and slot, every word', () => {
    const find = (text: string) => ids(applyItemQuery(all, q({ text }), { nowMs: NOW }));
    expect(find('notched')).toEqual(ids([sword, held, released]));
    expect(find('NOTCHED  rare')).toEqual([sword.id]);
    expect(find(legend.effect!.name.toLowerCase())).toEqual(ids([legend, awake]));
    expect(find('bosses')).toEqual(ids([legend, awake])); // the effect's text
    expect(find('drowned vigil')).toEqual([vigil.id]);
    expect(find('void')).toEqual([legend.id]);
    expect(find('prismatic awakened')).toEqual([awake.id]);
    expect(find('ring')).toEqual(ids([ring, legend, awake]));
    expect(find('no such thing')).toEqual([]);
    expect(find('   ')).toEqual(ids(all));
    // Affix names, as the tooltip shows them.
    const withAffix = view({
      rarityId: 'rare',
      affixes: [{ affixId: 'gold-find', value: 5 }] as ItemDto['affixes'],
    });
    const affixName = withAffix.affixes[0]!.label ?? 'gold';
    expect(
      ids(
        applyItemQuery([sword, withAffix], q({ text: affixName.split(' ')[0]! }), { nowMs: NOW }),
      ),
    ).toEqual([withAffix.id]);
  });
});

describe('inventory filters (ticket 8.5)', () => {
  const only = (over: Partial<ItemQuery>) =>
    ids(all.filter((i) => matchesItemQuery(i, q(over), NOW)));

  it('filters by slot, rarity and variant', () => {
    expect(only({ slot: 'ring' })).toEqual(ids([ring, legend, awake]));
    expect(only({ rarity: 'legendary' })).toEqual(ids([legend, vigil, awake]));
    expect(only({ variant: 'void' })).toEqual([legend.id]);
    expect(only({ variant: 'prismatic' })).toEqual([awake.id]);
    expect(only({ variant: 'none' })).toEqual(ids([sword, ring, vigil, held, released]));
  });

  it('filters by locked, tradeable, held and awakened', () => {
    expect(only({ locked: 'yes' })).toEqual([ring.id]);
    expect(only({ locked: 'no' })).not.toContain(ring.id);
    expect(only({ tradeable: 'yes' })).toEqual([legend.id]);
    expect(only({ tradeable: 'no' })).not.toContain(legend.id);
    // A hold that ended is not a hold.
    expect(only({ held: 'yes' })).toEqual([held.id]);
    expect(only({ held: 'no' })).toContain(released.id);
    expect(only({ awakened: 'yes' })).toEqual([awake.id]);
    expect(only({ rarity: 'legendary', awakened: 'no', slot: 'ring' })).toEqual([legend.id]);
  });

  it('counts the filters in use', () => {
    expect(activeFilterCount(DEFAULT_ITEM_QUERY)).toBe(0);
    expect(activeFilterCount(q({ text: 'x', sort: 'rarity' }))).toBe(0);
    expect(activeFilterCount(q({ slot: 'ring', held: 'no' }))).toBe(2);
  });
});

describe('inventory sorting (ticket 8.5)', () => {
  const sorted = (sort: ItemQuery['sort'], extra = {}) =>
    ids(applyItemQuery(all, q({ sort }), { nowMs: NOW, ...extra }));

  it('sorts newest first by default, stable on ties', () => {
    expect(sorted('newest')).toEqual(ids(all));
    expect(sorted('newest')).toEqual(ids([...all].reverse().reverse()));
  });

  it('sorts by rarity, item level and slot', () => {
    expect(sorted('rarity').slice(0, 3)).toEqual(ids([awake, legend, vigil]));
    expect(sorted('rarity').slice(-2)).toEqual(ids([released, held]));
    expect(sorted('itemLevel')).toEqual(ids([awake, legend, vigil, sword, ring, released, held]));
    const slots = applyItemQuery(all, q({ sort: 'slot' }), { nowMs: NOW }).map((i) => i.slot);
    // Grouped by slot, in the game's slot order.
    expect(new Set(slots).size).toBe(3);
    expect(slots.indexOf('weapon')).toBeGreaterThan(slots.lastIndexOf('ring'));
    expect(slots.indexOf('ring')).toBeGreaterThan(slots.lastIndexOf('head'));
  });

  it('sorts by the score over what is worn, unwearable last', () => {
    const worn = toItemView(
      dto({ baseId: 'iron-ring', rarityId: 'rare', itemLevel: 10, equippedSlot: 'ring1' }),
    );
    const equipped = equippedBySlot([worn]);
    // A warrior: rings over the worn ring score their difference; swords fill an empty slot.
    expect(scoreOverWorn(awake, equipped, 'warrior')).toBeGreaterThan(0);
    expect(scoreOverWorn(ring, equipped, 'warrior')).toBeLessThan(
      scoreOverWorn(legend, equipped, 'warrior')!,
    );
    // The mage cannot wield the notched longsword.
    expect(scoreOverWorn(sword, equipped, 'mage')).toBeNull();
    const order = applyItemQuery(all, q({ sort: 'score' }), {
      nowMs: NOW,
      equipped,
      classId: 'mage',
    });
    const scores = order.map((i) => scoreOverWorn(i, equipped, 'mage'));
    const firstNull = scores.indexOf(null);
    expect(firstNull).toBeGreaterThan(0);
    expect(scores.slice(firstNull).every((s) => s === null)).toBe(true);
    const known = scores.slice(0, firstNull) as number[];
    expect(known).toEqual([...known].sort((a, b) => b - a));
    expect(order[0]!.id).toBe(awake.id);
  });
});

describe('remembering the choice per screen (ticket 8.5)', () => {
  const memory = () => {
    const store = new Map<string, string>();
    return {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      store,
    } as unknown as Storage & { store: Map<string, string> };
  };

  it('saves and loads each screen on its own', () => {
    const s = memory();
    saveItemQuery('pack', q({ text: 'ring', sort: 'rarity', locked: 'yes' }), s);
    saveItemQuery('warehouse', q({ slot: 'head' }), s);
    expect(loadItemQuery('pack', s)).toEqual(q({ text: 'ring', sort: 'rarity', locked: 'yes' }));
    expect(loadItemQuery('warehouse', s)).toEqual(q({ slot: 'head' }));
    expect(loadItemQuery('shelf', s)).toEqual(DEFAULT_ITEM_QUERY);
  });

  it('reads broken or foreign stored values as the default', () => {
    const s = memory();
    s.setItem('worldforge.itemQuery.pack', '{not json');
    expect(loadItemQuery('pack', s)).toEqual(DEFAULT_ITEM_QUERY);
    expect(
      parseItemQuery({
        sort: 'price',
        slot: 'tail',
        locked: true,
        text: 'x'.repeat(500),
        held: 'no',
      }),
    ).toEqual(q({ text: 'x'.repeat(60), held: 'no' }));
    expect(parseItemQuery(null)).toEqual(DEFAULT_ITEM_QUERY);
    expect(parseItemQuery('pack')).toEqual(DEFAULT_ITEM_QUERY);
  });
});
