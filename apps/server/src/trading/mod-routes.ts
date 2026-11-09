import type { FastifyInstance } from 'fastify';
import { TRADE_PATTERN_RULES } from '@worldforge/game-core';
import { writeAudit } from '../db/audit.js';
import { withTransaction } from '../db/transaction.js';
import type { ActivityOptions } from '../activity/settle.js';
import { idempotentTransaction } from '../idempotency/index.js';
import { itemSchema } from '../inventory/routes.js';
import { materialListSchema } from '../economy/shared.js';
import { sanctionViewSchema } from '../social/sanctions.js';
import {
  listTrades,
  reverseTrade,
  tradeCase,
  type ReversalSanctionAction,
  type TradeListStatus,
} from './reversal.js';
import { tradePatterns } from './patterns.js';

/**
 * Trade moderation routes (ticket T.6, docs/API_CONVENTIONS.md, docs/TRADING.md "T.6 as built"),
 * all under `/api/mod`, all behind `app.requireStaff` as the `onRequest` hook (players and anonymous
 * visitors get the not-found handler's exact `404` before any validation). Players see only their
 * own history (T.5's `GET /api/trading/offers/history`).
 */

const uuid = {
  type: 'string',
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
} as const;

const whoSchema = {
  type: 'object',
  required: ['handle', 'displayName', 'role'],
  properties: {
    handle: { type: 'string' },
    displayName: { type: 'string' },
    role: { type: 'string' },
  },
} as const;

const personSchema = {
  anyOf: [
    {
      type: 'object',
      required: ['handle', 'displayName'],
      properties: { handle: { type: 'string' }, displayName: { type: 'string' } },
    },
    { type: 'null' },
  ],
} as const;

const heroSchema = {
  anyOf: [
    {
      type: 'object',
      required: ['name', 'classId', 'level'],
      properties: {
        name: { type: 'string' },
        classId: { type: 'string' },
        level: { type: 'integer' },
      },
    },
    { type: 'null' },
  ],
} as const;

const countSideSchema = {
  type: 'object',
  required: ['items', 'gold', 'materialUnits', 'rarities'],
  properties: {
    items: { type: 'integer' },
    gold: { type: 'integer' },
    materialUnits: { type: 'integer' },
    rarities: { type: 'array', items: { type: 'string' } },
  },
} as const;

const summaryProps = {
  id: { type: 'string' },
  status: { type: 'string' },
  kind: { type: 'string' },
  sender: whoSchema,
  receiver: whoSchema,
  createdAt: { type: 'string' },
  closedAt: { type: ['string', 'null'] },
  reversedAt: { type: ['string', 'null'] },
} as const;

const summarySchema = {
  type: 'object',
  required: Object.keys(summaryProps),
  properties: { ...summaryProps, give: countSideSchema, ask: countSideSchema },
} as const;

const sideSchema = {
  type: 'object',
  required: ['items', 'gold', 'materials'],
  properties: {
    items: { type: 'array', items: itemSchema },
    gold: { type: 'integer' },
    materials: materialListSchema,
  },
} as const;

const moveSchema = {
  type: 'object',
  required: ['items', 'gold', 'materials'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'worn', 'locked'],
        properties: {
          id: { type: 'string' },
          worn: { type: 'boolean' },
          locked: { type: 'boolean' },
        },
      },
    },
    gold: { type: 'integer' },
    materials: materialListSchema,
  },
} as const;

const refusalSchema = {
  type: 'object',
  required: ['check', 'text'],
  properties: {
    check: { type: 'string' },
    text: { type: 'string' },
    party: { type: 'string' },
    itemId: { type: 'string' },
    materialId: { type: 'string' },
    received: { type: 'integer' },
    available: { type: 'integer' },
    deadline: { type: 'string' },
  },
} as const;

