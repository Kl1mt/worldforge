import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { DEFAULT_TRADING_SETTINGS, validateTradingSettings } from '@worldforge/game-core';
import { accounts } from '../db/schema.js';
import { writeAudit } from '../db/audit.js';
import type { Transaction } from '../db/types.js';
import { ApiError } from '../errors.js';
import { idempotentTransaction } from '../idempotency/index.js';
import {
  loadGameSettings,
  tradingSettingsHistory,
  updateTradingSettings,
  type StoredTradingSettings,
} from './store.js';

/**
 * The trading settings API (ticket T.2, docs/API_CONVENTIONS.md "Admin"):
 * - `GET /api/mod/settings/trading`: staff only (moderators and admins; everyone else gets the
 *   not-found handler's exact `404`, like every `/api/mod` route). Moderators see the settings
 *   read-only (`canEdit: false`).
 * - `PUT /api/admin/settings/trading`: admins only (inside D.3's admin scope), `Idempotency-Key`,
 *   `expectedVersion` for optimistic concurrency. Validated by game-core (hard maxima refused).
 *
 * Reads come from the table, not the cache, so the panel always shows what is stored.
 */

const switchGroup = (keys: readonly string[]) =>
  ({
    type: 'object',
    required: keys,
    properties: Object.fromEntries(keys.map((k) => [k, { type: 'boolean' }])),
  }) as const;

const settingsSchema = {
  type: 'object',
  required: ['trading', 'trade', 'tradeable', 'shelf', 'limits'],
  properties: {
    trading: { type: 'boolean' },
    trade: switchGroup(['items', 'materials', 'gold']),
    tradeable: switchGroup(['epic', 'legendary', 'set', 'mythic', 'void']),
    shelf: switchGroup(['items', 'materials', 'gold']),
    limits: { type: 'object', additionalProperties: { type: 'integer' } },
  },
} as const;

const refSchema = {
  type: ['object', 'null'],
  required: ['handle', 'displayName'],
  properties: { handle: { type: 'string' }, displayName: { type: 'string' } },
} as const;

const changeSchema = {
  type: 'object',
  required: ['path', 'old', 'new'],
  properties: {
    path: { type: 'string' },
    old: { type: ['boolean', 'number'] },
    new: { type: ['boolean', 'number'] },
  },
} as const;

const viewSchema = {
  type: 'object',
  required: [
    'settings',
    'defaults',
    'version',
    'updatedAt',
    'updatedBy',
    'canEdit',
    'history',
    'nextCursor',
  ],
  properties: {
    settings: settingsSchema,
    defaults: settingsSchema,
    version: { type: 'integer' },
    updatedAt: { type: ['string', 'null'] },
    updatedBy: refSchema,
    canEdit: { type: 'boolean' },
    history: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'at', 'by', 'version', 'changes'],
        properties: {
          id: { type: 'string' },
          at: { type: 'string' },
          by: refSchema,
          version: { type: 'integer' },
          changes: { type: 'array', items: changeSchema },
        },
      },
    },
    nextCursor: { type: ['string', 'null'] },
    changed: { type: 'boolean' },
  },
} as const;

async function settingsView(
  app: FastifyInstance,
  stored: StoredTradingSettings,
  canEdit: boolean,
  before?: string,
) {
  const [history, by] = await Promise.all([
    tradingSettingsHistory(app.db, { before }),
    stored.updatedBy
      ? app.db
          .select({ handle: accounts.handle, displayName: accounts.displayName })
          .from(accounts)
          .where(eq(accounts.id, stored.updatedBy))
      : Promise.resolve([]),
  ]);
  return {
    settings: stored.settings,
    defaults: DEFAULT_TRADING_SETTINGS,
    version: stored.version,
    updatedAt: stored.updatedAt?.toISOString() ?? null,
    updatedBy: by[0] ?? null,
    canEdit,
    history: history.entries,
    nextCursor: history.nextCursor,
  };
}

/** `GET /api/mod/settings/trading` (staff, read-only for moderators). */
export async function registerSettingsRead(app: FastifyInstance): Promise<void> {
  app.get(
    '/mod/settings/trading',
    {
      onRequest: app.requireStaff,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            /** History page: entries older than this audit row id. */
            cursor: { type: 'string', pattern: '^[0-9a-f-]{36}$' },
          },
        },
        response: { 200: viewSchema },
      },
    },
    async (request) => {
      const { cursor } = request.query as { cursor?: string };
      const account = request.auth!.account;
      const stored = (await loadGameSettings(app.db)).trading;
      const out = await settingsView(app, stored, account.role === 'admin', cursor);
      await writeAudit(app.db, {
        event: 'admin.view',
        accountId: account.id,
        data: { section: 'trading-settings' },
      });
      return out;
    },
  );
}

/** `PUT /api/admin/settings/trading`, registered inside D.3's admin scope (admins only). */
export async function registerSettingsAdmin(
  admin: FastifyInstance,
  options: {
    now: () => Date;
    lockAdmin: (tx: Transaction, accountId: string) => Promise<void>;
  },
): Promise<void> {
  admin.put(
    '/settings/trading',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['expectedVersion', 'settings'],
          properties: {
            expectedVersion: { type: 'integer', minimum: 0, maximum: 2_147_483_647 },
            // Shape and bounds are game-core's (`validateTradingSettings`), so the panel gets
            // one plain message per field.
            settings: { type: 'object' },
          },
        },
        response: { 200: viewSchema },
      },
    },
    async (request, reply) => {
      const body = request.body as { expectedVersion: number; settings: unknown };
      const checked = validateTradingSettings(body.settings);
      if (!checked.ok) {
        throw new ApiError(400, 'validation_failed', 'Some settings are out of bounds.', {
          fields: Object.fromEntries(
            Object.entries(checked.fields).map(([k, v]) => [`settings.${k}`, v]),
          ),
        });
      }
      const actor = request.auth!.account.id;
      const result = await idempotentTransaction(
        admin,
        request,
        reply,
        { now: options.now },
        async (tx) => {
          await options.lockAdmin(tx, actor);
          const r = await updateTradingSettings(tx, {
            settings: checked.value,
            expectedVersion: body.expectedVersion,
            actorAccountId: actor,
            now: options.now(),
            events: admin.settingsEvents,
          });
          return { changed: r.changed, version: r.version };
        },
      );
      // This instance sees the change at once; others within the cache's TTL.
      admin.gameSettings.invalidate();
      const stored = (await loadGameSettings(admin.db)).trading;
      return { ...(await settingsView(admin, stored, true)), changed: result.changed };
    },
  );
}
