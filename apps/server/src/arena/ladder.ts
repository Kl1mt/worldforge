import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import {
  CLASS_IDS,
  LEVEL_BRACKET_IDS,
  PROVISIONAL_GAMES,
  canViewProfile,
  findLevelBracket,
  type ClassId,
  type ProfileVisibility,
} from '@worldforge/game-core';
import type { ArenaRating } from '../db/schema.js';
import type { Executor } from '../db/types.js';
import { queryRows } from '../db/query.js';
import { ApiError } from '../errors.js';
import { profileRelationsFor } from '../social/profiles.js';
import { hiddenTargetKeys } from '../social/sanctions.js';
import { characterNameKey, profileFieldKey } from '../social/targets.js';
import {
  NO_PRESTIGE_SHOWN,
  listSeasons,
  prestigeFor,
  prestigeShownSchema,
  seasonView,
  type PrestigeShown,
  type SeasonView,
} from '../seasons/model.js';
import {
  DEFAULT_BOARD_READ_LIMIT,
  createBoardReadLimiter,
  seasonViewSchema,
} from '../leaderboards/routes.js';
import { ratingView, type RatingView } from './rating.js';
import { notTestOrDeleted } from '../admin/eligibility.js';

/**
 * The arena ladder (ticket 5.6, docs/PVP.md "The ladder"): a season's rated heroes by rating, next
 * to the 5.2/5.3 boards and under their rules: everyone listed by display name (no opt-out), the
 * name links to the profile and the hero's name shows only where `canViewProfile` allows,
 * moderator-hidden names withheld, accounts with an active sanction left out at read time, pages
 * with an offset cursor, ETag polling and the board read limit.
 *
 * - **Who is ranked:** heroes with at least `PROVISIONAL_GAMES` rated duels this season
 *   (attacking and defending). Fewer: "provisional", shown only to their owner (`yours`, no rank).
 * - **Order:** rating (higher first), then more rated duels, then the earlier latest duel, then
 *   the hero id. A season under way reads `arena_ratings`; an archived one its final standings
 *   (`season_standings`, metric `arena`), re-ranked within filters.
 */

const notSanctioned = (now: Date) =>
  sql`not exists (select 1 from sanctions s
    where s.subject_id = e.account_id and s.lifted_at is null and s.expires_at > ${now.toISOString()}::timestamptz)
    and ${notTestOrDeleted}`;

/** The ladder's order over `arena_ratings e`. */
const LADDER_ORDER = sql`e.rating desc, e.games desc, e.last_rated_at asc, e.character_id asc`;

/** The hero's place on a season's ladder under way (no filters), or null if not ranked. */
export async function ladderRankOf(
  db: Executor,
  season: number,
  row: Pick<ArenaRating, 'rating' | 'games' | 'lastRatedAt' | 'characterId' | 'accountId'>,
  now: Date,
): Promise<number | null> {
  if (row.games < PROVISIONAL_GAMES) return null;
  const [own] = await queryRows<{ n: number }>(
    db,
    sql`select count(*)::int as n from sanctions s where s.subject_id = ${row.accountId}
      and s.lifted_at is null and s.expires_at > ${now.toISOString()}::timestamptz`,
  );
  if ((own?.n ?? 0) > 0) return null;
  const t = row.lastRatedAt.toISOString();
  const [ahead] = await queryRows<{ n: number }>(
    db,
    sql`select count(*)::int as n from arena_ratings e
      where e.season = ${season} and e.games >= ${PROVISIONAL_GAMES} and ${notSanctioned(now)}
        and (e.rating > ${row.rating}
          or (e.rating = ${row.rating} and e.games > ${row.games})
          or (e.rating = ${row.rating} and e.games = ${row.games} and e.last_rated_at < ${t}::timestamptz)
          or (e.rating = ${row.rating} and e.games = ${row.games} and e.last_rated_at = ${t}::timestamptz
            and e.character_id < ${row.characterId}::uuid))`,
  );
  return (ahead?.n ?? 0) + 1;
}

