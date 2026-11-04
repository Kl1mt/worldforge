import type { FastifyInstance } from 'fastify';
import { and, eq, ne } from 'drizzle-orm';
import {
  AREA_IDS,
  areaUnlockBlockers,
  isAreaId,
  requestAreaChange,
  type AreaId,
} from '@worldforge/game-core';
import {
  accounts,
  activities,
  characters,
  type Activity,
  type ActivitySummary,
  type Character,
} from '../db/schema.js';
import type { Transaction } from '../db/types.js';
import { withTransaction } from '../db/transaction.js';
import { writeAudit } from '../db/audit.js';
import { ApiError } from '../errors.js';
import { characterView, type CharacterView } from '../characters/routes.js';
import { assertNoOpenDungeonRun } from '../dungeon/routes.js';
import {
  emptySummary,
  endActivityTx,
  initialFarmState,
  settleActivityTx,
  type ActivityOptions,
  type SettleOutcome,
} from './settle.js';

/** Public activity shape. The seed secret and settlement counter never leave the server. */
export interface ActivityView {
  characterId: string;
  /** Area of the cycle in progress. */
  areaId: AreaId;
  /** Area the character travels to once the cycle in progress completes (ticket 2.2); null = none. */
  pendingAreaId: AreaId | null;
  startedAt: string;
  settledAt: string;
  /** Health carried between settlements (after the last simulated fight); null = full. */
  health: number | null;
}

export function activityView(a: Activity): ActivityView {
  return {
    characterId: a.characterId,
    areaId: a.areaId,
    pendingAreaId: a.pendingAreaId,
    startedAt: a.startedAt.toISOString(),
    settledAt: a.settledAt.toISOString(),
    health: a.health,
  };
}

export interface SummaryView extends ActivitySummary {
  /** End of the summary period (server time of this settlement). */
  until: string;
}

export interface ActivityStateResponse {
  activity: ActivityView | null;
  character: CharacterView;
}

export interface SettleResponse extends ActivityStateResponse {
  summary: SummaryView;
}

const idParamsSchema = {
  type: 'object',
  required: ['characterId'],
  properties: { characterId: { type: 'string', format: 'uuid' } },
} as const;

const startBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['areaId'],
  properties: { areaId: { type: 'string', maxLength: 64 } },
} as const;

type IdParams = { Params: { characterId: string } };

const notFound = () => new ApiError(404, 'not_found', 'No such character.');
const notFarming = () => new ApiError(409, 'not_farming', 'This character is not farming.');

/** Loads a character of this account or throws 404 (no distinction, so ids can't be probed). */
async function ownedCharacter(
  tx: Transaction,
  accountId: string,
  characterId: string,
): Promise<Character> {
  const [c] = await tx
    .select()
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.accountId, accountId)))
    .limit(1);
  if (!c) throw notFound();
  return c;
}

/** Refuses an area the character has not unlocked (server-side; never trust the client). */
function assertAreaUnlocked(character: Character, areaId: AreaId): void {
  const blockers = areaUnlockBlockers(areaId, { level: character.level }, character.progress);
  if (blockers.length > 0) {
    throw new ApiError(409, 'area_locked', 'This area is not open to this character yet.', {
      areaId,
      blockers,
    });
  }
}

/** Drains the summary: returns it and starts a fresh one at the settlement time. */
async function drainSummary(tx: Transaction, outcome: SettleOutcome): Promise<SummaryView> {
  const until = outcome.activity.settledAt;
  await tx
    .update(activities)
    .set({ summary: emptySummary(until) })
    .where(eq(activities.characterId, outcome.activity.characterId));
  return { ...outcome.activity.summary, until: until.toISOString() };
}

