import { refreshAchievements } from '../achievements/award.js';
import type { FastifyInstance } from 'fastify';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  DEFAULT_FORGE_ACTION_CONFIG,
  affixTierRange,
  attemptUpgrade,
  createRng,
  forgeCostBlockers,
  improveAffix,
  quoteImprove,
  quoteReroll,
  quoteUpgrade,
  rerollAffix,
  rerollOptions,
  type ClassId,
  type ForgeBlocker,
  type ForgeCost,
  type ForgeItem,
  type ForgeRefusal,
  type MaterialId,
  type RolledAffix,
} from '@worldforge/game-core';
import { characters, itemInstances, type Character, type ItemInstance } from '../db/schema.js';
import type { Database, Transaction } from '../db/types.js';
import { writeAudit } from '../db/audit.js';
import { recordTelemetry } from '../telemetry/record.js';
import { goldOut, materialCounts } from '../telemetry/counts.js';
import { ApiError } from '../errors.js';
import type { ActivityOptions } from '../activity/settle.js';
import { characterView, type CharacterView } from '../characters/routes.js';
import {
  characterNotFound,
  inventoryResponseSchema,
  inventoryView,
  itemSchema,
  itemView,
  lockOwnedCharacter,
  type InventoryView,
  type ItemView,
  assertItemInReach,
  assertItemNotHeld,
} from '../inventory/routes.js';
import { changeMaterialsTx, loadMaterialBundle } from '../materials/store.js';
import { idempotentTransaction } from '../idempotency/index.js';
import {
  changeGold,
  characterSchema,
  materialList,
  materialListSchema,
  type MaterialStack,
} from '../economy/shared.js';

/**
 * The Forge's improvement paths (ticket 3.4, GDD §8.1, docs/ECONOMY.md): item upgrades, affix
 * reroll and affix improvement. Rules and numbers are game-core's (`economy/forgeActions.ts`).
 *
 * No save-scumming: every random outcome comes from the item's own server-side stream,
 * ``createRng(`${forge_secret}:${forge_counter}`)``, and the transaction that applies the result
 * advances `forge_counter` by one. So an outcome is fixed by the item's state before the action: a
 * retry, a replay (same `Idempotency-Key`: the stored response) or a racing request (serialised by
 * the locks, it sees the advanced counter) can never draw it again. `forge_secret` never leaves
 * the server, so the player cannot predict a draw either. Lock order as everywhere: claim the
 * idempotency key, lock the character row (settling its activity first), then the item row.
 */

/** Gold and materials of a forge action, as the API lists them. */
export interface ForgeCostView {
  gold: number;
  materials: MaterialStack[];
}

/** One affix's improvement state (ticket 3.4). */
export interface ImproveView {
  index: number;
  affixId: string;
  tier: number;
  value: number;
  /** The tier's range; improvements never leave it. */
  min: number;
  max: number;
  improvements: number;
  maxImprovements: number;
  /** Why it can't be improved, or null. */
  refusal: 'improvement_cap' | 'affix_at_max' | 'unknown_affix' | null;
  /** What one improvement can reach, and its cost (null when refused). */
  next: { low: number; high: number } | null;
  cost: ForgeCostView | null;
  blockers: ForgeBlocker[];
}

/** What a reroll of one affix can produce (tier ranges at the item's level and rarity). */
export interface RerollOptionView {
  affixId: string;
  tiers: { tier: number; min: number; max: number }[];
}

/** The Forge's view of one item: its counters, the next upgrade and the affix options. */
export interface ForgeItemView {
  itemId: string;
  upgradeLevel: number;
  upgradePity: number;
  rerollCount: number;
  /** Null at +10 (or for an item whose base left the content). */
  upgrade: {
    fromLevel: number;
    toLevel: number;
    chance: number;
    pity: number;
    pityThreshold: number;
    guaranteed: boolean;
    bonusNow: number;
    bonusNext: number;
    cost: ForgeCostView;
    blockers: ForgeBlocker[];
  } | null;
  reroll: {
    cost: ForgeCostView;
    blockers: ForgeBlocker[];
    /** Per affix (by index): the affixes a reroll can put there. */
    options: RerollOptionView[][];
  } | null;
  improve: ImproveView[];
}

