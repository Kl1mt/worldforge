import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import {
  BOARD_SCOPES,
  CLASS_IDS,
  FORMULA_VERSIONS,
  LEVEL_BRACKET_IDS,
  SCORE_METRICS,
  canViewProfile,
  findLevelBracket,
  type BoardScope,
  type ClassId,
  type ProfileVisibility,
  type ScoreMetric,
} from '@worldforge/game-core';
import { characters, leaderboardEntries } from '../db/schema.js';
import type { Executor } from '../db/types.js';
import { queryRows } from '../db/query.js';
import { ApiError } from '../errors.js';
import { profileRelationsFor } from '../social/profiles.js';
import { hiddenTargetKeys } from '../social/sanctions.js';
import { characterNameKey, profileFieldKey } from '../social/targets.js';
import { refreshAccountHeroes, refreshHeroScores, type SnapshotDeps } from './snapshot.js';
import {
  NO_PRESTIGE_SHOWN,
  listSeasons,
  prestigeFor,
  prestigeShownSchema,
  roseInSeason,
  seasonView,
  type PrestigeShown,
  type SeasonView,
} from '../seasons/model.js';

/**
 * Leaderboards (ticket 5.2, docs/LEADERBOARDS.md "Boards", API_CONVENTIONS.md).
 *
 * - The refresh hook: after every successful write a player makes to a hero (any non-GET route
 *   under `/api/characters`, and the guild boss attempt, which can earn a stage for every hero of
 *   the account), that hero's snapshot rows are brought up to date before the answer is sent: right
 *   after the value transaction, never inside it. A failure is logged, not answered (the sweep
 *   repairs the row).
 * - `GET /api/leaderboards/:metric`: one board page, filters, your own heroes' ranks.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** Ticket 5.2: the game clock when the request arrived (a score change's `achieved_at`). */
    scoreClock: Date | null;
  }
}

export interface LeaderboardOptions {
  /** Game clock (the activity clock: scaled in playtests and e2e runs). */
  now: () => Date;
  /** Board reads per account and window (in-process, like 3.9's limits). */
  readLimit?: { max: number; windowMs: number };
}

/** Sized for a page polled every 60 s and a player clicking through filters and pages. */
export const DEFAULT_BOARD_READ_LIMIT = { max: 60, windowMs: 60_000 };

const READ_METHODS = new Set(['GET', 'HEAD']);

/** Registers the refresh hook on the app (before the API scope, so every route gets it). */
export function registerLeaderboardRefresh(app: FastifyInstance, now: () => Date): void {
  const deps: SnapshotDeps = { db: app.db, worldFlags: () => app.worldState.flags() };
  app.decorateRequest('scoreClock', null);
  app.addHook('onRequest', async (request) => {
    if (!READ_METHODS.has(request.method)) request.scoreClock = now();
  });
  app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload) => {
    if (READ_METHODS.has(request.method) || reply.statusCode >= 300) return payload;
    const accountId = request.auth?.account.id;
    const url = request.routeOptions.url ?? '';
    if (!accountId) return payload;
    const heroRoute = url.startsWith('/api/characters');
    const bossRoute = url === '/api/guild/boss/attempts';
    if (!heroRoute && !bossRoute) return payload;
    const params = request.params as { characterId?: string } | undefined;
    const characterId = heroRoute ? params?.characterId : undefined;
    try {
      await refreshAccountHeroes(deps, accountId, request.scoreClock ?? now(), characterId);
    } catch (err) {
      request.log.error({ err }, 'leaderboard refresh failed');
    }
    return payload;
  });
}

/** One board entry as a player sees it. No account, hero or item id, no time finer than a day. */
export interface BoardEntryView {
  rank: number;
  you: boolean;
  player: {
    handle: string;
    /** Null while a moderator hides it. */
    displayName: string | null;
    /** Whether this viewer may open the player's profile (its visibility and their relation). */
    profile: boolean;
    /** Ticket 5.3: the title and frame the player chose to show (cosmetic). */
    prestige: PrestigeShown;
  };
  hero: {
    /** Shown only where the profile may be opened, and not while a moderator hides it. */
    name: string | null;
    classId: ClassId;
    level: number;
  };
  value: number;
  sortKey: number[];
  /** UTC day on which the hero reached this standing (the last tie-breaker). */
  achievedOn: string;
}

