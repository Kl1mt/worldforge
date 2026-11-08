import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import {
  PATTERN_RULES,
  actionableRoles,
  patternFlags,
  type AccountRole,
  type PatternFlag,
} from '@worldforge/game-core';
import type { Executor } from '../db/types.js';
import { queryRows } from '../db/query.js';
import { writeAudit } from '../db/audit.js';

/**
 * The arena pattern report for moderators (ticket 5.6, docs/PVP.md "Pattern report",
 * docs/SOCIAL.md): pairs of accounts that fought many rated duels against each other in a window,
 * with how lopsided and one-sided they were, how much rating changed hands, and whether both were
 * created with the same invite (the D.2 audit row's invite id, compared on the server; never the
 * code). Read-only: acting happens through the queue's sanctions. Only pairs where the viewer may
 * act on at least one side are listed (`actionableRoles`), and never the viewer's own.
 */

export interface PatternPlayer {
  handle: string;
  displayName: string;
  role: AccountRole;
}

export interface PatternPairView {
  a: PatternPlayer;
  b: PatternPlayer;
  duels: number;
  winsA: number;
  winsB: number;
  draws: number;
  /** Duels `a` started (the rest `b` did). */
  challengesA: number;
  /** Rating `a` and `b` gained from these duels (sum over the pair's rated duels in a season). */
  ratingA: number;
  ratingB: number;
  /** Duels that moved no rating: the repeat-pair factor was 0, or no season was under way. */
  uncounted: number;
  firstOn: string;
  lastOn: string;
  flags: PatternFlag[];
  sameInvite: boolean;
}

interface PairRow extends Record<string, unknown> {
  a: string;
  b: string;
  duels: number;
  wins_a: number;
  wins_b: number;
  draws: number;
  challenges_a: number;
  rating_a: number | null;
  rating_b: number | null;
  uncounted: number;
  first_at: string | Date;
  last_at: string | Date;
}

