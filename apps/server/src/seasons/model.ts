import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  ARENA_RATING_VERSION,
  PROVISIONAL_GAMES,
  SCORE_METRICS,
  SEASON_CLOSE_GRACE_MS,
  SEASON_PLAN_MESSAGES,
  bestAward,
  nextAutomaticSeason,
  planEnd,
  planSchedule,
  seasonAwards,
  seasonStatus,
  type PrestigeMetric,
  type PrestigeTier,
  type Score,
  type ScoreMetric,
  type SeasonPlanProblem,
  type SeasonStatus,
} from '@worldforge/game-core';
import {
  prestigeDisplays,
  seasonAwards as seasonAwardsTable,
  seasonEntries,
  seasonStandings,
  seasons,
  type Character,
  type Season,
} from '../db/schema.js';
import { queryRows } from '../db/query.js';
import { withTransaction } from '../db/transaction.js';
import type { Database, Executor, Transaction } from '../db/types.js';
import { writeAudit } from '../db/audit.js';
import { ApiError } from '../errors.js';
import { notTestOrDeleted } from '../admin/eligibility.js';

/**
 * Seasons and prestige awards (ticket 5.3, docs/LEADERBOARDS.md "Seasons" and "Prestige rewards").
 *
 * - **Season rows.** `writeSeasonRows` runs inside 5.2's refresh transaction (after the hero's
 *   advisory lock): when a score moves and the refresh's clock (the request's arrival, the window
 *   rule) lies in an open season, the hero's `season_entries` row for that board takes the new
 *   standing. The season is read under a shared advisory lock (`season:<n>`), so the archive, which
 *   takes it exclusively, waits for every refresh in flight and no refresh writes after it.
 * - **Archive.** `archiveSeason` takes the final standings once, in one transaction, after the end
 *   plus `SEASON_CLOSE_GRACE_MS`: per board, the heroes whose score rose in the season, ranked like
 *   every board (score, reached first, hero id), accounts with an active sanction left out.
 * - **Awards.** `awardSeason` gives each account its best tier per board (game-core
 *   `seasonAwards`), in batches; the primary key `(season, account, metric)` and `on conflict do
 *   nothing` make it exactly-once, so a rerun after a crash, or two instances at once, finish the
 *   same set. `awarded_at` marks it done.
 */

const lockKey = (key: string) => sql`hashtextextended(${key}, 0)`;
/** Every change to the season plan (owner actions, the automatic next season) serialises here. */
const PLAN_LOCK = 'seasons:plan';
const seasonLock = (n: number) => `season:${n}`;

export async function listSeasons(db: Executor): Promise<Season[]> {
  return db.select().from(seasons).orderBy(asc(seasons.number));
}

/**
 * Inside a refresh transaction: the season whose window holds `at` and that is not archived, read
 * under its shared lock (re-checked after the lock), or null.
 */
export async function lockOpenSeason(tx: Transaction, at: Date): Promise<Season | null> {
  const iso = at.toISOString();
  const [candidate] = await tx
    .select()
    .from(seasons)
    .where(
      and(
        sql`${seasons.startsAt} <= ${iso}::timestamptz`,
        sql`${seasons.endsAt} > ${iso}::timestamptz`,
        isNull(seasons.archivedAt),
      ),
    );
  if (!candidate) return null;
  await tx.execute(
    sql`select pg_advisory_xact_lock_shared(${lockKey(seasonLock(candidate.number))})`,
  );
  const [fresh] = await tx.select().from(seasons).where(eq(seasons.number, candidate.number));
  if (!fresh || fresh.archivedAt) return null;
  const t = at.getTime();
  return t >= fresh.startsAt.getTime() && t < fresh.endsAt.getTime() ? fresh : null;
}

/** One metric's change in a refresh: the new score and the standing before it. */
export interface SeasonChange {
  metric: ScoreMetric;
  score: Score;
  /** The all-time `sort_key` before this refresh (null: the hero had no row). */
  previousKey: number[] | null;
  /** A formula bump that moved nothing in the input: the season row keeps its time and base. */
  versionOnly: boolean;
}