export async function registerActivities(
  app: FastifyInstance,
  options: ActivityOptions,
): Promise<void> {
  /** Current activity, read-only (no settlement, no client-contact mark). */
  app.get<IdParams>(
    '/characters/:characterId/activity',
    { preHandler: app.requireAccount, schema: { params: idParamsSchema } },
    async (request): Promise<ActivityStateResponse> => {
      const accountId = request.auth!.account.id;
      const [row] = await app.db
        .select({ character: characters, activity: activities })
        .from(characters)
        .leftJoin(activities, eq(activities.characterId, characters.id))
        .where(
          and(eq(characters.id, request.params.characterId), eq(characters.accountId, accountId)),
        )
        .limit(1);
      if (!row) throw notFound();
      return {
        activity: row.activity ? activityView(row.activity) : null,
        character: characterView(row.character),
      };
    },
  );

  /**
   * Start farming an area with the account's active character. Any other activity of the account
   * is settled and stopped (one activity per account). Same area again is a no-op (200).
   */
  app.post<IdParams & { Body: { areaId: string } }>(
    '/characters/:characterId/activity',
    {
      preHandler: app.requireAccount,
      schema: { params: idParamsSchema, body: startBodySchema },
    },
    async (request, reply) => {
      const accountId = request.auth!.account.id;
      const { characterId } = request.params;
      const { areaId } = request.body;
      if (!isAreaId(areaId)) {
        throw new ApiError(400, 'validation_failed', 'Some fields need attention.', {
          fields: { areaId: `Choose one of: ${AREA_IDS.join(', ')}.` },
        });
      }

      const result = await withTransaction(app.db, async (tx) => {
        // Serialise per account: one activity per account, checked under this lock.
        const [account] = await tx
          .select({ activeCharacterId: accounts.activeCharacterId })
          .from(accounts)
          .where(eq(accounts.id, accountId))
          .for('no key update');
        await ownedCharacter(tx, accountId, characterId);
        if (account?.activeCharacterId !== characterId) {
          throw new ApiError(
            409,
            'character_not_active',
            'Select this character before sending it out to farm.',
          );
        }
        // A dungeon run never stacks with farming (ticket 2.5).
        await assertNoOpenDungeonRun(tx, accountId);

        const others = await tx
          .select({ characterId: activities.characterId })
          .from(activities)
          .where(and(eq(activities.accountId, accountId), ne(activities.characterId, characterId)));
        for (const other of others) {
          const settled = await settleActivityTx(tx, other.characterId, options, { touch: true });
          if (settled) await endActivityTx(tx, settled.activity);
          await writeAudit(tx, {
            event: 'activity.stop',
            accountId,
            characterId: other.characterId,
            data: { reason: 'other_character_started' },
          });
        }

        const existing = await settleActivityTx(tx, characterId, options, { touch: true });
        if (existing) {
          // Unlocks use the level after settling: time before the request counts.
          assertAreaUnlocked(existing.character, areaId);
          const before = existing.activity;
          const next = requestAreaChange(
            { areaId: before.areaId, pendingAreaId: before.pendingAreaId, carryMs: before.carryMs },
            areaId,
          );
          let activity = before;
          if (next.areaId !== before.areaId || next.pendingAreaId !== before.pendingAreaId) {
            const switchedNow = next.areaId !== before.areaId;
            const [updated] = await tx
              .update(activities)
              .set({
                areaId: next.areaId,
                pendingAreaId: next.pendingAreaId,
                ...(switchedNow ? { startedAt: before.settledAt } : {}),
                updatedAt: options.now(),
              })
              .where(eq(activities.characterId, characterId))
              .returning();
            activity = updated!;
            await writeAudit(tx, {
              event: 'activity.start',
              accountId,
              characterId,
              data: {
                areaId,
                from: before.areaId,
                ...(switchedNow ? {} : { pending: next.pendingAreaId !== null }),
              },
            });
          }
          return { created: false, activity, character: existing.character };
        }

        const now = options.now();
        const owned = await ownedCharacter(tx, accountId, characterId);
        assertAreaUnlocked(owned, areaId);
        const farmState = initialFarmState(owned);
        // A cycle left unfinished by the last stop replays in its own area first (ticket 2.2).
        const cycleArea = farmState.areaId ?? areaId;
        const [activity] = await tx
          .insert(activities)
          .values({
            characterId,
            accountId,
            areaId: cycleArea,
            pendingAreaId: cycleArea === areaId ? null : areaId,
            seedSecret: farmState.seedSecret,
            cycleIndex: farmState.cycleIndex,
            settlementSeq: 0,
            startedAt: now,
            settledAt: now,
            lastSeenAt: now,
            carryMs: 0,
            health: farmState.health,
            summary: emptySummary(now),
            updatedAt: now,
          })
          .returning();
        await writeAudit(tx, { event: 'activity.start', accountId, characterId, data: { areaId } });
        const character = await ownedCharacter(tx, accountId, characterId);
        return { created: true, activity: activity!, character };
      });

      return reply.code(result.created ? 201 : 200).send({
        activity: activityView(result.activity),
        character: characterView(result.character),
      } satisfies ActivityStateResponse);
    },
  );

  /**
   * Settle now and collect the return summary: everything earned since the previous call
   * (including scheduled settlements while the client was away), and how much time was capped.
   */
  app.post<IdParams>(
    '/characters/:characterId/activity/settle',
    { preHandler: app.requireAccount, schema: { params: idParamsSchema } },
    async (request): Promise<SettleResponse> => {
      const accountId = request.auth!.account.id;
      const { characterId } = request.params;
      return withTransaction(app.db, async (tx) => {
        await ownedCharacter(tx, accountId, characterId);
        const outcome = await settleActivityTx(tx, characterId, options, { touch: true });
        if (!outcome) throw notFarming();
        const summary = await drainSummary(tx, outcome);
        return {
          activity: activityView(outcome.activity),
          character: characterView(outcome.character),
          summary,
        };
      });
    },
  );

  /** Stop farming: settles first, returns the final summary, then removes the activity. */
  app.post<IdParams>(
    '/characters/:characterId/activity/stop',
    { preHandler: app.requireAccount, schema: { params: idParamsSchema } },
    async (request): Promise<SettleResponse> => {
      const accountId = request.auth!.account.id;
      const { characterId } = request.params;
      return withTransaction(app.db, async (tx) => {
        await ownedCharacter(tx, accountId, characterId);
        const outcome = await settleActivityTx(tx, characterId, options, { touch: true });
        if (!outcome) throw notFarming();
        const summary = {
          ...outcome.activity.summary,
          until: outcome.activity.settledAt.toISOString(),
        };
        await endActivityTx(tx, outcome.activity);
        await writeAudit(tx, {
          event: 'activity.stop',
          accountId,
          characterId,
          data: { areaId: outcome.activity.areaId },
        });
        return { activity: null, character: characterView(outcome.character), summary };
      });
    },
  );
}
