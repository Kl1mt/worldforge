import type { FastifyInstance } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import {
  COSMETIC_EXCHANGE,
  exchangeCosmetic,
  exchangeOffer,
  forgeCostBlockers,
  type ForgeBlocker,
  type MaterialId,
} from '@worldforge/game-core';
import { characters, cosmeticUnlocks } from '../db/schema.js';
import type { Executor } from '../db/types.js';
import { writeAudit } from '../db/audit.js';
import { ApiError } from '../errors.js';
import { idempotentTransaction } from '../idempotency/index.js';
import type { ActivityOptions } from '../activity/settle.js';
import { characterNotFound, lockOwnedCharacter } from '../inventory/routes.js';
import { changeMaterialsTx, loadMaterialBundle } from '../materials/store.js';
import { heldValueOf } from '../shelf/held.js';
import { recordTelemetry } from '../telemetry/record.js';
import { materialCounts } from '../telemetry/counts.js';
import { materialList, materialListSchema, type MaterialStack } from '../economy/shared.js';
import { grantCosmeticsTx } from './grant.js';

/**
 * Ticket 6.11: the Forge's exchange (docs/COSMETICS.md "The exchange", docs/ECONOMY.md "Seal and
 * silver sinks"). A hero pays Gravewarden's Seals and Abbey silver from its own holdings (value on
 * hold after a trade excluded) for a collection-book cosmetic the account doesn't own yet.
 * - `GET /api/characters/:characterId/exchange`: the offers, each with its price, whether the
 *   account owns it and what the hero is missing.
 * - `POST /api/characters/:characterId/exchange` `{ cosmeticId }` (Idempotency-Key): grants the
 *   cosmetic through `grantCosmeticsTx` (exactly once per account: the unlock's primary key) and
 *   pays in the same transaction. A cosmetic already owned is refused before anything is paid
 *   (`409 already_owned`), also when two heroes of the account race for it. Audited
 *   (`cosmetic.exchange`, beside the grant's `cosmetic.grant`); telemetry `cosmetic.exchange` and
 *   `material.out` source `cosmetic_exchange`, reconciled.
 * Test accounts trade like anyone (cosmetics rank nothing); telemetry leaves them out (D.4).
 */

export interface ExchangeOfferView {
  cosmeticId: string;
  kind: string;
  name: string;
  description: string;
  price: MaterialStack[];
  owned: boolean;
  blockers: ForgeBlocker[];
}

export interface ExchangeResponse {
  characterId: string;
  materials: MaterialStack[];
  offers: ExchangeOfferView[];
}

export interface ExchangeBuyResponse extends ExchangeResponse {
  bought: string;
  paid: MaterialStack[];
}

const paramsSchema = {
  type: 'object',
  required: ['characterId'],
  properties: { characterId: { type: 'string', format: 'uuid' } },
} as const;

const offersSchema = {
  type: 'array',
  items: {
    type: 'object',
    required: ['cosmeticId', 'kind', 'name', 'description', 'price', 'owned', 'blockers'],
    properties: {
      cosmeticId: { type: 'string' },
      kind: { type: 'string' },
      name: { type: 'string' },
      description: { type: 'string' },
      price: materialListSchema,
      owned: { type: 'boolean' },
      blockers: {
        type: 'array',
        items: {
          type: 'object',
          required: ['kind', 'required', 'held'],
          properties: {
            kind: { type: 'string' },
            materialId: { type: 'string' },
            required: { type: 'integer' },
            held: { type: 'integer' },
          },
        },
      },
    },
  },
} as const;

const responseSchema = {
  type: 'object',
  required: ['characterId', 'materials', 'offers'],
  properties: {
    characterId: { type: 'string' },
    materials: materialListSchema,
    offers: offersSchema,
  },
} as const;

const buyResponseSchema = {
  type: 'object',
  required: ['characterId', 'materials', 'offers', 'bought', 'paid'],
  properties: {
    ...responseSchema.properties,
    bought: { type: 'string' },
    paid: materialListSchema,
  },
} as const;

type Bundle = Partial<Record<MaterialId, number>>;

