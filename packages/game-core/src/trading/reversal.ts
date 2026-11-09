import type { MaterialId } from '../world/materials.js';
import type { RolledAffix } from '../loot/generate.js';
import { isForged } from './binding.js';

/**
 * Moderator reversal of a completed trade (ticket T.6, docs/TRADING.md "Moderator reversal and
 * its limits" and "T.6 as built"). Pure rules the server applies under its locks:
 * - a moderator or admin may reverse an accepted trade within **14 days** of the accept, once;
 * - a reversal moves **everything** back (items, gold and materials, both sides) or nothing;
 * - it never creates value: it works only while every item is untouched on the hero that received
 *   it (in the pack or worn) and the received gold and materials are still on that hero, beyond
 *   whatever other trades hold there. Anything else refuses the whole reversal, and the answer
 *   lists every reason in plain words.
 *
 * What counts as untouched, per item (the receiving hero's row now, against the trade):
 * - **worn** (at any time): allowed. Wearing changes nothing about the item; it is taken off.
 * - **locked**: allowed (a lock moves no value); the item goes back unlocked, as it was traded.
 * - **sold, salvaged or discarded**: the row is gone: refused (`item_gone`).
 * - **with another hero** (taken out of the shelf by another hero of the account): refused
 *   (`item_moved`).
 * - **on the account shelf** or **in the Warehouse**: refused (`item_on_shelf`,
 *   `item_in_warehouse`): the receiver must take it out first, or the moderator sanctions.
 * - **in another offer** or **traded again**: refused (`item_in_offer`, `item_traded_again`; a
 *   traded item is account-bound, so this is a guard, not a path).
 * - **forged** (any upgrade attempt, reroll or improvement): refused (`item_forged`): its Forge
 *   spend can't be undone without creating or destroying value.
 * Gold and materials have no identity: the hero must hold at least what it received, not counting
 * what other trades still hold there (`gold_spent`, `materials_spent`).
 */

const DAY_MS = 86_400_000;

/** A trade can be reversed for 14 days after it was accepted (TRADING.md, owner decision 9a). */
export const TRADE_REVERSAL_WINDOW_MS = 14 * DAY_MS;

/** The last moment a trade accepted at `closedAt` can be reversed (exclusive). */
export function reversalDeadline(closedAt: Date): Date {
  return new Date(closedAt.getTime() + TRADE_REVERSAL_WINDOW_MS);
}

export const TRADE_REVERSAL_CHECKS = [
  'not_completed',
  'already_reversed',
  'too_old',
  'item_gone',
  'item_moved',
  'item_on_shelf',
  'item_in_warehouse',
  'item_in_offer',
  'item_traded_again',
  'item_forged',
  'gold_spent',
  'materials_spent',
] as const;
export type TradeReversalCheck = (typeof TRADE_REVERSAL_CHECKS)[number];

/** The trade's two parties, as a reversal names them. */
export type ReversalParty = 'sender' | 'receiver';

/** One item the trade moved: where it went, and its row now (null: the row is gone). */
export interface ReversalItemFacts {
  id: string;
  /** Who received it in the trade (it goes back to the other party). */
  receivedBy: ReversalParty;
  /** The hero it was handed to. */
  receivedByCharacterId: string;
  /** `traded_count` right after the trade (the snapshot's + 1). */
  tradedCountAfter: number;
  now: null | {
    characterId: string;
    inWarehouse: boolean;
    onShelf: boolean;
    escrowOfferId: string | null;
    tradedCount: number;
    upgradeLevel: number;
    upgradePity: number;
    rerollCount: number;
    forgeCounter: number;
    affixes: readonly RolledAffix[];
  };
}

/** What one party's hero received in gold and materials, and what it can give back now. */
export interface ReversalPurseFacts {
  party: ReversalParty;
  gold: { received: number; available: number };
  materials: Partial<Record<MaterialId, { received: number; available: number }>>;
}

export interface ReversalInput {
  status: string;
  closedAt: Date | null;
  reversedAt: Date | null;
  now: Date;
  items: readonly ReversalItemFacts[];
  purses: readonly ReversalPurseFacts[];
}

export interface TradeReversalRefusal {
  check: TradeReversalCheck;
  /** Whose side the problem is on (the party that received the value). */
  party?: ReversalParty;
  itemId?: string;
  materialId?: MaterialId;
  received?: number;
  available?: number;
  /** For `too_old`: when the window closed. */
  deadline?: string;
}

export interface TradeReversalDecision {
  reversible: boolean;
  refusals: TradeReversalRefusal[];
  /** The end of the 14-day window (null for an offer that never completed). */
  deadline: string | null;
}

/**
 * Whether the trade can be reversed now, with every reason it can't (in a fixed order: the
 * trade itself, then each item in the order given, then each party's gold and materials).
 * A trade that never completed, was already reversed or is past its window stops there.
 */
