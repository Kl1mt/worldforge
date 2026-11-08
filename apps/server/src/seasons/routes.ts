import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { PRESTIGE_METRICS, type PrestigeMetric } from '@worldforge/game-core';
import { characters, prestigeDisplays, seasonAwards, type Season } from '../db/schema.js';
import type { Executor, Transaction } from '../db/types.js';
import { ApiError } from '../errors.js';
import { socialWrite } from '../social/social-write.js';
import { seasonViewSchema } from '../leaderboards/routes.js';
import {
  currentAndNext,
  listSeasons,
  prestigeFor,
  prestigeShownSchema,
  scheduleSeason,
  seasonView,
  setSeasonEnd,
  NO_PRESTIGE_SHOWN,
} from './model.js';
import { queryRows } from '../db/query.js';
import { writeAudit } from '../db/audit.js';

/**
 * Ticket 5.3 routes (docs/API_CONVENTIONS.md "Seasons"):
 * - `GET /api/seasons`: the season under way, the next one and the past ones (the board filter).
 * - `GET /api/account/prestige`, `POST /api/account/prestige`: the player's earned awards and the
 *   title and frame they show (a social write: rate limited, audited).
 * - Admin (inside D.3's `/api/admin` scope, admins only): `GET /admin/seasons`,
 *   `POST /admin/seasons` (schedule or replace the next), `POST /admin/seasons/:number/end`
 *   (`{ endsAt }`, or `{}` to end now). No role is granted anywhere here.
 */

export interface SeasonRouteOptions {
  /** The game clock (season windows and `achieved_at` use it). */
  now: () => Date;
}

const seasonsResponse = {
  type: 'object',
  required: ['now', 'current', 'next', 'past'],
  properties: {
    now: { type: 'string' },
    current: { anyOf: [{ type: 'null' }, seasonViewSchema] },
    next: { anyOf: [{ type: 'null' }, seasonViewSchema] },
    past: { type: 'array', items: seasonViewSchema },
  },
} as const;

function seasonsBody(list: Season[], now: Date) {
  const { current, next } = currentAndNext(list, now);
  return {
    now: now.toISOString(),
    current: current ? seasonView(current, now) : null,
    next: next ? seasonView(next, now) : null,
    past: list
      .filter((s) => s.endsAt.getTime() <= now.getTime())
      .reverse()
      .map((s) => seasonView(s, now)),
  };
}

const choiceSchema = {
  anyOf: [
    { type: 'null' },
    {
      type: 'object',
      additionalProperties: false,
      required: ['season', 'metric'],
      properties: {
        season: { type: 'integer', minimum: 1, maximum: 100_000 },
        metric: { type: 'string', enum: [...PRESTIGE_METRICS] },
      },
    },
  ],
} as const;

const prestigeSettingsSchema = {
  type: 'object',
  required: ['earned', 'shown'],
  properties: {
    earned: {
      type: 'array',
      items: {
        type: 'object',
        required: ['season', 'metric', 'tier', 'rank', 'heroName', 'awardedAt'],
        properties: {
          season: { type: 'integer' },
          metric: { type: 'string' },
          tier: { type: 'string' },
          rank: { type: 'integer' },
          heroName: { type: ['string', 'null'] },
          awardedAt: { type: 'string' },
        },
      },
    },
    shown: prestigeShownSchema,
  },
} as const;

type Choice = { season: number; metric: PrestigeMetric } | null;

async function prestigeSettings(db: Executor, accountId: string) {
  const earned = await db
    .select({
      season: seasonAwards.season,
      metric: seasonAwards.metric,
      tier: seasonAwards.tier,
      rank: seasonAwards.rank,
      heroName: characters.name,
      awardedAt: seasonAwards.awardedAt,
    })
    .from(seasonAwards)
    .leftJoin(characters, eq(characters.id, seasonAwards.characterId))
    .where(eq(seasonAwards.accountId, accountId))
    .orderBy(desc(seasonAwards.season), asc(seasonAwards.rank), asc(seasonAwards.metric));
  const shown = (await prestigeFor(db, [accountId])).get(accountId) ?? NO_PRESTIGE_SHOWN;
  return {
    earned: earned.map((e) => ({
      ...e,
      heroName: e.heroName ?? null,
      awardedAt: e.awardedAt.toISOString(),
    })),
    shown,
  };
}

async function ownsAward(tx: Transaction, accountId: string, c: Choice): Promise<boolean> {
  if (c === null) return true;
  const [row] = await tx
    .select({ season: seasonAwards.season })
    .from(seasonAwards)
    .where(
      and(
        eq(seasonAwards.accountId, accountId),
        eq(seasonAwards.season, c.season),
        eq(seasonAwards.metric, c.metric),
      ),
    );
  return row !== undefined;
}

