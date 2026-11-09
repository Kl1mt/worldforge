import { refreshAchievements } from '../achievements/award.js';
import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import {
  FORGE_RECIPES,
  ITEM_SLOT_KINDS,
  craftBlockers,
  craftItem,
  findForgeRecipe,
  recipeSlots,
  salvageYield,
  sumYields,
  type CraftBlocker,
  type ItemSlotKind,
  type MaterialId,
} from '@worldforge/game-core';
import { characters, itemInstances } from '../db/schema.js';
import { uuidv7 } from '../db/uuid.js';
import { writeAudit } from '../db/audit.js';
import { recordTelemetry } from '../telemetry/record.js';
import {
  disposalCounts,
  dropCounts,
  goldIn,
  goldOut,
  materialCounts,
} from '../telemetry/counts.js';
import { ApiError } from '../errors.js';
import type { ActivityOptions } from '../activity/settle.js';
import { characterView, type CharacterView } from '../characters/routes.js';
import {
  characterNotFound,
  characterParamsSchema,
  inventoryResponseSchema,
  inventoryView,
  itemSchema,
  itemView,
  loadItems,
  lockOwnedCharacter,
  type InventoryView,
  type ItemView,
  isPackItem,
} from '../inventory/routes.js';
import { changeMaterialsTx, loadMaterialBundle } from '../materials/store.js';
import { idempotentTransaction } from '../idempotency/index.js';
import { registerForgeWork } from './work.js';
import { itemBindingColumns } from '../inventory/columns.js';
import {
  changeGold,
  characterSchema,
  deleteItems,
  inventoryFull,
  itemIdsBodySchema,
  materialList,
  materialListSchema,
  pickInventoryItems,
  type MaterialStack,
} from '../economy/shared.js';

/**
 * The Forge (ticket 2.6, GDD §8): salvage items into materials and a little gold, and craft
 * tier-appropriate gear in a chosen slot from materials. Upgrades, rerolls and affix improvement
 * (ticket 3.4) live in `./work.ts`. Salvage and craft need an `Idempotency-Key`, lock the character row,
 * settle its activity first, and are audited.
 */

export interface RecipeView {
  recipeId: string;
  name: string;
  description: string;
  tier: number;
  level: number;
  gold: number;
  materials: MaterialStack[];
  /** Slot kinds the recipe can make for this character's class. */
  slots: ItemSlotKind[];
  /** Unmet requirements now; empty = craftable. */
  blockers: CraftBlocker[];
}

export interface ForgeResponse {
  characterId: string;
  gold: number;
  materials: MaterialStack[];
  recipes: RecipeView[];
  /** What salvaging each unequipped item gives. */
  salvage: { itemId: string; gold: number; materials: MaterialStack[] }[];
}

export interface SalvageResponse {
  character: CharacterView;
  salvaged: { gold: number; materials: MaterialStack[] };
  inventory: InventoryView;
  materials: MaterialStack[];
}

export interface CraftResponse {
  character: CharacterView;
  item: ItemView;
  inventory: InventoryView;
  materials: MaterialStack[];
}

const blockerSchema = {
  type: 'object',
  required: ['kind'],
  properties: {
    kind: { type: 'string' },
    required: { type: 'integer' },
    held: { type: 'integer' },
    materialId: { type: 'string' },
  },
} as const;

const forgeResponseSchema = {
  type: 'object',
  required: ['characterId', 'gold', 'materials', 'recipes', 'salvage'],
  properties: {
    characterId: { type: 'string' },
    gold: { type: 'integer' },
    materials: materialListSchema,
    recipes: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'recipeId',
          'name',
          'description',
          'tier',
          'level',
          'gold',
          'materials',
          'slots',
          'blockers',
        ],
        properties: {
          recipeId: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          tier: { type: 'integer' },
          level: { type: 'integer' },
          gold: { type: 'integer' },
          materials: materialListSchema,
          slots: { type: 'array', items: { type: 'string' } },
          blockers: { type: 'array', items: blockerSchema },
        },
      },
    },
    salvage: {
      type: 'array',
      items: {
        type: 'object',
        required: ['itemId', 'gold', 'materials'],
        properties: {
          itemId: { type: 'string' },
          gold: { type: 'integer' },
          materials: materialListSchema,
        },
      },
    },
  },
} as const;

