import type { FastifyInstance } from 'fastify';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { characters, idempotencyKeys, type Character } from '../db/schema.js';
import type { Transaction } from '../db/types.js';
import { withTransaction } from '../db/transaction.js';
import { ApiError } from '../errors.js';
import { settleActivityTx, type ActivityOptions } from '../activity/settle.js';
import { characterView } from '../characters/routes.js';
import {
  IDEMPOTENCY_REPLAYED_HEADER,
  batchItemKey,
  idempotentTransaction,
  readIdempotencyKey,
  requestHash,
  runIdempotent,
} from '../idempotency/index.js';
import { acceptQuestTx, questBoard, turnInQuestTx, type AcceptRequest } from './store.js';

const characterParamsSchema = {
  type: 'object',
  required: ['characterId'],
  properties: { characterId: { type: 'string', format: 'uuid' } },
} as const;

const questParamsSchema = {
  type: 'object',
  required: ['characterId', 'questId'],
  properties: {
    characterId: { type: 'string', format: 'uuid' },
    questId: { type: 'string', format: 'uuid' },
  },
} as const;

const acceptBodySchema = {
  type: 'object',
  required: ['kind'],
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['story', 'contract'] },
    questId: { type: 'string', minLength: 1, maxLength: 64 },
    slot: { type: 'integer', minimum: 0, maximum: 15 },
    /** Ticket 3.6: the reward item's slot, for contracts that offer a choice. */
    rewardSlot: { type: 'string', minLength: 1, maxLength: 16 },
  },
} as const;

/** Ticket 8.5: at most this many quests in one batch turn-in (a hero holds far fewer). */
export const TURN_IN_BATCH_MAX = 8;

const batchBodySchema = {
  type: 'object',
  required: ['questIds'],
  additionalProperties: false,
  properties: {
    questIds: {
      type: 'array',
      minItems: 1,
      maxItems: TURN_IN_BATCH_MAX,
      uniqueItems: true,
      items: { type: 'string', format: 'uuid' },
    },
  },
} as const;

/** One quest's outcome in a batch turn-in: its reward, or why it was not turned in. */
export type BatchTurnInResult =
  | { questId: string; ok: true; reward: unknown }
  | { questId: string; ok: false; status: number; code: string; message: string };

const characterNotFound = () => new ApiError(404, 'not_found', 'No such character.');

/**
 * Locks the character, checks ownership and settles its running activity first (as client
 * contact), so quest changes see every event up to now and a newly accepted quest only counts
 * what happens after it (ticket 2.4).
 */
async function lockAndSettle(
  tx: Transaction,
  accountId: string,
  characterId: string,
  activity: ActivityOptions,
): Promise<Character> {
  const [character] = await tx
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
  if (!character) throw characterNotFound();
  const settled = await settleActivityTx(tx, characterId, activity, { touch: true });
  return settled?.character ?? character;
}

