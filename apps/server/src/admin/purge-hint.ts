import { count, lt } from 'drizzle-orm';
import { characters } from '../db/schema.js';
import type { Executor } from '../db/types.js';
import { RESTORE_WINDOW_MS } from './inspector.js';

/** Ticket D.4: soft-deleted heroes past the restore window (the CLI's `purge` would remove them). */
export async function purgeDueHint(db: Executor, now: Date): Promise<{ purgeDue: number }> {
  const [row] = await db
    .select({ n: count() })
    .from(characters)
    .where(lt(characters.deletedAt, new Date(now.getTime() - RESTORE_WINDOW_MS)));
  return { purgeDue: row?.n ?? 0 };
}
