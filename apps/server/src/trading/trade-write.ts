import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import type { TradeStanding, TradingSettings } from '@worldforge/game-core';
import { accounts, type Account } from '../db/schema.js';
import { withTransaction } from '../db/transaction.js';
import type { Transaction } from '../db/types.js';
import { ApiError } from '../errors.js';
import { loadTradingSettings } from '../settings/store.js';
import { loadTradeStanding } from './standing.js';

/**
 * The entry point for trade writes (ticket T.4, for T.5's send, accept, decline and cancel):
 * counts the request in the `trade` rate-limit class before any work (a refused write changes
 * nothing), then runs `fn` in a transaction after share-locking the actor's account row. A
 * sanction being issued holds that row for update (4.1), so a trade write either commits before
 * a new trade restriction, mute or suspension or sees it. `fn` gets the settings read from the
 * table (exact, not the cache), the actor's standing at the transaction's clock, and asks
 * game-core `tradeDecision` itself (it knows the action, the other account and the offer).
 */
export async function tradeWrite<T>(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  fn: (
    tx: Transaction,
    ctx: { account: Account; standing: TradeStanding; settings: TradingSettings; now: Date },
  ) => Promise<T>,
): Promise<T> {
  const accountId = request.auth!.account.id;
  app.tradeWriteLimit(accountId, reply);
  const now = app.authNow();
  return withTransaction(app.db, async (tx) => {
    const [account] = await tx
      .select()
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .for('share');
    if (!account) throw new ApiError(401, 'unauthenticated', 'Not logged in.');
    const standing = (await loadTradeStanding(tx, accountId, now))!;
    const settings = await loadTradingSettings(tx);
    return fn(tx, { account, standing, settings, now });
  });
}
