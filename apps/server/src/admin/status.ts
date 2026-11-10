import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { count, gte, isNull, sql } from 'drizzle-orm';
import { accountPresence, accounts, characters } from '../db/schema.js';
import { MIGRATIONS_FOLDER } from '../db/migrate.js';
import { queryRows } from '../db/query.js';
import type { Database } from '../db/types.js';

/**
 * Server status for the admin panel (ticket D.3, docs/DEPLOY.md "Admin panel"). Aggregates only:
 * the activity counts come from 4.3's presence rows and never show a player's time.
 */

/** What the image was built from (`deploy/Dockerfile` bakes it in); null when not recorded. */
export interface BuildInfo {
  gitSha: string | null;
  buildTime: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function databaseStatus(
  db: Database,
): Promise<{ status: 'up' | 'down'; latencyMs: number | null }> {
  const started = performance.now();
  try {
    await db.execute(sql`select 1`);
    return { status: 'up', latencyMs: Math.round((performance.now() - started) * 10) / 10 };
  } catch {
    return { status: 'down', latencyMs: null };
  }
}

export async function statusCounts(db: Database, now: Date) {
  const since = (ms: number) => new Date(now.getTime() - ms);
  const [[a], [c], [d1], [d7]] = await Promise.all([
    db.select({ n: count() }).from(accounts),
    db.select({ n: count() }).from(characters).where(isNull(characters.deletedAt)),
    db
      .select({ n: count() })
      .from(accountPresence)
      .where(gte(accountPresence.lastSeenAt, since(DAY_MS))),
    db
      .select({ n: count() })
      .from(accountPresence)
      .where(gte(accountPresence.lastSeenAt, since(7 * DAY_MS))),
  ]);
  return {
    accounts: a?.n ?? 0,
    characters: c?.n ?? 0,
    active24h: d1?.n ?? 0,
    active7d: d7?.n ?? 0,
  };
}

export interface MigrationStatus {
  /** Migrations shipped with this build (the drizzle journal). */
  available: number;
  /** Rows in `drizzle.__drizzle_migrations`. */
  applied: number;
  /** The newest shipped migration's tag. */
  latest: string | null;
  /** Shipped migrations newer than the newest applied one (should be empty after a deploy). */
  pending: string[];
}

/**
 * Compares the build's drizzle journal with the database's migration table, the way the migrator
 * decides what to run (by the journal's `when`). Null when either cannot be read.
 */
export async function migrationStatus(
  db: Database,
  folder: string = MIGRATIONS_FOLDER,
): Promise<MigrationStatus | null> {
  try {
    const journal = JSON.parse(await readFile(join(folder, 'meta', '_journal.json'), 'utf8')) as {
      entries: { tag: string; when: number }[];
    };
    const [row] = await queryRows<{ applied: number; last: string | null }>(
      db,
      sql`select count(*)::int as applied, max(created_at)::text as last
          from drizzle.__drizzle_migrations`,
    );
    const last = row?.last == null ? null : Number(row.last);
    return {
      available: journal.entries.length,
      applied: row?.applied ?? 0,
      latest: journal.entries.at(-1)?.tag ?? null,
      pending: journal.entries.filter((e) => last === null || e.when > last).map((e) => e.tag),
    };
  } catch {
    return null;
  }
}
