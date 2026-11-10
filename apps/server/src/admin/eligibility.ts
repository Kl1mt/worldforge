import { sql, type SQL } from 'drizzle-orm';

/**
 * Ticket D.4: the read-time rules that keep test accounts and soft-deleted heroes off every board,
 * ladder and season archive (and so out of season awards), next to 5.2's sanction rule. `e` is the
 * row alias with `account_id` and `character_id` (leaderboard, season and arena rows).
 */
export const notTestOrDeleted: SQL = sql`not exists (select 1 from accounts ta
    where ta.id = e.account_id and ta.is_test)
  and not exists (select 1 from characters dc
    where dc.id = e.character_id and dc.deleted_at is not null)`;