export interface ForgeItemResponse {
  characterId: string;
  gold: number;
  materials: MaterialStack[];
  item: ItemView;
  forge: ForgeItemView;
}

export type ForgeOutcome =
  | {
      action: 'upgrade';
      success: boolean;
      /** The pity (or a certain step) decided the attempt. */
      guaranteed: boolean;
      fromLevel: number;
      upgradeLevel: number;
      upgradePity: number;
    }
  | { action: 'reroll' | 'improve'; affixIndex: number; before: RolledAffix; after: RolledAffix };

export interface ForgeActionResponse {
  character: CharacterView;
  item: ItemView;
  forge: ForgeItemView;
  outcome: ForgeOutcome;
  paid: ForgeCostView;
  inventory: InventoryView;
  materials: MaterialStack[];
}

type Held = Partial<Record<MaterialId, number>>;

const costView = (c: ForgeCost): ForgeCostView => ({
  gold: c.gold,
  materials: materialList(c.materials),
});

const asForgeItem = (row: ItemInstance): ForgeItem => ({
  baseId: row.baseId,
  rarityId: row.rarityId,
  itemLevel: row.itemLevel,
  affixes: row.affixes,
  upgradeLevel: row.upgradeLevel,
  upgradePity: row.upgradePity,
  rerollCount: row.rerollCount,
});

export function forgeItemView(
  row: ItemInstance,
  classId: ClassId,
  gold: number,
  held: Held,
): ForgeItemView {
  const item = asForgeItem(row);
  const up = quoteUpgrade(item);
  const reroll = quoteReroll(item);
  return {
    itemId: row.id,
    upgradeLevel: row.upgradeLevel,
    upgradePity: row.upgradePity,
    rerollCount: row.rerollCount,
    upgrade: up.ok
      ? {
          fromLevel: up.value.fromLevel,
          toLevel: up.value.toLevel,
          chance: up.value.chance,
          pity: up.value.pity,
          pityThreshold: up.value.pityThreshold,
          guaranteed: up.value.guaranteed,
          bonusNow: up.value.bonusNow,
          bonusNext: up.value.bonusNext,
          cost: costView(up.value.cost),
          blockers: forgeCostBlockers(up.value.cost, gold, held),
        }
      : null,
    reroll:
      reroll.ok && item.affixes.length > 0
        ? {
            cost: costView(reroll.value),
            blockers: forgeCostBlockers(reroll.value, gold, held),
            options: item.affixes.map((_, index) => {
              const o = rerollOptions(item, index, classId);
              return o.ok
                ? o.value.map((x) => ({
                    affixId: x.affix.id,
                    tiers: x.tiers.map((t) => ({ tier: t.tier, min: t.min, max: t.max })),
                  }))
                : [];
            }),
          }
        : null,
    improve: item.affixes.map((rolled, index): ImproveView => {
      const q = quoteImprove(item, index);
      if (q.ok) {
        return {
          index,
          affixId: rolled.affixId,
          tier: rolled.tier,
          value: rolled.value,
          min: q.value.min,
          max: q.value.max,
          improvements: q.value.improvements,
          maxImprovements: q.value.maxImprovements,
          refusal: null,
          next: q.value.next,
          cost: costView(q.value.cost),
          blockers: forgeCostBlockers(q.value.cost, gold, held),
        };
      }
      const range = affixTierRange(rolled) ?? { min: rolled.value, max: rolled.value };
      return {
        index,
        affixId: rolled.affixId,
        tier: rolled.tier,
        value: rolled.value,
        ...range,
        improvements: rolled.improvements ?? 0,
        maxImprovements: DEFAULT_FORGE_ACTION_CONFIG.improve.maxImprovements,
        refusal:
          q.reason === 'improvement_cap' || q.reason === 'affix_at_max'
            ? q.reason
            : 'unknown_affix',
        next: null,
        cost: null,
        blockers: [],
      };
    }),
  };
}

