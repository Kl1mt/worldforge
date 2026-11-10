import type { FastifyInstance } from 'fastify';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  COSMETICS,
  cosmeticShownToday,
  findCosmetic,
  findEventDefinition,
  EVENT_DEFINITIONS,
  type MaterialId,
} from '@worldforge/game-core';
import {
  characters,
  cosmeticUnlocks,
  eventParticipants,
  eventTrackGrants,
  eventTracks,
  type WorldEvent,
} from '../db/schema.js';
import type { Executor, Transaction } from '../db/types.js';
import { withTransaction } from '../db/transaction.js';
import { queryRows } from '../db/query.js';
import { ApiError } from '../errors.js';
import { settleActivityTx, type ActivityOptions } from '../activity/settle.js';
import {
  cancelEvent,
  currentAndNextEvent,
  eventView,
  eventViewSchema,
  listEvents,
  scheduleEvent,
  setEventEnd,
  type CosmeticLookup,
} from './model.js';
import { joinEventTx } from './progress.js';

/**
 * Ticket 6.6 routes (docs/API_CONVENTIONS.md "Events", docs/EVENTS.md):
 * - `GET /api/events`: the event under way and the next one (the banner, the Tavern notice).
 * - `GET /api/characters/:id/event`: the hero's part in the event under way (quests, bonus) and
 *   the account's reward track.
 * - `POST /api/characters/:id/event/join`: take part (settles the hero first; repeat-safe).
 * - `GET /api/account/cosmetics`: the account's unlocked cosmetics.
 * - Admin (inside D.3's `/api/admin` scope): `GET /admin/events`, `POST /admin/events`,
 *   `POST /admin/events/:number/end` (`{ endsAt }`, or `{}` to end now),
 *   `POST /admin/events/:number/cancel`.
 */

export const cosmeticView: CosmeticLookup = (id) => {
  const c = findCosmetic(id);
  return {
    id,
    kind: c?.kind ?? 'unknown',
    name: c?.name ?? id,
    description: c?.description ?? '',
    shownToday: c ? cosmeticShownToday(c) : false,
  };
};

const view = (e: WorldEvent | null, now: Date) => (e ? eventView(e, now, cosmeticView) : null);

const nullable = (schema: object) => ({ anyOf: [{ type: 'null' }, schema] });

const eventsResponse = {
  type: 'object',
  required: ['now', 'current', 'next'],
  properties: {
    now: { type: 'string' },
    current: nullable(eventViewSchema),
    next: nullable(eventViewSchema),
  },
} as const;

const materialBag = { type: 'object', additionalProperties: { type: 'integer' } } as const;

const heroEventResponse = {
  type: 'object',
  required: ['now', 'current', 'next', 'hero', 'track'],
  properties: {
    ...eventsResponse.properties,
    hero: nullable({
      type: 'object',
      required: ['joinedAt', 'quests', 'tallies', 'bountyKills', 'bonus'],
      properties: {
        joinedAt: { type: 'string' },
        quests: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'progress', 'target', 'done'],
            properties: {
              id: { type: 'string' },
              progress: { type: 'integer' },
              target: { type: 'integer' },
              done: { type: 'boolean' },
            },
          },
        },
        tallies: { type: 'integer' },
        bountyKills: { type: 'integer' },
        bonus: materialBag,
      },
    }),
    track: nullable({
      type: 'object',
      required: ['tallies', 'granted'],
      properties: {
        tallies: { type: 'integer' },
        granted: {
          type: 'array',
          items: {
            type: 'object',
            required: ['tier', 'cosmeticId', 'grantedAt'],
            properties: {
              tier: { type: 'integer' },
              cosmeticId: { type: 'string' },
              grantedAt: { type: 'string' },
            },
          },
        },
      },
    }),
  },
} as const;

const characterParams = {
  type: 'object',
  required: ['characterId'],
  properties: { characterId: { type: 'string', format: 'uuid' } },
} as const;

const notFound = () => new ApiError(404, 'not_found', 'No such character.');

