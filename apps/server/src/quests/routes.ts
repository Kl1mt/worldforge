import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { characters, type Character } from '../db/schema.js';
import type { Transaction } from '../db/types.js';
import { withTransaction } from '../db/transaction.js';
import { ApiError } from '../errors.js';
import { settleActivityTx, type ActivityOptions } from '../activity/settle.js';
import { characterView } from '../characters/routes.js';
import { idempotentTransaction } from '../idempotency/index.js';
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
    .where(and(eq(characters.id, characterId), eq(characters.accountId, accountId)))
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
          and(eq(characters.id, request.params.characterId), eq(characters.accountId, accountId)),
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
}