export const tradeCaseSchema = {
  type: 'object',
  required: [
    ...Object.keys(summaryProps),
    'relation',
    'expiresAt',
    'senderHero',
    'receiverHero',
    'give',
    'ask',
    'voidReason',
    'heldUntil',
    'reversal',
    'reversible',
    'moves',
    'holds',
    'trail',
    'reports',
  ],
  properties: {
    ...summaryProps,
    relation: { type: 'string' },
    expiresAt: { type: 'string' },
    senderHero: heroSchema,
    receiverHero: heroSchema,
    give: sideSchema,
    ask: sideSchema,
    voidReason: { type: ['string', 'null'] },
    heldUntil: { type: ['string', 'null'] },
    reversal: {
      anyOf: [
        {
          type: 'object',
          required: ['at', 'reason', 'by'],
          properties: { at: { type: 'string' }, reason: { type: 'string' }, by: personSchema },
        },
        { type: 'null' },
      ],
    },
    reversible: {
      type: 'object',
      required: ['possible', 'deadline', 'refusals', 'canAct', 'cannotAct'],
      properties: {
        possible: { type: 'boolean' },
        deadline: { type: ['string', 'null'] },
        refusals: { type: 'array', items: refusalSchema },
        canAct: { type: 'boolean' },
        cannotAct: { type: ['string', 'null'] },
      },
    },
    moves: {
      type: 'object',
      required: ['toSender', 'toReceiver'],
      properties: { toSender: moveSchema, toReceiver: moveSchema },
    },
    holds: {
      type: 'array',
      items: {
        type: 'object',
        required: ['party', 'heldUntil', 'releasedAt', 'gold', 'materials', 'items'],
        properties: {
          party: { type: 'string' },
          heldUntil: { type: 'string' },
          releasedAt: { type: ['string', 'null'] },
          gold: { type: 'integer' },
          materials: materialListSchema,
          items: { type: 'integer' },
        },
      },
    },
    trail: {
      type: 'array',
      items: {
        type: 'object',
        required: ['event', 'at', 'by', 'text'],
        properties: {
          event: { type: 'string' },
          at: { type: 'string' },
          by: personSchema,
          text: { type: 'string' },
        },
      },
    },
    reports: {
      type: 'object',
      required: ['open', 'reportId'],
      properties: { open: { type: 'integer' }, reportId: { type: ['string', 'null'] } },
    },
  },
} as const;

const flowSchema = {
  type: 'object',
  required: ['items', 'gold', 'materialUnits'],
  properties: {
    items: { type: 'integer' },
    gold: { type: 'integer' },
    materialUnits: { type: 'integer' },
  },
} as const;

