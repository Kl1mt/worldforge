import type { FastifyInstance } from 'fastify';
import {
  SHRINE_BANK_LIMIT,
  SHRINE_DUPLICATE_MARKS,
  SHRINE_MARK_PRICES,
  SHRINE_POOL,
  SHRINE_RARITIES,
  findCosmetic,
  shrineOdds,
  shrineRarityChance,
} from '@worldforge/game-core';
import { eq } from 'drizzle-orm';
import { cosmeticUnlocks } from '../db/schema.js';
import { withTransaction } from '../db/transaction.js';
import type { Executor } from '../db/types.js';
import { idempotentTransaction } from '../idempotency/index.js';
import { buyWithMarksTx, drawTx, openShrineTx, recentDraws, type ShrineState } from './model.js';

/**
 * Ticket 9.5 routes (docs/SHRINE.md "API"):
 * - `GET /api/account/shrine`: draws held by source, the bank, marks, the published odds, the
 *   pool with what the account owns, the marks shop and the latest draws. Accrues the free bank.
 * - `POST /api/account/shrine/draw` (Idempotency-Key): one draw. `409 no_draws`.
 * - `POST /api/account/shrine/buy` `{ cosmeticId }` (Idempotency-Key): a chosen cosmetic for marks.
 *   `409 already_owned`, `422 unknown_offer | insufficient_marks`.
 * No route sells a draw: `paidDraws` is false until ROADMAP 8.8's legal review says otherwise.
 */

export interface ShrineView {
  unspent: { daily: number; play: number; shop: number };
  draws: number;
  bankLimit: number;
  /** When the next free draw is added (the next UTC midnight), or null while the bank is full. */
  nextFreeAt: string | null;
  marks: number;
  paidDraws: false;
  rarities: { rarity: string; chance: number; duplicateMarks: number; price: number }[];
  pool: {
    cosmeticId: string;
    kind: string;
    name: string;
    description: string;
    rarity: string;
    chance: number;
    price: number;
    owned: boolean;
  }[];
  recent: {
    id: string;
    cosmeticId: string;
    rarity: string;
    outcome: string;
    marks: number;
    spentSource: string;
    seed: string;
    drawnAt: string;
  }[];
}

async function shrineView(
  executor: Executor,
  accountId: string,
  state: ShrineState,
): Promise<ShrineView> {
  const owned = new Set(
    (
      await executor
        .select({ id: cosmeticUnlocks.cosmeticId })
        .from(cosmeticUnlocks)
        .where(eq(cosmeticUnlocks.accountId, accountId))
    ).map((r) => r.id),
  );
  const odds = new Map(shrineOdds().map((o) => [o.cosmeticId, o.chance]));
  const recent = await recentDraws(executor, accountId);
  const draws = state.unspent.daily + state.unspent.play + state.unspent.shop;
  return {
    unspent: state.unspent,
    draws,
    bankLimit: SHRINE_BANK_LIMIT,
    nextFreeAt:
      state.unspent.daily >= SHRINE_BANK_LIMIT
        ? null
        : new Date((state.dailyThrough + 1) * 86_400_000).toISOString(),
    marks: state.marks,
    paidDraws: false,
    rarities: SHRINE_RARITIES.map((r) => ({
      rarity: r,
      chance: shrineRarityChance(r),
      duplicateMarks: SHRINE_DUPLICATE_MARKS[r],
      price: SHRINE_MARK_PRICES[r],
    })),
    pool: SHRINE_POOL.map((e) => {
      const c = findCosmetic(e.cosmeticId)!;
      return {
        cosmeticId: e.cosmeticId,
        kind: e.kind,
        name: c.name,
        description: c.description,
        rarity: e.rarity,
        chance: odds.get(e.cosmeticId)!,
        price: SHRINE_MARK_PRICES[e.rarity],
        owned: owned.has(e.cosmeticId),
      };
    }),
    recent: recent.map((d) => ({ ...d, drawnAt: d.drawnAt.toISOString() })),
  };
}

const countsSchema = {
  type: 'object',
  required: ['daily', 'play', 'shop'],
  properties: { daily: { type: 'integer' }, play: { type: 'integer' }, shop: { type: 'integer' } },
} as const;