const salvageResponseSchema = {
  type: 'object',
  required: ['character', 'salvaged', 'inventory', 'materials'],
  properties: {
    character: characterSchema,
    salvaged: {
      type: 'object',
      required: ['gold', 'materials'],
      properties: { gold: { type: 'integer' }, materials: materialListSchema },
    },
    inventory: inventoryResponseSchema,
    materials: materialListSchema,
  },
} as const;

const craftResponseSchema = {
  type: 'object',
  required: ['character', 'item', 'inventory', 'materials'],
  properties: {
    character: characterSchema,
    item: itemSchema,
    inventory: inventoryResponseSchema,
    materials: materialListSchema,
  },
} as const;

const craftBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['recipeId', 'slot'],
  properties: {
    recipeId: { type: 'string', enum: FORGE_RECIPES.map((r) => r.id) },
    slot: { type: 'string', enum: [...ITEM_SLOT_KINDS] },
  },
} as const;

function negate(bundle: Partial<Record<MaterialId, number>>): Partial<Record<MaterialId, number>> {
  return Object.fromEntries(Object.entries(bundle).map(([k, n]) => [k, -n!]));
}

export async function registerForge(
  app: FastifyInstance,
  activity: ActivityOptions,
): Promise<void> {
  const capacity = activity.rules.inventory.capacity;
  // Ticket 3.4: upgrades, rerolls and affix improvement (`./work.ts`).
  await registerForgeWork(app, activity);

  app.get<{ Params: { characterId: string } }>(
    '/characters/:characterId/forge',
    {
      preHandler: app.requireAccount,
      schema: { params: characterParamsSchema, response: { 200: forgeResponseSchema } },
    },
    async (request): Promise<ForgeResponse> => {
      const accountId = request.auth!.account.id;
      const { characterId } = request.params;
      const [character] = await app.db
        .select()
        .from(characters)
        .where(and(eq(characters.id, characterId), eq(characters.accountId, accountId)));
      if (!character) throw characterNotFound();
      const held = await loadMaterialBundle(app.db, characterId);
      const items = await app.db
        .select()
        .from(itemInstances)
        .where(eq(itemInstances.characterId, characterId))
        .orderBy(asc(itemInstances.createdAt), asc(itemInstances.id));
      return {
        characterId,
        gold: character.gold,
        materials: materialList(held),
        recipes: FORGE_RECIPES.map((r) => ({
          recipeId: r.id,
          name: r.name,
          description: r.description,
          tier: r.tier,
          level: r.level,
          gold: r.gold,
          materials: r.materials.map((m) => ({ materialId: m.materialId, quantity: m.quantity })),
          slots: recipeSlots(r, character.classId),
          blockers: craftBlockers(r, character, held),
        })),
        salvage: items.filter(isPackItem).map((i) => {
          const y = salvageYield(i);
          return { itemId: i.id, gold: y.gold, materials: materialList(y.materials) };
        }),
      };
    },
  );

  app.post<{ Params: { characterId: string }; Body: { itemIds: string[] } }>(
    '/characters/:characterId/forge/salvage',
    {
      preHandler: app.requireAccount,
      schema: {
        params: characterParamsSchema,
        body: itemIdsBodySchema,
        response: { 200: salvageResponseSchema },
      },
    },
    async (request, reply) => {
      const switches = await app.gameSettings.tradingSwitches();
      const accountId = request.auth!.account.id;
      const { characterId } = request.params;
      const { itemIds } = request.body;
      return idempotentTransaction(
        app,
        request,
        reply,
        { now: activity.now },
        async (tx): Promise<SalvageResponse> => {
          const locked = await lockOwnedCharacter(tx, accountId, characterId, activity);
          const now = activity.now();
          const items = await loadItems(tx, characterId);
          const salvaging = pickInventoryItems(items, itemIds, now);
          const yields = salvaging.map((i) => salvageYield(i));
          const total = sumYields(yields);
          await deleteItems(tx, characterId, itemIds);
          const character = await changeGold(tx, locked, total.gold, now);
          await changeMaterialsTx(tx, characterId, total.materials, now);
          await writeAudit(tx, {
            event: 'forge.salvage',
            accountId,
            characterId,
            data: {
              gold: total.gold,
              materials: total.materials,
              items: salvaging.map((i) => ({
                itemId: i.id,
                baseId: i.baseId,
                rarityId: i.rarityId,
                itemLevel: i.itemLevel,
                seed: i.seed,
              })),
            },
          });
          recordTelemetry(tx, now, [
            { metric: 'forge', dims: ['salvage'], events: salvaging.length },
            ...disposalCounts('item.salvaged', salvaging, (n) => yields[n]!.gold),
            ...goldIn('forge_salvage', '', total.gold),
            ...materialCounts('material.in', 'forge_salvage', total.materials),
          ]);
          const gone = new Set(itemIds);
          return {
            character: characterView(character),
            salvaged: { gold: total.gold, materials: materialList(total.materials) },
            inventory: inventoryView(
              character,
              items.filter((i) => !gone.has(i.id)),
              switches,
            ),
            materials: materialList(await loadMaterialBundle(tx, characterId)),
          };
        },
      );
    },
  );

  app.post<{ Params: { characterId: string }; Body: { recipeId: string; slot: ItemSlotKind } }>(
    '/characters/:characterId/forge/craft',
    {
      preHandler: app.requireAccount,
      schema: {
        params: characterParamsSchema,
        body: craftBodySchema,
        response: { 200: craftResponseSchema },
      },
    },
    async (request, reply) => {
      const switches = await app.gameSettings.tradingSwitches();
      const accountId = request.auth!.account.id;
      const { characterId } = request.params;
      const { recipeId, slot } = request.body;
      const recipe = findForgeRecipe(recipeId)!;
      return idempotentTransaction(
        app,
        request,
        reply,
        { now: activity.now },
        async (tx): Promise<CraftResponse> => {
          const locked = await lockOwnedCharacter(tx, accountId, characterId, activity);
          const now = activity.now();
          if (!recipeSlots(recipe, locked.classId).includes(slot)) {
            throw new ApiError(422, 'wrong_slot', 'This recipe makes nothing for that slot.', {
              slot,
            });
          }
          const held = await loadMaterialBundle(tx, characterId);
          const blockers = craftBlockers(recipe, locked, held);
          if (blockers.length > 0) {
            const first = blockers[0]!;
            const [code, message] =
              first.kind === 'level'
                ? ['recipe_locked', `You need level ${first.required} for this recipe.`]
                : blockers.some((b) => b.kind === 'material')
                  ? ['insufficient_materials', 'Not enough materials.']
                  : ['insufficient_gold', 'Not enough gold.'];
            throw new ApiError(422, code, message, { blockers });
          }
          const items = await loadItems(tx, characterId);
          if (items.filter(isPackItem).length >= capacity) {
            throw inventoryFull(capacity);
          }
          const crafted = craftItem({
            recipe,
            classId: locked.classId,
            level: locked.level,
            slot,
            seed: randomInt(0, 0xffffffff),
          });
          if (!crafted) throw new Error('unreachable: recipe slot checked above');

          const character = await changeGold(tx, locked, -recipe.gold, now);
          const cost = Object.fromEntries(recipe.materials.map((m) => [m.materialId, m.quantity]));
          await changeMaterialsTx(tx, characterId, negate(cost), now);
          const [row] = await tx
            .insert(itemInstances)
            .values({
              id: uuidv7(),
              characterId,
              ...crafted,
              // Ticket T.1: a crafted Epic or better is bind on equip (docs/TRADING.md).
              ...itemBindingColumns(crafted, 'forge', accountId),
              source: 'forge',
              createdAt: now,
            })
            .returning();
          const item = row!;
          await writeAudit(tx, {
            event: 'forge.craft',
            accountId,
            characterId,
            data: {
              recipeId,
              slot,
              gold: recipe.gold,
              materials: cost,
              itemId: item.id,
              baseId: item.baseId,
              rarityId: item.rarityId,
              itemLevel: item.itemLevel,
              seed: item.seed,
            },
          });
          await refreshAchievements(tx, character, ['maxRarity'], now); // ticket 4.2
          recordTelemetry(tx, now, [
            { metric: 'forge', dims: ['craft', recipeId] },
            ...dropCounts('craft', recipeId, [item]),
            ...goldOut('forge_craft', recipeId, recipe.gold),
            ...materialCounts('material.out', 'forge_craft', cost),
          ]);
          return {
            character: characterView(character),
            item: itemView(item, switches),
            inventory: inventoryView(character, [...items, item], switches),
            materials: materialList(await loadMaterialBundle(tx, characterId)),
          };
        },
      );
    },
  );
}
