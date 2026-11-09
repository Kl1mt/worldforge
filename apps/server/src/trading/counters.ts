import { and, eq, inArray, or, sql } from 'drizzle-orm';
import {
  TRADE_CAPS,
  TRADE_CAP_METRICS,
  checkTradeCaps,
  counterKey,
  tradeWindows,
  type TradeCapMetric,
  type TradeCapRefusal,
  type TradeCounterKey,
  type TradeCounterValues,
  type TradeDirection,
  type TradingLimits,
} from '@worldforge/game-core';
import { tradeCounters } from '../db/schema.js';
import type { Executor, Transaction } from '../db/types.js';
import { ApiError } from '../errors.js';

/**
 * Trade cap counters (ticket T.4, docs/TRADING.md "T.4 as built"). The API T.5 calls:
 *
 * - **At send** (no reservation): `readTradeCounters` + game-core `checkTradeCaps` for both
 *   accounts, so an offer that couldn't be accepted right now is refused up front. Nothing is
 *   counted: an open offer must not use up the receiver's cap (a sender could block a friend's
 *   week with offers they never mean to complete), and a declined or expired offer leaves nothing
 *   to give back.
 * - **At accept**: `commitTradeCounters(tx, …)` inside the accept transaction: takes both
 *   accounts' counter locks, reads the windows holding the transaction's clock, checks every cap
 *   against the fresh settings (`loadTradingSettings(tx)`), and increments, all or nothing. A
 *   refusal throws `409 trade_cap_reached` and the accept rolls back. Check-then-increment under
 *   a lock: two accepts competing for the last slot of a cap serialise, and exactly one fits.
 *
 * **Locks:** a transaction-scoped advisory lock per account (`trade-counters:<id>`), taken in id
 * order. T.5 takes them **last**, after its row locks (accounts, heroes, items); only counter
 * reads and writes run under them, and nothing else takes them, so there is no lock cycle.
 */

export async function lockTradeCounters(tx: Executor, accountIds: string[]): Promise<void> {
  for (const id of [...new Set(accountIds)].sort()) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`trade-counters:${id}`}, 0))`,
    );
  }
}

/** The account's counters for the day and the week holding `now`. */
export async function readTradeCounters(
  executor: Executor,
  accountId: string,
  now: Date,
): Promise<TradeCounterValues> {
  const w = tradeWindows(now);
  const rows = await executor
    .select()
    .from(tradeCounters)
    .where(
      and(
        eq(tradeCounters.accountId, accountId),
        or(
          and(eq(tradeCounters.period, 'day'), eq(tradeCounters.windowStart, w.day.key)),
          and(eq(tradeCounters.period, 'week'), eq(tradeCounters.windowStart, w.week.key)),
        ),
      ),
    );
  const out: TradeCounterValues = {};
  for (const r of rows) {
    const metric = r.metric as TradeCapMetric;
    if (!TRADE_CAP_METRICS.includes(metric) || TRADE_CAPS[metric].period !== r.period) continue;
    out[counterKey(metric, r.direction)] = r.amount;
  }
  return out;
}

export interface TradeCounterParty {
  accountId: string;
  /** What this trade adds for the account (game-core `tradeCapIncrements`). */
  adding: TradeCounterValues;
}

export interface TradeCapRefusalView extends TradeCapRefusal {
  /** Whose cap: the acting account's, or the other one's. */
  party: 'you' | 'them';
}

/**
 * Inside the accept transaction: checks every cap of every party and, if all fit, adds the
 * trade to the counters. Throws `409 trade_cap_reached` (nothing written) otherwise, with the
 * refusals; caps of the other party carry no numbers (only that one of theirs is full).
 */
export async function commitTradeCounters(
  tx: Transaction,
  input: { actorId: string; parties: TradeCounterParty[]; limits: TradingLimits; now: Date },
): Promise<void> {
  const { parties, limits, now } = input;
  await lockTradeCounters(
    tx,
    parties.map((p) => p.accountId),
  );
  const refusals: TradeCapRefusalView[] = [];
  for (const p of parties) {
    const used = await readTradeCounters(tx, p.accountId, now);
    for (const r of checkTradeCaps({ used, adding: p.adding, limits, now })) {
      refusals.push({ ...r, party: p.accountId === input.actorId ? 'you' : 'them' });
    }
  }
  if (refusals.length > 0) throw tradeCapError(refusals);
  const w = tradeWindows(now);
  for (const p of parties) {
    for (const [key, amount] of Object.entries(p.adding) as [TradeCounterKey, number][]) {
      if (!amount || amount <= 0) continue;
      const [metric, direction] = key.split(':') as [TradeCapMetric, TradeDirection];
      const period = TRADE_CAPS[metric].period;
      await tx
        .insert(tradeCounters)
        .values({
          accountId: p.accountId,
          period,
          windowStart: w[period].key,
          metric,
          direction,
          amount,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            tradeCounters.accountId,
            tradeCounters.period,
            tradeCounters.windowStart,
            tradeCounters.metric,
            tradeCounters.direction,
          ],
          set: { amount: sql`${tradeCounters.amount} + ${amount}`, updatedAt: now },
        });
    }
  }
}

/** `409 trade_cap_reached`; the other party's refusals say only which cap, not its numbers. */
export function tradeCapError(refusals: TradeCapRefusalView[]): ApiError {
  return new ApiError(409, 'trade_cap_reached', 'This trade would go over a trade limit.', {
    refusals: refusals.map((r) =>
      r.party === 'you'
        ? r
        : { check: r.check, party: r.party, metric: r.metric, direction: r.direction },
    ),
  });
}

/** Counter rows of several accounts in the current windows (reconciliation and tests). */
export async function tradeCounterRows(executor: Executor, accountIds: string[]) {
  if (accountIds.length === 0) return [];
  return executor.select().from(tradeCounters).where(inArray(tradeCounters.accountId, accountIds));
}
