import { randomBytes } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  SHRINE_DRAW_SOURCES,
  findCosmetic,
  shrineAccrual,
  shrineBankStart,
  shrineDay,
  shrineEntry,
  shrineMarkPrice,
  shrineOutcome,
  shrinePurchaseProblem,
  shrineSpendSource,
  type ShrineDrawSource,
  type ShrineOutcome,
} from '@worldforge/game-core';
import {
  accounts,
  cosmeticUnlocks,
  shrineAccounts,
  shrineDrawGrants,
  shrineDraws,
  shrinePurchases,
} from '../db/schema.js';
import { writeAudit } from '../db/audit.js';
import type { Executor, Transaction } from '../db/types.js';
import { ApiError } from '../errors.js';
import { grantCosmeticsTx } from '../cosmetics/grant.js';
import { recordTelemetry } from '../telemetry/record.js';

/**
 * The Reward Shrine on the server (ticket 9.5, docs/SHRINE.md). Cosmetic only: it writes
 * `shrine_*` rows, `cosmetic_unlocks` (through `grantCosmeticsTx`) and audit rows, and never a
 * gameplay row.
 *
 * - **Exactly once.** Every Shrine write takes the account's `shrine_accounts` row `for update`
 *   first, so a draw, a purchase and the daily accrual of one account run one at a time; draw
 *   grants carry a unique `(account, source_key)`, so a source pays its draws once whatever races.
 * - **Server seeds.** A draw's seed comes from `crypto` and is stored with the draw; game-core's
 *   `drawShrine(seed)` replays it.
 * - **Reconciled.** Draws = grants + marks (every draw is one or the other), marks held = marks
 *   earned − marks spent, and per source draws spent ≤ draws granted (`reconcileShrine`).
 */

export type Unspent = Record<ShrineDrawSource, number>;

export interface ShrineState {
  /** Draws held, by source (free daily, play, shop). */
  unspent: Unspent;
  marks: number;
  /** The last UTC day the free bank accrued through (`today` after any read). */
  dailyThrough: number;
}

