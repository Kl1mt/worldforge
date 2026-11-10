import type { FastifyInstance, FastifyReply } from 'fastify';
import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';
import { HANDLE_RE } from '@worldforge/game-core';
import { accounts, inviteCodes, type InviteCode } from '../db/schema.js';
import { writeAudit } from '../db/audit.js';
import type { Executor } from '../db/types.js';
import { ApiError, notFoundBody } from '../errors.js';
import {
  INVITE_NOTE_MAX,
  MAX_INVITE_USES,
  createInvite,
  inviteRedemptions,
  inviteStatus,
  revokeInvite,
} from '../auth/invites.js';
import { buildTelemetryReport, parseDay, telemetrySections } from '../telemetry/report.js';
import { PLAYER_SEARCH_LIMIT, playerDetail, searchPlayers, staffList } from './players.js';
import { databaseStatus, migrationStatus, statusCounts, type BuildInfo } from './status.js';
import { projectProgressSummary } from '../community/model.js';
import { registerSeasonAdmin } from '../seasons/routes.js';
import { registerSettingsAdmin } from '../settings/routes.js';
import type { ActivityOptions } from '../activity/settle.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { lockAdmin } from './tools.js';
import { registerAdminTools } from './tool-routes.js';

/**
 * The admin panel's API (ticket D.3, docs/API_CONVENTIONS.md "Admin"), all under `/api/admin`.
 * `app.requireAdmin` runs as the scope's `onRequest` hook, before body validation: anyone who is
 * not an admin gets exactly the not-found handler's `404`, whatever they send. Admins then pass
 * `requireAccount` (suspension check, 3.9's per-account limits, presence).
 *
 * Roles are deliberately read-only here: no route grants or revokes a role (4.1's design, so a
 * stolen admin session cannot mint admins); that stays with `pnpm admin:role` on the server.
 *
 * Every route writes an audit row on the admin's account (`admin.view` for the overviews,
 * `admin.player.search`/`admin.player.view`, `admin.telemetry.reconcile`, and D.2's
 * `invite.create`/`invite.revoke` with `via: 'admin'`). Audit data never holds an invite code, an
 * email, an IP or the search text.
 */

export interface AdminOptions {
  /** What the running build was made from (`WORLDFORGE_GIT_SHA`, `WORLDFORGE_BUILD_TIME`). */
  build?: BuildInfo;
  /** The audit-log reconcile scans the whole log: per admin, this many per window. */
  reconcileLimit?: { max: number; windowMs: number };
  /** Ticket 5.3: the game clock for the season controls (default: the auth clock). */
  gameNow?: () => Date;
  /** Ticket D.4: the farming settings (the tools settle and lock heroes like gameplay does). */
  activity?: ActivityOptions;
}

export const DEFAULT_RECONCILE_LIMIT = { max: 3, windowMs: 5 * 60_000 };
const INVITE_PAGE_DEFAULT = 50;
const INVITE_PAGE_MAX = 200;
const MAX_INVITE_TTL_HOURS = 24 * 365;

const refSchema = {
  type: ['object', 'null'],
  required: ['handle', 'displayName'],
  properties: { handle: { type: 'string' }, displayName: { type: 'string' } },
} as const;

const inviteViewSchema = {
  type: 'object',
  required: [
    'id',
    'status',
    'uses',
    'maxUses',
    'expiresAt',
    'revokedAt',
    'note',
    'createdAt',
    'createdBy',
    'redeemedBy',
  ],
  properties: {
    id: { type: 'string' },
    status: { type: 'string' },
    uses: { type: 'integer' },
    maxUses: { type: 'integer' },
    expiresAt: { type: ['string', 'null'] },
    revokedAt: { type: ['string', 'null'] },
    note: { type: 'string' },
    createdAt: { type: 'string' },
    createdBy: refSchema,
    redeemedBy: {
      type: 'array',
      items: {
        type: 'object',
        required: ['handle', 'displayName', 'registeredAt'],
        properties: {
          handle: { type: 'string' },
          displayName: { type: 'string' },
          registeredAt: { type: 'string' },
        },
      },
    },
  },
} as const;