const patternsSchema = {
  type: 'object',
  required: ['windowDays', 'rules', 'totals', 'pairs', 'accounts', 'inviteClusters'],
  properties: {
    windowDays: { type: 'integer' },
    rules: { type: 'object', additionalProperties: true },
    totals: {
      type: 'object',
      required: ['trades', 'reversed', 'flaggedItems'],
      properties: {
        trades: { type: 'integer' },
        reversed: { type: 'integer' },
        flaggedItems: { type: 'integer' },
      },
    },
    pairs: {
      type: 'array',
      items: {
        type: 'object',
        required: ['a', 'b', 'trades', 'aToB', 'bToA', 'reversed', 'firstOn', 'lastOn', 'flags'],
        properties: {
          a: whoSchema,
          b: whoSchema,
          trades: { type: 'integer' },
          aToB: flowSchema,
          bToA: flowSchema,
          reversed: { type: 'integer' },
          firstOn: { type: 'string' },
          lastOn: { type: 'string' },
          flags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    accounts: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'who',
          'trades',
          'partners',
          'given',
          'received',
          'receivedWhileNew',
          'accountAgeDays',
          'weeksAtCap',
          'capsReached',
          'flaggedItems',
          'reversals',
          'flags',
        ],
        properties: {
          who: whoSchema,
          trades: { type: 'integer' },
          partners: { type: 'integer' },
          given: flowSchema,
          received: flowSchema,
          receivedWhileNew: flowSchema,
          accountAgeDays: { type: 'integer' },
          weeksAtCap: { type: 'integer' },
          capsReached: { type: 'array', items: { type: 'string' } },
          flaggedItems: { type: 'integer' },
          reversals: { type: 'integer' },
          flags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    inviteClusters: {
      type: 'array',
      items: {
        type: 'object',
        required: ['members', 'trades'],
        properties: {
          members: { type: 'array', items: whoSchema },
          trades: { type: 'integer' },
        },
      },
    },
  },
} as const;

const handleSchema = { type: 'string', pattern: '^[0-9a-zA-Z]{1,64}$' } as const;

export async function registerTradeModeration(
  app: FastifyInstance,
  activity: ActivityOptions,
): Promise<void> {
  // The history: every offer the viewer may see, newest first; one account's (`handle`), or one
  // pair's (`handle` and `with`).
  app.get(
    '/mod/trades',
    {
      onRequest: app.requireStaff,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            handle: handleSchema,
            with: handleSchema,
            status: { type: 'string', enum: ['all', 'open', 'accepted', 'reversed', 'ended'] },
            before: uuid,
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['trades', 'nextCursor'],
            properties: {
              trades: { type: 'array', items: summarySchema },
              nextCursor: { type: ['string', 'null'] },
            },
          },
        },
      },
    },
    async (request) => {
      const q = request.query as {
        handle?: string;
        with?: string;
        status?: TradeListStatus;
        before?: string;
        limit?: number;
      };
      const actor = request.auth!.account;
      const out = await listTrades(app.db, actor, { ...q, limit: q.limit ?? 30 });
      await writeAudit(app.db, {
        event: 'mod.trade.list',
        accountId: actor.id,
        data: { byAccount: !!q.handle, byPair: !!q.with, results: out.trades.length },
      });
      return out;
    },
  );

  app.get(
    '/mod/trades/:offerId',
    {
      onRequest: app.requireStaff,
      schema: {
        params: { type: 'object', required: ['offerId'], properties: { offerId: uuid } },
        response: { 200: tradeCaseSchema },
      },
    },
    async (request) => {
      const { offerId } = request.params as { offerId: string };
      const actor = request.auth!.account;
      const out = await tradeCase(app.db, actor, offerId, app.authNow());
      await writeAudit(app.db, {
        event: 'mod.trade.view',
        accountId: actor.id,
        data: { offerId },
      });
      return out;
    },
  );

  app.post(
    '/mod/trades/:offerId/reverse',
    {
      onRequest: app.requireStaff,
      schema: {
        params: { type: 'object', required: ['offerId'], properties: { offerId: uuid } },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['reason'],
          properties: {
            reason: { type: 'string', maxLength: 2000 },
            sanction: {
              type: 'object',
              additionalProperties: false,
              required: ['handle', 'action', 'durationHours'],
              properties: {
                handle: handleSchema,
                action: { type: 'string', enum: ['mute', 'suspend', 'restrictTrade'] },
                durationHours: { type: 'integer', minimum: 1, maximum: 24 * 366 },
              },
            },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['offerId', 'reversedAt', 'sanction', 'case'],
            properties: {
              offerId: { type: 'string' },
              reversedAt: { type: 'string' },
              sanction: { anyOf: [sanctionViewSchema, { type: 'null' }] },
              case: tradeCaseSchema,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { offerId } = request.params as { offerId: string };
      const body = request.body as {
        reason: string;
        sanction?: { handle: string; action: ReversalSanctionAction; durationHours: number };
      };
      const actor = request.auth!.account;
      const now = app.authNow();
      return idempotentTransaction(app, request, reply, { now: () => now }, async (tx) => {
        const result = await reverseTrade(
          tx,
          { actorId: actor.id, offerId, reason: body.reason, sanction: body.sanction, now },
          activity,
          app.sanctionEvents,
        );
        return { ...result, case: await tradeCase(tx, actor, offerId, now) };
      });
    },
  );

  app.get(
    '/mod/trading/patterns',
    {
      onRequest: app.requireStaff,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            days: { type: 'integer', minimum: 1, maximum: TRADE_PATTERN_RULES.maxWindowDays },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
          },
        },
        response: { 200: patternsSchema },
      },
    },
    async (request) => {
      const { days = TRADE_PATTERN_RULES.windowDays, limit = 50 } = request.query as {
        days?: number;
        limit?: number;
      };
      const actor = request.auth!.account;
      const out = await withTransaction(app.db, (tx) =>
        tradePatterns(tx, actor, app.authNow(), days, limit),
      );
      await writeAudit(app.db, {
        event: 'mod.trade.patterns',
        accountId: actor.id,
        data: { days, pairs: out.pairs.length, accounts: out.accounts.length },
      });
      return out;
    },
  );
}
