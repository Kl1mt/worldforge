import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { GAME_VERSION } from '@worldforge/game-core';
import { accountNotifications } from '../db/schema.js';
import { withTransaction } from '../db/transaction.js';
import { INBOX_KEEP, INBOX_KINDS, markReadTx, notifyTx } from './notify.js';

/**
 * The notification inbox (ticket 8.5, docs/NOTIFICATIONS.md): the account's own entries only.
 * - `GET /api/inbox/summary` → `{ unread, newest }`, with an `ETag` (`304` when unchanged): the
 *   shell's badge polls it every 60 s while the tab is visible.
 * - `GET /api/inbox?limit=` → `{ entries, unread }` (newest first, at most `INBOX_KEEP`).
 * - `POST /api/inbox/read { ids }` or `{ all: true }` → `{ marked, unread }`. Repeat-safe by state
 *   (a read entry stays read), so no `Idempotency-Key`.
 */

export interface InboxEntryView {
  id: string;
  kind: (typeof INBOX_KINDS)[number];
  data: Record<string, unknown>;
  createdAt: string;
  read: boolean;
}

const entrySchema = {
  type: 'object',
  required: ['id', 'kind', 'data', 'createdAt', 'read'],
  properties: {
    id: { type: 'string' },
    kind: { type: 'string', enum: [...INBOX_KINDS] },
    data: { type: 'object', additionalProperties: true },
    createdAt: { type: 'string' },
    read: { type: 'boolean' },
  },
} as const;

const summarySchema = {
  type: 'object',
  required: ['unread', 'newest'],
  properties: { unread: { type: 'integer' }, newest: { type: ['string', 'null'] } },
} as const;

const listQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { limit: { type: 'integer', minimum: 1, maximum: INBOX_KEEP, default: 50 } },
} as const;

const readBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ids: {
      type: 'array',
      maxItems: INBOX_KEEP,
      uniqueItems: true,
      items: { type: 'string', format: 'uuid' },
    },
    all: { type: 'boolean', const: true },
  },
  oneOf: [{ required: ['ids'] }, { required: ['all'] }],
} as const;

/** Accounts that already have this version's release entry (per process; a cheap guard). */
const releaseNoted = new Set<string>();

/**
 * The current version's patch-note entry (F.3): written the first time the account reads its
 * inbox on this version (a deploy has no transaction to write it in), once by its dedupe key.
 */
async function ensureReleaseEntry(app: FastifyInstance, accountId: string, now: Date) {
  const key = `${accountId}:${GAME_VERSION}`;
  if (releaseNoted.has(key)) return;
  await withTransaction(app.db, (tx) =>
    notifyTx(tx, {
      accountId,
      kind: 'release',
      data: { version: GAME_VERSION },
      now,
      dedupeKey: `release:${GAME_VERSION}`,
    }),
  );
  if (releaseNoted.size > 50_000) releaseNoted.clear();
  releaseNoted.add(key);
}

async function unreadCount(app: FastifyInstance, accountId: string): Promise<number> {
  const [row] = await app.db
    .select({ n: sql<number>`count(*)::int` })
    .from(accountNotifications)
    .where(and(eq(accountNotifications.accountId, accountId), isNull(accountNotifications.readAt)));
  return row?.n ?? 0;
}

/** Sets the body's `ETag`; true when the client already holds it (answer `304`). */
function notModified(request: FastifyRequest, reply: FastifyReply, body: unknown): boolean {
  const etag = `"${createHash('sha256').update(JSON.stringify(body)).digest('base64url').slice(0, 22)}"`;
  void reply.header('etag', etag).header('cache-control', 'private, no-cache');
  return request.headers['if-none-match'] === etag;
}

export async function registerInbox(app: FastifyInstance, now: () => Date): Promise<void> {
  app.get(
    '/inbox/summary',
    {
      preHandler: app.requireAccount,
      schema: { response: { 200: summarySchema, 304: { type: 'null' } } },
    },
    async (request, reply) => {
      const accountId = request.auth!.account.id;
      await ensureReleaseEntry(app, accountId, now());
      const [newest] = await app.db
        .select({ id: accountNotifications.id })
        .from(accountNotifications)
        .where(eq(accountNotifications.accountId, accountId))
        .orderBy(desc(accountNotifications.createdAt), desc(accountNotifications.id))
        .limit(1);
      const body = { unread: await unreadCount(app, accountId), newest: newest?.id ?? null };
      if (notModified(request, reply, body)) return reply.code(304).send();
      return body;
    },
  );

  app.get<{ Querystring: { limit: number } }>(
    '/inbox',
    {
      preHandler: app.requireAccount,
      schema: {
        querystring: listQuerySchema,
        response: {
          200: {
            type: 'object',
            required: ['entries', 'unread'],
            properties: {
              entries: { type: 'array', items: entrySchema },
              unread: { type: 'integer' },
            },
          },
          304: { type: 'null' },
        },
      },
    },
    async (request, reply) => {
      const accountId = request.auth!.account.id;
      await ensureReleaseEntry(app, accountId, now());
      const rows = await app.db
        .select()
        .from(accountNotifications)
        .where(eq(accountNotifications.accountId, accountId))
        .orderBy(desc(accountNotifications.createdAt), desc(accountNotifications.id))
        .limit(request.query.limit);
      const entries: InboxEntryView[] = rows.map((r) => ({
        id: r.id,
        kind: r.kind as InboxEntryView['kind'],
        data: r.data,
        createdAt: r.createdAt.toISOString(),
        read: r.readAt !== null,
      }));
      const body = { entries, unread: await unreadCount(app, accountId) };
      if (notModified(request, reply, body)) return reply.code(304).send();
      return body;
    },
  );

  app.post<{ Body: { ids?: string[]; all?: true } }>(
    '/inbox/read',
    { preHandler: app.requireAccount, schema: { body: readBodySchema } },
    async (request) => {
      const accountId = request.auth!.account.id;
      const marked = await withTransaction(app.db, (tx) =>
        markReadTx(tx, accountId, request.body.all ? 'all' : (request.body.ids ?? []), now()),
      );
      return { marked, unread: await unreadCount(app, accountId) };
    },
  );
}