export interface LadderEntryView {
  /** Null for your own provisional heroes (not ranked yet). */
  rank: number | null;
  you: boolean;
  player: {
    handle: string;
    /** Null while a moderator hides the name. */
    displayName: string | null;
    profile: boolean;
    prestige: PrestigeShown;
  };
  hero: { name: string | null; classId: ClassId; level: number };
  rating: RatingView;
}

export interface LadderView {
  season: SeasonView | null;
  filters: { classId: ClassId | null; bracket: string | null };
  provisionalGames: number;
  total: number;
  entries: LadderEntryView[];
  nextCursor: string | null;
  /** The viewer's heroes on this season's ladder (ranked first, then provisional). */
  yours: LadderEntryView[];
  youExcluded: boolean;
}

interface LadderRow extends Record<string, unknown> {
  character_id: string;
  account_id: string;
  class_id: ClassId;
  level: number;
  rating: number;
  deviation: number;
  volatility: number;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  rank: string | number | null;
  total: string | number;
  name: string;
  handle: string;
  display_name: string;
  profile_visibility: ProfileVisibility;
}

const encodeCursor = (offset: number) => Buffer.from(`o:${offset}`).toString('base64url');
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const m = /^o:(\d{1,7})$/.exec(Buffer.from(cursor, 'base64url').toString());
  if (!m)
    throw new ApiError(400, 'validation_failed', 'Unknown cursor.', {
      fields: { cursor: 'unknown' },
    });
  return Number(m[1]);
}

export interface LadderQuery {
  season: { number: number; archived: boolean } | null;
  classId: ClassId | null;
  bracket: string | null;
  offset: number;
  limit: number;
}