async function inviteViews(db: Executor, rows: InviteCode[], now: Date) {
  const creatorIds = [...new Set(rows.map((r) => r.createdByAccountId).filter((x) => x !== null))];
  const [redemptions, creators] = await Promise.all([
    inviteRedemptions(
      db,
      rows.map((r) => r.id),
    ),
    creatorIds.length
      ? db
          .select({ id: accounts.id, handle: accounts.handle, displayName: accounts.displayName })
          .from(accounts)
          .where(inArray(accounts.id, creatorIds))
      : Promise.resolve([]),
  ]);
  return rows.map((r) => {
    const creator = creators.find((c) => c.id === r.createdByAccountId);
    return {
      id: r.id,
      status: inviteStatus(r, now),
      uses: r.uses,
      maxUses: r.maxUses,
      expiresAt: r.expiresAt?.toISOString() ?? null,
      revokedAt: r.revokedAt?.toISOString() ?? null,
      note: r.note,
      createdAt: r.createdAt.toISOString(),
      createdBy: creator ? { handle: creator.handle, displayName: creator.displayName } : null,
      redeemedBy: (redemptions.get(r.id) ?? []).map((x) => ({
        handle: x.handle,
        displayName: x.displayName,
        registeredAt: x.registeredAt.toISOString(),
      })),
    };
  });
}

const sanctionRowSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    kind: { type: 'string' },
    status: { type: 'string' },
    reason: { type: 'string' },
    target: { type: ['object', 'null'], additionalProperties: { type: 'string' } },
    createdAt: { type: 'string' },
    expiresAt: { type: 'string' },
    liftedAt: { type: ['string', 'null'] },
    liftReason: { type: ['string', 'null'] },
    issuedBy: refSchema,
    liftedBy: refSchema,
  },
} as const;

const reportRowSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    target: { type: 'object', additionalProperties: { type: 'string' } },
    reason: { type: 'string' },
    note: { type: ['string', 'null'] },
    status: { type: 'string' },
    createdAt: { type: 'string' },
    resolvedAt: { type: ['string', 'null'] },
    reporter: refSchema,
    resolvedBy: refSchema,
  },
} as const;

const playerRowSchema = {
  type: 'object',
  properties: {
    handle: { type: 'string' },
    displayName: { type: 'string' },
    role: { type: 'string' },
    createdAt: { type: 'string' },
  },
} as const;

const telemetrySchema = {
  type: 'object',
  required: ['report', 'sections'],
  properties: {
    /** 3.8's rollup sections, exactly as `pnpm report:telemetry` prints them. */
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          tables: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                headers: { type: 'array', items: { type: 'string' } },
                rows: {
                  type: 'array',
                  items: { type: 'array', items: { type: ['string', 'number'] } },
                },
              },
            },
          },
          notes: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    report: {
      type: 'object',
      properties: {
        window: {
          type: 'object',
          properties: {
            from: { type: ['string', 'null'] },
            to: { type: ['string', 'null'] },
            firstDay: { type: ['string', 'null'] },
            lastDay: { type: ['string', 'null'] },
            days: { type: 'integer' },
          },
        },
        rollups: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              metric: { type: 'string' },
              dims: { type: 'array', items: { type: 'string' } },
              events: { type: 'number' },
              amount: { type: 'number' },
            },
          },
        },
        snapshot: {
          type: 'object',
          properties: {
            equippedCharacters: { type: 'integer' },
            usage: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  classId: { type: 'string' },
                  kind: { type: 'string' },
                  id: { type: 'string' },
                  equipped: { type: 'integer' },
                },
              },
            },
            builds: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  classId: { type: 'string' },
                  signature: { type: 'string' },
                  characters: { type: 'integer' },
                },
              },
            },
          },
        },
        reconcile: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              check: { type: 'string' },
              audit: { type: 'number' },
              rollup: { type: 'number' },
              ok: { type: 'boolean' },
            },
          },
        },
      },
    },
  },
} as const;

