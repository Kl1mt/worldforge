import { sql } from 'drizzle-orm';
import { queryRows } from '../db/query.js';
import type { Database, DatabaseHandle, Executor } from '../db/types.js';

/**
 * Cache invalidation across API instances (ticket 6.9, docs/DEPLOY.md "Running two API
 * instances"). Each instance keeps its own copy of three caches:
 *
 * - `world`: the world state (4.6: flags and completed projects, `app.worldState`);
 * - `settings`: the game settings (T.2, `app.gameSettings`);
 * - `formulas`: the season windows and board formula plan (6.1, `app.formulaVersions`): the
 *   season state. Event state (6.6) is not cached; it is read from its table on every request.
 *
 * A write that changes what a cache holds calls `bumpCacheVersion(tx, name)` **in its
 * transaction**: the cache's row in `cache_versions` gets the next version, and `NOTIFY wf_cache`
 * carries the name, delivered by PostgreSQL only when the transaction commits. Every instance
 * listens on a dedicated connection and drops its copy on the notify (the next read loads the
 * table). **Fallback:** an instance that missed a notify (its listening connection dropped, it was
 * reconnecting) compares the versions every `pollMs` (default 15 s) and drops what changed, and
 * each cache still expires after its 60 s TTL, so a change reaches every instance within 60 s
 * whatever happens, as before 6.9. The owner's CLIs bump too, so their changes arrive at once.
 */
export const CACHE_CHANNEL = 'wf_cache';
export const SHARED_CACHES = ['world', 'settings', 'formulas'] as const;
export type SharedCacheName = (typeof SHARED_CACHES)[number];
export const DEFAULT_CACHE_POLL_MS = 15_000;

/** Bumps a cache's version and notifies every instance (on commit when `ex` is a transaction). */
export async function bumpCacheVersion(ex: Executor, name: SharedCacheName): Promise<void> {
  await ex.execute(sql`
    insert into cache_versions (name, version, updated_at) values (${name}, 1, now())
    on conflict (name) do update set version = cache_versions.version + 1, updated_at = now()`);
  await ex.execute(sql`select pg_notify(${CACHE_CHANNEL}, ${name})`);
}

export interface CacheSyncOptions {
  pollMs?: number;
  /** Tests: don't listen (an instance that never hears a notify: the version fallback only). */
  listen?: boolean;
  log?: { warn: (obj: object, msg: string) => void; info: (obj: object, msg: string) => void };
}

export class CacheSync {
  /** Counts for tests.  */
  readonly stats = { notified: 0, polled: 0, invalidatedByPoll: 0, listening: false };
  private readonly seen = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private unlisten: (() => Promise<void>) | null = null;
  private stopped = false;
  private reconnect: NodeJS.Timeout | undefined;

  constructor(
    private readonly db: Database,
    private readonly handle: DatabaseHandle,
    private readonly targets: Record<SharedCacheName, () => void>,
    private readonly options: CacheSyncOptions = {},
  ) {}

  /** Starts listening and the version check. */
  async start(): Promise<void> {
    this.stopped = false;
    // The versions as they are now, then the notifies (whose own check catches what changed between).
    await this.checkVersions(false).catch(() => undefined);
    if (this.options.listen !== false) await this.listen();
    const pollMs = this.options.pollMs ?? DEFAULT_CACHE_POLL_MS;
    if (pollMs > 0) {
      this.timer = setInterval(() => {
        this.checkVersions(true).catch((err: unknown) =>
          this.options.log?.warn({ err }, 'cache version check failed'),
        );
      }, pollMs);
      this.timer.unref();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.reconnect) clearTimeout(this.reconnect);
    const u = this.unlisten;
    this.unlisten = null;
    this.stats.listening = false;
    await u?.().catch(() => undefined);
  }

  /**
   * After a local write that committed: drops this instance's copy at once (the other instances
   * hear the notify the write's `bumpCacheVersion` sent).
   */
  invalidateLocal(name: SharedCacheName): void {
    this.targets[name]();
  }

  /** Reads every version and drops the caches whose version moved (`drop: false` only records). */
  async checkVersions(drop = true): Promise<SharedCacheName[]> {
    this.stats.polled += 1;
    const rows = await queryRows<{ name: string; version: number | string }>(
      this.db,
      sql`select name, version from cache_versions`,
    );
    const changed: SharedCacheName[] = [];
    for (const r of rows) {
      const v = Number(r.version);
      const before = this.seen.get(r.name);
      this.seen.set(r.name, v);
      if (drop && before !== v && (SHARED_CACHES as readonly string[]).includes(r.name))
        changed.push(r.name as SharedCacheName);
    }
    for (const name of changed) this.targets[name]();
    this.stats.invalidatedByPoll += changed.length;
    return changed;
  }

  private async listen(): Promise<void> {
    if (!this.handle.listen || this.stopped) return;
    try {
      this.unlisten = await this.handle.listen(
        CACHE_CHANNEL,
        (payload) => {
          if ((SHARED_CACHES as readonly string[]).includes(payload)) {
            this.stats.notified += 1;
            this.targets[payload as SharedCacheName]();
          }
        },
        (err) => {
          // The listening connection dropped: the version check covers the gap; listen again.
          this.options.log?.warn({ err }, 'cache notify connection lost; reconnecting');
          this.stats.listening = false;
          this.unlisten = null;
          this.scheduleReconnect();
        },
      );
      this.stats.listening = true;
      // Changes made while not listening.
      await this.checkVersions(true).catch(() => undefined);
    } catch (err) {
      this.options.log?.warn({ err }, 'cache notify listen failed; retrying');
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnect) return;
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined;
      void this.listen();
    }, 2_000);
    this.reconnect.unref();
  }
}
