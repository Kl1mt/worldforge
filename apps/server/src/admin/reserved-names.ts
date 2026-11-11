import type { FastifyInstance } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import {
  RESERVED_NAME_DEFAULTS,
  nameSkeleton,
  reservedNameMatch,
  validatePlayerText,
} from '@worldforge/game-core';
import { reservedNames, type ReservedName } from '../db/schema.js';
import type { Executor, Transaction } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { ApiError } from '../errors.js';
import { idempotentTransaction } from '../idempotency/index.js';
import { adminAudit, lockAdmin, reasonSchema } from './tools.js';

/**
 * The reserved-names store (ticket 6.9, docs/SOCIAL.md "Look-alike and reserved names"): names the
 * admins add on top of the built-in `RESERVED_NAME_DEFAULTS`, managed from the admin panel's Names
 * tab and `pnpm admin:tools reserved-name` (`deploy/admin.sh reserved-name …`). One entry
 * per look (unique skeleton). Adding a name never touches players who already carry it
 * (grandfathered); only new and changed names are refused. Audited `admin.reserved_name.*`.
 */
export interface ReservedNameView {
  id: string | null;
  name: string;
  /** `staff`, `boss`, `npc` (built in, can't be removed) or `custom` (added by an admin). */
  group: 'staff' | 'boss' | 'npc' | 'custom';
  note: string;
  createdAt: string | null;
}

export async function listReservedNames(db: Executor): Promise<ReservedNameView[]> {
  const rows = await db.select().from(reservedNames).orderBy(asc(reservedNames.name));
  return [
    ...RESERVED_NAME_DEFAULTS.map((d) => ({
      id: null,
      name: d.name,
      group: d.group,
      note: '',
      createdAt: null,
    })),
    ...rows.map(viewOf),
  ];
}

const viewOf = (r: ReservedName): ReservedNameView => ({
  id: r.id,
  name: r.name,
  group: 'custom',
  note: r.note,
  createdAt: r.createdAt.toISOString(),
});

/** Adds a reserved name, or refuses: not a name, already covered (built in or the same look). */
export async function addReservedName(
  tx: Executor,
  input: { name: string; note?: string; by: string | null; now: Date },
): Promise<ReservedName> {
  const checked = validatePlayerText('displayName', input.name);
  // Shape only: a reserved name may itself be a reserved word ("Admin" is built in already).
  if (!checked.ok && checked.problem !== 'reserved' && checked.problem !== 'blocked') {
    throw new ApiError(400, 'validation_failed', checked.message, {
      fields: { name: checked.message },
    });
  }
  const name = checked.value;
  const builtIn = reservedNameMatch(name);
  if (builtIn && nameSkeleton(builtIn) === nameSkeleton(name)) {
    throw new ApiError(409, 'already_reserved', `"${builtIn}" is reserved already (built in).`);
  }
  const skeleton = nameSkeleton(name);
  const [row] = await tx
    .insert(reservedNames)
    .values({
      id: uuidv7(),
      name,
      skeleton,
      note: (input.note ?? '').trim().slice(0, 200),
      createdBy: input.by,
      createdAt: input.now,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    const [same] = await tx
      .select()
      .from(reservedNames)
      .where(eq(reservedNames.skeleton, skeleton));
    throw new ApiError(409, 'already_reserved', `"${same?.name ?? name}" is reserved already.`);
  }
  return row;
}

/** Removes a custom entry by id or by name (any look-alike spelling). Returns it, or null. */
export async function removeReservedName(
  tx: Executor,
  by: { id: string } | { name: string },
): Promise<ReservedName | null> {
  const where =
    'id' in by ? eq(reservedNames.id, by.id) : eq(reservedNames.skeleton, nameSkeleton(by.name));
  const [row] = await tx.delete(reservedNames).where(where).returning();
  return row ?? null;
}

const listSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['names'],
  properties: {
    names: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'group', 'note', 'createdAt'],
        properties: {
          id: { type: ['string', 'null'] },
          name: { type: 'string' },
          group: { type: 'string' },
          note: { type: 'string' },
          createdAt: { type: ['string', 'null'] },
        },
      },
    },
  },
} as const;

/** `GET/POST /api/admin/reserved-names`, `DELETE /api/admin/reserved-names/:id` (admin scope). */
export async function registerReservedNamesAdmin(admin: FastifyInstance): Promise<void> {
  const write = <T>(
    request: Parameters<typeof idempotentTransaction>[1],
    reply: Parameters<typeof idempotentTransaction>[2],
    fn: (tx: Transaction, adminId: string) => Promise<T>,
    status = 200,
  ) =>
    idempotentTransaction(
      admin,
      request,
      reply,
      { now: () => admin.authNow(), status },
      async (tx) => {
        const adminId = request.auth!.account.id;
        await lockAdmin(tx, adminId);
        return fn(tx, adminId);
      },
    );

  admin.get('/reserved-names', { schema: { response: { 200: listSchema } } }, async () => ({
    names: await listReservedNames(admin.db),
  }));

  admin.post(
    '/reserved-names',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'reason'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 64 },
            note: { type: 'string', maxLength: 200 },
            reason: reasonSchema,
          },
        },
        response: { 201: listSchema },
      },
    },
    async (request, reply) => {
      const b = request.body as { name: string; note?: string; reason: string };
      return write(
        request,
        reply,
        async (tx, adminId) => {
          const row = await addReservedName(tx, {
            name: b.name,
            ...(b.note !== undefined ? { note: b.note } : {}),
            by: adminId,
            now: admin.authNow(),
          });
          await adminAudit(tx, {
            event: 'admin.reserved_name.add',
            adminId,
            target: { id: adminId },
            reason: b.reason,
            after: { name: row.name },
          });
          return { names: await listReservedNames(tx) };
        },
        201,
      );
    },
  );

  admin.delete(
    '/reserved-names/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['reason'],
          properties: { reason: reasonSchema },
        },
        response: { 200: listSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const b = request.body as { reason: string };
      return write(request, reply, async (tx, adminId) => {
        const row = await removeReservedName(tx, { id });
        if (!row)
          throw new ApiError(404, 'not_found', 'No such reserved name (built-in names stay).');
        await adminAudit(tx, {
          event: 'admin.reserved_name.remove',
          adminId,
          target: { id: adminId },
          reason: b.reason,
          before: { name: row.name },
        });
        return { names: await listReservedNames(tx) };
      });
    },
  );
}