/**
 * Writes the hero's season rows for a refresh at `at` (5.2's `achieved_at` for moved keys).
 * `levelChanged`: the hero's level copy changes on every season row of the season (the bracket
 * filter), as on the all-time rows.
 */
export async function writeSeasonRows(
  tx: Transaction,
  hero: Character,
  at: Date,
  changes: SeasonChange[],
  levelChanged: boolean,
): Promise<number | null> {
  if (changes.length === 0 && !levelChanged) return null;
  const season = await lockOpenSeason(tx, at);
  if (!season) return null;
  for (const c of changes) {
    const pk = and(
      eq(seasonEntries.season, season.number),
      eq(seasonEntries.characterId, hero.id),
      eq(seasonEntries.metric, c.metric),
    );
    if (c.versionOnly) {
      // Ticket B.4: a hero whose standing has not moved this season (its base equals its key)
      // keeps base = key under the new formula, so a longer key (a new tie-breaker) never reads
      // as a rise. Any other base differs from the key in a value both versions share, and still
      // compares the same way.
      const newKey = sql`array[${sql.join(
        c.score.sortKey.map((k) => sql`${k}`),
        sql`, `,
      )}]::bigint[]`;
      await tx
        .update(seasonEntries)
        .set({
          formulaVersion: c.score.formulaVersion,
          value: c.score.value,
          sortKey: c.score.sortKey,
          baseSortKey: sql`case when ${seasonEntries.baseSortKey} = ${seasonEntries.sortKey} then ${newKey} else ${seasonEntries.baseSortKey} end`,
          updatedAt: at,
        })
        .where(pk);
      continue;
    }
    await tx
      .insert(seasonEntries)
      .values({
        season: season.number,
        characterId: hero.id,
        metric: c.metric,
        accountId: hero.accountId,
        classId: hero.classId,
        level: hero.level,
        formulaVersion: c.score.formulaVersion,
        value: c.score.value,
        sortKey: c.score.sortKey,
        baseSortKey: c.previousKey,
        achievedAt: at,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: [seasonEntries.season, seasonEntries.characterId, seasonEntries.metric],
        set: {
          classId: hero.classId,
          level: hero.level,
          formulaVersion: c.score.formulaVersion,
          value: c.score.value,
          sortKey: c.score.sortKey,
          achievedAt: at,
          updatedAt: at,
        },
      });
  }
  if (levelChanged) {
    await tx
      .update(seasonEntries)
      .set({ level: hero.level })
      .where(and(eq(seasonEntries.season, season.number), eq(seasonEntries.characterId, hero.id)));
  }
  return season.number;
}

/** A season as the admin panel, the CLI and the board filter see it. */
export interface SeasonView {
  number: number;
  startsAt: string;
  endsAt: string;
  status: SeasonStatus;
  archivedAt: string | null;
  awardedAt: string | null;
}

export function seasonView(s: Season, now: Date): SeasonView {
  return {
    number: s.number,
    startsAt: s.startsAt.toISOString(),
    endsAt: s.endsAt.toISOString(),
    status: seasonStatus(s, now),
    archivedAt: s.archivedAt?.toISOString() ?? null,
    awardedAt: s.awardedAt?.toISOString() ?? null,
  };
}

/** The season under way and the next one (scheduled), from a list. */
export function currentAndNext(list: Season[], now: Date) {
  const t = now.getTime();
  const current = list.find((s) => s.startsAt.getTime() <= t && t < s.endsAt.getTime()) ?? null;
  const next = list.find((s) => s.startsAt.getTime() > t) ?? null;
  return { current, next };
}

function planError(problem: SeasonPlanProblem): ApiError {
  return new ApiError(409, 'season_plan_refused', SEASON_PLAN_MESSAGES[problem], { problem });
}

