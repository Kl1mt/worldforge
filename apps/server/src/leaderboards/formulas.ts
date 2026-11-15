import { bumpCacheVersion } from '../shared/cache-sync.js';
import { eq, sql } from 'drizzle-orm';
import {
  formulaVersionsAt,
  normaliseFormulaSchedule,
  normalisePvpRulesPlan,
  planFormulaSwitches,
  planPvpRulesSwitch,
  pvpRulesVersionAt,
  type PvpRulesSwitch,
  type FormulaSwitch,
  type FormulaVersions,
} from '@worldforge/game-core';
import { gameSettings, seasons } from '../db/schema.js';
import { writeAudit } from '../db/audit.js';
import { withTransaction } from '../db/transaction.js';
import type { Database, Executor } from '../db/types.js';

/**
 * Formula versions between seasons (ticket 6.1, docs/LEADERBOARDS.md "Formula versions between
 * seasons"). The plan is stored in `game_settings` under `leaderboards.formulas` (`{ switches }`,
 * game-core `FormulaSwitch`); no migration. The first time a server sees a newer formula version
 * than the plan holds, it adds a switch that waits for the end of the season under way (or none:
 * at once), under an advisory lock so two instances plan it once. Every write, read and check of
 * the boards then uses `formulaVersionsAt(plan, seasons, now)` at its own game-clock moment, so a
 * season's rows are all computed by one version and the 5.2 sweep recomputes every hero the moment
 * the season ends (rows of another version are "missing" for it).
 */

export const FORMULA_SCHEDULE_KEY = 'leaderboards.formulas';
export const DEFAULT_FORMULA_TTL_MS = 60_000;

export async function loadFormulaSchedule(db: Executor): Promise<FormulaSwitch[]> {
  const [row] = await db
    .select({ value: gameSettings.value })
    .from(gameSettings)
    .where(eq(gameSettings.key, FORMULA_SCHEDULE_KEY));
  return normaliseFormulaSchedule(row?.value?.switches);
}

async function seasonWindows(db: Executor) {
  return db
    .select({ number: seasons.number, startsAt: seasons.startsAt, endsAt: seasons.endsAt })
    .from(seasons);
}

/**
 * Plans the switches the code needs (idempotent). Returns the stored plan and whether it changed.
 * Audited `leaderboards.formula_schedule` with the added switches.
 */
export async function ensureFormulaSchedule(
  db: Database,
  now: Date,
): Promise<{ schedule: FormulaSwitch[]; added: FormulaSwitch[] }> {
  const current = await loadFormulaSchedule(db);
  if (planFormulaSwitches(current, await seasonWindows(db), now).length === 0)
    return { schedule: current, added: [] };
  return withTransaction(db, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${'leaderboards:formula-schedule'}, 0))`,
    );
    const schedule = await loadFormulaSchedule(tx);
    const added = planFormulaSwitches(schedule, await seasonWindows(tx), now);
    if (added.length === 0) return { schedule, added };
    const next = [...schedule, ...added];
    const [row] = await tx
      .select({ version: gameSettings.version })
      .from(gameSettings)
      .where(eq(gameSettings.key, FORMULA_SCHEDULE_KEY));
    const value = { switches: next } as unknown as Record<string, unknown>;
    await tx
      .insert(gameSettings)
      .values({ key: FORMULA_SCHEDULE_KEY, value, version: 1, updatedAt: now })
      .onConflictDoUpdate({
        target: gameSettings.key,
        set: { value, version: (row?.version ?? 0) + 1, updatedAt: now },
      });
    await writeAudit(tx, { event: 'leaderboards.formula_schedule', data: { added } });
    // Ticket 6.9: every instance's formula plan reloads when this commits.
    await bumpCacheVersion(tx, 'formulas');
    return { schedule: next, added };
  });
}

/**
 * Ticket 9.2: the duel rules plan (`PVP_RULES_VERSION` between seasons, 5.3's rule), stored in
 * `game_settings` under `arena.rules` (`{ switches }`, game-core `PvpRulesSwitch`), planned once
 * like the formula switches (advisory lock, audited `arena.rules_schedule`). No migration.
 */
export const PVP_RULES_SCHEDULE_KEY = 'arena.rules';

export async function loadPvpRulesPlan(db: Executor): Promise<PvpRulesSwitch[]> {
  const [row] = await db
    .select({ value: gameSettings.value })
    .from(gameSettings)
    .where(eq(gameSettings.key, PVP_RULES_SCHEDULE_KEY));
  return normalisePvpRulesPlan(row?.value?.switches);
}

export async function ensurePvpRulesPlan(db: Database, now: Date): Promise<PvpRulesSwitch[]> {
  const current = await loadPvpRulesPlan(db);
  if (planPvpRulesSwitch(current, await seasonWindows(db), now).length === 0) return current;
  return withTransaction(db, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${'arena:rules-schedule'}, 0))`,
    );
    const plan = await loadPvpRulesPlan(tx);
    const added = planPvpRulesSwitch(plan, await seasonWindows(tx), now);
    if (added.length === 0) return plan;
    const next = [...plan, ...added];
    const [row] = await tx
      .select({ version: gameSettings.version })
      .from(gameSettings)
      .where(eq(gameSettings.key, PVP_RULES_SCHEDULE_KEY));
    const value = { switches: next } as unknown as Record<string, unknown>;
    await tx
      .insert(gameSettings)
      .values({ key: PVP_RULES_SCHEDULE_KEY, value, version: 1, updatedAt: now })
      .onConflictDoUpdate({
        target: gameSettings.key,
        set: { value, version: (row?.version ?? 0) + 1, updatedAt: now },
      });
    await writeAudit(tx, { event: 'arena.rules_schedule', data: { added } });
    await bumpCacheVersion(tx, 'formulas');
    return next;
  });
}

/**
 * The versions in force at a game-clock moment, from a cached copy of the plan and the season
 * windows (refreshed every `ttlMs` of the real clock, and at once after `invalidate()`, which the
 * season plan routes call). The comparison with `now` is made on every call, so the switch happens
 * exactly at the season's end even while the copy is cached.
 */
export class FormulaVersionSource {
  private cached: {
    schedule: FormulaSwitch[];
    pvpRules: PvpRulesSwitch[];
    seasons: Awaited<ReturnType<typeof seasonWindows>>;
    loadedAt: number;
  } | null = null;

  constructor(
    private readonly db: Database,
    private readonly ttlMs = DEFAULT_FORMULA_TTL_MS,
    private readonly clock: () => number = Date.now,
  ) {}

  private async load(now: Date) {
    if (!this.cached || this.clock() - this.cached.loadedAt >= this.ttlMs) {
      const { schedule } = await ensureFormulaSchedule(this.db, now);
      const pvpRules = await ensurePvpRulesPlan(this.db, now);
      this.cached = {
        schedule,
        pvpRules,
        seasons: await seasonWindows(this.db),
        loadedAt: this.clock(),
      };
    }
    return this.cached;
  }

  async at(now: Date): Promise<FormulaVersions> {
    const c = await this.load(now);
    return formulaVersionsAt(c.schedule, c.seasons, now);
  }

  /** Ticket 9.2: the duel rules version in force at a game-clock moment (`simulateDuel`). */
  async pvpRulesAt(now: Date): Promise<number> {
    const c = await this.load(now);
    return pvpRulesVersionAt(c.pvpRules, c.seasons, now);
  }

  invalidate(): void {
    this.cached = null;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    formulaVersions: FormulaVersionSource;
  }
}
