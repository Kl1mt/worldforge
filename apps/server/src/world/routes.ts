import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import {
  AREA_IDS,
  DUNGEON_IDS,
  areaUnlockBlockers,
  dungeonUnlockBlockers,
  type AreaId,
  type DungeonId,
  type UnlockBlocker,
  type WorldProgress,
} from '@worldforge/game-core';
import { activities, characters } from '../db/schema.js';
import { ApiError } from '../errors.js';

export interface WorldPlaceView<Id extends string> {
  id: Id;
  unlocked: boolean;
  /** Unmet conditions in a stable order (level first); empty when unlocked. */
  blockers: UnlockBlocker[];
}

export interface WorldStateResponse {
  characterId: string;
  level: number;
  progress: WorldProgress;
  /** Where the character is farming now (null = idle). */
  current: { areaId: AreaId; pendingAreaId: AreaId | null } | null;
  areas: WorldPlaceView<AreaId>[];
  /** Dungeons with their unlock state; `available` = runs can be started (ticket 2.5). */
  dungeons: (WorldPlaceView<DungeonId> & { available: boolean })[];
}

const idParamsSchema = {
  type: 'object',
  required: ['characterId'],
  properties: { characterId: { type: 'string', format: 'uuid' } },
} as const;

/** World state of a character (ticket 2.2): which places are open and why the others are not. */
export async function registerWorld(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { characterId: string } }>(
    '/characters/:characterId/world',
    { preHandler: app.requireAccount, schema: { params: idParamsSchema } },
    async (request): Promise<WorldStateResponse> => {
      const accountId = request.auth!.account.id;
      const [row] = await app.db
        .select({
          id: characters.id,
          level: characters.level,
          progress: characters.progress,
          areaId: activities.areaId,
          pendingAreaId: activities.pendingAreaId,
        })
        .from(characters)
        .leftJoin(activities, eq(activities.characterId, characters.id))
        .where(
          and(eq(characters.id, request.params.characterId), eq(characters.accountId, accountId)),
        )
        .limit(1);
      if (!row) throw new ApiError(404, 'not_found', 'No such character.');
      const who = { level: row.level };
      return {
        characterId: row.id,
        level: row.level,
        progress: row.progress,
        current: row.areaId ? { areaId: row.areaId, pendingAreaId: row.pendingAreaId } : null,
        areas: AREA_IDS.map((id) => {
          const blockers = areaUnlockBlockers(id, who, row.progress);
          return { id, unlocked: blockers.length === 0, blockers };
        }),
        dungeons: DUNGEON_IDS.map((id) => {
          const blockers = dungeonUnlockBlockers(id, who, row.progress);
          return { id, unlocked: blockers.length === 0, blockers, available: true };
        }),
      };
    },
  );
}