function utcDate(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

/** Draws granted minus draws spent, per source. */
export async function unspentDraws(executor: Executor, accountId: string): Promise<Unspent> {
  const granted = await executor
    .select({
      source: shrineDrawGrants.source,
      n: sql<number>`coalesce(sum(${shrineDrawGrants.count}), 0)::int`,
    })
    .from(shrineDrawGrants)
    .where(eq(shrineDrawGrants.accountId, accountId))
    .groupBy(shrineDrawGrants.source);
  const spent = await executor
    .select({ source: shrineDraws.spentSource, n: sql<number>`count(*)::int` })
    .from(shrineDraws)
    .where(eq(shrineDraws.accountId, accountId))
    .groupBy(shrineDraws.spentSource);
  const out: Unspent = { daily: 0, play: 0, shop: 0 };
  for (const g of granted) out[g.source] += Number(g.n);
  for (const s of spent) out[s.source] -= Number(s.n);
  return out;
}

/**
 * Takes the account's Shrine row `for update` (making it the first time, with the bank starting
 * the day before the account was made) and accrues the free daily draws up to `now`. Returns the
 * state after the accrual. Every Shrine write and the Shrine read call this in their transaction.
 */
export async function openShrineTx(
  tx: Executor,
  accountId: string,
  now: Date,
): Promise<ShrineState> {
  const [account] = await tx
    .select({ createdAt: accounts.createdAt })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  if (!account) throw new ApiError(404, 'not_found', 'No such account.');
  await tx
    .insert(shrineAccounts)
    .values({ accountId, dailyThrough: shrineBankStart(account.createdAt), createdAt: now })
    .onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(shrineAccounts)
    .where(eq(shrineAccounts.accountId, accountId))
    .for('update');
  const unspent = await unspentDraws(tx, accountId);
  const today = shrineDay(now);
  const accrual = shrineAccrual(row!.dailyThrough, unspent.daily, today);
  if (accrual.through !== row!.dailyThrough) {
    await tx
      .update(shrineAccounts)
      .set({ dailyThrough: accrual.through })
      .where(eq(shrineAccounts.accountId, accountId));
  }
  if (accrual.grant > 0) {
    const granted = await insertGrantTx(tx, {
      accountId,
      source: 'daily',
      key: `daily:${utcDate(today)}`,
      count: accrual.grant,
      now,
    });
    if (granted) unspent.daily += accrual.grant;
  }
  return { unspent, marks: row!.marks, dailyThrough: accrual.through };
}

async function insertGrantTx(
  executor: Executor,
  g: {
    accountId: string;
    source: ShrineDrawSource;
    key: string;
    count: number;
    now: Date;
    characterId?: string | null;
  },
): Promise<boolean> {
  if (!Number.isInteger(g.count) || g.count <= 0) return false;
  const inserted = await executor
    .insert(shrineDrawGrants)
    .values({
      accountId: g.accountId,
      source: g.source,
      sourceKey: g.key,
      count: g.count,
      characterId: g.characterId ?? null,
      grantedAt: g.now,
    })
    .onConflictDoNothing()
    .returning({ id: shrineDrawGrants.id });
  if (inserted.length === 0) return false;
  await writeAudit(executor, {
    event: 'shrine.grant',
    accountId: g.accountId,
    characterId: g.characterId ?? null,
    data: { source: g.source, key: g.key, count: g.count },
  });
  recordTelemetry(executor as Transaction, g.now, [
    { metric: 'shrine.grant', dims: [g.source, g.key.split(':')[0]!], amount: g.count },
  ]);
  return true;
}

/**
 * Draws earned in play (event tiers, season honours, deeds), granted once per `key` in the
 * transaction of the event that earned them. Returns whether this call granted them. Needs no
 * Shrine row (the draws are counted from the grant ledger).
 */
export async function grantPlayDrawsTx(
  executor: Executor,
  g: { accountId: string; key: string; count: number; now: Date; characterId?: string | null },
): Promise<boolean> {
  return insertGrantTx(executor, { ...g, source: 'play' });
}

export interface DrawResult extends ShrineOutcome {
  drawId: string;
  seed: string;
  spentSource: ShrineDrawSource;
}

/** One draw: spends a held draw (daily first), rolls a fresh `crypto` seed and pays the outcome. */
export async function drawTx(
  tx: Transaction,
  accountId: string,
  now: Date,
  seed: string = randomBytes(16).toString('hex'),
): Promise<DrawResult> {
  const state = await openShrineTx(tx, accountId, now);
  const spentSource = shrineSpendSource(state.unspent);
  if (!spentSource) {
    throw new ApiError(409, 'no_draws', 'You have no draws at the Shrine. Come back tomorrow.');
  }
  const owned = await ownedShrineIds(tx, accountId);
  const outcome = shrineOutcome(seed, owned);
  const [draw] = await tx
    .insert(shrineDraws)
    .values({
      accountId,
      spentSource,
      seed,
      cosmeticId: outcome.cosmeticId,
      rarity: outcome.rarity,
      outcome: outcome.outcome,
      marks: outcome.marks,
      drawnAt: now,
    })
    .returning({ id: shrineDraws.id });
  if (outcome.outcome === 'grant') {
    const granted = await grantCosmeticsTx(
      tx,
      { accountId, now, source: `shrine:draw:${draw!.id}` },
      [outcome.cosmeticId],
    );
    // The Shrine row lock serialises every writer of Shrine cosmetics, so the grant cannot lose.
    if (granted.length !== 1) throw new Error('shrine: the draw’s cosmetic was granted elsewhere');
  } else {
    await tx
      .update(shrineAccounts)
      .set({ marks: sql`${shrineAccounts.marks} + ${outcome.marks}` })
      .where(eq(shrineAccounts.accountId, accountId));
  }
  await writeAudit(tx, {
    event: 'shrine.draw',
    accountId,
    data: {
      drawId: draw!.id,
      seed,
      spentSource,
      cosmeticId: outcome.cosmeticId,
      rarity: outcome.rarity,
      outcome: outcome.outcome,
      marks: outcome.marks,
    },
  });
  recordTelemetry(tx, now, [
    {
      metric: 'shrine.draw',
      dims: [spentSource, outcome.rarity, outcome.outcome],
      amount: outcome.marks,
    },
  ]);
  return { ...outcome, drawId: draw!.id, seed, spentSource };
}

/** Buys a chosen Shrine cosmetic with marks (once per account). */
export async function buyWithMarksTx(
  tx: Transaction,
  accountId: string,
  cosmeticId: string,
  now: Date,
): Promise<{ cosmeticId: string; price: number }> {
  const state = await openShrineTx(tx, accountId, now);
  const owned = await ownedShrineIds(tx, accountId);
  const problem = shrinePurchaseProblem(cosmeticId, owned, state.marks);
  if (problem === 'unknown_offer') {
    throw new ApiError(422, 'unknown_offer', 'The Shrine does not offer that.');
  }
  if (problem === 'already_owned') {
    throw new ApiError(409, 'already_owned', 'You already have that keepsake.');
  }
  if (problem === 'insufficient_marks') {
    throw new ApiError(422, 'insufficient_marks', 'You do not have enough Shrine marks for that.');
  }
  const price = shrineMarkPrice(cosmeticId)!;
  await tx.insert(shrinePurchases).values({ accountId, cosmeticId, price, boughtAt: now });
  const granted = await grantCosmeticsTx(tx, { accountId, now, source: 'shrine:marks' }, [
    cosmeticId,
  ]);
  if (granted.length !== 1) throw new Error('shrine: the bought cosmetic was granted elsewhere');
  await tx
    .update(shrineAccounts)
    .set({ marks: sql`${shrineAccounts.marks} - ${price}` })
    .where(eq(shrineAccounts.accountId, accountId));
  const entry = shrineEntry(cosmeticId)!;
  await writeAudit(tx, {
    event: 'shrine.buy',
    accountId,
    data: { cosmeticId, kind: findCosmetic(cosmeticId)!.kind, rarity: entry.rarity, price },
  });
  recordTelemetry(tx, now, [
    { metric: 'shrine.buy', dims: [entry.rarity, entry.kind], amount: price },
  ]);
  return { cosmeticId, price };
}

async function ownedShrineIds(executor: Executor, accountId: string): Promise<Set<string>> {
  const rows = await executor
    .select({ id: cosmeticUnlocks.cosmeticId })
    .from(cosmeticUnlocks)
    .where(eq(cosmeticUnlocks.accountId, accountId));
  return new Set(rows.map((r) => r.id));
}

/** The account's latest draws, newest first. */
export async function recentDraws(executor: Executor, accountId: string, limit = 10) {
  return executor
    .select({
      id: shrineDraws.id,
      cosmeticId: shrineDraws.cosmeticId,
      rarity: shrineDraws.rarity,
      outcome: shrineDraws.outcome,
      marks: shrineDraws.marks,
      spentSource: shrineDraws.spentSource,
      seed: shrineDraws.seed,
      drawnAt: shrineDraws.drawnAt,
    })
    .from(shrineDraws)
    .where(eq(shrineDraws.accountId, accountId))
    .orderBy(desc(shrineDraws.drawnAt), desc(shrineDraws.id))
    .limit(limit);
}

export interface ShrineReconcile {
  accountId: string;
  draws: number;
  grants: number;
  marksDraws: number;
  marksEarned: number;
  marksSpent: number;
  marksHeld: number;
  /** Per source: draws granted and spent. */
  bySource: Record<ShrineDrawSource, { granted: number; spent: number }>;
  /** Draws whose stored seed no longer replays to what they paid (always 0). */
  replayMismatches: number;
  ok: boolean;
}

/**
 * Ticket 9.5's reconciliation for one account: draws = grants + marks draws (each grant draw has
 * its `shrine:draw:<id>` unlock), marks held = earned − spent, draws spent ≤ granted per source,
 * and every stored seed replays to the cosmetic it drew.
 */
export async function reconcileShrine(
  executor: Executor,
  accountId: string,
): Promise<ShrineReconcile> {
  const draws = await executor
    .select()
    .from(shrineDraws)
    .where(eq(shrineDraws.accountId, accountId));
  const unlocks = await executor
    .select({ source: cosmeticUnlocks.source, id: cosmeticUnlocks.cosmeticId })
    .from(cosmeticUnlocks)
    .where(
      and(eq(cosmeticUnlocks.accountId, accountId), sql`${cosmeticUnlocks.source} like 'shrine:%'`),
    );
  const purchases = await executor
    .select()
    .from(shrinePurchases)
    .where(eq(shrinePurchases.accountId, accountId));
  const [row] = await executor
    .select({ marks: shrineAccounts.marks })
    .from(shrineAccounts)
    .where(eq(shrineAccounts.accountId, accountId));
  const grantsBySource = await executor
    .select({
      source: shrineDrawGrants.source,
      n: sql<number>`coalesce(sum(${shrineDrawGrants.count}), 0)::int`,
    })
    .from(shrineDrawGrants)
    .where(eq(shrineDrawGrants.accountId, accountId))
    .groupBy(shrineDrawGrants.source);
  const bySource = Object.fromEntries(
    SHRINE_DRAW_SOURCES.map((s) => [s, { granted: 0, spent: 0 }]),
  ) as ShrineReconcile['bySource'];
  for (const g of grantsBySource) bySource[g.source].granted = Number(g.n);
  for (const d of draws) bySource[d.spentSource].spent += 1;
  const unlockBySource = new Map(unlocks.map((u) => [u.source, u.id]));
  const grantDraws = draws.filter((d) => d.outcome === 'grant');
  const grants = grantDraws.filter(
    (d) => unlockBySource.get(`shrine:draw:${d.id}`) === d.cosmeticId,
  ).length;
  const marksDraws = draws.filter((d) => d.outcome === 'marks').length;
  const marksEarned = draws.reduce((a, d) => a + d.marks, 0);
  const marksSpent = purchases.reduce((a, p) => a + p.price, 0);
  const bought = purchases.filter((p) =>
    unlocks.some((u) => u.source === 'shrine:marks' && u.id === p.cosmeticId),
  ).length;
  let replayMismatches = 0;
  for (const d of draws) {
    const replay = shrineOutcome(d.seed, new Set()).cosmeticId;
    if (replay !== d.cosmeticId) replayMismatches += 1;
  }
  const marksHeld = row?.marks ?? 0;
  const ok =
    draws.length === grants + marksDraws &&
    grantDraws.length === grants &&
    marksHeld === marksEarned - marksSpent &&
    bought === purchases.length &&
    SHRINE_DRAW_SOURCES.every((s) => bySource[s].spent <= bySource[s].granted) &&
    replayMismatches === 0;
  return {
    accountId,
    draws: draws.length,
    grants,
    marksDraws,
    marksEarned,
    marksSpent,
    marksHeld,
    bySource,
    replayMismatches,
    ok,
  };
}