async function ownedHero(db: Executor, accountId: string, characterId: string) {
  const [hero] = await db
    .select({ id: characters.id, accountId: characters.accountId })
    .from(characters)
    .where(
      and(
        eq(characters.id, characterId),
        eq(characters.accountId, accountId),
        isNull(characters.deletedAt),
      ),
    );
  if (!hero) throw notFound();
  return hero;
}

/** The hero's part in the event under way and the account's track, as clients see them. */
export async function heroEventBody(
  db: Executor,
  hero: { id: string; accountId: string },
  now: Date,
) {
  const list = await listEvents(db);
  const { current, next } = currentAndNextEvent(list, now);
  const base = { now: now.toISOString(), current: view(current, now), next: view(next, now) };
  const def = current ? findEventDefinition(current.definitionId) : undefined;
  if (!current || !def) return { ...base, hero: null, track: null };
  const [p] = await db
    .select()
    .from(eventParticipants)
    .where(
      and(eq(eventParticipants.event, current.number), eq(eventParticipants.characterId, hero.id)),
    );
  const [t] = await db
    .select({ tallies: eventTracks.tallies })
    .from(eventTracks)
    .where(and(eq(eventTracks.event, current.number), eq(eventTracks.accountId, hero.accountId)));
  const granted = await db
    .select({
      tier: eventTrackGrants.tier,
      cosmeticId: eventTrackGrants.cosmeticId,
      grantedAt: eventTrackGrants.grantedAt,
    })
    .from(eventTrackGrants)
    .where(
      and(
        eq(eventTrackGrants.event, current.number),
        eq(eventTrackGrants.accountId, hero.accountId),
      ),
    )
    .orderBy(asc(eventTrackGrants.tier));
  return {
    ...base,
    hero: p
      ? {
          joinedAt: p.joinedAt.toISOString(),
          quests: def.quests.map((q, i) => ({
            id: q.id,
            progress: p.progress[i] ?? 0,
            target: q.objective.count,
            done: (p.progress[i] ?? 0) >= q.objective.count,
          })),
          tallies: p.tallies,
          bountyKills: p.bountyKills,
          bonus: p.bonus as Partial<Record<MaterialId, number>>,
        }
      : null,
    track: {
      tallies: t?.tallies ?? 0,
      granted: granted.map((g) => ({ ...g, grantedAt: g.grantedAt.toISOString() })),
    },
  };
}

const cosmeticsResponse = {
  type: 'object',
  required: ['unlocks'],
  properties: {
    unlocks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'kind', 'name', 'description', 'shownToday', 'source', 'grantedAt'],
        properties: {
          id: { type: 'string' },
          kind: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          shownToday: { type: 'boolean' },
          source: { type: 'string' },
          grantedAt: { type: 'string' },
        },
      },
    },
  },
} as const;

export async function accountCosmetics(db: Executor, accountId: string) {
  const rows = await db
    .select()
    .from(cosmeticUnlocks)
    .where(eq(cosmeticUnlocks.accountId, accountId))
    .orderBy(asc(cosmeticUnlocks.grantedAt), asc(cosmeticUnlocks.cosmeticId));
  return {
    unlocks: rows.map((r) => ({
      ...cosmeticView(r.cosmeticId),
      source: r.source,
      grantedAt: r.grantedAt.toISOString(),
    })),
  };
}

