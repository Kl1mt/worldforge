import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import {
  ARENA_RATING_VERSION,
  PAIR_WINDOW_MS,
  mailboxKey,
  rateDuel,
  ratingFactor,
  ratingRange,
  ratingStanding,
  type RatingStanding,
  seasonStartRating,
  type ClassId,
  type DuelOutcome,
  type Rating,
} from '@worldforge/game-core';
import {
  accounts,
  arenaRatings,
  duels,
  seasons,
  type ArenaRating,
  type DuelRatingRecord,
  type Season,
} from '../db/schema.js';
import type { Executor, Transaction } from '../db/types.js';
import { queryRows } from '../db/query.js';
import { lockOpenSeason } from '../seasons/model.js';
import { friendIds } from '../social/relations.js';
import { guildmateIds } from '../social/guild-model.js';

/**
 * The arena rating on the server (ticket 5.6, docs/PVP.md "Rating"). Ratings are per hero and per
 * season (`arena_ratings`), written only inside a rated duel's transaction after 5.5's locks, in
 * this order: the season's shared lock (`season:<n>`, the archive takes it exclusively, so no duel
 * writes a rating after the final standings) → the pair lock (`arena-pair:<a>:<b>`, the two
 * accounts sorted: the diminishing-returns count is exact under races) → both heroes' rating
 * locks, sorted by id (two duels against one defender, or two heroes attacking each other, never
 * deadlock). Every lock is transaction-scoped; nothing else waits on them.
 */

