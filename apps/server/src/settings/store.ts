import { bumpCacheVersion } from '../shared/cache-sync.js';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import {
  diffTradingSettings,
  normaliseTradingSettings,
  switchedOff,
  tradingSwitchesOf,
  type TradingSettings,
  type TradingSettingsChange,
  type TradingSwitchPath,
  type TradingSwitches,
} from '@worldforge/game-core';
import { accounts, auditLog, gameSettings } from '../db/schema.js';
import { writeAudit } from '../db/audit.js';
import type { Database, Executor, Transaction } from '../db/types.js';
import { ApiError } from '../errors.js';

/**
 * Game settings (ticket T.2, docs/TRADING.md "T.2 as built"). The `game_settings` table is the one
 * source of truth; this module reads it, keeps one cached copy per server process (exactly like
 * 4.6's world-state cache) and writes changes.
 *
 * - **Read** through `app.gameSettings.trading()` / `.tradingSwitches()`: from memory while fresh.
 * - **Invalidated** right after an edit commits (the admin route calls `invalidate()`), so the
 *   instance that wrote it sees the change at once.
 * - **TTL backstop** (`DEFAULT_SETTINGS_TTL_MS`, 60 s): a change made by another process shows up
 *   within a minute without a restart.
 * - **No stale write-back:** a load that started before an `invalidate()` does not store its result.
 * - **Missing rows and fields are the defaults** (game-core `normaliseTradingSettings`, which also
 *   clamps stored numbers to their hard maxima), so the table needs no backfill.
 *
 * Inside a value transaction, read the table directly (`loadTradingSettings(tx)`): the cache is
 * for views and gates, the table for decisions that must be exact (T.4/T.5).
 */

export const TRADING_SETTINGS_KEY = 'trading';
export const DEFAULT_SETTINGS_TTL_MS = 60_000;
/** History rows the panel shows. */
export const SETTINGS_HISTORY_LIMIT = 50;

export interface StoredTradingSettings {
  settings: TradingSettings;
  /** 0 while nothing was ever saved (the defaults); then 1, 2, … */
  version: number;
  updatedAt: Date | null;
  updatedBy: string | null;
}

export interface GameSettingsSnapshot {
  trading: StoredTradingSettings;
}

export async function loadGameSettings(db: Executor): Promise<GameSettingsSnapshot> {
  const rows = await db.select().from(gameSettings);
  const trading = rows.find((r) => r.key === TRADING_SETTINGS_KEY);
  return {
    trading: {
      settings: normaliseTradingSettings(trading?.value),
      version: trading?.version ?? 0,
      updatedAt: trading?.updatedAt ?? null,
      updatedBy: trading?.updatedBy ?? null,
    },
  };
}

/** The trading settings straight from the table (for exact decisions inside a transaction). */
export async function loadTradingSettings(db: Executor): Promise<TradingSettings> {
  const [row] = await db
    .select({ value: gameSettings.value })
    .from(gameSettings)
    .where(eq(gameSettings.key, TRADING_SETTINGS_KEY));
  return normaliseTradingSettings(row?.value);
}

export class GameSettingsCache {
  private cached: { snapshot: GameSettingsSnapshot; loadedAt: number } | null = null;
  private generation = 0;
  /** Database reads so far (tests). */
  loads = 0;

  constructor(
    private readonly db: Database,
    private readonly ttlMs: number = DEFAULT_SETTINGS_TTL_MS,
    private readonly clock: () => number = Date.now,
  ) {}

  async get(): Promise<GameSettingsSnapshot> {
    const hit = this.cached;
    const t = this.clock();
    if (hit && t - hit.loadedAt < this.ttlMs && t >= hit.loadedAt) return hit.snapshot;
    const generation = this.generation;
    this.loads += 1;
    const snapshot = await loadGameSettings(this.db);
    if (generation === this.generation) this.cached = { snapshot, loadedAt: this.clock() };
    return snapshot;
  }

  async trading(): Promise<TradingSettings> {
    return (await this.get()).trading.settings;
  }

  /** The switches T.1's `itemBinding(item, switches)` reads, for item views. */
  async tradingSwitches(): Promise<TradingSwitches> {
    return tradingSwitchesOf(await this.trading());
  }

  /** Drops the cached copy; call after a commit that changed a setting. */
  invalidate(): void {
    this.generation += 1;
    this.cached = null;
  }
}

/**
 * What a settings edit changed, handed to every `onSettingsChanged` listener (the seam T.5 voids
 * open offers from: `switchedOff` lists the switches that went from on to off).
 */
export interface TradingSettingsChangeEvent {
  key: typeof TRADING_SETTINGS_KEY;
  before: TradingSettings;
  after: TradingSettings;
  changes: TradingSettingsChange[];
  switchedOff: TradingSwitchPath[];
  version: number;
  actorAccountId: string;
  at: Date;
}

/**
 * A listener runs **inside the edit's transaction**, after the new row and its audit row are
 * written and before the commit: what it writes commits or rolls back with the switch, and a
 * throw refuses the whole edit. Keep it to the database work the change needs (T.5: void the
 * affected open offers and return their escrow).
 */
export type SettingsChangedListener = (
  event: TradingSettingsChangeEvent,
  tx: Transaction,
) => Promise<void>;