/** Tavern quests and contracts (ticket 2.4, docs/QUESTS.md). */
export async function registerQuests(
  app: FastifyInstance,
  activity: ActivityOptions,
): Promise<void> {
  app.get<{ Params: { characterId: string } }>(
    '/characters/:characterId/quests',
    { preHandler: app.requireAccount, schema: { params: characterParamsSchema } },
    async (request) => {
      const accountId = request.auth!.account.id;
      const [character] = await app.db
        .select({
          id: characters.id,
          classId: characters.classId,
          level: characters.level,
          progress: characters.progress,
        })
        .from(characters)
        .where(
          and(
            eq(characters.id, request.params.characterId),
            eq(characters.accountId, accountId),
            isNull(characters.deletedAt),
          ),
        )
        .limit(1);
      if (!character) throw characterNotFound();
      return questBoard(app.db, character, activity.now(), await app.worldState.flags());
    },
  );

  app.post<{
    Params: { characterId: string };
    Body: { kind: string; questId?: string; slot?: number; rewardSlot?: string };
  }>(
    '/characters/:characterId/quests',
    {
      preHandler: app.requireAccount,
      schema: { params: characterParamsSchema, body: acceptBodySchema },
    },
    async (request, reply) => {
      const accountId = request.auth!.account.id;
      const body = request.body;
      let accept: AcceptRequest;
      if (
        body.kind === 'story' &&
        body.questId !== undefined &&
        body.slot === undefined &&
        body.rewardSlot === undefined
      ) {
        accept = { kind: 'story', questId: body.questId };
      } else if (
        body.kind === 'contract' &&
        body.slot !== undefined &&
        body.questId === undefined
      ) {
        accept = {
          kind: 'contract',
          slot: body.slot,
          ...(body.rewardSlot !== undefined ? { rewardSlot: body.rewardSlot } : {}),
        };
      } else {
        throw new ApiError(
          400,
          'validation_failed',
          'Send { kind: "story", questId } or { kind: "contract", slot, rewardSlot? }.',
        );
      }
      const world = await app.worldState.flags();
      const board = await withTransaction(app.db, async (tx) => {
        const now = activity.now();
        const character = await lockAndSettle(tx, accountId, request.params.characterId, activity);
        await acceptQuestTx(tx, character, accept, now, world);
        return questBoard(tx, character, now, world);
      });
      return reply.code(201).send(board);
    },
  );

  app.post<{ Params: { characterId: string; questId: string } }>(
    '/characters/:characterId/quests/:questId/turn-in',
    { preHandler: app.requireAccount, schema: { params: questParamsSchema } },
    async (request, reply) => {
      const accountId = request.auth!.account.id;
      const { characterId, questId } = request.params;
      const world = await app.worldState.flags();
      const switches = await app.gameSettings.tradingSwitches();
      return idempotentTransaction(app, request, reply, { now: activity.now }, async (tx) => {
        const now = activity.now();
        const character = await lockAndSettle(tx, accountId, characterId, activity);
        const outcome = await turnInQuestTx(tx, character, questId, {
          inventoryCapacity: activity.rules.inventory.capacity,
          now,
          world,
          switches,
        });
        return {
          quests: await questBoard(tx, outcome.character, now, world),
          character: characterView(outcome.character),
          reward: outcome.reward,
        };
      });
    },
  );

  // Ticket 8.5 (docs/QUESTS.md "Claiming several at once"): every ready quest in one request. Each
  // quest is turned in by the single turn-in's own transaction (`turnInQuestTx`), under its own
  // stored key derived from the batch's `Idempotency-Key` (`batchItemKey`), so a retry replays
  // what was done and runs only the rest, and one quest's failure (a full pack, already turned
  // in) is reported for that quest alone. The batch's answer is stored under its own key last.
  app.post<{ Params: { characterId: string }; Body: { questIds: string[] } }>(
    '/characters/:characterId/quests/turn-in-batch',
    {
      preHandler: app.requireAccount,
      schema: { params: characterParamsSchema, body: batchBodySchema },
    },
    async (request, reply) => {
      const accountId = request.auth!.account.id;
      const { characterId } = request.params;
      const key = readIdempotencyKey(request);
      const hash = requestHash(request.method, request.url.split('?')[0]!, request.body);
      const [done] = await app.db
        .select()
        .from(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.accountId, accountId),
            eq(idempotencyKeys.key, key),
            gt(idempotencyKeys.expiresAt, activity.now()),
          ),
        );
      if (done && done.requestHash !== hash) {
        throw new ApiError(
          409,
          'idempotency_conflict',
          'This Idempotency-Key was already used for a different request.',
        );
      }
      if (done) {
        void reply.header(IDEMPOTENCY_REPLAYED_HEADER, 'true');
        return reply.code(done.statusCode).send(done.response);
      }
      // The hero must be ours before anything runs (the same 404 as every hero route).
      const [hero] = await app.db
        .select({ id: characters.id })
        .from(characters)
        .where(
          and(
            eq(characters.id, characterId),
            eq(characters.accountId, accountId),
            isNull(characters.deletedAt),
          ),
        );
      if (!hero) throw characterNotFound();
      const world = await app.worldState.flags();
      const switches = await app.gameSettings.tradingSwitches();
      const results: BatchTurnInResult[] = [];
      for (const questId of request.body.questIds) {
        try {
          const run = await runIdempotent(
            app.db,
            { accountId, key: batchItemKey(key, questId), hash, now: activity.now },
            async (tx) => {
              const now = activity.now();
              const character = await lockAndSettle(tx, accountId, characterId, activity);
              const outcome = await turnInQuestTx(tx, character, questId, {
                inventoryCapacity: activity.rules.inventory.capacity,
                now,
                world,
                switches,
              });
              return { reward: outcome.reward as unknown };
            },
          );
          results.push({ questId, ok: true, reward: run.body.reward });
        } catch (err) {
          if (!(err instanceof ApiError)) throw err;
          results.push({
            questId,
            ok: false,
            status: err.statusCode,
            code: err.code,
            message: err.message,
          });
        }
      }
      const stored = await runIdempotent(
        app.db,
        { accountId, key, hash, now: activity.now },
        async (tx) => {
          const now = activity.now();
          const character = await lockAndSettle(tx, accountId, characterId, activity);
          return {
            results,
            quests: await questBoard(tx, character, now, world),
            character: characterView(character),
          };
        },
      );
      if (stored.replayed) void reply.header(IDEMPOTENCY_REPLAYED_HEADER, 'true');
      return reply.code(stored.status).send(stored.body);
    },
  );
}