/** Player routes. */
export async function registerEvents(
  app: FastifyInstance,
  activity: ActivityOptions,
): Promise<void> {
  app.get(
    '/events',
    { preHandler: app.requireAccount, schema: { response: { 200: eventsResponse } } },
    async () => {
      const now = activity.now();
      const { current, next } = currentAndNextEvent(await listEvents(app.db), now);
      return { now: now.toISOString(), current: view(current, now), next: view(next, now) };
    },
  );

  app.get<{ Params: { characterId: string } }>(
    '/characters/:characterId/event',
    {
      preHandler: app.requireAccount,
      schema: { params: characterParams, response: { 200: heroEventResponse } },
    },
    async (request) => {
      const hero = await ownedHero(app.db, request.auth!.account.id, request.params.characterId);
      return heroEventBody(app.db, hero, activity.now());
    },
  );

  app.post<{ Params: { characterId: string } }>(
    '/characters/:characterId/event/join',
    {
      preHandler: app.requireAccount,
      schema: {
        params: characterParams,
        response: { 200: heroEventResponse, 201: heroEventResponse },
      },
    },
    async (request, reply) => {
      const accountId = request.auth!.account.id;
      const { characterId } = request.params;
      const { joined, body } = await withTransaction(app.db, async (tx: Transaction) => {
        const now = activity.now();
        const [hero] = await tx
          .select()
          .from(characters)
          .where(
            and(
              eq(characters.id, characterId),
              eq(characters.accountId, accountId),
              isNull(characters.deletedAt),
            ),
          )
          .for('no key update');
        if (!hero) throw notFound();
        // Settle first: farming before the join never counts toward the event.
        await settleActivityTx(tx, characterId, activity, { touch: true });
        const { current } = currentAndNextEvent(await listEvents(tx), now);
        const out = await joinEventTx(tx, hero, current, now);
        return { joined: out.joined, body: await heroEventBody(tx, hero, now) };
      });
      return reply.code(joined ? 201 : 200).send(body);
    },
  );

  app.get(
    '/account/cosmetics',
    { preHandler: app.requireAccount, schema: { response: { 200: cosmeticsResponse } } },
    async (request) => accountCosmetics(app.db, request.auth!.account.id),
  );
}

const adminEventsResponse = {
  type: 'object',
  required: ['now', 'definitions', 'current', 'next', 'past', 'counts'],
  properties: {
    now: { type: 'string' },
    definitions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'name', 'tagline', 'defaultDays'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          tagline: { type: 'string' },
          defaultDays: { type: 'integer' },
        },
      },
    },
    current: nullable(eventViewSchema),
    next: nullable(eventViewSchema),
    past: {
      type: 'array',
      items: {
        type: 'object',
        required: ['event', 'closedAt', 'cancelledAt', 'rewardsSweptAt'],
        properties: {
          event: eventViewSchema,
          closedAt: { type: ['string', 'null'] },
          cancelledAt: { type: ['string', 'null'] },
          rewardsSweptAt: { type: ['string', 'null'] },
        },
      },
    },
    /** Per event shown: heroes and accounts taking part (test accounts left out), tiers granted. */
    counts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['event', 'heroes', 'accounts', 'questsDone', 'grants'],
        properties: {
          event: { type: 'integer' },
          heroes: { type: 'integer' },
          accounts: { type: 'integer' },
          questsDone: { type: 'integer' },
          grants: { type: 'integer' },
        },
      },
    },
  },
} as const;

/** The admin panel's and the CLI's view of the calendar. */
export async function adminEventsBody(db: Executor, now: Date) {
  const list = await listEvents(db);
  const { current, next } = currentAndNextEvent(list, now);
  const past = list
    .filter(
      (e) => e !== current && e !== next && (e.cancelledAt || e.endsAt.getTime() <= now.getTime()),
    )
    .reverse()
    .slice(0, 10);
  const shown = [current, next, ...past].filter((e): e is WorldEvent => e !== null);
  const counts =
    shown.length === 0
      ? []
      : await queryRows<{
          event: number;
          heroes: number;
          accounts: number;
          questsDone: number;
          grants: number;
        }>(
          db,
          sql`select w.number as event,
              (select count(*)::int from event_participants e
                where e.event = w.number and not exists (select 1 from accounts a
                  where a.id = e.account_id and a.is_test)) as heroes,
              (select count(distinct e.account_id)::int from event_participants e
                where e.event = w.number and not exists (select 1 from accounts a
                  where a.id = e.account_id and a.is_test)) as accounts,
              0 as "questsDone",
              (select count(*)::int from event_track_grants g
                where g.event = w.number and not exists (select 1 from accounts a
                  where a.id = g.account_id and a.is_test)) as grants
            from world_events w
            where w.number = any(${`{${shown.map((e) => e.number).join(',')}}`}::int[])
            order by w.number desc`,
        );
  // Quests done per event: counted in game-core terms (progress at each quest's target).
  for (const c of counts) {
    const e = shown.find((x) => x.number === c.event)!;
    const def = findEventDefinition(e.definitionId);
    if (!def) continue;
    const rows = await db
      .select({ progress: eventParticipants.progress })
      .from(eventParticipants)
      .where(
        and(
          eq(eventParticipants.event, e.number),
          sql`not exists (select 1 from accounts a where a.id = ${eventParticipants.accountId} and a.is_test)`,
        ),
      );
    c.questsDone = rows.reduce(
      (s, r) => s + def.quests.filter((q, i) => (r.progress[i] ?? 0) >= q.objective.count).length,
      0,
    );
  }
  return {
    now: now.toISOString(),
    definitions: EVENT_DEFINITIONS.map((d) => ({
      id: d.id,
      name: d.name,
      tagline: d.tagline,
      defaultDays: d.defaultDays,
    })),
    current: view(current, now),
    next: view(next, now),
    past: past
      .map((e) => ({
        event: view(e, now),
        closedAt: e.closedAt?.toISOString() ?? null,
        cancelledAt: e.cancelledAt?.toISOString() ?? null,
        rewardsSweptAt: e.rewardsSweptAt?.toISOString() ?? null,
      }))
      .filter((p) => p.event !== null),
    counts,
  };
}

