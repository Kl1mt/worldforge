import type { FastifyInstance } from 'fastify';
import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  COSMETICS,
  equipProblem,
  findCosmetic,
  isDefaultCosmetic,
  type CosmeticSource,
} from '@worldforge/game-core';
import {
  characters,
  cosmeticDisplays,
  cosmeticUnlocks,
  heroAppearances,
  prestigeDisplays,
} from '../db/schema.js';
import { writeAudit } from '../db/audit.js';
import type { Executor } from '../db/types.js';
import { ApiError } from '../errors.js';
import { idempotentTransaction } from '../idempotency/index.js';
import { heroPalettes } from './display.js';

/**
 * Ticket 6.8 routes (docs/COSMETICS.md "API"):
 * - `GET /api/account/collection`: the collection book: every cosmetic with whether the account
 *   owns it, what it shows, and each hero's appearance.
 * - `POST /api/account/cosmetics/equip` `{ banner?, crest?, titleColour? }` (each an owned id of
 *   that kind, or null for the plain look): the account's banner, crest and title colour.
 * - `POST /api/characters/:characterId/appearance` `{ appearance }` (an owned appearance id,
 *   `appearance.default` or null): one hero's palette.
 * Both writes need an `Idempotency-Key`, accept only the account's own unlocks (`422 not_owned`,
 * `422 wrong_kind`, `422 unknown_cosmetic`; the foreign keys back it) and are audited
 * (`cosmetic.equip`). Titles are chosen in Season honours (`POST /api/account/prestige`).
 * Cosmetics are account-bound: no route trades, mails, sells or buys one.
 */

export interface CollectionEntry {
  id: string;
  kind: string;
  name: string;
  description: string;
  source: CosmeticSource;
  owned: boolean;
  /** The UTC day it was granted (null: not owned, or owned by default). */
  grantedOn: string | null;
}

export interface CollectionResponse {
  entries: CollectionEntry[];
  equipped: {
    banner: string | null;
    crest: string | null;
    titleColour: string | null;
    cosmeticTitle: string | null;
  };
  heroes: { id: string; name: string; classId: string; banner: string; palette: string | null }[];
}

const sourceSchema = {
  type: 'object',
  required: ['kind'],
  additionalProperties: true,
  properties: { kind: { type: 'string' } },
} as const;

const collectionSchema = {
  type: 'object',
  required: ['entries', 'equipped', 'heroes'],
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'kind', 'name', 'description', 'source', 'owned', 'grantedOn'],
        properties: {
          id: { type: 'string' },
          kind: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          source: sourceSchema,
          owned: { type: 'boolean' },
          grantedOn: { type: ['string', 'null'] },
        },
      },
    },
    equipped: {
      type: 'object',
      required: ['banner', 'crest', 'titleColour', 'cosmeticTitle'],
      properties: {
        banner: { type: ['string', 'null'] },
        crest: { type: ['string', 'null'] },
        titleColour: { type: ['string', 'null'] },
        cosmeticTitle: { type: ['string', 'null'] },
      },
    },
    heroes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'name', 'classId', 'banner', 'palette'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          classId: { type: 'string' },
          banner: { type: 'string' },
          palette: { type: ['string', 'null'] },
        },
      },
    },
  },
} as const;

const idSchema = { type: ['string', 'null'], minLength: 1, maxLength: 64 } as const;

export async function collectionView(
  executor: Executor,
  accountId: string,
): Promise<CollectionResponse> {
  const [unlocks, [display], [prestige], heroes] = await Promise.all([
    executor
      .select({ id: cosmeticUnlocks.cosmeticId, grantedAt: cosmeticUnlocks.grantedAt })
      .from(cosmeticUnlocks)
      .where(eq(cosmeticUnlocks.accountId, accountId)),
    executor.select().from(cosmeticDisplays).where(eq(cosmeticDisplays.accountId, accountId)),
    executor
      .select({ cosmeticTitle: prestigeDisplays.cosmeticTitle })
      .from(prestigeDisplays)
      .where(eq(prestigeDisplays.accountId, accountId)),
    executor
      .select({
        id: characters.id,
        name: characters.name,
        classId: characters.classId,
        appearance: characters.appearance,
      })
      .from(characters)
      .where(and(eq(characters.accountId, accountId), isNull(characters.deletedAt)))
      .orderBy(asc(characters.createdAt), asc(characters.id)),
  ]);
  const owned = new Map(unlocks.map((u) => [u.id, u.grantedAt]));
  const palettes = await heroPalettes(
    executor,
    heroes.map((h) => h.id),
  );
  return {
    entries: COSMETICS.map((c) => {
      const at = owned.get(c.id);
      return {
        id: c.id,
        kind: c.kind,
        name: c.name,
        description: c.description,
        source: c.source,
        owned: at !== undefined || c.source.kind === 'default',
        grantedOn: at ? at.toISOString().slice(0, 10) : null,
      };
    }),
    equipped: {
      banner: display?.banner ?? null,
      crest: display?.crest ?? null,
      titleColour: display?.titleColour ?? null,
      cosmeticTitle: prestige?.cosmeticTitle ?? null,
    },
    heroes: heroes.map((h) => ({
      id: h.id,
      name: h.name,
      classId: h.classId,
      banner: h.appearance.banner,
      palette: palettes.get(h.id) ?? null,
    })),
  };
}