export async function registerSeasons(
  app: FastifyInstance,
  options: SeasonRouteOptions,
): Promise<void> {
  app.get(
    '/seasons',
    { preHandler: app.requireAccount, schema: { response: { 200: seasonsResponse } } },
    async () => seasonsBody(await listSeasons(app.db), options.now()),
  );

  app.get(
    '/account/prestige',
    { preHandler: app.requireAccount, schema: { response: { 200: prestigeSettingsSchema } } },
    async (request) => prestigeSettings(app.db, request.auth!.account.id),
  );

  // Which earned title and frame to show; each `null` (show none) or one of the player's own
  // awards. A social write (rate limited, audited); carries no player text.
  app.post(
    '/account/prestige',
    {
      preHandler: app.requireAccount,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'frame'],
          properties: { title: choiceSchema, frame: choiceSchema },
        },
        response: { 200: prestigeSettingsSchema },
      },
    },
    async (request, reply) => {
      const body = request.body as { title: Choice; frame: Choice };
      return socialWrite(app, request, reply, 'profile', async (tx, { account, now }) => {
        for (const [field, choice] of [
          ['title', body.title],
          ['frame', body.frame],
        ] as const) {
          if (!(await ownsAward(tx, account.id, choice))) {
            throw new ApiError(422, 'award_not_earned', 'You have not earned that honour.', {
              fields: { [field]: 'not_earned' },
            });
          }
        }
        const values = {
          titleSeason: body.title?.season ?? null,
          titleMetric: body.title?.metric ?? null,
          frameSeason: body.frame?.season ?? null,
          frameMetric: body.frame?.metric ?? null,
          updatedAt: now,
        };
        await tx
          .insert(prestigeDisplays)
          .values({ accountId: account.id, ...values })
          .onConflictDoUpdate({ target: prestigeDisplays.accountId, set: values });
        await writeAudit(tx, {
          event: 'profile.prestige',
          accountId: account.id,
          data: { title: body.title, frame: body.frame },
        });
        return prestigeSettings(tx, account.id);
      });
    },
  );
}

const adminSeasonsResponse = {
  type: 'object',
  required: ['now', 'current', 'next', 'past', 'counts'],
  properties: {
    ...seasonsResponse.properties,
    /** Per season shown: rows on its boards, final standings and awards. */
    counts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['season', 'entries', 'standings', 'awards'],
        properties: {
          season: { type: 'integer' },
          entries: { type: 'integer' },
          standings: { type: 'integer' },
          awards: { type: 'integer' },
        },
      },
    },
  },
} as const;

/** The admin panel's season controls; registered inside the `/admin` scope (its 404 guard). */
export async function registerSeasonAdmin(
  admin: FastifyInstance,
  options: SeasonRouteOptions & {
    audit: (accountId: string, event: string, data: Record<string, unknown>) => Promise<unknown>;
    /** D.3's guard: re-reads the admin's role inside the plan transaction. */
    lockAdmin: (tx: Transaction, accountId: string) => Promise<void>;
  },
): Promise<void> {
  const body = async () => {
    const now = options.now();
    const list = await listSeasons(admin.db);
    const view = seasonsBody(list, now);
    const shown = [view.current, view.next, ...view.past.slice(0, 10)].filter((s) => s !== null);
    const counts = await queryRows<{
      season: number;
      entries: number;
      standings: number;
      awards: number;
    }>(
      admin.db,
      sql`select s.number as season,
          (select count(*)::int from season_entries e where e.season = s.number) as entries,
          (select count(*)::int from season_standings t where t.season = s.number) as standings,
          (select count(*)::int from season_awards a where a.season = s.number) as awards
        from seasons s where s.number = any(${`{${shown.map((s) => s.number).join(',')}}`}::int[])
        order by s.number desc`,
    );
    return { ...view, past: view.past.slice(0, 10), counts };
  };

  admin.get(
    '/seasons',
    { schema: { response: { 200: adminSeasonsResponse } } },
    async (request) => {
      const out = await body();
      await options.audit(request.auth!.account.id, 'admin.view', { section: 'seasons' });
      return out;
    },
  );

  admin.post(
    '/seasons',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['startsAt', 'endsAt'],
          properties: {
            startsAt: { type: 'string', format: 'date-time', maxLength: 40 },
            endsAt: { type: 'string', format: 'date-time', maxLength: 40 },
          },
        },
        response: { 200: adminSeasonsResponse },
      },
    },
    async (request) => {
      const b = request.body as { startsAt: string; endsAt: string };
      const actor = request.auth!.account.id;
      await scheduleSeason(
        admin.db,
        { startsAt: new Date(b.startsAt), endsAt: new Date(b.endsAt) },
        options.now(),
        { accountId: actor, via: 'admin', guard: (tx) => options.lockAdmin(tx, actor) },
      );
      return body();
    },
  );

  admin.post(
    '/seasons/:number/end',
    {
      schema: {
        params: {
          type: 'object',
          required: ['number'],
          properties: { number: { type: 'integer', minimum: 1, maximum: 100_000 } },
        },
        body: {
          type: ['object', 'null'],
          additionalProperties: false,
          properties: {
            /** Omitted: end now. */
            endsAt: { type: 'string', format: 'date-time', maxLength: 40 },
          },
        },
        response: { 200: adminSeasonsResponse },
      },
    },
    async (request) => {
      const { number } = request.params as { number: number };
      const b = (request.body ?? {}) as { endsAt?: string };
      const actor = request.auth!.account.id;
      const now = options.now();
      await setSeasonEnd(admin.db, number, b.endsAt ? new Date(b.endsAt) : now, now, {
        accountId: actor,
        via: 'admin',
        guard: (tx) => options.lockAdmin(tx, actor),
      });
      return body();
    },
  );
}