const REFUSALS: Record<ForgeRefusal, [number, string, string]> = {
  unknown_base: [422, 'item_unforgeable', 'The smith does not know this item any more.'],
  max_upgrade: [422, 'max_upgrade', 'This item is already at +10.'],
  no_such_affix: [422, 'no_such_affix', 'The item has no such affix.'],
  unknown_affix: [422, 'item_unforgeable', 'The smith does not know this affix any more.'],
  improvement_cap: [422, 'improvement_cap', 'This affix has been improved as far as it goes.'],
  affix_at_max: [422, 'affix_at_max', 'This affix is already at its tier’s maximum.'],
};

function refused(reason: ForgeRefusal, details?: Record<string, unknown>): ApiError {
  const [status, code, message] = REFUSALS[reason];
  return new ApiError(status, code, message, details);
}

function cannotPay(blockers: ForgeBlocker[]): ApiError {
  return blockers.some((b) => b.kind === 'material')
    ? new ApiError(422, 'insufficient_materials', 'Not enough materials.', { blockers })
    : new ApiError(422, 'insufficient_gold', 'Not enough gold.', { blockers });
}

const itemNotFound = () => new ApiError(404, 'not_found', 'No such item.');

/** Locks the item row (after the character lock). `404` for another character's or no item. */
async function lockItem(
  tx: Transaction,
  characterId: string,
  itemId: string,
): Promise<ItemInstance> {
  const [row] = await tx
    .select()
    .from(itemInstances)
    .where(and(eq(itemInstances.id, itemId), eq(itemInstances.characterId, characterId)))
    .for('update');
  if (!row) throw itemNotFound();
  // Ticket 4.7: the Forge works on worn and packed items, not on stored or shelved ones (T.3).
  assertItemInReach(row);
  return row;
}

const negate = (bundle: Held): Held =>
  Object.fromEntries(Object.entries(bundle).map(([k, n]) => [k, -n!]));

const forgeItemParamsSchema = {
  type: 'object',
  required: ['characterId', 'itemId'],
  properties: {
    characterId: { type: 'string', format: 'uuid' },
    itemId: { type: 'string', format: 'uuid' },
  },
} as const;

const characterParamsSchema = {
  type: 'object',
  required: ['characterId'],
  properties: { characterId: { type: 'string', format: 'uuid' } },
} as const;

const upgradeBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['itemId'],
  properties: { itemId: { type: 'string', format: 'uuid' } },
} as const;

const affixBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['itemId', 'affixIndex'],
  properties: {
    itemId: { type: 'string', format: 'uuid' },
    affixIndex: { type: 'integer', minimum: 0, maximum: 15 },
  },
} as const;

const costSchema = {
  type: 'object',
  required: ['gold', 'materials'],
  properties: { gold: { type: 'integer' }, materials: materialListSchema },
} as const;

const blockersSchema = {
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
} as const;

const affixSchema = itemSchema.properties.affixes.items;

