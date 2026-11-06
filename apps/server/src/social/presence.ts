import { sql } from 'drizzle-orm';
import { PRESENCE_WRITE_INTERVAL_MS } from '@worldforge/game-core';
import { accountPresence } from '../db/schema.js';
import type { Database } from '../db/types.js';

const SWEEP_AT = 10_000;

/**
 * Records "last seen" from authenticated requests (ticket 4.3, docs/SOCIAL.md "Presence"),
 * coalesced in process memory: at most one upsert per account every `intervalMs` (default 3 min),
 * however many requests it makes (3.9 allows 900 a minute). A restart forgets the memory, so the
 * first request after it writes once. The upsert never moves the time backwards and touches only
 * `account_presence`, never the account row. A failure is logged and never fails the request.
 */
export function createPresenceRecorder(
  db: Database,
  onError: (err: unknown) => void,
  intervalMs: number = PRESENCE_WRITE_INTERVAL_MS,
) {
  const written = new Map<string, number>();
  return async function seen(accountId: string, at: Date): Promise<void> {
    const t = at.getTime();
    const last = written.get(accountId);
    if (last !== undefined && t - last < intervalMs && t >= last) return;
    if (last === undefined && written.size >= SWEEP_AT) {
      for (const [id, w] of written) if (t - w >= intervalMs) written.delete(id);
    }
    written.set(accountId, t);
    try {
      await db
        .insert(accountPresence)
        .values({ accountId, lastSeenAt: at })
        .onConflictDoUpdate({
          target: accountPresence.accountId,
          set: {
            lastSeenAt: sql`greatest(${accountPresence.lastSeenAt}, excluded.last_seen_at)`,
          },
        });
    } catch (err) {
      written.delete(accountId);
      onError(err);
    }
  };
}