export class SettingsEvents {
  private readonly listeners: SettingsChangedListener[] = [];

  onSettingsChanged(listener: SettingsChangedListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  async emit(event: TradingSettingsChangeEvent, tx: Transaction): Promise<void> {
    for (const l of [...this.listeners]) await l(event, tx);
  }
}

export interface UpdateTradingSettingsResult {
  changed: boolean;
  changes: TradingSettingsChange[];
  version: number;
}

/**
 * Saves new trading settings in `tx` (already validated by game-core `validateTradingSettings`).
 * `expectedVersion` is the version the admin's form was loaded from: anything else is
 * `409 settings_conflict` (another admin saved in between; the panel reloads and shows theirs), so
 * the last write never silently clobbers the first. An edit that changes nothing writes nothing.
 * The row is locked (`for update`), and a first save racing another first save loses on the
 * primary key, so exactly one of two concurrent edits from one version wins.
 */
export async function updateTradingSettings(
  tx: Transaction,
  input: {
    settings: TradingSettings;
    expectedVersion: number;
    actorAccountId: string;
    now: Date;
    events?: SettingsEvents;
  },
): Promise<UpdateTradingSettingsResult> {
  const [row] = await tx
    .select()
    .from(gameSettings)
    .where(eq(gameSettings.key, TRADING_SETTINGS_KEY))
    .for('update');
  const current = row?.version ?? 0;
  const conflict = () =>
    new ApiError(
      409,
      'settings_conflict',
      'Someone else saved the trading settings since you opened them. Reload to see their change.',
      { currentVersion: current },
    );
  if (input.expectedVersion !== current) throw conflict();
  const before = normaliseTradingSettings(row?.value);
  const after = input.settings;
  const changes = diffTradingSettings(before, after);
  if (changes.length === 0) return { changed: false, changes, version: current };
  const version = current + 1;
  const value = after as unknown as Record<string, unknown>;
  // Ticket 6.9: every instance's settings reload when this commits.
  await bumpCacheVersion(tx, 'settings');
  if (row) {
    const updated = await tx
      .update(gameSettings)
      .set({ value, version, updatedBy: input.actorAccountId, updatedAt: input.now })
      .where(and(eq(gameSettings.key, TRADING_SETTINGS_KEY), eq(gameSettings.version, current)))
      .returning({ key: gameSettings.key });
    if (updated.length === 0) throw conflict();
  } else {
    const inserted = await tx
      .insert(gameSettings)
      .values({
        key: TRADING_SETTINGS_KEY,
        value,
        version,
        updatedBy: input.actorAccountId,
        updatedAt: input.now,
      })
      .onConflictDoNothing()
      .returning({ key: gameSettings.key });
    if (inserted.length === 0) throw conflict();
  }
  await writeAudit(tx, {
    event: 'settings.update',
    accountId: input.actorAccountId,
    data: { key: TRADING_SETTINGS_KEY, version, changes },
  });
  await input.events?.emit(
    {
      key: TRADING_SETTINGS_KEY,
      before,
      after,
      changes,
      switchedOff: switchedOff(before, after),
      version,
      actorAccountId: input.actorAccountId,
      at: input.now,
    },
    tx,
  );
  return { changed: true, changes, version };
}

export interface SettingsHistoryEntry {
  /** The audit row id (also the cursor). */
  id: string;
  at: string;
  by: { handle: string; displayName: string } | null;
  version: number;
  changes: TradingSettingsChange[];
}

/** The `settings.update` rows of the trading settings, newest first (the panel's history). */
export async function tradingSettingsHistory(
  db: Executor,
  { before, limit = SETTINGS_HISTORY_LIMIT }: { before?: string | undefined; limit?: number } = {},
): Promise<{ entries: SettingsHistoryEntry[]; nextCursor: string | null }> {
  const rows = await db
    .select({
      id: auditLog.id,
      accountId: auditLog.accountId,
      data: auditLog.data,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.event, 'settings.update'),
        sql`${auditLog.data}->>'key' = ${TRADING_SETTINGS_KEY}`,
        before ? lt(auditLog.id, before) : undefined,
      ),
    )
    // uuidv7 ids sort by creation time.
    .orderBy(desc(auditLog.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const ids = [...new Set(page.map((r) => r.accountId).filter((x) => x !== null))];
  const people = ids.length
    ? await db
        .select({ id: accounts.id, handle: accounts.handle, displayName: accounts.displayName })
        .from(accounts)
        .where(inArray(accounts.id, ids))
    : [];
  return {
    entries: page.map((r) => {
      const p = people.find((x) => x.id === r.accountId);
      const data = r.data as { version?: number; changes?: TradingSettingsChange[] };
      return {
        id: r.id,
        at: r.createdAt.toISOString(),
        by: p ? { handle: p.handle, displayName: p.displayName } : null,
        version: data.version ?? 0,
        changes: data.changes ?? [],
      };
    }),
    nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Ticket T.2: the cached game settings (trading switches and limits). */
    gameSettings: GameSettingsCache;
    /** Ticket T.2: listeners run inside a settings edit's transaction (T.5 voids offers here). */
    settingsEvents: SettingsEvents;
  }
}
