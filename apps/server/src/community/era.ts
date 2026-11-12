import { sql } from 'drizzle-orm';
import { worldEra, type WorldFlags } from '@worldforge/game-core';
import { broadcastTx } from '../inbox/notify.js';
import { writeAudit } from '../db/audit.js';
import type { Transaction } from '../db/types.js';
import { recordTelemetry } from '../telemetry/record.js';

/**
 * World eras (ticket 6.7, docs/WORLD.md "Eras of Graumark"). The era is never stored: it is
 * game-core `worldEra(flags)` of the `world_flags` table, so it can't drift from the flags. Every
 * transaction that changes the flags calls this with the flags before and after (read under its
 * own locks): when the derived era moves, it writes `world.era_change` (from, to, and what moved
 * it) and the telemetry count `world.era` (from, to) in the same transaction, so the two
 * reconcile exactly (`reconcileWithAudit` "world: era changes").
 */
/**
 * Inside a transaction that changes `world_flags`: the world lock (transaction-scoped advisory
 * lock), taken before reading the flags it compares, so two flag changes (a project completing, an
 * admin toggle) never both read the same "before" and the era rows always chain. Lock order: the
 * project's (or the admin's) own lock first, then this one.
 */
export async function lockWorldFlags(tx: Transaction): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('world:flags', 0))`);
}

export async function recordEraChange(
  tx: Transaction,
  before: WorldFlags,
  after: WorldFlags,
  now: Date,
  cause: { projectId?: string; flagId?: string; by?: 'admin' },
): Promise<{ from: string; to: string } | null> {
  const from = worldEra(before).id;
  const to = worldEra(after).id;
  if (from === to) return null;
  await writeAudit(tx, { event: 'world.era_change', data: { from, to, ...cause } });
  // Ticket 8.5: every account's inbox (once per era).
  await broadcastTx(tx, { kind: 'world.era', data: { from, to }, now, dedupeKey: `era:${to}` });
  recordTelemetry(tx, now, [{ metric: 'world.era', dims: [from, to] }]);
  return { from, to };
}