export interface PlanActor {
  /** Who changed the plan: an admin's account (audited on it), or the owner's CLI. */
  accountId: string | null;
  via: 'admin' | 'cli';
  /** Inside the plan transaction: e.g. re-check the admin's role. */
  guard?: (tx: Transaction) => Promise<void>;
}

async function underPlanLock<T>(db: Database, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return withTransaction(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${lockKey(PLAN_LOCK)})`);
    return fn(tx);
  });
}

/** Schedules the next season, or replaces the scheduled one (not yet begun). */
export async function scheduleSeason(
  db: Database,
  window: { startsAt: Date; endsAt: Date },
  now: Date,
  actor: PlanActor,
): Promise<Season> {
  return underPlanLock(db, async (tx) => {
    await actor.guard?.(tx);
    const plan = planSchedule(await listSeasons(tx), window, now);
    if (!plan.ok) throw planError(plan.problem);
    const [row] = plan.replaces
      ? await tx
          .update(seasons)
          .set({ startsAt: window.startsAt, endsAt: window.endsAt })
          .where(eq(seasons.number, plan.number))
          .returning()
      : await tx
          .insert(seasons)
          .values({ number: plan.number, ...window, createdAt: now })
          .returning();
    await writeAudit(tx, {
      event: 'season.schedule',
      accountId: actor.accountId,
      data: {
        via: actor.via,
        season: plan.number,
        replaced: plan.replaces !== null,
        startsAt: window.startsAt.toISOString(),
        endsAt: window.endsAt.toISOString(),
      },
    });
    return row!;
  });
}

/**
 * Moves the end of the season under way or the next one: earlier ("end early", `endsAt` = now)
 * or later ("extend"). A back-to-back next season moves along, keeping its length.
 */
export async function setSeasonEnd(
  db: Database,
  number: number,
  endsAt: Date,
  now: Date,
  actor: PlanActor,
): Promise<{ season: Season; follower: Season | null }> {
  return underPlanLock(db, async (tx) => {
    await actor.guard?.(tx);
    const list = await listSeasons(tx);
    const plan = planEnd(list, number, endsAt, now);
    if (!plan.ok) throw planError(plan.problem);
    // Move the follower first when the season grows, so the windows never overlap in between.
    let follower: Season | null = null;
    const moveFollower = async () => {
      if (!plan.follower) return;
      const moved = await tx
        .update(seasons)
        .set({ startsAt: plan.follower.startsAt, endsAt: plan.follower.endsAt })
        .where(eq(seasons.number, plan.follower.season.number))
        .returning();
      follower = moved[0] ?? null;
    };
    const growing = endsAt.getTime() > plan.season.endsAt.getTime();
    if (growing) await moveFollower();
    const [season] = await tx
      .update(seasons)
      .set({ endsAt })
      .where(eq(seasons.number, number))
      .returning();
    if (!growing) await moveFollower();
    await writeAudit(tx, {
      event: endsAt.getTime() <= now.getTime() + 60_000 ? 'season.end' : 'season.extend',
      accountId: actor.accountId,
      data: {
        via: actor.via,
        season: number,
        from: plan.season.endsAt.toISOString(),
        to: endsAt.toISOString(),
        follower: plan.follower ? plan.follower.season.number : null,
      },
    });
    return { season: season!, follower };
  });
}

/** Creates the next season back to back once the latest has begun and nothing follows it. */
export async function ensureNextSeason(db: Database, now: Date): Promise<Season | null> {
  const list = await listSeasons(db);
  if (!nextAutomaticSeason(list, now)) return null;
  return underPlanLock(db, async (tx) => {
    const next = nextAutomaticSeason(await listSeasons(tx), now);
    if (!next) return null;
    const [row] = await tx
      .insert(seasons)
      .values({ ...next, createdAt: now })
      .onConflictDoNothing()
      .returning();
    if (row) {
      await writeAudit(tx, {
        event: 'season.schedule',
        data: {
          via: 'automatic',
          season: row.number,
          startsAt: row.startsAt.toISOString(),
          endsAt: row.endsAt.toISOString(),
        },
      });
    }
    return row ?? null;
  });
}

/** An account with an active sanction of any kind (the boards' rule, 5.2) at `at`. */
const notSanctioned = (at: Date) =>
  sql`not exists (select 1 from sanctions s
    where s.subject_id = e.account_id and s.lifted_at is null and s.expires_at > ${at.toISOString()}::timestamptz)
    and ${notTestOrDeleted}`;

/** Season rows that are on the board: the score rose during the season. */
export const roseInSeason = sql`(e.base_sort_key is null or e.sort_key > e.base_sort_key)`;

export type ArchiveOutcome = 'archived' | 'already' | 'not_due' | 'missing';

/**
 * Takes the season's final standings (the archive) once: after `endsAt + graceMs`, in one
 * transaction under the season's exclusive lock (refreshes in flight finish first; later ones
 * see `archived_at` and write nothing). `sanctionsAt`: the auth clock for the sanction rule.
 */
export async function archiveSeason(
  db: Database,
  number: number,
  now: Date,
  sanctionsAt: Date,
  graceMs = SEASON_CLOSE_GRACE_MS,
): Promise<ArchiveOutcome> {
  return withTransaction(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${lockKey(seasonLock(number))})`);
    const [season] = await tx
      .select()
      .from(seasons)
      .where(eq(seasons.number, number))
      .for('update');
    if (!season) return 'missing';
    if (season.archivedAt) return 'already';
    if (now.getTime() < season.endsAt.getTime() + graceMs) return 'not_due';
    for (const metric of SCORE_METRICS) {
      await tx.execute(sql`insert into season_standings
          (season, metric, rank, character_id, account_id, class_id, level, formula_version,
           value, sort_key, achieved_at)
        select e.season, e.metric,
          row_number() over (order by e.sort_key desc, e.achieved_at asc, e.character_id asc),
          e.character_id, e.account_id, e.class_id, e.level, e.formula_version, e.value,
          e.sort_key, e.achieved_at
        from season_entries e
        where e.season = ${number} and e.metric = ${metric} and ${roseInSeason}
          and ${notSanctioned(sanctionsAt)}
        on conflict do nothing`);
    }
    // Ticket 5.6: the arena ladder's final standings (metric `arena`): the established heroes
    // (at least PROVISIONAL_GAMES rated duels), by rating, then more duels, then the earlier last
    // duel, then the hero id. `value` is the rounded rating, `sort_key` [rating × 100, games];
    // the full rating (deviation, volatility, record) stays in `arena_ratings`, never reset.
    await tx.execute(sql`insert into season_standings
        (season, metric, rank, character_id, account_id, class_id, level, formula_version,
         value, sort_key, achieved_at)
      select e.season, 'arena',
        row_number() over (order by e.rating desc, e.games desc, e.last_rated_at asc,
          e.character_id asc),
        e.character_id, e.account_id, e.class_id, e.level, ${ARENA_RATING_VERSION},
        round(e.rating)::bigint, array[round(e.rating * 100)::bigint, e.games::bigint],
        e.last_rated_at
      from arena_ratings e
      where e.season = ${number} and e.games >= ${PROVISIONAL_GAMES}
        and ${notSanctioned(sanctionsAt)}
      on conflict do nothing`);
    await tx.update(seasons).set({ archivedAt: now }).where(eq(seasons.number, number));
    const [counted] = await queryRows<{ n: number }>(
      tx,
      sql`select count(*)::int as n from season_standings where season = ${number}`,
    );
    await writeAudit(tx, {
      event: 'season.archive',
      data: { season: number, standings: counted?.n ?? 0 },
    });
    return 'archived';
  });
}