export function reversalDecision(input: ReversalInput): TradeReversalDecision {
  const deadline = input.closedAt ? reversalDeadline(input.closedAt) : null;
  const iso = deadline?.toISOString() ?? null;
  if (input.status !== 'accepted' || !input.closedAt) {
    return { reversible: false, refusals: [{ check: 'not_completed' }], deadline: iso };
  }
  if (input.reversedAt) {
    return { reversible: false, refusals: [{ check: 'already_reversed' }], deadline: iso };
  }
  if (input.now.getTime() >= deadline!.getTime()) {
    return { reversible: false, refusals: [{ check: 'too_old', deadline: iso! }], deadline: iso };
  }
  const refusals: TradeReversalRefusal[] = [];
  for (const item of input.items) {
    const party = item.receivedBy;
    const at = { party, itemId: item.id };
    const row = item.now;
    if (!row) {
      refusals.push({ check: 'item_gone', ...at });
      continue;
    }
    if (row.characterId !== item.receivedByCharacterId) {
      refusals.push({ check: 'item_moved', ...at });
    } else if (row.onShelf) refusals.push({ check: 'item_on_shelf', ...at });
    else if (row.inWarehouse) refusals.push({ check: 'item_in_warehouse', ...at });
    if (row.escrowOfferId) refusals.push({ check: 'item_in_offer', ...at });
    if (row.tradedCount !== item.tradedCountAfter) {
      refusals.push({ check: 'item_traded_again', ...at });
    }
    if (isForged(row)) refusals.push({ check: 'item_forged', ...at });
  }
  for (const purse of input.purses) {
    const { party } = purse;
    if (purse.gold.received > 0 && purse.gold.available < purse.gold.received) {
      refusals.push({
        check: 'gold_spent',
        party,
        received: purse.gold.received,
        available: Math.max(0, purse.gold.available),
      });
    }
    for (const [id, m] of Object.entries(purse.materials).sort(([a], [b]) =>
      a.localeCompare(b),
    ) as [MaterialId, { received: number; available: number }][]) {
      if (m.received > 0 && m.available < m.received) {
        refusals.push({
          check: 'materials_spent',
          party,
          materialId: id,
          received: m.received,
          available: Math.max(0, m.available),
        });
      }
    }
  }
  return { reversible: refusals.length === 0, refusals, deadline: iso };
}

/** Plain words for each refusal (the moderator's case view and the `409` body). */
export const TRADE_REVERSAL_TEXT: Readonly<Record<TradeReversalCheck, string>> = {
  not_completed: 'Only a completed trade can be reversed. This offer never changed hands.',
  already_reversed: 'This trade has already been reversed.',
  too_old: 'A trade can only be reversed within 14 days of its completion.',
  item_gone:
    'An item from this trade was sold, salvaged or discarded. A reversal never creates items, so it can’t be undone; sanction instead.',
  item_moved:
    'An item from this trade is now with another hero of that account (moved through the account shelf).',
  item_on_shelf: 'An item from this trade is on the account shelf. It has to be taken out first.',
  item_in_warehouse:
    'An item from this trade is in the Warehouse. It has to be taken out to the hero first.',
  item_in_offer: 'An item from this trade sits in another trade offer.',
  item_traded_again: 'An item from this trade has been traded again since.',
  item_forged:
    'An item from this trade was worked at the Forge (an upgrade, reroll or improvement). That work can’t be undone without creating or destroying value.',
  gold_spent:
    'The hero no longer holds the gold it received in this trade (part of it was spent or traded on).',
  materials_spent:
    'The hero no longer holds the materials it received in this trade (part of them were used or traded on).',
};

/** What both players read on a reversed trade (with the moderator's reason). */
export const TRADE_REVERSED_TEXT =
  'A moderator reversed this trade: everything in it went back to the hero it came from.';

/** What a reversed item becomes again: as it was traded (fresh, unworn, unlocked, not held). */
export interface ReversedItemState {
  binding: 'equip';
  boundAccountId: null;
  tradedCount: number;
  holdUntil: null;
  equippedSlot: null;
  locked: false;
  /** Cleared when the first wear came with or after the trade; kept otherwise. */
  firstEquippedAt: Date | null;
}

/**
 * The item's state after a reversal (docs/TRADING.md "T.6 as built"): the trade is undone, so the
 * item is as it was traded: bind on equip again (a tradeable item was fresh), `traded_count` back,
 * no hold, taken off and unlocked. A first wear by the receiver (at or after the accept) is undone
 * with it; an earlier one can't exist (a worn item was never tradeable) but would be kept.
 */
export function reversedItemState(
  item: { tradedCount: number; firstEquippedAt: Date | null },
  acceptedAt: Date,
): ReversedItemState {
  const worn = item.firstEquippedAt;
  return {
    binding: 'equip',
    boundAccountId: null,
    tradedCount: Math.max(0, item.tradedCount - 1),
    holdUntil: null,
    equippedSlot: null,
    locked: false,
    firstEquippedAt: worn && worn.getTime() < acceptedAt.getTime() ? worn : null,
  };
}