export async function arenaPatterns(
  db: Executor,
  viewer: { id: string; role: AccountRole },
  now: Date,
  days: number,
  limit: number,
): Promise<{ pairs: PatternPairView[]; windowDays: number; rules: typeof PATTERN_RULES }> {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const pairs = await queryRows<PairRow>(
    db,
    sql`with rated as (
        select least(d.challenger_account_id, d.defender_account_id) as a,
          greatest(d.challenger_account_id, d.defender_account_id) as b,
          d.challenger_account_id as c, d.outcome, d.rating, d.fought_at
        from duels d
        where d.kind = 'rated' and d.fought_at > ${since}::timestamptz
          and d.challenger_account_id is not null and d.defender_account_id is not null
      )
      select a, b, count(*)::int as duels,
        count(*) filter (where (outcome = 'challenger' and c = a) or (outcome = 'defender' and c = b))::int as wins_a,
        count(*) filter (where (outcome = 'challenger' and c = b) or (outcome = 'defender' and c = a))::int as wins_b,
        count(*) filter (where outcome = 'draw')::int as draws,
        count(*) filter (where c = a)::int as challenges_a,
        sum(case when rating is null then 0 when c = a
          then (rating->'challenger'->'after'->>'rating')::float8 - (rating->'challenger'->'before'->>'rating')::float8
          else (rating->'defender'->'after'->>'rating')::float8 - (rating->'defender'->'before'->>'rating')::float8 end) as rating_a,
        sum(case when rating is null then 0 when c = b
          then (rating->'challenger'->'after'->>'rating')::float8 - (rating->'challenger'->'before'->>'rating')::float8
          else (rating->'defender'->'after'->>'rating')::float8 - (rating->'defender'->'before'->>'rating')::float8 end) as rating_b,
        count(*) filter (where rating is null or (rating->>'factor')::float8 = 0)::int as uncounted,
        min(fought_at) as first_at, max(fought_at) as last_at
      from rated
      group by a, b
      having count(*) >= ${PATTERN_RULES.minDuels}`,
  );
  const ids = [...new Set(pairs.flatMap((p) => [p.a, p.b]))];
  const people =
    ids.length === 0
      ? []
      : await queryRows<{
          id: string;
          handle: string;
          display_name: string;
          role: AccountRole;
          invite_id: string | null;
        }>(
          db,
          sql`select a.id, a.handle, a.display_name, a.role,
              (select l.data->>'inviteId' from audit_log l
                where l.account_id = a.id and l.event = 'account.register' limit 1) as invite_id
            from accounts a where a.id in (${sql.join(
              ids.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})`,
        );
  const byId = new Map(people.map((p) => [p.id, p]));
  const actionable = new Set<AccountRole>(actionableRoles(viewer.role) as AccountRole[]);
  const mayAct = (id: string) => id !== viewer.id && actionable.has(byId.get(id)?.role ?? 'admin');
  const day = (d: string | Date) => new Date(d).toISOString().slice(0, 10);
  const views: PatternPairView[] = [];
  for (const p of pairs) {
    const a = byId.get(p.a);
    const b = byId.get(p.b);
    if (!a || !b) continue;
    if (p.a === viewer.id || p.b === viewer.id) continue;
    if (!mayAct(p.a) && !mayAct(p.b)) continue;
    const stats = {
      duels: Number(p.duels),
      winsA: Number(p.wins_a),
      winsB: Number(p.wins_b),
      challengesA: Number(p.challenges_a),
    };
    views.push({
      a: { handle: a.handle, displayName: a.display_name, role: a.role },
      b: { handle: b.handle, displayName: b.display_name, role: b.role },
      ...stats,
      draws: Number(p.draws),
      ratingA: Math.round(Number(p.rating_a ?? 0)),
      ratingB: Math.round(Number(p.rating_b ?? 0)),
      uncounted: Number(p.uncounted),
      firstOn: day(p.first_at),
      lastOn: day(p.last_at),
      flags: patternFlags(stats),
      sameInvite: a.invite_id !== null && a.invite_id === b.invite_id,
    });
  }
  views.sort(
    (x, y) =>
      y.flags.length - x.flags.length ||
      y.duels - x.duels ||
      (x.lastOn < y.lastOn ? 1 : x.lastOn > y.lastOn ? -1 : 0) ||
      x.a.handle.localeCompare(y.a.handle) ||
      x.b.handle.localeCompare(y.b.handle),
  );
  return { pairs: views.slice(0, limit), windowDays: days, rules: PATTERN_RULES };
}

const playerSchema = {
  type: 'object',
  required: ['handle', 'displayName', 'role'],
  properties: {
    handle: { type: 'string' },
    displayName: { type: 'string' },
    role: { type: 'string' },
  },
} as const;

export async function registerArenaPatterns(
  app: FastifyInstance,
  options: { now: () => Date },
): Promise<void> {
  app.get(
    '/mod/arena/patterns',
    {
      onRequest: app.requireStaff,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            days: { type: 'integer', minimum: 1, maximum: 90 },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['pairs', 'windowDays', 'rules'],
            properties: {
              windowDays: { type: 'integer' },
              rules: { type: 'object', additionalProperties: true },
              pairs: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    a: playerSchema,
                    b: playerSchema,
                    duels: { type: 'integer' },
                    winsA: { type: 'integer' },
                    winsB: { type: 'integer' },
                    draws: { type: 'integer' },
                    challengesA: { type: 'integer' },
                    ratingA: { type: 'integer' },
                    ratingB: { type: 'integer' },
                    uncounted: { type: 'integer' },
                    firstOn: { type: 'string' },
                    lastOn: { type: 'string' },
                    flags: { type: 'array', items: { type: 'string' } },
                    sameInvite: { type: 'boolean' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const { days = PATTERN_RULES.windowDays, limit = 50 } = request.query as {
        days?: number;
        limit?: number;
      };
      const actor = request.auth!.account;
      const out = await arenaPatterns(app.db, actor, options.now(), days, limit);
      await writeAudit(app.db, {
        event: 'mod.arena.patterns',
        accountId: actor.id,
        data: { days, pairs: out.pairs.length },
      });
      return out;
    },
  );
}
