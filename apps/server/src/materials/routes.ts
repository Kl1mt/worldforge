import type { FastifyInstance } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { characters } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { materialsView, type MaterialsResponse } from './store.js';

const idParamsSchema = {
  type: 'object',
  required: ['characterId'],
  properties: { characterId: { type: 'string', format: 'uuid' } },
} as const;

/**
 * Materials and professions of a character (ticket 2.3). Read-only: materials are granted only by
 * settlement. Clients settle first if they want current numbers.
 */
export async function registerMaterials(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { characterId: string } }>(
    '/characters/:characterId/materials',
    { preHandler: app.requireAccount, schema: { params: idParamsSchema } },
    async (request): Promise<MaterialsResponse> => {
      const accountId = request.auth!.account.id;
      const { characterId } = request.params;
      const [owned] = await app.db
        .select({ id: characters.id })
        .from(characters)
        .where(
          and(
            eq(characters.id, characterId),
            eq(characters.accountId, accountId),
            isNull(characters.deletedAt),
          ),
        )
        .limit(1);
      if (!owned) throw new ApiError(404, 'not_found', 'No such character.');
      return materialsView(app.db, characterId);
    },
  );
}
