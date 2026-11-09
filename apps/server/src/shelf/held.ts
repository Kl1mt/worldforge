import { NO_HELD_VALUE, type HeldValue } from '@worldforge/game-core';
import type { Executor } from '../db/types.js';

/**
 * The held-value seam of the account shelf (ticket T.3, docs/TRADING.md "3. The shared account
 * shelf"): gold and materials a hero received in a trade under 72 hours ago can't go onto the
 * shelf until the hold ends, so a reversal can always find them.
 *
 * Trading doesn't exist yet, so nothing is held: this always answers `NO_HELD_VALUE`. T.5 adds
 * `trade_holds` (hero, gold, materials, until) and replaces the body with a read of that hero's
 * holds whose `until` lies after `now` (the transaction's clock: the window rule). The shelf's
 * deposit already subtracts what this returns from what the hero may move (game-core
 * `planShelfDeposit`), so T.5 changes this function only. Items carry their own hold (T.1's
 * `hold_until`), which the deposit checks directly.
 */
export async function heldValueOf(
  _tx: Executor,
  _characterId: string,
  _now: Date,
): Promise<HeldValue> {
  return NO_HELD_VALUE;
}