async function ownedIds(executor: Executor, accountId: string): Promise<Set<string>> {
  const rows = await executor
    .select({ id: cosmeticUnlocks.cosmeticId })
    .from(cosmeticUnlocks)
    .where(eq(cosmeticUnlocks.accountId, accountId));
  return new Set(rows.map((r) => r.id));
}

const PROBLEM: Record<'unknown' | 'wrong_kind' | 'not_owned', [string, string]> = {
  unknown: ['unknown_cosmetic', 'There is no such keepsake.'],
  wrong_kind: ['wrong_kind', 'That keepsake does not go there.'],
  not_owned: ['not_owned', 'You have not earned that keepsake yet.'],
};

function refuse(field: string, problem: keyof typeof PROBLEM): never {
  const [code, message] = PROBLEM[problem];
  throw new ApiError(422, code, message, { fields: { [field]: problem } });
}

type AccountSlot = 'banner' | 'crest' | 'titleColour';
const ACCOUNT_SLOTS: readonly AccountSlot[] = ['banner', 'crest', 'titleColour'];

export async function registerCosmetics(
  app: FastifyInstance,
  options: { now: () => Date },
): Promise<void> {
  app.get(
    '/account/collection',
    { preHandler: app.requireAccount, schema: { response: { 200: collectionSchema } } },
    async (request) => collectionView(app.db, request.auth!.account.id),
  );

  app.post<{ Body: Partial<Record<AccountSlot, string | null>> }>(
    '/account/cosmetics/equip',
    {
      preHandler: app.requireAccount,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: { banner: idSchema, crest: idSchema, titleColour: idSchema },
        },
        response: { 200: collectionSchema },
      },
    },
    async (request, reply) => {
      const accountId = request.auth!.account.id;
      return idempotentTransaction(app, request, reply, { now: options.now }, async (tx) => {
        const now = options.now();
        const owned = await ownedIds(tx, accountId);
        const change: Partial<Record<AccountSlot, string | null>> = {};
        for (const slot of ACCOUNT_SLOTS) {
          if (!(slot in request.body)) continue;
          const id = request.body[slot] ?? null;
          const problem = equipProblem(slot, id, owned);
          if (problem) refuse(slot, problem);
          change[slot] = id;
        }
        await tx
          .insert(cosmeticDisplays)
          .values({ accountId, ...change, updatedAt: now })
          .onConflictDoUpdate({
            target: cosmeticDisplays.accountId,
            set: { ...change, updatedAt: now },
          });
        await writeAudit(tx, {
          event: 'cosmetic.equip',
          accountId,
          data: { scope: 'account', ...change },
        });
        return collectionView(tx, accountId);
      });
    },
  );

  app.post<{ Params: { characterId: string }; Body: { appearance: string | null } }>(
    '/characters/:characterId/appearance',
    {
      preHandler: app.requireAccount,
      schema: {
        params: {
          type: 'object',
          required: ['characterId'],
          properties: { characterId: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['appearance'],
          properties: { appearance: idSchema },
        },
        response: { 200: collectionSchema },
      },
    },
    async (request, reply) => {
      const accountId = request.auth!.account.id;
      const { characterId } = request.params;
      return idempotentTransaction(app, request, reply, { now: options.now }, async (tx) => {
        const now = options.now();
        const [hero] = await tx
          .select({ id: characters.id })
          .from(characters)
          .where(
            and(
              eq(characters.id, characterId),
              eq(characters.accountId, accountId),
              isNull(characters.deletedAt),
            ),
          );
        if (!hero) throw new ApiError(404, 'not_found', 'No such character.');
        const id = request.body.appearance;
        const problem = equipProblem('appearance', id, await ownedIds(tx, accountId));
        if (problem) refuse('appearance', problem);
        if (id === null || isDefaultCosmetic(id)) {
          await tx.delete(heroAppearances).where(eq(heroAppearances.characterId, characterId));
        } else {
          await tx
            .insert(heroAppearances)
            .values({ characterId, accountId, appearance: id, updatedAt: now })
            .onConflictDoUpdate({
              target: heroAppearances.characterId,
              set: { appearance: id, updatedAt: now },
            });
        }
        await writeAudit(tx, {
          event: 'cosmetic.equip',
          accountId,
          characterId,
          data: {
            scope: 'hero',
            appearance: id === null || isDefaultCosmetic(id) ? null : findCosmetic(id)!.id,
          },
        });
        return collectionView(tx, accountId);
      });
    },
  );
}
