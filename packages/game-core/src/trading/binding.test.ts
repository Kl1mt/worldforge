import { describe, expect, it } from 'vitest';
import { RARITY_IDS, type RarityId } from '../rarity.js';
import {
  DEFAULT_TRADING_SWITCHES,
  ITEM_BINDING_SOURCES,
  TRADE_CATEGORIES,
  hoardSource,
  itemBinding,
  itemBindingSource,
  itemBindingState,
  itemTradeCategories,
  type ItemBindingInput,
  type ItemBindingSource,
  type TradeCategory,
  type TradingSwitches,
} from './binding.js';

/** One stored `source` string per binding source. */
const STORED_SOURCE: Record<ItemBindingSource, string> = {
  farming: 'farming',
  crypt: 'dungeon:namelessCrypt',
  hoard: hoardSource('namelessCrypt'),
  craft: 'forge',
  quest: 'quest',
  contract: 'contract',
  merchant: 'merchant',
  unknown: 'test',
};

/** Item states (docs/TRADING.md "By state"), each as the columns that show it. */
const STATES: Record<string, Partial<ItemBindingInput>> = {
  fresh: {},
  equipped: { equippedSlot: 'chest' },
  wornBefore: { firstEquippedAt: new Date('2026-11-01T00:00:00Z') },
  upgraded: { upgradeLevel: 1, forgeCounter: 1 },
  failedUpgrade: { upgradePity: 1, forgeCounter: 1 },
  rerolled: { rerollCount: 1, forgeCounter: 1 },
  improved: { affixes: [{ affixId: 'health', tier: 1, value: 10, improvements: 1 }] },
  rerolledAffixOnly: { affixes: [{ affixId: 'health', tier: 1, value: 10, rerolled: true }] },
  counterOnly: { forgeCounter: 1 },
  traded: { tradedCount: 1 },
  storedBound: { binding: 'account' },
  storedEquip: { binding: 'equip' },
};
const FRESH_STATES = new Set(['fresh', 'storedEquip']);

/** Item kinds: rarity × variant × set, every combination (invalid ones included). */
const KINDS = RARITY_IDS.flatMap((rarityId) =>
  [null, 'void' as const].flatMap((variant) =>
    [null, 'abbey-penitent'].map((setId) => ({ rarityId, variant, setId })),
  ),
);

/** The expected categories, written out from TRADING.md's rarity table. */
function expectedCategories(kind: {
  rarityId: RarityId;
  variant: 'void' | null;
  setId: string | null;
}): TradeCategory[] {
  const out: TradeCategory[] = [];
  if (kind.rarityId === 'epic') out.push('epic');
  if (kind.rarityId === 'legendary') out.push(kind.setId ? 'set' : 'legendary');
  if (kind.rarityId === 'mythic') out.push('mythic');
  // Void only exists on Legendary and Mythic (set pieces included); elsewhere it does nothing.
  if (kind.variant === 'void' && (kind.rarityId === 'legendary' || kind.rarityId === 'mythic')) {
    out.push('void');
  }
  return out;
}

const ALL_ON: TradingSwitches = {
  trading: true,
  items: true,
  categories: { epic: true, legendary: true, set: true, mythic: true, void: true },
};

