import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import {
  COMMUNITY_PROJECTS,
  PROJECT_RESOURCES,
  contributionWindow,
  isProjectOpen,
  planContribution,
  stageAgeDays,
  type MaterialId,
  type ProjectResource,
  type ResourceAmounts,
  eraCrierLine,
  worldEra,
  worldEraIndex,
} from '@worldforge/game-core';
import { accountAchievements, accounts } from '../db/schema.js';
import { writeAudit } from '../db/audit.js';
import { ApiError } from '../errors.js';
import type { ActivityOptions } from '../activity/settle.js';
import { characterSchema, characterView } from '../characters/routes.js';
import { changeGold } from '../economy/shared.js';
import { idempotentTransaction } from '../idempotency/index.js';
import { lockOwnedCharacter } from '../inventory/routes.js';
import { changeMaterialsTx, loadMaterialBundle } from '../materials/store.js';
import { recordTelemetry } from '../telemetry/record.js';
import { goldOut, materialCounts } from '../telemetry/counts.js';
import {
  addContribution,
  advanceProject,
  completedProjectIds,
  givenInWindow,
  lockProject,
  projectBoard,
  projectOrThrow,
  catchUpProject,
  stageFirstDay,
  stageTotals,
} from './model.js';

/**
 * Community project routes (ticket 4.6, docs/COMMUNITY.md, docs/API_CONVENTIONS.md).
 *
 * - `GET /api/world`: the global world state (flags, completed projects, and since 6.7 the era
 *   and the crier's call of the day) from the cache; every screen polls it for the world notice
 *   (120 s, `ETag`).
 * - `GET /api/community/projects`: the project board with the viewer's own contribution and
 *   remaining cap (polled every 60 s while open, `ETag`).
 * - `POST /api/community/projects/:projectId/contribute`: a value operation (`Idempotency-Key`).
 *   Under the hero's lock (its activity settles first) and the project's lock: the stage must be
 *   the one the client saw (`409 stage_changed` otherwise, nothing spent), the offer must be held,
 *   and only what the stage still needs and the account may still give this window is taken.
 *   Spend, totals, the account's window row, the `community.contribute` audit row, telemetry and
 *   any stage or project completion commit together.
 */

const ETAG = (body: unknown) =>
  `"${createHash('sha256').update(JSON.stringify(body)).digest('base64url').slice(0, 22)}"`;

function sendTagged(request: FastifyRequest, reply: FastifyReply, body: unknown) {
  const etag = ETAG(body);
  void reply.header('etag', etag).header('cache-control', 'private, no-cache');
  if (request.headers['if-none-match'] === etag) return reply.code(304).send();
  return body;
}

const resourceAmountSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['resource', 'amount'],
  properties: {
    resource: { type: 'string', enum: [...PROJECT_RESOURCES] },
    amount: { type: 'integer', minimum: 1, maximum: 10_000_000 },
  },
} as const;

const amountListSchema = {
  type: 'array',
  items: {
    type: 'object',
    required: ['resource', 'amount'],
    properties: { resource: { type: 'string' }, amount: { type: 'integer' } },
  },
} as const;

function amountList(amounts: ResourceAmounts): { resource: ProjectResource; amount: number }[] {
  return PROJECT_RESOURCES.filter((r) => (amounts[r] ?? 0) > 0).map((resource) => ({
    resource,
    amount: amounts[resource]!,
  }));
}

