import type { FastifyInstance } from 'fastify';
import { and, asc, count, eq } from 'drizzle-orm';
import {
  BANNER_IDS,
  CLASS_IDS,
  STARTING_CHARACTER,
  isBannerId,
  isClassId,
  validateCharacterName,
  type CharacterAppearance,
  type ClassId,
} from '@worldforge/game-core';
import { accounts, characters, type Character } from '../db/schema.js';
import { constraintOf, sqlStateOf, withTransaction } from '../db/transaction.js';
import { writeAudit } from '../db/audit.js';
import { uuidv7 } from '../db/uuid.js';
import { ApiError } from '../errors.js';

/** The public character shape (docs/API_CONVENTIONS.md). */
export interface CharacterView {
  id: string;
  name: string;
  classId: ClassId;
  appearance: CharacterAppearance;
  level: number;
  experience: number;
  gold: number;
  createdAt: string;
}

export function characterView(c: Character): CharacterView {
  return {
    id: c.id,
    name: c.name,
    classId: c.classId,
    appearance: c.appearance,
    level: c.level,
    experience: c.experience,
    gold: c.gold,
    createdAt: c.createdAt.toISOString(),
  };
}

const characterSchema = {
  type: 'object',
  required: ['id', 'name', 'classId', 'appearance', 'level', 'experience', 'gold', 'createdAt'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    classId: { type: 'string' },
    appearance: {
      type: 'object',
      required: ['banner'],
      properties: { banner: { type: 'string' } },
    },
    level: { type: 'integer' },
    experience: { type: 'integer' },
    gold: { type: 'integer' },
    createdAt: { type: 'string' },
  },
} as const;

const characterResponseSchema = {
  type: 'object',
  required: ['character'],
  properties: { character: characterSchema },
} as const;

const listResponseSchema = {
  type: 'object',
  required: ['characters', 'slots', 'activeCharacterId'],
  properties: {
    characters: { type: 'array', items: characterSchema },
    slots: {
      type: 'object',
      required: ['used', 'total'],
      properties: { used: { type: 'integer' }, total: { type: 'integer' } },
    },
    activeCharacterId: { type: ['string', 'null'] },
  },
} as const;

// Shape only; the name rules come from game-core so the message is friendly and per field.
// classId and banner are strings here (not enums) for the same reason.
const createBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'classId', 'appearance'],
  properties: {
    name: { type: 'string', maxLength: 64 },
    classId: { type: 'string', maxLength: 32 },
    appearance: {
      type: 'object',
      additionalProperties: false,
      required: ['banner'],
      properties: { banner: { type: 'string', maxLength: 32 } },
    },
  },
} as const;

const idParamsSchema = {
  type: 'object',
  required: ['characterId'],
  properties: { characterId: { type: 'string', format: 'uuid' } },
} as const;

interface CreateBody {
  name: string;
  classId: string;
  appearance: { banner: string };
}

const UNIQUE_VIOLATION = '23505';

export async function registerCharacters(app: FastifyInstance): Promise<void> {
  app.get(
    '/characters',
    { preHandler: app.requireAccount, schema: { response: { 200: listResponseSchema } } },
    async (request) => {
      const { account } = request.auth!;
      const rows = await app.db
        .select()
        .from(characters)
        .where(eq(characters.accountId, account.id))
        .orderBy(asc(characters.createdAt), asc(characters.id));
      return {
        characters: rows.map(characterView),
        slots: { used: rows.length, total: account.characterSlots },
        activeCharacterId: account.activeCharacterId,
      };
    },
  );

  app.post<{ Body: CreateBody }>(
    '/characters',
    {
      preHandler: app.requireAccount,
      schema: { body: createBodySchema, response: { 201: characterResponseSchema } },
    },
    async (request, reply) => {
      const accountId = request.auth!.account.id;
      const { name: rawName, classId, appearance } = request.body;
      const banner = appearance.banner;

      const name = validateCharacterName(rawName);
      if (!name.ok || !isClassId(classId) || !isBannerId(banner)) {
        const fields: Record<string, string> = {};
        if (!name.ok) fields.name = name.message;
        if (!isClassId(classId)) fields.classId = `Choose one of: ${CLASS_IDS.join(', ')}.`;
        if (!isBannerId(banner))
          fields['appearance.banner'] = `Choose one of: ${BANNER_IDS.join(', ')}.`;
        throw new ApiError(400, 'validation_failed', 'Some fields need attention.', { fields });
      }

      try {
        const character = await withTransaction(app.db, async (tx) => {
          // Lock the account row so concurrent creations count slots one at a time.
          const [locked] = await tx
            .select({ slots: accounts.characterSlots })
            .from(accounts)
            .where(eq(accounts.id, accountId))
            .for('update');
          const [used] = await tx
            .select({ n: count() })
            .from(characters)
            .where(eq(characters.accountId, accountId));
          if (!locked || (used?.n ?? 0) >= locked.slots) {
            throw new ApiError(422, 'no_free_slot', 'Every character slot is taken.', {
              slots: { used: used?.n ?? 0, total: locked?.slots ?? 0 },
            });
          }

          const createdAt = new Date();
          const [created] = await tx
            .insert(characters)
            .values({
              id: uuidv7(),
              accountId,
              name: name.name,
              classId,
              appearance: { banner },
              ...STARTING_CHARACTER,
              createdAt,
              updatedAt: createdAt,
            })
            .returning();
          // A new character becomes the active one: the player just chose to play it.
          await tx
            .update(accounts)
            .set({ activeCharacterId: created!.id, updatedAt: createdAt })
            .where(eq(accounts.id, accountId));
          await writeAudit(tx, {
            event: 'character.create',
            accountId,
            characterId: created!.id,
            data: { classId },
          });
          return created!;
        });
        return reply.code(201).send({ character: characterView(character) });
      } catch (err) {
        if (
          sqlStateOf(err) === UNIQUE_VIOLATION &&
          constraintOf(err) === 'characters_name_lower_key'
        ) {
          throw new ApiError(409, 'character_name_taken', 'This name is already taken.', {
            fields: { name: 'This name is already taken.' },
          });
        }
        throw err;
      }
    },
  );

  app.post<{ Params: { characterId: string } }>(
    '/characters/:characterId/select',
    {
      preHandler: app.requireAccount,
      schema: { params: idParamsSchema, response: { 200: characterResponseSchema } },
    },
    async (request) => {
      const accountId = request.auth!.account.id;
      // Another account's character gets the same 404 as a missing one, so ids can't be probed.
      const [character] = await app.db
        .select()
        .from(characters)
        .where(
          and(eq(characters.id, request.params.characterId), eq(characters.accountId, accountId)),
        )
        .limit(1);
      if (!character) throw new ApiError(404, 'not_found', 'No such character.');
      // Characters never change owner, so the check above stays true for this write.
      await app.db
        .update(accounts)
        .set({ activeCharacterId: character.id, updatedAt: new Date() })
        .where(eq(accounts.id, accountId));
      return { character: characterView(character) };
    },
  );
}