const forgeItemSchema = {
  type: 'object',
  required: [
    'itemId',
    'upgradeLevel',
    'upgradePity',
    'rerollCount',
    'upgrade',
    'reroll',
    'improve',
  ],
  properties: {
    itemId: { type: 'string' },
    upgradeLevel: { type: 'integer' },
    upgradePity: { type: 'integer' },
    rerollCount: { type: 'integer' },
    upgrade: {
      type: ['object', 'null'],
      required: [
        'fromLevel',
        'toLevel',
        'chance',
        'pity',
        'pityThreshold',
        'guaranteed',
        'bonusNow',
        'bonusNext',
        'cost',
        'blockers',
      ],
      properties: {
        fromLevel: { type: 'integer' },
        toLevel: { type: 'integer' },
        chance: { type: 'number' },
        pity: { type: 'integer' },
        pityThreshold: { type: 'integer' },
        guaranteed: { type: 'boolean' },
        bonusNow: { type: 'number' },
        bonusNext: { type: 'number' },
        cost: costSchema,
        blockers: blockersSchema,
      },
    },
    reroll: {
      type: ['object', 'null'],
      required: ['cost', 'blockers', 'options'],
      properties: {
        cost: costSchema,
        blockers: blockersSchema,
        options: {
          type: 'array',
          items: {
            type: 'array',
            items: {
              type: 'object',
              required: ['affixId', 'tiers'],
              properties: {
                affixId: { type: 'string' },
                tiers: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['tier', 'min', 'max'],
                    properties: {
                      tier: { type: 'integer' },
                      min: { type: 'number' },
                      max: { type: 'number' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    improve: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'index',
          'affixId',
          'tier',
          'value',
          'min',
          'max',
          'improvements',
          'maxImprovements',
          'refusal',
          'next',
          'cost',
          'blockers',
        ],
        properties: {
          index: { type: 'integer' },
          affixId: { type: 'string' },
          tier: { type: 'integer' },
          value: { type: 'number' },
          min: { type: 'number' },
          max: { type: 'number' },
          improvements: { type: 'integer' },
          maxImprovements: { type: 'integer' },
          refusal: { type: ['string', 'null'] },
          next: {
            type: ['object', 'null'],
            required: ['low', 'high'],
            properties: { low: { type: 'number' }, high: { type: 'number' } },
          },
          cost: { anyOf: [costSchema, { type: 'null' }] },
          blockers: blockersSchema,
        },
      },
    },
  },
} as const;

const forgeItemResponseSchema = {
  type: 'object',
  required: ['characterId', 'gold', 'materials', 'item', 'forge'],
  properties: {
    characterId: { type: 'string' },
    gold: { type: 'integer' },
    materials: materialListSchema,
    item: itemSchema,
    forge: forgeItemSchema,
  },
} as const;

const forgeActionResponseSchema = {
  type: 'object',
  required: ['character', 'item', 'forge', 'outcome', 'paid', 'inventory', 'materials'],
  properties: {
    character: characterSchema,
    item: itemSchema,
    forge: forgeItemSchema,
    outcome: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string' },
        success: { type: 'boolean' },
        guaranteed: { type: 'boolean' },
        fromLevel: { type: 'integer' },
        upgradeLevel: { type: 'integer' },
        upgradePity: { type: 'integer' },
        affixIndex: { type: 'integer' },
        before: affixSchema,
        after: affixSchema,
      },
    },
    paid: costSchema,
    inventory: inventoryResponseSchema,
    materials: materialListSchema,
  },
} as const;

type Action = 'upgrade' | 'reroll' | 'improve';

interface Applied {
  /** The columns to write besides the counter. */
  patch: Partial<Pick<ItemInstance, 'upgradeLevel' | 'upgradePity' | 'rerollCount' | 'affixes'>>;
  outcome: ForgeOutcome;
  /** Extra audit data (the roll, the affixes). */
  audit: Record<string, unknown>;
  /** Telemetry dimensions after the action (`forge` metric, docs/TELEMETRY.md). */
  telemetry: [detail: string, outcome: string];
}

export async function registerForgeWork(
  app: FastifyInstance,
  activity: ActivityOptions,
): Promise<void> {
  app.get<{ Params: { characterId: string; itemId: string } }>(
    '/characters/:characterId/forge/items/:itemId',
    {
      preHandler: app.requireAccount,
      schema: { params: forgeItemParamsSchema, response: { 200: forgeItemResponseSchema } },
    },
    async (request): Promise<ForgeItemResponse> => {
      const switches = await app.gameSettings.tradingSwitches();
      const accountId = request.auth!.account.id;
      const { characterId, itemId } = request.params;
      const db: Database = app.db;
      const [character] = await db
        .select()
        .from(characters)
        .where(and(eq(characters.id, characterId), eq(characters.accountId, accountId)));
      if (!character) throw characterNotFound();
      const [row] = await db
        .select()
        .from(itemInstances)
        .where(and(eq(itemInstances.id, itemId), eq(itemInstances.characterId, characterId)));
      if (!row) throw itemNotFound();
      assertItemInReach(row);
      const held = await loadMaterialBundle(db, characterId);
      return {
        characterId,
        gold: character.gold,
        materials: materialList(held),
        item: itemView(row, switches),
        forge: forgeItemView(row, character.classId, character.gold, held),
      };
    },
  );

  /**
   * Shared body of the three actions: lock, quote (refusals and costs checked before anything is
   * paid or drawn), pay, draw from the item's stream, apply, advance the counter, audit.
   */
  function action<B extends { itemId: string }>(
    name: Action,
    path: string,
    bodySchema: object,
    run: (
      row: ItemInstance,
      character: Character,
      body: B,
    ) => {
      cost: ForgeCost;
      apply: (rng: ReturnType<typeof createRng>) => Applied;
    },
  ): void {
    app.post<{ Params: { characterId: string }; Body: B }>(
      `/characters/:characterId/forge/${path}`,
      {
        preHandler: app.requireAccount,
        schema: {
          params: characterParamsSchema,
          body: bodySchema,
          response: { 200: forgeActionResponseSchema },
        },
      },
      async (request, reply) => {
        const switches = await app.gameSettings.tradingSwitches();
        const accountId = request.auth!.account.id;
        const { characterId } = request.params;
        const body = request.body as B;
        return idempotentTransaction(
          app,
          request,
          reply,
          { now: activity.now },
          async (tx): Promise<ForgeActionResponse> => {
            const locked = await lockOwnedCharacter(tx, accountId, characterId, activity);
            const row = await lockItem(tx, characterId, body.itemId);
            const now = activity.now();
            // Ticket T.5: an item received in a trade is never forged while held.
            assertItemNotHeld(row, now);
            const { cost, apply } = run(row, locked, body);
            const held = await loadMaterialBundle(tx, characterId);
            const blockers = forgeCostBlockers(cost, locked.gold, held);
            if (blockers.length > 0) throw cannotPay(blockers);

            // Pay first: the result is revealed only after paying, and both commit together.
            const character = await changeGold(tx, locked, -cost.gold, now);
            await changeMaterialsTx(tx, characterId, negate(cost.materials), now);
            const counter = row.forgeCounter;
            const applied = apply(createRng(`${row.forgeSecret}:${counter}`));
            const [updated] = await tx
              .update(itemInstances)
              .set({
                ...applied.patch,
                forgeCounter: sql`${itemInstances.forgeCounter} + 1`,
                // Ticket T.1: any Forge work binds the item to the account (docs/TRADING.md).
                binding: 'account',
                boundAccountId: sql`coalesce(${itemInstances.boundAccountId}, ${accountId}::uuid)`,
              })
              .where(and(eq(itemInstances.id, row.id), eq(itemInstances.forgeCounter, counter)))
              .returning();
            // Unreachable under the item lock; the counter guard is the backstop.
            if (!updated) throw new Error('forge counter moved under the item lock');
            await writeAudit(tx, {
              event: `forge.${name}`,
              accountId,
              characterId,
              data: {
                itemId: row.id,
                baseId: row.baseId,
                rarityId: row.rarityId,
                itemLevel: row.itemLevel,
                forgeCounter: counter,
                gold: cost.gold,
                materials: cost.materials,
                ...applied.audit,
              },
            });
            // Ticket 4.2: an upgrade can earn the +N achievements.
            if (name === 'upgrade') {
              await refreshAchievements(tx, character, ['maxUpgradeLevel'], now);
            }
            recordTelemetry(tx, now, [
              { metric: 'forge', dims: [name, ...applied.telemetry] },
              ...goldOut(`forge_${name}`, row.rarityId, cost.gold),
              ...materialCounts('material.out', `forge_${name}`, cost.materials),
            ]);
            const items = await tx
              .select()
              .from(itemInstances)
              .where(eq(itemInstances.characterId, characterId))
              .orderBy(asc(itemInstances.createdAt), asc(itemInstances.id));
            const heldAfter = await loadMaterialBundle(tx, characterId);
            return {
              character: characterView(character),
              item: itemView(updated, switches),
              forge: forgeItemView(updated, character.classId, character.gold, heldAfter),
              outcome: applied.outcome,
              paid: costView(cost),
              inventory: inventoryView(character, items, switches),
              materials: materialList(heldAfter),
            };
          },
        );
      },
    );
  }

  action<{ itemId: string }>('upgrade', 'upgrade', upgradeBodySchema, (row) => {
    const item = asForgeItem(row);
    const quote = quoteUpgrade(item);
    if (!quote.ok) throw refused(quote.reason, { itemId: row.id });
    return {
      cost: quote.value.cost,
      apply: (rng) => {
        const out = attemptUpgrade(item, rng);
        return {
          patch: { upgradeLevel: out.upgradeLevel, upgradePity: out.upgradePity },
          outcome: {
            action: 'upgrade',
            success: out.success,
            guaranteed: out.guaranteed,
            fromLevel: item.upgradeLevel,
            upgradeLevel: out.upgradeLevel,
            upgradePity: out.upgradePity,
          },
          audit: {
            fromLevel: item.upgradeLevel,
            toLevel: out.upgradeLevel,
            success: out.success,
            guaranteed: out.guaranteed,
            pityBefore: item.upgradePity,
            pityAfter: out.upgradePity,
            roll: out.roll,
          },
          // The level tried for, and how it went (a pity success is `guaranteed`).
          telemetry: [
            `+${item.upgradeLevel + 1}`,
            out.success ? (out.guaranteed ? 'guaranteed' : 'success') : 'failure',
          ],
        };
      },
    };
  });

  action<{ itemId: string; affixIndex: number }>(
    'reroll',
    'reroll',
    affixBodySchema,
    (row, character, { affixIndex }) => {
      const item = asForgeItem(row);
      const options = rerollOptions(item, affixIndex, character.classId);
      if (!options.ok) throw refused(options.reason, { itemId: row.id, affixIndex });
      const quote = quoteReroll(item);
      if (!quote.ok) throw refused(quote.reason, { itemId: row.id });
      return {
        cost: quote.value,
        apply: (rng) => {
          const out = rerollAffix(item, affixIndex, character.classId, rng);
          if (!out.ok)
            throw new Error(`unreachable: reroll refused after the check (${out.reason})`);
          const before = item.affixes[affixIndex]!;
          const after = out.value[affixIndex]!;
          return {
            patch: { affixes: out.value, rerollCount: item.rerollCount + 1 },
            outcome: { action: 'reroll', affixIndex, before, after },
            audit: { affixIndex, before, after, rerollCount: item.rerollCount + 1 },
            telemetry: [row.rarityId, after.affixId],
          };
        },
      };
    },
  );

  action<{ itemId: string; affixIndex: number }>(
    'improve',
    'improve',
    affixBodySchema,
    (row, _character, { affixIndex }) => {
      const item = asForgeItem(row);
      const quote = quoteImprove(item, affixIndex);
      if (!quote.ok) throw refused(quote.reason, { itemId: row.id, affixIndex });
      return {
        cost: quote.value.cost,
        apply: (rng) => {
          const out = improveAffix(item, affixIndex, rng);
          if (!out.ok)
            throw new Error(`unreachable: improve refused after the check (${out.reason})`);
          const before = item.affixes[affixIndex]!;
          const after = out.value[affixIndex]!;
          return {
            patch: { affixes: out.value },
            outcome: { action: 'improve', affixIndex, before, after },
            audit: { affixIndex, before, after },
            telemetry: [row.rarityId, after.affixId],
          };
        },
      };
    },
  );
}