/** Cosmetic ids, for tests. */
export const COSMETIC_IDS = COSMETICS.map((c) => c.id);

/** The admin panel's event controls; registered inside the `/admin` scope (its 404 guard). */
export async function registerEventAdmin(
  admin: FastifyInstance,
  options: {
    now: () => Date;
    audit: (accountId: string, event: string, data: Record<string, unknown>) => Promise<unknown>;
    lockAdmin: (tx: Transaction, accountId: string) => Promise<void>;
  },
): Promise<void> {
  const numberParams = {
    type: 'object',
    required: ['number'],
    properties: { number: { type: 'integer', minimum: 1, maximum: 100_000 } },
  } as const;
  const actor = (id: string) => ({
    accountId: id,
    via: 'admin' as const,
    guard: (tx: Transaction) => options.lockAdmin(tx, id),
  });

  admin.get('/events', { schema: { response: { 200: adminEventsResponse } } }, async (request) => {
    const out = await adminEventsBody(admin.db, options.now());
    await options.audit(request.auth!.account.id, 'admin.view', { section: 'events' });
    return out;
  });

  admin.post(
    '/events',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['definitionId', 'startsAt', 'endsAt'],
          properties: {
            definitionId: { type: 'string', minLength: 1, maxLength: 64 },
            startsAt: { type: 'string', format: 'date-time', maxLength: 40 },
            endsAt: { type: 'string', format: 'date-time', maxLength: 40 },
          },
        },
        response: { 200: adminEventsResponse },
      },
    },
    async (request) => {
      const b = request.body as { definitionId: string; startsAt: string; endsAt: string };
      const now = options.now();
      await scheduleEvent(
        admin.db,
        {
          definitionId: b.definitionId,
          startsAt: new Date(b.startsAt),
          endsAt: new Date(b.endsAt),
        },
        now,
        actor(request.auth!.account.id),
      );
      return adminEventsBody(admin.db, now);
    },
  );

  admin.post(
    '/events/:number/end',
    {
      schema: {
        params: numberParams,
        body: {
          type: ['object', 'null'],
          additionalProperties: false,
          properties: { endsAt: { type: 'string', format: 'date-time', maxLength: 40 } },
        },
        response: { 200: adminEventsResponse },
      },
    },
    async (request) => {
      const { number } = request.params as { number: number };
      const b = (request.body ?? {}) as { endsAt?: string };
      const now = options.now();
      await setEventEnd(
        admin.db,
        number,
        b.endsAt ? new Date(b.endsAt) : now,
        now,
        actor(request.auth!.account.id),
      );
      return adminEventsBody(admin.db, now);
    },
  );

  admin.post(
    '/events/:number/cancel',
    { schema: { params: numberParams, response: { 200: adminEventsResponse } } },
    async (request) => {
      const { number } = request.params as { number: number };
      const now = options.now();
      await cancelEvent(admin.db, number, now, actor(request.auth!.account.id));
      return adminEventsBody(admin.db, now);
    },
  );
}