const viewSchema = {
  type: 'object',
  required: [
    'unspent',
    'draws',
    'bankLimit',
    'nextFreeAt',
    'marks',
    'paidDraws',
    'rarities',
    'pool',
    'recent',
  ],
  properties: {
    unspent: countsSchema,
    draws: { type: 'integer' },
    bankLimit: { type: 'integer' },
    nextFreeAt: { type: ['string', 'null'] },
    marks: { type: 'integer' },
    paidDraws: { type: 'boolean' },
    rarities: {
      type: 'array',
      items: {
        type: 'object',
        required: ['rarity', 'chance', 'duplicateMarks', 'price'],
        properties: {
          rarity: { type: 'string' },
          chance: { type: 'number' },
          duplicateMarks: { type: 'integer' },
          price: { type: 'integer' },
        },
      },
    },
    pool: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'cosmeticId',
          'kind',
          'name',
          'description',
          'rarity',
          'chance',
          'price',
          'owned',
        ],
        properties: {
          cosmeticId: { type: 'string' },
          kind: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          rarity: { type: 'string' },
          chance: { type: 'number' },
          price: { type: 'integer' },
          owned: { type: 'boolean' },
        },
      },
    },
    recent: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'id',
          'cosmeticId',
          'rarity',
          'outcome',
          'marks',
          'spentSource',
          'seed',
          'drawnAt',
        ],
        properties: {
          id: { type: 'string' },
          cosmeticId: { type: 'string' },
          rarity: { type: 'string' },
          outcome: { type: 'string' },
          marks: { type: 'integer' },
          spentSource: { type: 'string' },
          seed: { type: 'string' },
          drawnAt: { type: 'string' },
        },
      },
    },
  },
} as const;

const drawResultSchema = {
  type: 'object',
  required: ['drawId', 'seed', 'spentSource', 'cosmeticId', 'rarity', 'outcome', 'marks'],
  properties: {
    drawId: { type: 'string' },
    seed: { type: 'string' },
    spentSource: { type: 'string' },
    cosmeticId: { type: 'string' },
    rarity: { type: 'string' },
    outcome: { type: 'string' },
    marks: { type: 'integer' },
  },
} as const;

export async function registerShrine(
  app: FastifyInstance,
  options: { now: () => Date; drawSeed?: () => string },
): Promise<void> {
  app.get(
    '/account/shrine',
    { preHandler: app.requireAccount, schema: { response: { 200: viewSchema } } },
    async (request) => {
      const accountId = request.auth!.account.id;
      return withTransaction(app.db, async (tx) => {
        const state = await openShrineTx(tx, accountId, options.now());
        return shrineView(tx, accountId, state);
      });
    },
  );

  app.post(
    '/account/shrine/draw',
    {
      preHandler: app.requireAccount,
      schema: {
        response: {
          200: {
            type: 'object',
            required: ['draw', 'shrine'],
            properties: { draw: drawResultSchema, shrine: viewSchema },
          },
        },
      },
    },
    async (request, reply) => {
      const accountId = request.auth!.account.id;
      return idempotentTransaction(app, request, reply, { now: options.now }, async (tx) => {
        const now = options.now();
        const draw = await drawTx(tx, accountId, now, options.drawSeed?.());
        const state = await openShrineTx(tx, accountId, now);
        return { draw, shrine: await shrineView(tx, accountId, state) };
      });
    },
  );

  app.post<{ Body: { cosmeticId: string } }>(
    '/account/shrine/buy',
    {
      preHandler: app.requireAccount,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['cosmeticId'],
          properties: { cosmeticId: { type: 'string', minLength: 1, maxLength: 64 } },
        },
        response: {
          200: {
            type: 'object',
            required: ['bought', 'shrine'],
            properties: {
              bought: {
                type: 'object',
                required: ['cosmeticId', 'price'],
                properties: { cosmeticId: { type: 'string' }, price: { type: 'integer' } },
              },
              shrine: viewSchema,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const accountId = request.auth!.account.id;
      return idempotentTransaction(app, request, reply, { now: options.now }, async (tx) => {
        const now = options.now();
        const bought = await buyWithMarksTx(tx, accountId, request.body.cosmeticId, now);
        const state = await openShrineTx(tx, accountId, now);
        return { bought, shrine: await shrineView(tx, accountId, state) };
      });
    },
  );
}