const lockKey = (key: string) => sql`hashtextextended(${key}, 0)`;
const xactLock = (tx: Transaction, key: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(${lockKey(key)})`);

/** The season a rated duel at `at` counts in (not archived), or null. Reads only, no lock. */
export async function ratingSeasonAt(db: Executor, at: Date): Promise<Season | null> {
  const iso = at.toISOString();
  const [row] = await db
    .select()
    .from(seasons)
    .where(
      and(
        sql`${seasons.startsAt} <= ${iso}::timestamptz`,
        sql`${seasons.endsAt} > ${iso}::timestamptz`,
        isNull(seasons.archivedAt),
      ),
    );
  return row ?? null;
}

export const ratingOf = (r: Pick<ArenaRating, 'rating' | 'deviation' | 'volatility'>): Rating => ({
  rating: r.rating,
  deviation: r.deviation,
  volatility: r.volatility,
});

/**
 * Each hero's rating in `season`: its row, or where it has none yet, where it would start (the
 * soft reset from its latest earlier season, else 1500 / 350 / 0.06). With no season, everyone
 * stands at the start. Two queries whatever the number of heroes.
 */
export async function ratingsFor(
  db: Executor,
  season: number | null,
  characterIds: readonly string[],
): Promise<Map<string, { rating: Rating; row: ArenaRating | null }>> {
  const out = new Map<string, { rating: Rating; row: ArenaRating | null }>();
  const ids = [...new Set(characterIds)];
  if (ids.length === 0) return out;
  const rows =
    season === null
      ? []
      : await db
          .select()
          .from(arenaRatings)
          .where(and(eq(arenaRatings.season, season), inArray(arenaRatings.characterId, ids)));
  for (const r of rows) out.set(r.characterId, { rating: ratingOf(r), row: r });
  const missing = ids.filter((id) => !out.has(id));
  if (missing.length > 0) {
    const previous =
      season === null
        ? []
        : await queryRows<{
            character_id: string;
            rating: number;
            deviation: number;
            volatility: number;
          }>(
            db,
            sql`select distinct on (r.character_id) r.character_id, r.rating, r.deviation, r.volatility
              from arena_ratings r
              where r.season < ${season} and r.character_id in (${sql.join(
                missing.map((id) => sql`${id}::uuid`),
                sql`, `,
              )})
              order by r.character_id, r.season desc`,
          );
    const prev = new Map(previous.map((p) => [p.character_id, p]));
    for (const id of missing) {
      const p = prev.get(id);
      out.set(id, {
        rating: seasonStartRating(
          p
            ? {
                rating: Number(p.rating),
                deviation: Number(p.deviation),
                volatility: Number(p.volatility),
              }
            : null,
        ),
        row: null,
      });
    }
  }
  return out;
}

/**
 * Rated duels between two accounts (either challenging, any heroes) in the window before `at`:
 * the diminishing-returns count (`ratingFactor`).
 */
export async function priorPairDuels(
  db: Executor,
  a: string,
  b: string,
  at: Date,
): Promise<number> {
  const since = new Date(at.getTime() - PAIR_WINDOW_MS);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(duels)
    .where(
      and(
        eq(duels.kind, 'rated'),
        or(
          and(eq(duels.challengerAccountId, a), eq(duels.defenderAccountId, b)),
          and(eq(duels.challengerAccountId, b), eq(duels.defenderAccountId, a)),
        ),
        gt(duels.foughtAt, since),
        lte(duels.foughtAt, at),
      ),
    );
  return row?.n ?? 0;
}

/** For each of `others`, rated duels with `accountId` in the window before `at` (0 omitted). */
export async function pairCountsWith(
  db: Executor,
  accountId: string,
  others: readonly string[],
  at: Date,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (others.length === 0) return out;
  const since = new Date(at.getTime() - PAIR_WINDOW_MS).toISOString();
  const rows = await queryRows<{ other: string; n: number }>(
    db,
    sql`select case when d.challenger_account_id = ${accountId} then d.defender_account_id
        else d.challenger_account_id end as other, count(*)::int as n
      from duels d
      where d.kind = 'rated'
        and (d.challenger_account_id = ${accountId} or d.defender_account_id = ${accountId})
        and d.fought_at > ${since}::timestamptz and d.fought_at <= ${at.toISOString()}::timestamptz
      group by 1`,
  );
  const wanted = new Set(others);
  for (const r of rows) if (wanted.has(r.other)) out.set(r.other, Number(r.n));
  return out;
}

/**
 * Of `others`, the accounts that may never meet `accountId` in a rated duel (game-core
 * `ratedPairExclusion`): friends, guildmates (both read live) and accounts that share a sign-up
 * signal with it. The only signal is the **mailbox** (game-core `mailboxKey` of the stored email:
 * case, `+tags` and Gmail dots folded). Emails are read here and compared in memory only: never
 * returned, logged, audited or stored in another form.
 */
export async function ratedExclusions(
  db: Executor,
  accountId: string,
  others: readonly string[],
): Promise<Map<string, 'friend' | 'guildmate' | 'sharedSignal'>> {
  const out = new Map<string, 'friend' | 'guildmate' | 'sharedSignal'>();
  const ids = [...new Set(others)].filter((id) => id !== accountId);
  if (ids.length === 0) return out;
  const [friends, mates, emails] = await Promise.all([
    friendIds(db, accountId),
    guildmateIds(db, accountId),
    db
      .select({ id: accounts.id, email: accounts.email })
      .from(accounts)
      .where(inArray(accounts.id, [accountId, ...ids])),
  ]);
  const friendSet = new Set(friends);
  const mateSet = new Set(mates);
  const mine = emails.find((e) => e.id === accountId);
  const myKey = mine ? mailboxKey(mine.email) : null;
  const shared = new Set(
    emails
      .filter((e) => e.id !== accountId && myKey !== null && mailboxKey(e.email) === myKey)
      .map((e) => e.id),
  );
  for (const id of ids) {
    if (friendSet.has(id)) out.set(id, 'friend');
    else if (mateSet.has(id)) out.set(id, 'guildmate');
    else if (shared.has(id)) out.set(id, 'sharedSignal');
  }
  return out;
}

/** Whether two accounts share a sign-up signal (the mailbox). Never announced to players. */
export async function shareSignal(db: Executor, a: string, b: string): Promise<boolean> {
  if (a === b) return false;
  const rows = await db
    .select({ email: accounts.email })
    .from(accounts)
    .where(inArray(accounts.id, [a, b]));
  return rows.length === 2 && mailboxKey(rows[0]!.email) === mailboxKey(rows[1]!.email);
}

export interface RatedSide {
  accountId: string;
  characterId: string;
  classId: ClassId;
  level: number;
  bracketId: string;
}

/**
 * Inside a rated duel's transaction, after the duel was simulated and before its row is written:
 * both heroes' ratings move (game-core `rateDuel`), under the locks described above. Returns what
 * to store on the duel row, or null when no season is open at `now` (the duel still counts toward
 * the daily ten, but moves no rating).
 */
export async function applyRatedDuel(
  tx: Transaction,
  input: {
    challenger: RatedSide;
    defender: RatedSide;
    outcome: DuelOutcome;
    now: Date;
  },
): Promise<DuelRatingRecord | null> {
  const { challenger: c, defender: d, now } = input;
  const season = await lockOpenSeason(tx, now);
  if (!season) return null;
  const [lo, hi] = [c.accountId, d.accountId].sort();
  await xactLock(tx, `arena-pair:${lo}:${hi}`);
  for (const id of [c.characterId, d.characterId].sort())
    await xactLock(tx, `arena-rating:${season.number}:${id}`);
  const current = await ratingsFor(tx, season.number, [c.characterId, d.characterId]);
  const cur = (id: string) => current.get(id)!;
  const prior = await priorPairDuels(tx, c.accountId, d.accountId, now);
  const factor = ratingFactor(prior);
  const out = rateDuel({
    challenger: {
      rating: cur(c.characterId).rating,
      lastRatedAt: cur(c.characterId).row?.lastRatedAt ?? null,
    },
    defender: {
      rating: cur(d.characterId).rating,
      lastRatedAt: cur(d.characterId).row?.lastRatedAt ?? null,
    },
    outcome: input.outcome,
    factor,
    now,
  });
  const write = async (side: RatedSide, after: Rating, score: 'win' | 'loss' | 'draw') => {
    const inc = {
      wins: score === 'win' ? 1 : 0,
      losses: score === 'loss' ? 1 : 0,
      draws: score === 'draw' ? 1 : 0,
    };
    await tx
      .insert(arenaRatings)
      .values({
        season: season.number,
        characterId: side.characterId,
        accountId: side.accountId,
        classId: side.classId,
        level: side.level,
        bracketId: side.bracketId,
        ratingVersion: ARENA_RATING_VERSION,
        ...after,
        games: 1,
        ...inc,
        lastRatedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [arenaRatings.season, arenaRatings.characterId],
        set: {
          classId: side.classId,
          level: side.level,
          bracketId: side.bracketId,
          ratingVersion: ARENA_RATING_VERSION,
          ...after,
          games: sql`${arenaRatings.games} + 1`,
          wins: sql`${arenaRatings.wins} + ${inc.wins}`,
          losses: sql`${arenaRatings.losses} + ${inc.losses}`,
          draws: sql`${arenaRatings.draws} + ${inc.draws}`,
          lastRatedAt: now,
          updatedAt: now,
        },
      });
  };
  const cScore =
    input.outcome === 'draw' ? 'draw' : input.outcome === 'challenger' ? 'win' : 'loss';
  const dScore = cScore === 'draw' ? 'draw' : cScore === 'win' ? 'loss' : 'win';
  await write(c, out.challenger.after, cScore);
  await write(d, out.defender.after, dScore);
  return {
    season: season.number,
    ratingVersion: ARENA_RATING_VERSION,
    factor,
    priorPairDuels: prior,
    challenger: { before: out.challenger.before, after: out.challenger.after },
    defender: { before: out.defender.before, after: out.defender.after },
  };
}

/** A hero's rows across seasons, newest first (the arena screen's history line). */
export async function heroRatings(db: Executor, characterId: string): Promise<ArenaRating[]> {
  return db
    .select()
    .from(arenaRatings)
    .where(eq(arenaRatings.characterId, characterId))
    .orderBy(desc(arenaRatings.season));
}

/** A rating as players see it (ticket 5.6): rounded, with its likely range and plain words. */
export interface RatingView {
  rating: number;
  low: number;
  high: number;
  standing: RatingStanding;
  games: number;
  wins: number;
  losses: number;
  draws: number;
}

export function ratingView(
  r: Rating,
  record: { games: number; wins: number; losses: number; draws: number } | null,
): RatingView {
  const range = ratingRange(r);
  const games = record?.games ?? 0;
  return {
    rating: range.shown,
    low: range.low,
    high: range.high,
    standing: ratingStanding(r, games),
    games,
    wins: record?.wins ?? 0,
    losses: record?.losses ?? 0,
    draws: record?.draws ?? 0,
  };
}