async function earnedRewards(db: FastifyInstance['db'], accountId: string): Promise<Set<string>> {
  const ids = COMMUNITY_PROJECTS.map((p) => p.rewardAchievementId);
  const rows = await db
    .select({ id: accountAchievements.achievementId })
    .from(accountAchievements)
    .where(
      and(
        eq(accountAchievements.accountId, accountId),
        inArray(accountAchievements.achievementId, ids),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

export async function registerCommunity(
  app: FastifyInstance,
  activity: ActivityOptions,
): Promise<void> {
  app.get('/world', { preHandler: app.requireAccount }, async (request, reply) => {
    const state = await app.worldState.get();
    // Ticket 6.7: the world era (derived from the flags; words only) and today's crier call.
    const era = worldEra(state.flags);
    return sendTagged(request, reply, {
      flags: state.flags,
      era: {
        id: era.id,
        index: worldEraIndex(era.id),
        name: era.name,
        title: era.title,
        crier: eraCrierLine(era, contributionWindow(activity.now()).day),
      },
      completed: state.completed.map((c) => ({
        projectId: c.projectId,
        completedOn: c.completedAt.toISOString().slice(0, 10),
      })),
    });
  });

  app.get('/community/projects', { preHandler: app.requireAccount }, async (request, reply) => {
    const me = request.auth!.account;
    const board = await projectBoard(
      app.db,
      me.id,
      activity.now(),
      await earnedRewards(app.db, me.id),
    );
    return sendTagged(request, reply, board);
  });

  app.post<{ Params: { projectId: string } }>(
    '/community/projects/:projectId/contribute',
    {
      preHandler: app.requireAccount,
      schema: {
        params: {
          type: 'object',
          required: ['projectId'],
          properties: { projectId: { type: 'string', maxLength: 64 } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['characterId', 'stageId', 'offer'],
          properties: {
            characterId: { type: 'string', format: 'uuid' },
            stageId: { type: 'string', maxLength: 64 },
            offer: {
              type: 'array',
              minItems: 1,
              maxItems: PROJECT_RESOURCES.length,
              items: resourceAmountSchema,
            },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['accepted', 'limited', 'stagesCompleted', 'projectCompleted', 'character'],
            properties: {
              accepted: amountListSchema,
              limited: {
                type: 'object',
                additionalProperties: { type: 'string', enum: ['stage', 'cap'] },
              },
              stagesCompleted: { type: 'array', items: { type: 'string' } },
              projectCompleted: { type: 'boolean' },
              character: characterSchema,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const me = request.auth!.account;
      const body = request.body as {
        characterId: string;
        stageId: string;
        offer: { resource: ProjectResource; amount: number }[];
      };
      const def = projectOrThrow(request.params.projectId);
      const offer: ResourceAmounts = {};
      for (const o of body.offer) {
        if (offer[o.resource] !== undefined) {
          throw new ApiError(400, 'validation_failed', 'Each resource may appear once.', {
            fields: { offer: `${o.resource} appears twice.` },
          });
        }
        offer[o.resource] = o.amount;
      }
      let completed = false;
      // Ticket B.3: a stage whose needs were lowered (a balance change) to what it already holds
      // is finished first, in its own transaction, so it never stands stuck at its need (the
      // contribution below then answers `stage_changed` for it, and the board shows the next).
      if (await catchUpProject(app.db, def, activity.now())) app.worldState.invalidate();
      const result = await idempotentTransaction(
        app,
        request,
        reply,
        { now: activity.now },
        async (tx) => {
          const now = activity.now();
          // Lock order: hero (settles its activity first) → project → counter rows.
          const hero = await lockOwnedCharacter(tx, me.id, body.characterId, activity);
          // Ticket 6.7: test accounts (D.4) never move the shared world. Read in the transaction:
          // the flag is set by the CLI and may change at any time.
          const [acct] = await tx
            .select({ isTest: accounts.isTest })
            .from(accounts)
            .where(eq(accounts.id, me.id));
          if (acct?.isTest) {
            throw new ApiError(
              403,
              'test_account',
              'Test accounts do not give to the town works: the projects change the world for every player.',
            );
          }
          const row = await lockProject(tx, def.id, now);
          if (row.completedAt !== null) {
            throw new ApiError(409, 'project_complete', 'This project is already finished.');
          }
          if (!isProjectOpen(def, await completedProjectIds(tx))) {
            throw new ApiError(409, 'project_locked', 'This project has not begun yet.', {
              requires: def.requires,
            });
          }
          const stage = def.stages[row.stageIndex]!;
          if (stage.id !== body.stageId) {
            throw new ApiError(409, 'stage_changed', 'The project moved on to another stage.', {
              currentStageId: stage.id,
            });
          }
          for (const resource of Object.keys(offer) as ProjectResource[]) {
            if (!stage.needs.some((n) => n.resource === resource)) {
              throw new ApiError(422, 'not_needed', 'This stage does not need that.', { resource });
            }
          }
          // The offer must be held (after the settlement above).
          const held = await loadMaterialBundle(tx, hero.id);
          if ((offer.gold ?? 0) > hero.gold) {
            throw new ApiError(422, 'insufficient_gold', 'Not enough gold.', {
              required: offer.gold,
              held: hero.gold,
            });
          }
          for (const [resource, amount] of Object.entries(offer) as [ProjectResource, number][]) {
            if (resource !== 'gold' && amount > (held[resource] ?? 0)) {
              throw new ApiError(422, 'insufficient_materials', 'Not enough materials.', {
                resource,
                required: amount,
                held: held[resource] ?? 0,
              });
            }
          }
          const { day } = contributionWindow(now);
          const plan = planContribution(
            stage,
            await stageTotals(tx, def.id, stage.id),
            await givenInWindow(tx, def.id, stage.id, me.id, day),
            offer,
            stageAgeDays(await stageFirstDay(tx, def.id, stage.id), day),
          );
          const accepted = plan.accepted;
          if (Object.keys(accepted).length === 0) {
            throw new ApiError(
              409,
              'contribution_capped',
              'You have given all you may to this stage today. The cap resets at midnight (UTC).',
              { resetsAt: contributionWindow(now).endsAt.toISOString(), limited: plan.limited },
            );
          }
          const gold = accepted.gold ?? 0;
          const materials: Partial<Record<MaterialId, number>> = {};
          for (const [r, n] of Object.entries(accepted) as [ProjectResource, number][]) {
            if (r !== 'gold') materials[r] = n;
          }
          let character = hero;
          if (gold > 0) character = await changeGold(tx, hero, -gold, now);
          await changeMaterialsTx(
            tx,
            hero.id,
            Object.fromEntries(Object.entries(materials).map(([k, n]) => [k, -n])),
            now,
          );
          await addContribution(tx, def.id, stage.id, me.id, day, accepted);
          await writeAudit(tx, {
            event: 'community.contribute',
            accountId: me.id,
            characterId: hero.id,
            data: {
              projectId: def.id,
              stageId: stage.id,
              day,
              gold,
              materials,
              goldAfter: character.gold,
            },
          });
          recordTelemetry(tx, now, [
            { metric: 'community.contribute', dims: [def.id, stage.id] },
            ...goldOut('community_project', def.id, gold),
            ...materialCounts('material.out', 'community_project', materials),
          ]);
          const outcome = await advanceProject(tx, def, row, now);
          if (outcome.projectCompleted) completed = true;
          return {
            accepted: amountList(accepted),
            limited: plan.limited,
            stagesCompleted: outcome.stagesCompleted,
            projectCompleted: outcome.projectCompleted,
            character: characterView(character),
          };
        },
      );
      // After the commit: the next world-state read sees the new flag at once.
      if (completed) app.worldState.invalidate();
      return result;
    },
  );
}
