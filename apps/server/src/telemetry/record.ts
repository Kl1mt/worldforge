import { sql } from 'drizzle-orm';
import { telemetryDaily } from '../db/schema.js';
import type { Executor, Transaction } from '../db/types.js';

/**
 * Per-transaction telemetry recorder (ticket 3.8, docs/TELEMETRY.md).
 *
 * Value paths call `recordTelemetry(tx, now, counts)` next to their `writeAudit`. Nothing is
 * written then: the counts are summed in memory per transaction, and `withTransaction` flushes
 * them in one sorted upsert as the transaction's last statement, so:
 * - the rollups commit or roll back with the audit row they mirror (a failed request, a refused
 *   one and a retried attempt leave nothing; an `Idempotency-Key` replay never runs the handler);
 * - the hot counter rows are locked only between that last statement and the commit;
 * - every transaction takes the counter row locks in the same (sorted) order, so two flushes can
 *   never deadlock each other, and a transaction flushes at most once.
 * Reads the game clock (`now`) for the day bucket; never reads or changes game state.
 */

/** The metrics in `telemetry_daily`. Dimensions per metric: docs/TELEMETRY.md. */
export const TELEMETRY_METRICS = [
  'item.drop',
  'item.variant',
  'item.effect',
  'item.set',
  'item.fate',
  'item.sold',
  'item.salvaged',
  'item.discarded',
  'pack.overflow',
  'pack.over_capacity',
  'gold.in',
  'gold.out',
  'material.in',
  'material.out',
  'xp.in',
  'farming.settle',
  'crypt.start',
  'crypt.claim',
  'quest.reward',
  'forge',
  'guild_boss.attempt',
  'guild_boss.stage',
  // Ticket 4.6: community projects.
  'community.contribute',
  'community.stage',
] as const;
export type TelemetryMetric = (typeof TELEMETRY_METRICS)[number];

export interface TelemetryCount {
  metric: TelemetryMetric;
  /** Up to three content-id dimensions (area, rarity, recipe, …); never a player-specific value. */
  dims?: readonly string[];
  /** Occurrences (default 1). */
  events?: number;
  /** Summed quantity (gold, items, materials, XP; default 0). */
  amount?: number;
}

/**
 * Dimensions are content ids and small enums. This guard keeps ids, names and emails out by
 * construction: a uuid, an `@` or free text fails loudly in tests instead of reaching a rollup.
 */
const DIM_PATTERN = /^[A-Za-z0-9_:+.-]{0,64}$/;
const UUID_LIKE = /[0-9a-f]{8}-[0-9a-f]{4}-/i;

export function assertTelemetryDim(dim: string): void {
  if (!DIM_PATTERN.test(dim) || UUID_LIKE.test(dim)) {
    throw new Error(`telemetry dimension is not a content id: ${JSON.stringify(dim)}`);
  }
}

/** UTC calendar day of a game-clock instant, `YYYY-MM-DD`. */
export function telemetryDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

interface Pending {
  day: string;
  metric: string;
  dim1: string;
  dim2: string;
  dim3: string;
  events: number;
  amount: number;
}

const SEP = '\u0000';
const pending = new WeakMap<object, Map<string, Pending>>();

/** Adds counts to the transaction's pending rollups (written by `flushTelemetry`). */
export function recordTelemetry(
  tx: Transaction,
  now: Date,
  counts: readonly TelemetryCount[],
): void {
  if (counts.length === 0) return;
  const day = telemetryDay(now);
  let rows = pending.get(tx);
  if (!rows) {
    rows = new Map();
    pending.set(tx, rows);
  }
  for (const c of counts) {
    const dims = c.dims ?? [];
    if (dims.length > 3) throw new Error(`telemetry ${c.metric}: at most three dimensions`);
    for (const d of dims) assertTelemetryDim(d);
    const events = c.events ?? 1;
    const amount = c.amount ?? 0;
    if (!Number.isSafeInteger(events) || events < 0 || !Number.isSafeInteger(amount)) {
      throw new Error(`telemetry ${c.metric}: events and amount must be integers`);
    }
    if (events === 0 && amount === 0) continue;
    const [dim1 = '', dim2 = '', dim3 = ''] = dims;
    const key = [day, c.metric, dim1, dim2, dim3].join(SEP);
    const row = rows.get(key);
    if (row) {
      row.events += events;
      row.amount += amount;
    } else {
      rows.set(key, { day, metric: c.metric, dim1, dim2, dim3, events, amount });
    }
  }
}

/** Pending rows of a transaction, sorted by key (the lock order). For tests and the flush. */
export function pendingTelemetry(tx: Executor): Pending[] {
  const rows = pending.get(tx);
  if (!rows) return [];
  return [...rows.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, r]) => r);
}

/**
 * Writes the transaction's pending rollups in one upsert, in key order. `withTransaction` calls it
 * as the last statement of every transaction; a no-op when nothing was recorded.
 */
export async function flushTelemetry(tx: Executor): Promise<void> {
  const rows = pendingTelemetry(tx);
  pending.delete(tx);
  if (rows.length === 0) return;
  await tx
    .insert(telemetryDaily)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        telemetryDaily.day,
        telemetryDaily.metric,
        telemetryDaily.dim1,
        telemetryDaily.dim2,
        telemetryDaily.dim3,
      ],
      set: {
        events: sql`${telemetryDaily.events} + excluded.events`,
        amount: sql`${telemetryDaily.amount} + excluded.amount`,
      },
    });
}