export interface BoardView {
  metric: ScoreMetric;
  scope: BoardScope;
  /** Ticket 5.3: the season shown (`scope=season`); null for all time, or before any season. */
  season: SeasonView | null;
  formulaVersion: number;
  filters: { classId: ClassId | null; bracket: string | null };
  total: number;
  entries: BoardEntryView[];
  /** Opaque; null on the last page. */
  nextCursor: string | null;
  /** The viewer's heroes on this board (with these filters), best first. */
  yours: BoardEntryView[];
  /** Whether the viewer's heroes are left off the boards (an active sanction). */
  youExcluded: boolean;
}

interface RankedRow extends Record<string, unknown> {
  character_id: string;
  account_id: string;
  class_id: ClassId;
  level: number;
  value: string | number;
  sort_key: (string | number)[] | string;
  achieved_at: string | Date;
  rank: string | number;
  total: string | number;
  name: string;
  handle: string;
  display_name: string;
  profile_visibility: ProfileVisibility;
}

/** `bigint[]` comes back as an array from node-postgres and as `{1,2}` text from some drivers. */
function parseKey(raw: RankedRow['sort_key']): number[] {
  if (Array.isArray(raw)) return raw.map(Number);
  return raw.replace(/[{}]/g, '').split(',').filter(Boolean).map(Number);
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

/** An account with an active sanction of any kind is left off every board (read time only). */
const notSanctioned = (now: Date) =>
  sql`not exists (select 1 from sanctions s
    where s.subject_id = e.account_id and s.lifted_at is null and s.expires_at > ${now.toISOString()}::timestamptz)`;

export interface BoardQuery {
  metric: ScoreMetric;
  scope: BoardScope;
  /** `scope=season`: the season's number, its archive state (null: no season to show). */
  season?: { number: number; archived: boolean } | null;
  classId: ClassId | null;
  bracket: string | null;
  offset: number;
  limit: number;
}

/** The board page and the viewer's own entries, ranked over the filtered, eligible rows. */
export async function readBoard(
  db: Executor,
  viewerId: string,
  q: BoardQuery,
  now: Date,
): Promise<BoardView> {
  // The rows a board ranks (ticket 5.3): all time, a season under way (its heroes whose score
  // rose), or an archived season (its final standings, in their archived order).
  const season = q.scope === 'season' ? (q.season ?? null) : null;
  const source =
    q.scope !== 'season'
      ? sql`leaderboard_entries`
      : season?.archived
        ? sql`season_standings`
        : sql`season_entries`;
  const where: SQL[] = [sql`e.metric = ${q.metric}`, notSanctioned(now)];
  if (q.scope !== 'season') where.push(sql`e.formula_version = ${FORMULA_VERSIONS[q.metric]}`);
  else if (!season) where.push(sql`false`);
  else {
    where.push(sql`e.season = ${season.number}`);
    if (!season.archived) where.push(roseInSeason);
  }
  const order = season?.archived
    ? sql`e.rank asc`
    : sql`e.sort_key desc, e.achieved_at asc, e.character_id asc`;
  if (q.classId) where.push(sql`e.class_id = ${q.classId}`);
  const bracket = q.bracket ? findLevelBracket(q.bracket) : undefined;
  if (bracket) {
    where.push(sql`e.level >= ${bracket.min}`);
    if (bracket.max !== null) where.push(sql`e.level <= ${bracket.max}`);
  }
  const rows = await queryRows<RankedRow>(
    db,
    sql`with ranked as (
      select e.character_id, e.account_id, e.class_id, e.level, e.value, e.sort_key, e.achieved_at,
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
  let total = rows.length > 0 ? Number(rows[0]!.total) : 0;
  if (rows.length === 0 && q.offset > 0) {
    const [c] = await queryRows<{ n: number }>(
      db,
      sql`select count(*)::int as n from ${source} e where ${sql.join(where, sql` and `)}`,
    );
    total = c?.n ?? 0;
  }

  const accountIds = [...new Set(rows.map((r) => r.account_id))];
  const relations = await profileRelationsFor(db, viewerId, accountIds);
  const prestige = await prestigeFor(db, accountIds);
  const hidden = await hiddenTargetKeys(
    db,
    [
      ...accountIds.map((id) => profileFieldKey(id, 'displayName')),
      ...rows.map((r) => characterNameKey(r.character_id)),
    ],
    now,
  );
  const view = (r: RankedRow): BoardEntryView => {
    const you = r.account_id === viewerId;
    const profile = canViewProfile(r.profile_visibility, relations.get(r.account_id) ?? 'stranger');
    const nameHidden = !you && hidden.has(characterNameKey(r.character_id));
    return {
      rank: Number(r.rank),
      you,
      player: {
        handle: r.handle,
        displayName:
          !you && hidden.has(profileFieldKey(r.account_id, 'displayName')) ? null : r.display_name,
        profile,
        prestige: prestige.get(r.account_id) ?? NO_PRESTIGE_SHOWN,
      },
      hero: { name: profile && !nameHidden ? r.name : null, classId: r.class_id, level: r.level },
      value: Number(r.value),
      sortKey: parseKey(r.sort_key),
      achievedOn: new Date(r.achieved_at).toISOString().slice(0, 10),
    };
  };
  const entries = rows
    .filter((r) => Number(r.rank) > q.offset && Number(r.rank) <= q.offset + q.limit)
    .map(view);
  const yours = rows.filter((r) => r.account_id === viewerId).map(view);
  const [sanctioned] = await queryRows<{ n: number }>(
    db,
    sql`select count(*)::int as n from sanctions s where s.subject_id = ${viewerId}
      and s.lifted_at is null and s.expires_at > ${now.toISOString()}::timestamptz`,
  );
  return {
    metric: q.metric,
    scope: q.scope,
    season: null,
    formulaVersion: FORMULA_VERSIONS[q.metric],
    filters: { classId: q.classId, bracket: bracket?.id ?? null },
    total,
    entries,
    nextCursor: q.offset + q.limit < total ? encodeCursor(q.offset + q.limit) : null,
    yours,
    youExcluded: (sanctioned?.n ?? 0) > 0,
  };
}

const entrySchema = {
  type: 'object',
  required: ['rank', 'you', 'player', 'hero', 'value', 'sortKey', 'achievedOn'],
  properties: {
    rank: { type: 'integer' },
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
    value: { type: 'number' },
    sortKey: { type: 'array', items: { type: 'number' } },
    achievedOn: { type: 'string' },
  },
} as const;

export const seasonViewSchema = {
  type: 'object',
  required: ['number', 'startsAt', 'endsAt', 'status', 'archivedAt', 'awardedAt'],
  properties: {
    number: { type: 'integer' },
    startsAt: { type: 'string' },
    endsAt: { type: 'string' },
    status: { type: 'string' },
    archivedAt: { type: ['string', 'null'] },
    awardedAt: { type: ['string', 'null'] },
  },
} as const;

const boardSchema = {
  type: 'object',
  properties: {
    board: {
      type: 'object',
      properties: {
        metric: { type: 'string' },
        scope: { type: 'string' },
        season: { anyOf: [{ type: 'null' }, seasonViewSchema] },
        formulaVersion: { type: 'integer' },
        filters: {
          type: 'object',
          properties: {
            classId: { type: ['string', 'null'] },
            bracket: { type: ['string', 'null'] },
          },
        },
        total: { type: 'integer' },
        entries: { type: 'array', items: entrySchema },
        nextCursor: { type: ['string', 'null'] },
        yours: { type: 'array', items: entrySchema },
        youExcluded: { type: 'boolean' },
      },
    },
  },
} as const;

interface BoardRequest {
  Params: { metric: ScoreMetric };
  Querystring: {
    scope?: BoardScope;
    season?: number;
    class?: ClassId;
    bracket?: string;
    cursor?: string;
    limit?: number;
  };
}

export async function registerLeaderboards(
  app: FastifyInstance,
  options: LeaderboardOptions,
): Promise<void> {
  const deps: SnapshotDeps = { db: app.db, worldFlags: () => app.worldState.flags() };
  const limit = options.readLimit ?? DEFAULT_BOARD_READ_LIMIT;
  const windows = new Map<string, { startedAt: number; n: number }>();

  /** The board read class: bounds how often one account can rank a whole board. */
  const checkRead = (accountId: string, reply: FastifyReply) => {
    const t = app.authNow().getTime();
    let w = windows.get(accountId);
    if (!w || t - w.startedAt >= limit.windowMs || t < w.startedAt) {
      if (!w && windows.size >= 10_000) {
        for (const [id, x] of windows) if (t - x.startedAt >= limit.windowMs) windows.delete(id);
      }
      w = { startedAt: t, n: 0 };
      windows.set(accountId, w);
    }
    if (w.n >= limit.max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((w.startedAt + limit.windowMs - t) / 1000));
      void reply.header('retry-after', String(retryAfterSeconds));
      throw new ApiError(
        429,
        'rate_limited',
        `Too many board reads. Try again in ${retryAfterSeconds} s.`,
        {
          retryAfterSeconds,
          limit: 'boards',
        },
      );
    }
    w.n += 1;
  };

  app.get<BoardRequest>(
    '/leaderboards/:metric',
    {
      preHandler: app.requireAccount,
      schema: {
        params: {
          type: 'object',
          required: ['metric'],
          properties: { metric: { type: 'string', enum: [...SCORE_METRICS] } },
        },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            scope: { type: 'string', enum: [...BOARD_SCOPES] },
            season: { type: 'integer', minimum: 1, maximum: 100_000 },
            class: { type: 'string', enum: [...CLASS_IDS] },
            bracket: { type: 'string', enum: [...LEVEL_BRACKET_IDS] },
            cursor: { type: 'string', maxLength: 64 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
        response: { 200: boardSchema },
      },
    },
    async (request, reply) => {
      const accountId = request.auth!.account.id;
      checkRead(accountId, reply);
      const now = app.authNow();
      // The lazy backfill for the viewer: heroes without current rows get them now.
      const own = await app.db
        .select({
          id: characters.id,
          n: sql<number>`(select count(*)::int from ${leaderboardEntries}
          where ${leaderboardEntries.characterId} = ${characters.id})`,
        })
        .from(characters)
        .where(and(eq(characters.accountId, accountId)));
      for (const h of own) {
        if (h.n < SCORE_METRICS.length) await refreshHeroScores(deps, h.id, options.now());
      }
      // Ticket 5.3: which season (`scope=season`): the one asked for, else the season under way,
      // else the latest that has begun; none yet is an empty board, an unknown number a 404.
      const scope = request.query.scope ?? (request.query.season ? 'season' : 'allTime');
      let season: SeasonView | null = null;
      if (scope === 'season') {
        const gameNow = options.now();
        const list = await listSeasons(app.db);
        const begun = list.filter((s) => s.startsAt.getTime() <= gameNow.getTime());
        const pick =
          request.query.season !== undefined
            ? begun.find((s) => s.number === request.query.season)
            : begun.at(-1);
        if (request.query.season !== undefined && !pick)
          throw new ApiError(404, 'season_not_found', 'No such season (or it has not begun).');
        season = pick ? seasonView(pick, gameNow) : null;
      }
      const board = await readBoard(
        app.db,
        accountId,
        {
          metric: request.params.metric,
          scope,
          season: season ? { number: season.number, archived: season.archivedAt !== null } : null,
          classId: request.query.class ?? null,
          bracket: request.query.bracket ?? null,
          offset: decodeCursor(request.query.cursor),
          limit: request.query.limit ?? 50,
        },
        now,
      );
      const body = { board: { ...board, season } };
      const etag = `"${createHash('sha256').update(JSON.stringify(body)).digest('base64url').slice(0, 22)}"`;
      void reply.header('etag', etag).header('cache-control', 'private, no-cache');
      if (request.headers['if-none-match'] === etag) return reply.code(304).send();
      return body;
    },
  );
}
