import { and, eq, gt } from 'drizzle-orm';
import { isMaterialId, type HeldValue, type MaterialBundle } from '@worldforge/game-core';
import { tradeHolds } from '../db/schema.js';
import type { Executor } from '../db/types.js';

/**
 * Held value (ticket T.3's seam, filled by T.5, docs/TRADING.md "Cooldowns"): gold and materials a
 * hero received in a trade less than 72 hours ago. They sit in the hero's purse and stacks but
 * can't be spent, traded or put on the shelf until the hold ends, so a reversal (T.6) can always
 * find them.
 *
 * A hold counts while its `held_until` lies after `now`, the transaction's clock (the window rule).
 * Its release (`released_at`, the `trade.release` audit row) is bookkeeping written once
 * afterwards: spending never waits for it, so there is nothing to race. Read under the hero's row
 * lock: holds are only ever added by an accept, which locks the receiving hero too.
 *
 * Every spend goes through `changeGold` / `changeMaterialsTx`, which call this (the
 * `spend-paths.test.ts` guard fails if a new path writes gold or materials another way).
 */
export async function heldValueOf(
  tx: Executor,
  characterId: string,
  now: Date,
): Promise<HeldValue> {
  const rows = await tx
    .select({ gold: tradeHolds.gold, materials: tradeHolds.materials })
    .from(tradeHolds)
    .where(and(eq(tradeHolds.characterId, characterId), gt(tradeHolds.heldUntil, now)));
  let gold = 0;
  const materials: MaterialBundle = {};
  for (const r of rows) {
    gold += r.gold;
    for (const [id, q] of Object.entries(r.materials ?? {})) {
      if (isMaterialId(id) && typeof q === 'number' && q > 0) {
        materials[id] = (materials[id] ?? 0) + q;
      }
    }
  }
  return { gold, materials };
}