export async function registerAdmin(app: FastifyInstance, options: AdminOptions = {}) {
  const build: BuildInfo = options.build ?? { gitSha: null, buildTime: null };
  const reconcileLimit = options.reconcileLimit ?? DEFAULT_RECONCILE_LIMIT;
  const reconcileWindows = new Map<string, { startedAt: number; n: number }>();

  /** The stricter class for `?reconcile=1` (it scans the audit log), per admin, in memory. */
  const checkReconcile = (accountId: string, reply: FastifyReply) => {
    const t = app.authNow().getTime();
    let w = reconcileWindows.get(accountId);
    if (!w || t - w.startedAt >= reconcileLimit.windowMs || t < w.startedAt) {
      w = { startedAt: t, n: 0 };
      reconcileWindows.set(accountId, w);
    }
    if (w.n >= reconcileLimit.max) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((w.startedAt + reconcileLimit.windowMs - t) / 1000),
      );
      void reply.header('retry-after', String(retryAfterSeconds));
      throw new ApiError(
        429,
        'rate_limited',
        `The reconcile scans the whole audit log. Try again in ${retryAfterSeconds} s.`,
        { retryAfterSeconds, limit: 'reconcile' },
      );
    }
    w.n += 1;
  };

  const audit = (accountId: string, event: string, data: Record<string, unknown>) =>
    writeAudit(app.db, { event, accountId, data });

  await app.register(
    async (admin) => {
      // Before body validation: non-admins cannot tell these routes from missing ones.
      admin.addHook('onRequest', app.requireAdmin);
      // Only on an admin's answers (ticket 4.11: the 404 for everyone else carries no header the
      // not-found handler's does not).
      admin.addHook('onSend', async (request, reply, payload) => {
        if (request.auth) void reply.header('cache-control', 'no-store');
        return payload;
      });
      // Ticket 4.11: every other path under /api/admin answers like a missing route, after the
      // same onRequest 404 (so a malformed body cannot tell real routes from missing ones).
      admin.all('/*', async (request, reply) => reply.code(404).send(notFoundBody(request)));

      // ---- Invites (D.2's module: hashing, redemption and audit stay there) ----------------
      admin.get(
        '/invites',
        {
          schema: {
            querystring: {
              type: 'object',
              additionalProperties: false,
              properties: {
                cursor: { type: 'string', format: 'uuid' },
                limit: { type: 'integer', minimum: 1, maximum: INVITE_PAGE_MAX },
              },
            },
            response: {
              200: {
                type: 'object',
                required: ['invites', 'nextCursor'],
                properties: {
                  invites: { type: 'array', items: inviteViewSchema },
                  nextCursor: { type: ['string', 'null'] },
                },
              },
            },
          },
        },
        async (request) => {
          const { cursor, limit = INVITE_PAGE_DEFAULT } = request.query as {
            cursor?: string;
            limit?: number;
          };
          const account = request.auth!.account;
          const now = app.authNow();
          let where;
          if (cursor) {
            const [at] = await app.db
              .select({ createdAt: inviteCodes.createdAt })
              .from(inviteCodes)
              .where(eq(inviteCodes.id, cursor));
            if (!at) throw new ApiError(400, 'validation_failed', 'Unknown cursor.');
            where = or(
              lt(inviteCodes.createdAt, at.createdAt),
              and(eq(inviteCodes.createdAt, at.createdAt), lt(inviteCodes.id, cursor)),
            );
          }
          const rows = await app.db
            .select()
            .from(inviteCodes)
            .where(where)
            .orderBy(desc(inviteCodes.createdAt), desc(inviteCodes.id))
            .limit(limit + 1);
          const page = rows.slice(0, limit);
          await audit(account.id, 'admin.view', { section: 'invites' });
          return {
            invites: await inviteViews(app.db, page, now),
            nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
          };
        },
      );

      admin.post(
        '/invites',
        {
          schema: {
            body: {
              type: 'object',
              additionalProperties: false,
              required: ['maxUses', 'expiresInHours'],
              properties: {
                maxUses: { type: 'integer', minimum: 1, maximum: MAX_INVITE_USES },
                /** Null: never expires. */
                expiresInHours: {
                  type: ['integer', 'null'],
                  minimum: 1,
                  maximum: MAX_INVITE_TTL_HOURS,
                },
                note: { type: 'string', maxLength: INVITE_NOTE_MAX },
              },
            },
            response: {
              201: {
                type: 'object',
                required: ['code', 'invite'],
                properties: { code: { type: 'string' }, invite: inviteViewSchema },
              },
            },
          },
        },
        async (request, reply) => {
          const body = request.body as {
            maxUses: number;
            expiresInHours: number | null;
            note?: string;
          };
          const account = request.auth!.account;
          const now = app.authNow();
          const { code, invite } = await createInvite(
            app.db,
            {
              maxUses: body.maxUses,
              expiresAt:
                body.expiresInHours === null
                  ? null
                  : new Date(now.getTime() + body.expiresInHours * 3_600_000),
              note: body.note ?? '',
              createdByAccountId: account.id,
              via: 'admin',
              guard: (tx) => lockAdmin(tx, account.id),
            },
            now,
          );
          void reply.code(201);
          // The only time the code leaves the server: it is stored hashed (and never logged).
          return { code, invite: (await inviteViews(app.db, [invite], now))[0]! };
        },
      );

      admin.post(
        '/invites/:inviteId/revoke',
        {
          schema: {
            params: {
              type: 'object',
              required: ['inviteId'],
              properties: { inviteId: { type: 'string', format: 'uuid' } },
            },
            body: { type: ['object', 'null'], additionalProperties: false, properties: {} },
            response: {
              200: {
                type: 'object',
                required: ['invite', 'changed'],
                properties: { invite: inviteViewSchema, changed: { type: 'boolean' } },
              },
            },
          },
        },
        async (request) => {
          const { inviteId } = request.params as { inviteId: string };
          const account = request.auth!.account;
          const now = app.authNow();
          // By id only: a code never travels in a URL or a body after creation.
          const result = await revokeInvite(app.db, inviteId, now, {
            via: 'admin',
            actorAccountId: account.id,
            guard: (tx) => lockAdmin(tx, account.id),
          });
          if (!result) throw new ApiError(404, 'not_found', 'No such invite.');
          return {
            invite: (await inviteViews(app.db, [result.invite], now))[0]!,
            changed: result.changed,
          };
        },
      );

      // ---- Telemetry: 3.8's report builder, read-only ---------------------------------------
      admin.get(
        '/telemetry',
        {
          schema: {
            querystring: {
              type: 'object',
              additionalProperties: false,
              properties: {
                from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
                to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
                reconcile: { type: 'boolean' },
              },
            },
            response: { 200: telemetrySchema },
          },
        },
        async (request, reply) => {
          const q = request.query as { from?: string; to?: string; reconcile?: boolean };
          const account = request.auth!.account;
          const day = (v: string | undefined, name: string) => {
            try {
              return v ? parseDay(v, name) : null;
            } catch (err) {
              throw new ApiError(400, 'validation_failed', (err as Error).message);
            }
          };
          const from = day(q.from, 'from');
          const to = day(q.to, 'to');
          if (from && to && from > to) {
            throw new ApiError(400, 'validation_failed', '`from` must not be after `to`.');
          }
          if (q.reconcile) checkReconcile(account.id, reply);
          const report = await buildTelemetryReport(
            app.db,
            { from, to },
            { reconcile: q.reconcile === true },
          );
          await audit(
            account.id,
            q.reconcile ? 'admin.telemetry.reconcile' : 'admin.view',
            q.reconcile
              ? { from, to, ok: report.reconcile!.every((c) => c.ok) }
              : { section: 'telemetry', from, to },
          );
          return { report, sections: telemetrySections(report) };
        },
      );

      // ---- Players: read-only lookup -------------------------------------------------------
      // A POST, so what the admin typed never lands in a request log's URL.
      admin.post(
        '/players/search',
        {
          schema: {
            body: {
              type: 'object',
              additionalProperties: false,
              required: ['query'],
              properties: { query: { type: 'string', minLength: 1, maxLength: 64 } },
            },
            response: {
              200: {
                type: 'object',
                required: ['players', 'truncated', 'limit'],
                properties: {
                  players: { type: 'array', items: playerRowSchema },
                  truncated: { type: 'boolean' },
                  limit: { type: 'integer' },
                },
              },
            },
          },
        },
        async (request) => {
          const { query } = request.body as { query: string };
          if (query.trim() === '') {
            throw new ApiError(400, 'validation_failed', 'Type a name or a handle.');
          }
          const result = await searchPlayers(app.db, query);
          await audit(request.auth!.account.id, 'admin.player.search', {
            results: result.players.length,
          });
          return { ...result, limit: PLAYER_SEARCH_LIMIT };
        },
      );

      admin.get(
        '/players/:handle',
        {
          schema: {
            params: {
              type: 'object',
              required: ['handle'],
              properties: { handle: { type: 'string', pattern: HANDLE_RE.source } },
            },
            response: {
              200: {
                type: 'object',
                required: ['player'],
                properties: {
                  player: {
                    type: 'object',
                    properties: {
                      handle: { type: 'string' },
                      displayName: { type: 'string' },
                      role: { type: 'string' },
                      createdAt: { type: 'string' },
                      registration: {
                        type: ['object', 'null'],
                        properties: {
                          at: { type: 'string' },
                          invite: {
                            type: ['object', 'null'],
                            properties: {
                              id: { type: 'string' },
                              note: { type: ['string', 'null'] },
                            },
                          },
                        },
                      },
                      characters: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            name: { type: 'string' },
                            classId: { type: 'string' },
                            level: { type: 'integer' },
                            createdAt: { type: 'string' },
                          },
                        },
                      },
                      sanctions: { type: 'array', items: sanctionRowSchema },
                      reports: { type: 'array', items: reportRowSchema },
                      reportsTruncated: { type: 'boolean' },
                      actionable: { type: 'boolean' },
                    },
                  },
                },
              },
            },
          },
        },
        async (request) => {
          const { handle } = request.params as { handle: string };
          const player = await playerDetail(app.db, handle, app.authNow());
          if (!player) throw new ApiError(404, 'not_found', 'No player with that handle.');
          await audit(request.auth!.account.id, 'admin.player.view', { handle });
          return { player };
        },
      );

      // ---- Server status ---------------------------------------------------------------------
      admin.get(
        '/status',
        {
          schema: {
            response: {
              200: {
                type: 'object',
                properties: {
                  build: {
                    type: 'object',
                    properties: {
                      gitSha: { type: ['string', 'null'] },
                      buildTime: { type: ['string', 'null'] },
                    },
                  },
                  startedAt: { type: 'string' },
                  uptimeSeconds: { type: 'integer' },
                  db: {
                    type: 'object',
                    properties: {
                      status: { type: 'string' },
                      latencyMs: { type: ['number', 'null'] },
                    },
                  },
                  registrationMode: { type: 'string' },
                  counts: {
                    type: ['object', 'null'],
                    properties: {
                      accounts: { type: 'integer' },
                      characters: { type: 'integer' },
                      active24h: { type: 'integer' },
                      active7d: { type: 'integer' },
                    },
                  },
                  migrations: {
                    type: ['object', 'null'],
                    properties: {
                      available: { type: 'integer' },
                      applied: { type: 'integer' },
                      latest: { type: ['string', 'null'] },
                      pending: { type: 'array', items: { type: 'string' } },
                    },
                  },
                  // Ticket 4.6: community project progress (aggregates only).
                  projects: {
                    type: ['array', 'null'],
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        name: { type: 'string' },
                        status: { type: 'string' },
                        stage: { type: 'integer' },
                        stages: { type: 'integer' },
                        completedOn: { type: ['string', 'null'] },
                        contributors: { type: 'integer' },
                        current: {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: {
                              resource: { type: 'string' },
                              delivered: { type: 'integer' },
                              required: { type: 'integer' },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        async (request) => {
          const now = app.authNow();
          const uptimeSeconds = Math.round(process.uptime());
          const db = await databaseStatus(app.db);
          const [counts, migrations, projects] =
            db.status === 'up'
              ? await Promise.all([
                  statusCounts(app.db, now).catch(() => null),
                  migrationStatus(app.db),
                  projectProgressSummary(app.db).catch(() => null),
                ])
              : [null, null, null];
          await audit(request.auth!.account.id, 'admin.view', { section: 'status' }).catch(
            (err: unknown) => request.log.warn({ err }, 'admin audit failed'),
          );
          return {
            build,
            startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
            uptimeSeconds,
            db,
            registrationMode: app.registrationMode,
            counts,
            migrations,
            projects,
          };
        },
      );

      // ---- Seasons (ticket 5.3): view, schedule the next, end early or extend -----------------
      await registerSeasonAdmin(admin, {
        now: options.gameNow ?? (() => app.authNow()),
        audit,
        lockAdmin,
      });

      // ---- Trading settings (ticket T.2): edit; the read is `GET /api/mod/settings/trading` ----
      await registerSettingsAdmin(admin, { now: () => app.authNow(), lockAdmin });

      // ---- Ticket D.4: the admin tools (inspector, items, currencies, heroes, progress, sessions,
      // world, view as player). Roles stay read-only.
      await registerAdminTools(admin, {
        activity: options.activity ?? {
          ...DEFAULT_ACTIVITY_OPTIONS,
          now: options.gameNow ?? (() => app.authNow()),
        },
      });

      // ---- Roles: read-only (granting stays CLI-only) ----------------------------------------
      admin.get(
        '/roles',
        {
          schema: {
            response: {
              200: {
                type: 'object',
                required: ['staff'],
                properties: {
                  staff: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        handle: { type: 'string' },
                        displayName: { type: 'string' },
                        role: { type: 'string' },
                        accountCreatedAt: { type: 'string' },
                        grantedAt: { type: ['string', 'null'] },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        async (request) => {
          const staff = await staffList(app.db);
          await audit(request.auth!.account.id, 'admin.view', { section: 'roles' });
          return { staff };
        },
      );
    },
    { prefix: '/admin' },
  );
}
