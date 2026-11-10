import { sql } from 'drizzle-orm';
import type { Database } from '../db/types.js';
import { queryRows } from '../db/query.js';

/**
 * The newest game timestamp the playtest database holds (ms), or null when it holds none. The
 * playtest clock starts no earlier than this (`startOffsetMs`), so time never runs backwards across
 * restarts even if the saved clock offset is lost or stale (ticket P.1).
 *
 * Phase 1 only had farming times. Ticket 2.8 adds every Phase 2 table that stamps the clock: a hero
 * in the crypt has no activity row, and a clock restarted behind a dungeon run would leave the run
 * "in progress" until real time caught up with its end (days with `--fast`).
 *
 * Ticket 3.8: telemetry rollups stamp the game day (its start, UTC, is a safe lower bound).
 * Ticket 4.9: guild boss attempts and rewards stamp the game clock (the week of an attempt is
 * derived from it); `guild_boss_weeks.updated_at` and `guild_boss_stages.reached_at` equal an
 * attempt's `created_at`.
 * Ticket 4.6: community projects (last change), contribution windows and world flags.
 */
export async function latestStoredTimeMs(db: Database): Promise<number | null> {
  const rows = await queryRows<{ ms: number | null }>(
    db,
    sql`
    select (extract(epoch from greatest(
      (select max(greatest(settled_at, last_seen_at)) from activities),
      (select max(coalesce(claimed_at, started_at)) from dungeon_runs),
      (select max(coalesce(turned_in_at, accepted_at)) from character_quests),
      (select max(created_at) from merchant_purchases),
      (select max(created_at) from item_instances),
      (select max(created_at) from idempotency_keys),
      (select max(day)::timestamp at time zone 'UTC' from telemetry_daily),
      (select max(day)::timestamp at time zone 'UTC' from telemetry_daily_test),
      (select max(created_at) from guild_boss_attempts),
      (select max(greatest(earned_at, claimed_at, created_at)) from guild_boss_rewards)
,
      (select max(updated_at) from community_projects),
      (select max(day)::timestamp at time zone 'UTC' from community_contributions),
      (select max(set_at) from world_flags)
    )) * 1000)::float8 as ms`,
  );
  const ms = rows[0]?.ms;
  return ms === null || ms === undefined ? null : Number(ms);
}
