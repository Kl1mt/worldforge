import { describe, expect, it } from 'vitest';
import {
  TRADE_REVERSAL_CHECKS,
  TRADE_REVERSAL_TEXT,
  TRADE_REVERSAL_WINDOW_MS,
  reversalDecision,
  reversedItemState,
  type ReversalInput,
  type ReversalItemFacts,
} from './reversal.js';

const ACCEPTED = new Date('2031-01-05T12:00:00.000Z');
const HOUR = 3_600_000;

const untouched = (over: Partial<NonNullable<ReversalItemFacts['now']>> = {}) => ({
  characterId: 'hero-b',
  inWarehouse: false,
  onShelf: false,
  escrowOfferId: null,
  tradedCount: 1,
  upgradeLevel: 0,
  upgradePity: 0,
  rerollCount: 0,
  forgeCounter: 0,
  affixes: [],
  ...over,
});

function input(over: Partial<ReversalInput> = {}): ReversalInput {
  return {
    status: 'accepted',
    closedAt: ACCEPTED,
    reversedAt: null,
    now: new Date(ACCEPTED.getTime() + HOUR),
    items: [
      {
        id: 'item-1',
        receivedBy: 'receiver',
        receivedByCharacterId: 'hero-b',
        tradedCountAfter: 1,
        now: untouched(),
      },
    ],
    purses: [
      {
        party: 'receiver',
        gold: { received: 500, available: 500 },
        materials: { timber: { received: 20, available: 20 } },
      },
    ],
    ...over,
  };
}

const checks = (i: ReversalInput) => reversalDecision(i).refusals.map((r) => r.check);

describe('reversalDecision', () => {
  it('allows an untouched trade within 14 days', () => {
    const d = reversalDecision(input());
    expect(d).toEqual({
      reversible: true,
      refusals: [],
      deadline: new Date(ACCEPTED.getTime() + TRADE_REVERSAL_WINDOW_MS).toISOString(),
    });
  });

  it('closes the window exactly 14 days after the accept', () => {
    const edge = ACCEPTED.getTime() + 14 * 24 * HOUR;
    expect(checks(input({ now: new Date(edge - 1) }))).toEqual([]);
    expect(checks(input({ now: new Date(edge) }))).toEqual(['too_old']);
  });

  it('stops at the trade itself: never completed, already reversed', () => {
    expect(checks(input({ status: 'open', closedAt: null }))).toEqual(['not_completed']);
    expect(checks(input({ status: 'declined' }))).toEqual(['not_completed']);
    expect(checks(input({ reversedAt: ACCEPTED }))).toEqual(['already_reversed']);
  });

  it.each([
    ['gone (sold, salvaged, discarded)', null, ['item_gone']],
    ['with another hero', untouched({ characterId: 'hero-b2' }), ['item_moved']],
    ['on the shelf', untouched({ onShelf: true }), ['item_on_shelf']],
    ['in the warehouse', untouched({ inWarehouse: true }), ['item_in_warehouse']],
    ['in another offer', untouched({ escrowOfferId: 'o2' }), ['item_in_offer']],
    ['traded again', untouched({ tradedCount: 2 }), ['item_traded_again']],
    ['upgraded', untouched({ upgradeLevel: 1 }), ['item_forged']],
    ['after a failed upgrade', untouched({ upgradePity: 1 }), ['item_forged']],
    ['rerolled', untouched({ rerollCount: 1 }), ['item_forged']],
  ] as const)('refuses an item %s', (_name, now, want) => {
    const base = input();
    expect(checks({ ...base, items: [{ ...base.items[0]!, now }] })).toEqual(want);
  });

  it('refuses gold and materials partly spent, and lists every reason', () => {
    const d = reversalDecision(
      input({
        items: [{ ...input().items[0]!, now: null }],
        purses: [
          {
            party: 'receiver',
            gold: { received: 500, available: 499 },
            materials: {
              timber: { received: 20, available: 3 },
              ironOre: { received: 5, available: -2 },
            },
          },
          { party: 'sender', gold: { received: 0, available: 0 }, materials: {} },
        ],
      }),
    );
    expect(d.reversible).toBe(false);
    expect(d.refusals).toEqual([
      { check: 'item_gone', party: 'receiver', itemId: 'item-1' },
      { check: 'gold_spent', party: 'receiver', received: 500, available: 499 },
      {
        check: 'materials_spent',
        party: 'receiver',
        materialId: 'ironOre',
        received: 5,
        available: 0,
      },
      {
        check: 'materials_spent',
        party: 'receiver',
        materialId: 'timber',
        received: 20,
        available: 3,
      },
    ]);
  });

  it('has plain words for every check', () => {
    for (const c of TRADE_REVERSAL_CHECKS)
      expect(TRADE_REVERSAL_TEXT[c].length).toBeGreaterThan(20);
  });
});

describe('reversedItemState', () => {
  it('puts the item back as it was traded', () => {
    const worn = new Date(ACCEPTED.getTime() + HOUR);
    expect(reversedItemState({ tradedCount: 1, firstEquippedAt: worn }, ACCEPTED)).toEqual({
      binding: 'equip',
      boundAccountId: null,
      tradedCount: 0,
      holdUntil: null,
      equippedSlot: null,
      locked: false,
      firstEquippedAt: null,
    });
    const before = new Date(ACCEPTED.getTime() - HOUR);
    expect(reversedItemState({ tradedCount: 1, firstEquippedAt: before }, ACCEPTED)).toMatchObject({
      firstEquippedAt: before,
    });
    expect(reversedItemState({ tradedCount: 0, firstEquippedAt: null }, ACCEPTED).tradedCount).toBe(
      0,
    );
  });
});