export async function readLadder(
  db: Executor,
  viewerId: string,
  q: LadderQuery,
  now: Date,
): Promise<Omit<LadderView, 'season'>> {
  const bracket = q.bracket ? findLevelBracket(q.bracket) : undefined;
  const filters: SQL[] = [];
  if (q.classId) filters.push(sql`e.class_id = ${q.classId}`);
  if (bracket) {
    filters.push(sql`e.level >= ${bracket.min}`);
    if (bracket.max !== null) filters.push(sql`e.level <= ${bracket.max}`);
  }
  let rows: LadderRow[] = [];
  let provisional: LadderRow[] = [];
  if (q.season) {
    const n = q.season.number;
    const where = [notSanctioned(now), ...filters];
    // An archived season ranks its final standings (joined to the rating row for the details).
    const source = q.season.archived
      ? sql`(select st.character_id, st.account_id, st.class_id, st.level, st.rank as final_rank,
            r.rating, r.deviation, r.volatility, r.games, r.wins, r.losses, r.draws,
            r.last_rated_at
          from season_standings st
            join arena_ratings r on r.season = st.season and r.character_id = st.character_id
          where st.season = ${n} and st.metric = 'arena')`
      : sql`(select r.*, null::int as final_rank from arena_ratings r
          where r.season = ${n} and r.games >= ${PROVISIONAL_GAMES})`;
    const order = q.season.archived ? sql`e.final_rank asc` : LADDER_ORDER;
    rows = await queryRows<LadderRow>(
      db,
      sql`with ranked as (
        select e.character_id, e.account_id, e.class_id, e.level, e.rating, e.deviation,
          e.volatility, e.games, e.wins, e.losses, e.draws,
          row_number() over (order by ${order}) as rank,
          count(*) over () as total
        from ${source} e
        where ${sql.join(where, sql` and `)}
      )
      select r.*, c.name, a.handle, a.display_name, a.profile_visibility
      from ranked r
        join characters c on c.id = r.character_id
        join accounts a on a.id = r.account_id
      where (r.rank > ${q.offset} and r.rank <= ${q.offset + q.limit}) or r.account_id = ${viewerId}
      order by r.rank`,
    );
    if (!q.season.archived) {
      provisional = await queryRows<LadderRow>(
        db,
        sql`select e.character_id, e.account_id, e.class_id, e.level, e.rating, e.deviation,
            e.volatility, e.games, e.wins, e.losses, e.draws, null as rank, 0 as total,
            c.name, a.handle, a.display_name, a.profile_visibility
          from arena_ratings e
            join characters c on c.id = e.character_id
            join accounts a on a.id = e.account_id
          where e.season = ${n} and e.account_id = ${viewerId} and e.games < ${PROVISIONAL_GAMES}
            ${filters.length ? sql`and ${sql.join(filters, sql` and `)}` : sql``}
          order by e.rating desc, e.character_id`,
      );
    }
  }
  let total = rows.length > 0 ? Number(rows[0]!.total) : 0;
  if (rows.length === 0 && q.offset > 0 && q.season) {
    // Past the end: count for the page footer.
    const [c] = await queryRows<{ n: number }>(
      db,
      q.season.archived
        ? sql`select count(*)::int as n from season_standings e
            where e.season = ${q.season.number} and e.metric = 'arena' and ${notSanctioned(now)}
            ${filters.length ? sql`and ${sql.join(filters, sql` and `)}` : sql``}`
        : sql`select count(*)::int as n from arena_ratings e
            where e.season = ${q.season.number} and e.games >= ${PROVISIONAL_GAMES}
              and ${notSanctioned(now)}
            ${filters.length ? sql`and ${sql.join(filters, sql` and `)}` : sql``}`,
    );
    total = c?.n ?? 0;
  }

  const all = [...rows, ...provisional];
  const accountIds = [...new Set(all.map((r) => r.account_id))];
  const [relations, prestige, hidden, sanctioned] = await Promise.all([
    profileRelationsFor(db, viewerId, accountIds),
    prestigeFor(db, accountIds),
    hiddenTargetKeys(
      db,
      [
        ...accountIds.map((id) => profileFieldKey(id, 'displayName')),
        ...all.map((r) => characterNameKey(r.character_id)),
      ],
      now,
    ),
    queryRows<{ n: number }>(
      db,
      sql`select count(*)::int as n from sanctions s where s.subject_id = ${viewerId}
        and s.lifted_at is null and s.expires_at > ${now.toISOString()}::timestamptz`,
    ),
  ]);
  const youExcluded = (sanctioned[0]?.n ?? 0) > 0;
  const view = (r: LadderRow): LadderEntryView => {
    const you = r.account_id === viewerId;
    const profile = canViewProfile(r.profile_visibility, relations.get(r.account_id) ?? 'stranger');
    const nameHidden = !you && hidden.has(characterNameKey(r.character_id));
    return {
      rank: r.rank === null ? null : Number(r.rank),
      you,
      player: {
        handle: r.handle,
        displayName:
          !you && hidden.has(profileFieldKey(r.account_id, 'displayName')) ? null : r.display_name,
        profile,
        prestige: prestige.get(r.account_id) ?? NO_PRESTIGE_SHOWN,
      },
      hero: {
        name: (you || profile) && !nameHidden ? r.name : null,
        classId: r.class_id,
        level: Number(r.level),
      },
      rating: ratingView(
        {
          rating: Number(r.rating),
          deviation: Number(r.deviation),
          volatility: Number(r.volatility),
        },
        {
          games: Number(r.games),
          wins: Number(r.wins),
          losses: Number(r.losses),
          draws: Number(r.draws),
        },
      ),
    };
  };
  return {
    filters: { classId: q.classId, bracket: bracket?.id ?? null },
    provisionalGames: PROVISIONAL_GAMES,
    total,
    entries: rows
      .filter((r) => Number(r.rank) > q.offset && Number(r.rank) <= q.offset + q.limit)
      .map(view),
    nextCursor: q.offset + q.limit < total ? encodeCursor(q.offset + q.limit) : null,
    yours: youExcluded
      ? []
      : [...rows.filter((r) => r.account_id === viewerId), ...provisional].map(view),
    youExcluded,
  };
}

