import { asc, isNotNull } from 'drizzle-orm';
import { worldFlagsFrom, type WorldFlags } from '@worldforge/game-core';
import { communityProjects, worldFlags } from '../db/schema.js';
import type { Database, Executor } from '../db/types.js';

/**
 * Global world state (ticket 4.6, docs/COMMUNITY.md "World state"). The `world_flags` table is
 * the one source of truth; this module reads it and keeps one cached copy per server process.
 *
 * - **Read** through `app.worldState.get()`: served from memory while fresh.
 * - **Invalidated** right after a transaction that completed a project commits (the contribute
 *   route calls `invalidate()`), so the next read sees the new flag at once.
 * - **TTL backstop** (`DEFAULT_WORLD_STATE_TTL_MS`, 60 s): a change made by another process (the
 *   owner's `admin:project` CLI) shows up within a minute without a restart.
 * - **Restarts** start empty and load from the table, so nothing is lost or stale across them.
 * - **No stale write-back:** a load that started before an `invalidate()` does not store its
 *   result (generation check), so a read racing a completion cannot cache the old flags.
 *
 * Inside a value transaction, read the table directly (`loadWorldState(tx)`) instead: the cache
 * is for views and gates, the table for decisions that must be exact.
 */

export interface WorldState {
  flags: WorldFlags;
  /** Completed projects, oldest first (game-clock completion time). */
  completed: { projectId: string; completedAt: Date }[];
}

export const DEFAULT_WORLD_STATE_TTL_MS = 60_000;

export async function loadWorldState(db: Executor): Promise<WorldState> {
  const [flags, done] = await Promise.all([
    db.select({ id: worldFlags.flagId }).from(worldFlags),
    db
      .select({
        projectId: communityProjects.projectId,
        completedAt: communityProjects.completedAt,
      })
      .from(communityProjects)
      .where(isNotNull(communityProjects.completedAt))
      .orderBy(asc(communityProjects.completedAt), asc(communityProjects.projectId)),
  ]);
  return {
    flags: worldFlagsFrom(flags.map((f) => f.id)),
    completed: done.map((d) => ({ projectId: d.projectId, completedAt: d.completedAt! })),
  };
}

export class WorldStateCache {
  private cached: { state: WorldState; loadedAt: number } | null = null;
  private generation = 0;
  /** Database reads so far (tests). */
  loads = 0;

  constructor(
    private readonly db: Database,
    private readonly ttlMs: number = DEFAULT_WORLD_STATE_TTL_MS,
    private readonly clock: () => number = Date.now,
  ) {}

  async get(): Promise<WorldState> {
    const hit = this.cached;
    if (hit && this.clock() - hit.loadedAt < this.ttlMs) return hit.state;
    const generation = this.generation;
    this.loads += 1;
    const state = await loadWorldState(this.db);
    if (generation === this.generation) this.cached = { state, loadedAt: this.clock() };
    return state;
  }

  async flags(): Promise<WorldFlags> {
    return (await this.get()).flags;
  }

  /** Drops the cached copy; call after a commit that changed flags or completions. */
  invalidate(): void {
    this.generation += 1;
    this.cached = null;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Ticket 4.6: the cached global world state (flags set by community projects). */
    worldState: WorldStateCache;
  }
}