async function exchangeView(
  executor: Executor,
  accountId: string,
  characterId: string,
  now: Date,
): Promise<ExchangeResponse> {
  const held = await loadMaterialBundle(executor, characterId);
  const onHold = await heldValueOf(executor, characterId, now);
  const spendable: Bundle = { ...held };
  for (const [id, n] of Object.entries(onHold.materials) as [MaterialId, number][]) {
    spendable[id] = Math.max(0, (spendable[id] ?? 0) - n);
  }
  const owned = new Set(
    (
      await executor
        .select({ id: cosmeticUnlocks.cosmeticId })
        .from(cosmeticUnlocks)
        .where(eq(cosmeticUnlocks.accountId, accountId))
    ).map((r) => r.id),
  );
  return {
    characterId,
    materials: materialList(held),
    offers: COSMETIC_EXCHANGE.map((o) => {
      const c = exchangeCosmetic(o);
      const isOwned = owned.has(o.cosmeticId);
      return {
        cosmeticId: o.cosmeticId,
        kind: c.kind,
        name: c.name,
        description: c.description,
        price: materialList(o.price),
        owned: isOwned,
        blockers: isOwned ? [] : forgeCostBlockers({ gold: 0, materials: o.price }, 0, spendable),
      };
    }),
  };
}

export async function registerCosmeticExchange(
  app: FastifyInstance,
  activity: ActivityOptions,
): Promise<void> {
  app.get<{ Params: { characterId: string } }>(
    '/characters/:characterId/exchange',
    {
      preHandler: app.requireAccount,
      schema: { params: paramsSchema, response: { 200: responseSchema } },
    },
    async (request): Promise<ExchangeResponse> => {
      const accountId = request.auth!.account.id;
      const { characterId } = request.params;
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
      return exchangeView(app.db, accountId, characterId, activity.now());
    },
  );

  app.post<{ Params: { characterId: string }; Body: { cosmeticId: string } }>(
    '/characters/:characterId/exchange',
    {
      preHandler: app.requireAccount,
      schema: {
        params: paramsSchema,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['cosmeticId'],
          properties: { cosmeticId: { type: 'string', minLength: 1, maxLength: 64 } },
        },
        response: { 200: buyResponseSchema },
      },
    },
    async (request, reply) => {
      const accountId = request.auth!.account.id;
      const { characterId } = request.params;
      const { cosmeticId } = request.body;
      return idempotentTransaction(
        app,
        request,
        reply,
        { now: activity.now },
        async (tx): Promise<ExchangeBuyResponse> => {
          const hero = await lockOwnedCharacter(tx, accountId, characterId, activity);
          const now = activity.now();
          const offer = exchangeOffer(cosmeticId);
          if (!offer) {
            throw new ApiError(422, 'unknown_offer', 'The Forge doesn’t trade that.', {
              cosmeticId,
            });
          }
          const view = await exchangeView(tx, accountId, characterId, now);
          const quote = view.offers.find((o) => o.cosmeticId === cosmeticId)!;
          if (quote.owned) {
            throw new ApiError(409, 'already_owned', 'Your collection book already holds this.', {
              cosmeticId,
            });
          }
          if (quote.blockers.length > 0) {
            throw new ApiError(422, 'insufficient_materials', 'Not enough materials.', {
              blockers: quote.blockers,
            });
          }
          // Grant first: the unlock's primary key decides a race between two heroes of the
          // account (the loser inserts nothing and rolls back before paying).
          const granted = await grantCosmeticsTx(
            tx,
            { accountId, characterId, now, source: `exchange:${characterId}` },
            [cosmeticId],
          );
          if (granted.length === 0) {
            throw new ApiError(409, 'already_owned', 'Your collection book already holds this.', {
              cosmeticId,
            });
          }
          const negated = Object.fromEntries(
            Object.entries(offer.price).map(([k, n]) => [k, -n!]),
          ) as Bundle;
          await changeMaterialsTx(tx, characterId, negated, now);
          await writeAudit(tx, {
            event: 'cosmetic.exchange',
            accountId,
            characterId,
            data: {
              cosmeticId,
              kind: exchangeCosmetic(offer).kind,
              gold: 0,
              materials: offer.price,
              heroLevel: hero.level,
            },
          });
          recordTelemetry(tx, now, [
            { metric: 'cosmetic.exchange', dims: [exchangeCosmetic(offer).kind, cosmeticId] },
            ...materialCounts('material.out', 'cosmetic_exchange', offer.price),
          ]);
          const after = await exchangeView(tx, accountId, characterId, now);
          return { ...after, bought: cosmeticId, paid: materialList(offer.price) };
        },
      );
    },
  );
}
