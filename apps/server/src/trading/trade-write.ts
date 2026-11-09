import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import type { TradeStanding, TradingSettings } from '@worldforge/game-core';
import { accounts, gameSettings, type Account } from '../db/schema.js';
import { idempotentTransaction } from '../idempotency/index.js';
import { withTransaction } from '../db/transaction.js';
import type { Transaction } from '../db/types.js';
import { ApiError } from '../errors.js';
import { TRADING_SETTINGS_KEY, loadTradingSettings } from '../settings/store.js';
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
export interface TradeWriteContext {
  account: Account;
  standing: TradeStanding;
  settings: TradingSettings;
  now: Date;
}

export interface TradeWriteOptions {
  /**
   * Ticket T.5: run inside `idempotentTransaction` (an `Idempotency-Key` is required; a replay
   * returns the stored response), with this status on success.
   */
  idempotent?: { status?: number };
  /**
   * Ticket T.5: share-lock the trading settings row too (after the account row), so a switch
   * being turned off and a send or accept serialise: the write either commits before the edit
   * (and the edit's listener voids the offer) or reads the new settings.
   */
  lockSettings?: boolean;
}

export async function tradeWrite<T>(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  fn: (tx: Transaction, ctx: TradeWriteContext) => Promise<T>,
  options: TradeWriteOptions = {},
): Promise<T> {
  const accountId = request.auth!.account.id;
  app.tradeWriteLimit(accountId, reply);
  const now = app.authNow();
  const body = async (tx: Transaction): Promise<T> => {
    const [account] = await tx
      .select()
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .for('share');
    if (!account) throw new ApiError(401, 'unauthenticated', 'Not logged in.');
    const standing = (await loadTradeStanding(tx, accountId, now))!;
    if (options.lockSettings) await lockTradingSettingsShared(tx);
    const settings = await loadTradingSettings(tx);
    return fn(tx, { account, standing, settings, now });
  };
  if (options.idempotent) {
    return idempotentTransaction(
      app,
      request,
      reply,
      {
        now: () => now,
        ...(options.idempotent.status ? { status: options.idempotent.status } : {}),
      },
      body,
    );
  }
  return withTransaction(app.db, body);
}

/** `select … for share` on the trading settings row (no row: the defaults, nothing to lock). */
export async function lockTradingSettingsShared(tx: Transaction): Promise<void> {
  await tx
    .select({ key: gameSettings.key })
    .from(gameSettings)
    .where(eq(gameSettings.key, TRADING_SETTINGS_KEY))
    .for('share');
}