export interface AwardOptions {
  /** Awards inserted per transaction. */
  batch?: number;
  /** Tests only: throw after this many batches (a crash mid-award). */
  failAfterBatches?: number;
}

export type AwardOutcome =
  | { kind: 'awarded'; inserted: number; total: number }
  | { kind: 'already' | 'not_archived' | 'missing' };

/**
 * Gives a season's prestige awards from its archive. Resumable and exactly-once: the awards are
 * recomputed from the archive (deterministic), inserted in batches with `on conflict do nothing`
 * on `(season, account, metric)`, and `awarded_at` is set only after the last batch, together with
 * each newly decorated account's default display (its best award, if it never chose one).
 */
export async function awardSeason(
  db: Database,
  number: number,
  now: Date,
  options: AwardOptions = {},
): Promise<AwardOutcome> {
  const [season] = await db.select().from(seasons).where(eq(seasons.number, number));
  if (!season) return { kind: 'missing' };
  if (!season.archivedAt) return { kind: 'not_archived' };
  if (season.awardedAt) return { kind: 'already' };
  const standings = await db
    .select({
      metric: seasonStandings.metric,
      rank: seasonStandings.rank,
      accountId: seasonStandings.accountId,
      characterId: seasonStandings.characterId,
      level: seasonStandings.level,
    })
    .from(seasonStandings)
    .where(eq(seasonStandings.season, number));
  const awards = seasonAwards(standings);
  const batch = Math.max(1, options.batch ?? 500);
  let inserted = 0;
  for (let i = 0, n = 0; i < awards.length; i += batch, n += 1) {
    if (options.failAfterBatches !== undefined && n >= options.failAfterBatches) {
      throw new Error(`award run stopped after ${n} batches (test)`);
    }
    const slice = awards.slice(i, i + batch);
    const rows = await db
      .insert(seasonAwardsTable)
      .values(
        slice.map((a) => ({
          season: number,
          accountId: a.accountId,
          metric: a.metric,
          tier: a.tier,
          rank: a.rank,
          characterId: a.characterId,
          awardedAt: now,
        })),
      )
      .onConflictDoNothing()
      .returning({ accountId: seasonAwardsTable.accountId });
    inserted += rows.length;
  }
  await withTransaction(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${lockKey(seasonLock(number))})`);
    const [fresh] = await tx.select().from(seasons).where(eq(seasons.number, number)).for('update');
    if (!fresh || fresh.awardedAt) return;
    // Default displays: accounts decorated this season that never chose (no display row).
    const mine = await tx
      .select({
        accountId: seasonAwardsTable.accountId,
        metric: seasonAwardsTable.metric,
        tier: seasonAwardsTable.tier,
      })
      .from(seasonAwardsTable)
      .where(
        and(
          eq(seasonAwardsTable.season, number),
          sql`not exists (select 1 from prestige_displays d where d.account_id = ${seasonAwardsTable.accountId})`,
        ),
      );
    const byAccount = new Map<
      string,
      { metric: PrestigeMetric; tier: PrestigeTier; season: number }[]
    >();
    for (const a of mine) {
      const list = byAccount.get(a.accountId) ?? [];
      list.push({ metric: a.metric, tier: a.tier, season: number });
      byAccount.set(a.accountId, list);
    }
    const defaults = [...byAccount].map(([accountId, list]) => {
      const best = bestAward(list)!;
      return {
        accountId,
        titleSeason: number,
        titleMetric: best.metric,
        frameSeason: number,
        frameMetric: best.metric,
        updatedAt: now,
      };
    });
    for (let i = 0; i < defaults.length; i += batch) {
      await tx
        .insert(prestigeDisplays)
        .values(defaults.slice(i, i + batch))
        .onConflictDoNothing();
    }
    await tx.update(seasons).set({ awardedAt: now }).where(eq(seasons.number, number));
    const [counted] = await queryRows<{ n: number }>(
      tx,
      sql`select count(*)::int as n from season_awards where season = ${number}`,
    );
    await writeAudit(tx, {
      event: 'season.award',
      data: { season: number, awards: counted?.n ?? 0 },
    });
  });
  return { kind: 'awarded', inserted, total: awards.length };
}

export interface SeasonJobReport {
  created: number | null;
  archived: number[];
  awarded: number[];
}

/**
 * The scheduler's season step (each settlement run; the CLI's `close`): the automatic next
 * season, then every ended season's archive and awards, oldest first. Each step is idempotent,
 * so overlapping runs and restarts are safe.
 */
export async function runSeasonJobs(
  db: Database,
  now: Date,
  sanctionsAt: Date,
  options: { graceMs?: number; award?: AwardOptions } = {},
): Promise<SeasonJobReport> {
  const report: SeasonJobReport = { created: null, archived: [], awarded: [] };
  const created = await ensureNextSeason(db, now);
  report.created = created?.number ?? null;
  const open = await db
    .select()
    .from(seasons)
    .where(
      and(isNull(seasons.awardedAt), sql`${seasons.endsAt} <= ${now.toISOString()}::timestamptz`),
    )
    .orderBy(asc(seasons.number));
  for (const s of open) {
    if (!s.archivedAt) {
      const out = await archiveSeason(db, s.number, now, sanctionsAt, options.graceMs);
      if (out === 'archived') report.archived.push(s.number);
      if (out !== 'archived' && out !== 'already') continue;
    }
    const award = await awardSeason(db, s.number, now, options.award);
    if (award.kind === 'awarded') report.awarded.push(s.number);
  }
  return report;
}

/** What each account shows (title and frame), for boards, profiles and guild rosters. */
export interface PrestigeBadge {
  season: number;
  metric: PrestigeMetric;
  tier: PrestigeTier;
}
export interface PrestigeShown {
  title: PrestigeBadge | null;
  frame: PrestigeBadge | null;
  /** Ticket 6.6: a cosmetic title (e.g. an event's) shown instead of a season title. */
  cosmeticTitle: string | null;
}

export async function prestigeFor(
  db: Executor,
  accountIds: readonly string[],
): Promise<Map<string, PrestigeShown>> {
  const out = new Map<string, PrestigeShown>();
  const ids = [...new Set(accountIds)];
  if (ids.length === 0) return out;
  const rows = await queryRows<{
    account_id: string;
    title_season: number | null;
    title_metric: PrestigeMetric | null;
    title_tier: PrestigeTier | null;
    frame_season: number | null;
    frame_metric: PrestigeMetric | null;
    frame_tier: PrestigeTier | null;
    cosmetic_title: string | null;
  }>(
    db,
    sql`select d.account_id, d.title_season, d.title_metric, t.tier as title_tier,
        d.frame_season, d.frame_metric, f.tier as frame_tier, d.cosmetic_title
      from prestige_displays d
        left join season_awards t on t.account_id = d.account_id
          and t.season = d.title_season and t.metric = d.title_metric
        left join season_awards f on f.account_id = d.account_id
          and f.season = d.frame_season and f.metric = d.frame_metric
      where d.account_id = any(${`{${ids.join(',')}}`}::uuid[])`,
  );
  for (const r of rows) {
    out.set(r.account_id, {
      title:
        r.title_season !== null && r.title_metric && r.title_tier
          ? { season: Number(r.title_season), metric: r.title_metric, tier: r.title_tier }
          : null,
      frame:
        r.frame_season !== null && r.frame_metric && r.frame_tier
          ? { season: Number(r.frame_season), metric: r.frame_metric, tier: r.frame_tier }
          : null,
      cosmeticTitle: r.cosmetic_title ?? null,
    });
  }
  return out;
}

export const NO_PRESTIGE_SHOWN: PrestigeShown = { title: null, frame: null, cosmeticTitle: null };

export const prestigeBadgeSchema = {
  anyOf: [
    { type: 'null' },
    {
      type: 'object',
      required: ['season', 'metric', 'tier'],
      properties: {
        season: { type: 'integer' },
        metric: { type: 'string' },
        tier: { type: 'string' },
      },
    },
  ],
} as const;

export const prestigeShownSchema = {
  type: 'object',
  required: ['title', 'frame'],
  properties: {
    title: prestigeBadgeSchema,
    frame: prestigeBadgeSchema,
    cosmeticTitle: { type: ['string', 'null'] },
  },
} as const;