describe('itemBinding (ticket T.1)', () => {
  it('classifies every stored source', () => {
    for (const source of ITEM_BINDING_SOURCES) {
      expect(itemBindingSource(STORED_SOURCE[source])).toBe(source);
    }
    expect(itemBindingSource('dungeon:ashenWatch')).toBe('crypt');
    expect(itemBindingSource(hoardSource('ashenWatch'))).toBe('hoard');
    expect(itemBindingSource('')).toBe('unknown');
    expect(itemBindingSource('Farming')).toBe('unknown');
  });

  it('follows the table for every rarity × variant × set × source × state', () => {
    let cases = 0;
    for (const kind of KINDS) {
      for (const source of ITEM_BINDING_SOURCES) {
        for (const [stateName, state] of Object.entries(STATES)) {
          const item: ItemBindingInput = { ...kind, source: STORED_SOURCE[source], ...state };
          const openSource = source === 'farming' || source === 'crypt' || source === 'craft';
          const epicOrBetter =
            kind.rarityId === 'epic' || kind.rarityId === 'legendary' || kind.rarityId === 'mythic';
          const fresh = FRESH_STATES.has(stateName);
          const bindOnEquip = openSource && epicOrBetter && fresh;
          const label = `${kind.rarityId}/${kind.variant}/${kind.setId}/${source}/${stateName}`;

          const off = itemBinding(item);
          expect(off.binding, label).toBe(bindOnEquip ? 'equip' : 'account');
          // Switches never change the state, only whether it can be offered.
          expect(off.tradeable, label).toBe(false);
          const on = itemBinding(item, ALL_ON);
          expect(on.binding, label).toBe(off.binding);
          expect(on.reason, label).toBe(off.reason);
          expect(on.tradeable, label).toBe(bindOnEquip);
          expect(on.categories, label).toEqual(bindOnEquip ? expectedCategories(kind) : []);
          expect(itemBindingState(item), label).toEqual({
            binding: off.binding,
            reason: off.reason,
          });

          // The reason names the first rule that binds, in TRADING.md's order.
          const expectedReason =
            stateName === 'traded'
              ? 'traded'
              : !openSource
                ? 'source'
                : !epicOrBetter
                  ? 'rarity'
                  : fresh
                    ? 'fresh'
                    : stateName === 'equipped' || stateName === 'wornBefore'
                      ? 'worn'
                      : stateName === 'storedBound'
                        ? 'bound'
                        : 'forged';
          expect(off.reason, label).toBe(expectedReason);
          cases += 1;
        }
      }
    }
    expect(cases).toBe(KINDS.length * ITEM_BINDING_SOURCES.length * Object.keys(STATES).length);
  });

  it('needs the master switch, the item switch and every category switch', () => {
    const voidSet: ItemBindingInput = {
      rarityId: 'legendary',
      variant: 'void',
      setId: 'abbey-penitent',
      source: 'farming',
    };
    expect(itemTradeCategories(voidSet)).toEqual(['set', 'void']);
    expect(itemBinding(voidSet, ALL_ON).tradeable).toBe(true);
    expect(itemBinding(voidSet, { ...ALL_ON, trading: false }).tradeable).toBe(false);
    expect(itemBinding(voidSet, { ...ALL_ON, items: false }).tradeable).toBe(false);
    for (const c of TRADE_CATEGORIES) {
      const one = { ...ALL_ON, categories: { ...ALL_ON.categories, [c]: false } };
      expect(itemBinding(voidSet, one).tradeable, c).toBe(c !== 'set' && c !== 'void');
    }
    // Each category opens exactly its own items.
    for (const c of TRADE_CATEGORIES) {
      const none = Object.fromEntries(TRADE_CATEGORIES.map((x) => [x, false]));
      const only = { ...ALL_ON, categories: { ...none, [c]: true } as typeof ALL_ON.categories };
      const open = KINDS.filter(
        (k) => itemBinding({ ...k, source: 'farming' }, only).tradeable,
      ).map((k) => expectedCategories(k));
      for (const cats of open) expect(cats).toEqual([c]);
    }
  });

  it('starts with the master and items off, so nothing is tradeable (T.2 defaults)', () => {
    expect(DEFAULT_TRADING_SWITCHES.trading).toBe(false);
    expect(DEFAULT_TRADING_SWITCHES.items).toBe(false);
    expect(DEFAULT_TRADING_SWITCHES.categories).toEqual({
      epic: true,
      legendary: true,
      set: true,
      mythic: false,
      void: false,
    });
    for (const k of KINDS) {
      expect(itemBinding({ ...k, source: 'farming' }).tradeable).toBe(false);
    }
  });

  it('accepts a first-equipped time as an ISO string (API views)', () => {
    const item: ItemBindingInput = {
      rarityId: 'epic',
      source: 'farming',
      firstEquippedAt: '2026-11-08T10:00:00.000Z',
    };
    expect(itemBinding(item).reason).toBe('worn');
  });
});
