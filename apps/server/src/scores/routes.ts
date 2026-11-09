import type { FastifyInstance } from 'fastify';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import {
  computeScores,
  type ScoredItem,
  type Scores,
  type ScoringInput,
  type WorldFlags,
} from '@worldforge/game-core';
import {
  characters,
  guildBossAttempts,
  guildBossRewards,
  itemInstances,
  type Character,
} from '../db/schema.js';
import type { Executor } from '../db/types.js';
import { ApiError } from '../errors.js';

/**
 * Ticket 5.1: a hero's four leaderboard scores with their breakdown (docs/LEADERBOARDS.md),
 * computed from server state only. Read-only: nothing is stored yet (5.2 stores snapshots) and
 * no score is ever accepted from a client.
 */

/**
 * The highest guild boss stage this hero helped break: a stage whose reward the account earned
 * (`guild_boss_rewards.status = 'earned'`) in a week in which this hero fought for that guild.
 */
export async function heroGuildBossStage(db: Executor, hero: Character): Promise<number> {
  const [row] = await db
    .select({ stage: sql<number | null>`max(${guildBossRewards.stage})` })
    .from(guildBossRewards)
    .where(
      and(
        eq(guildBossRewards.accountId, hero.accountId),
        eq(guildBossRewards.status, 'earned'),
        sql`exists (select 1 from ${guildBossAttempts}
          where ${guildBossAttempts.characterId} = ${hero.id}
            and ${guildBossAttempts.guildId} = ${guildBossRewards.guildId}
            and ${guildBossAttempts.week} = ${guildBossRewards.week})`,
      ),
    );
  return Number(row?.stage ?? 0);
}

/** Everything the scores read, from the hero's own rows (5.2 stores this next to each value). */
export async function scoringInput(
  app: { worldState: { flags: () => Promise<WorldFlags> } },
  db: Executor,
  hero: Character,
): Promise<ScoringInput> {
  const rows = await db
    .select({
      slot: itemInstances.equippedSlot,
      seed: itemInstances.seed,
      baseId: itemInstances.baseId,
      rarityId: itemInstances.rarityId,
      itemLevel: itemInstances.itemLevel,
      affixes: itemInstances.affixes,
      upgradeLevel: itemInstances.upgradeLevel,
      variant: itemInstances.variant,
      effectId: itemInstances.effectId,
      effectRoll: itemInstances.effectRoll,
      mythicId: itemInstances.mythicId,
      setId: itemInstances.setId,
    })
    .from(itemInstances)
    .where(and(eq(itemInstances.characterId, hero.id), isNotNull(itemInstances.equippedSlot)));
  const equipment: ScoredItem[] = rows.map((r) => ({ ...r, slot: r.slot! }));
  return {
    classId: hero.classId,
    level: hero.level,
    experience: hero.experience,
    equipment,
    progress: hero.progress,
    world: await app.worldState.flags(),
    guildBossStage: await heroGuildBossStage(db, hero),
  };
}

const idParamsSchema = {
  type: 'object',
  required: ['characterId'],
  properties: { characterId: { type: 'string', format: 'uuid' } },
} as const;

export async function registerScores(
  app: FastifyInstance,
  now: () => Date = () => new Date(),
): Promise<void> {
  app.get<{ Params: { characterId: string } }>(
    '/characters/:characterId/scores',
    { preHandler: app.requireAccount, schema: { params: idParamsSchema } },
    async (request): Promise<{ scores: Scores }> => {
      const accountId = request.auth!.account.id;
      // Another account's hero is the same 404 as a missing one (public boards come in 5.2).
      const [hero] = await app.db
        .select()
        .from(characters)
        .where(
          and(eq(characters.id, request.params.characterId), eq(characters.accountId, accountId)),
        )
        .limit(1);
      if (!hero) throw new ApiError(404, 'not_found', 'No such character.');
      // Ticket 6.1: the versions in force (an older one until the season under way ends).
      const versions = await app.formulaVersions.at(now());
      return { scores: computeScores(await scoringInput(app, app.db, hero), versions) };
    },
  );
}