const ratingSchema = {
  type: 'object',
  required: ['rating', 'low', 'high', 'standing', 'games', 'wins', 'losses', 'draws'],
  properties: {
    rating: { type: 'integer' },
    low: { type: 'integer' },
    high: { type: 'integer' },
    standing: { type: 'string' },
    games: { type: 'integer' },
    wins: { type: 'integer' },
    losses: { type: 'integer' },
    draws: { type: 'integer' },
  },
} as const;

const entrySchema = {
  type: 'object',
  required: ['rank', 'you', 'player', 'hero', 'rating'],
  properties: {
    rank: { type: ['integer', 'null'] },
    you: { type: 'boolean' },
    player: {
      type: 'object',
      properties: {
        handle: { type: 'string' },
        displayName: { type: ['string', 'null'] },
        profile: { type: 'boolean' },
        prestige: prestigeShownSchema,
      },
    },
    hero: {
      type: 'object',
      properties: {
        name: { type: ['string', 'null'] },
        classId: { type: 'string' },
        level: { type: 'integer' },
      },
    },
    rating: ratingSchema,
  },
} as const;

const ladderSchema = {
  type: 'object',
  properties: {
    ladder: {
      type: 'object',
      properties: {
        season: { anyOf: [{ type: 'null' }, seasonViewSchema] },
        filters: {
          type: 'object',
          properties: {
            classId: { type: ['string', 'null'] },
            bracket: { type: ['string', 'null'] },
          },
        },
        provisionalGames: { type: 'integer' },
        total: { type: 'integer' },
        entries: { type: 'array', items: entrySchema },
        nextCursor: { type: ['string', 'null'] },
        yours: { type: 'array', items: entrySchema },
        youExcluded: { type: 'boolean' },
      },
    },
  },
} as const;

interface LadderRequest {
  Querystring: {
    season?: number;
    class?: ClassId;
    bracket?: string;
    cursor?: string;
    limit?: number;
  };
}

export async function registerLadder(
  app: FastifyInstance,
  options: { now: () => Date; readLimit?: { max: number; windowMs: number } },
): Promise<void> {
  const checkRead = createBoardReadLimiter(app, options.readLimit ?? DEFAULT_BOARD_READ_LIMIT);
  app.get<LadderRequest>(
    '/arena/ladder',
    {
      preHandler: app.requireAccount,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            season: { type: 'integer', minimum: 1, maximum: 100_000 },
            class: { type: 'string', enum: [...CLASS_IDS] },
            // Rated duels open at level 10: the 1–9 bracket has no ladder.
            bracket: { type: 'string', enum: LEVEL_BRACKET_IDS.filter((b) => b !== '1-9') },
            cursor: { type: 'string', maxLength: 64 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
        response: { 200: ladderSchema },
      },
    },
    async (request, reply) => {
      const accountId = request.auth!.account.id;
      checkRead(accountId, reply);
      const gameNow = options.now();
      // Which season: the one asked for, else the one under way, else the latest begun.
      const begun = (await listSeasons(app.db)).filter(
        (s) => s.startsAt.getTime() <= gameNow.getTime(),
      );
      const pick =
        request.query.season !== undefined
          ? begun.find((s) => s.number === request.query.season)
          : begun.at(-1);
      if (request.query.season !== undefined && !pick)
        throw new ApiError(404, 'season_not_found', 'No such season (or it has not begun).');
      const season = pick ? seasonView(pick, gameNow) : null;
      const ladder = await readLadder(
        app.db,
        accountId,
        {
          season: season ? { number: season.number, archived: season.archivedAt !== null } : null,
          classId: request.query.class ?? null,
          bracket: request.query.bracket ?? null,
          offset: decodeCursor(request.query.cursor),
          limit: request.query.limit ?? 50,
        },
        app.authNow(),
      );
      const body = { ladder: { season, ...ladder } };
      const etag = `"${createHash('sha256').update(JSON.stringify(body)).digest('base64url').slice(0, 22)}"`;
      void reply.header('etag', etag).header('cache-control', 'private, no-cache');
      if (request.headers['if-none-match'] === etag) return reply.code(304).send();
      return body;
    },
  );
}
