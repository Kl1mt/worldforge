import { refreshAchievements } from '../achievements/award.js';
import type { FastifyInstance } from 'fastify';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  DEFAULT_FORGE_ACTION_CONFIG,
  affixTierRange,
  attemptUpgrade,
  awakeningCost,
  awakeningRefusal,
  shippedAwakening,
  type AwakeningRefusal,
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
import { heldValueOf } from '../shelf/held.js';
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
  /**
   * Ticket 6.5b: awakening (docs/AWAKENING.md). `refusal` says why the item can't (null when it
   * can); `cost` and `blockers` are the price and what is missing (held value excluded). Null on
   * an item already awakened.
   */
  awaken: {
    refusal: AwakeningRefusal | null;
    cost: ForgeCostView;
    blockers: ForgeBlocker[];
    effectStrength: number;
  } | null;
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
  | { action: 'reroll' | 'improve'; affixIndex: number; before: RolledAffix; after: RolledAffix }
  /** Ticket 6.5b: what the awakening strengthens (the item's own effect, or its set's bonuses). */
  | { action: 'awaken'; awakened: 'effect' | 'set'; effectStrength: number };

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

/** Ticket 6.5b: an awakening's price as a Forge cost (gold and the three materials). */
export function awakenForgeCost(row: Pick<ItemInstance, 'itemLevel'>): ForgeCost {
  const c = awakeningCost(row);
  return {
    gold: c.gold,
    materials: {
      tyrantsEmber: c.tyrantsEmber,
      gravewardenSeal: c.gravewardenSeal,
      soulShard: c.soulShard,
    },
  };
}

/** Ticket 6.5b: the row as the awakening rules read it. */
const asAwakenable = (row: ItemInstance) => ({
  baseId: row.baseId,
  rarityId: row.rarityId,
  itemLevel: row.itemLevel,
  affixes: row.affixes,
  upgradeLevel: row.upgradeLevel,
  effectId: row.effectId,
  effectRoll: row.effectRoll,
  mythicId: row.mythicId,
  setId: row.setId,
  variant: row.variant ?? null,
  awakening: row.awakening ?? null,
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
  /** Ticket 6.5b: gold and materials received in a trade and still on hold (not spendable). */
  onHold: { gold: number; materials: Held } = { gold: 0, materials: {} },
): ForgeItemView {
  const item = asForgeItem(row);
  const up = quoteUpgrade(item);
  const reroll = quoteReroll(item);
  const awakenCost = awakenForgeCost(row);
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
    awaken: row.awakening
      ? null
      : {
          refusal: awakeningRefusal(asAwakenable(row)),
          cost: costView(awakenCost),
          blockers: forgeCostBlockers(
            awakenCost,
            Math.max(0, gold - onHold.gold),
            spendableOf(held, onHold.materials),
          ),
          effectStrength: shippedAwakening().effectStrength,
        },
  };
}

/** Ticket 6.5b: holdings less what is on hold after a trade. */
function spendableOf(held: Held, onHold: Held): Held {
  const out: Held = { ...held };
  for (const [id, n] of Object.entries(onHold) as [MaterialId, number][]) {
    out[id] = Math.max(0, (out[id] ?? 0) - n);
  }
  return out;
}

/** Ticket 6.5b: why an item can't be awakened, in plain words. */
const AWAKEN_REFUSALS: Record<AwakeningRefusal, [number, string, string]> = {
  rarity: [422, 'not_awakenable', 'Only Legendary, Mythic and set items can be awakened.'],
  upgrade_level: [422, 'not_awakenable', 'Only items at +10 can be awakened.'],
  item_level: [422, 'not_awakenable', 'Only items of item level 23 or higher can be awakened.'],
  already_awakened: [422, 'already_awakened', 'This item is already awakened.'],
  nothing_to_awaken: [422, 'not_awakenable', 'This item has no effect or set bonus to awaken.'],
  unknown_base: [422, 'item_unforgeable', 'The smith does not know this item any more.'],
  affix_missing: [422, 'not_awakenable', 'This item can’t be awakened.'],
  affix_not_allowed: [422, 'not_awakenable', 'This item can’t be awakened.'],
  affix_present: [422, 'not_awakenable', 'This item can’t be awakened.'],
};

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

function awakenRefused(reason: AwakeningRefusal, itemId: string): ApiError {
  const [status, code, message] = AWAKEN_REFUSALS[reason];
  return new ApiError(status, code, message, { itemId, reason });
}

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
    'awaken',
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
    awaken: {
      type: ['object', 'null'],
      required: ['refusal', 'cost', 'blockers', 'effectStrength'],
      properties: {
        refusal: { type: ['string', 'null'] },
        cost: costSchema,
        blockers: blockersSchema,
        effectStrength: { type: 'number' },
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
        awakened: { type: 'string' },
        effectStrength: { type: 'number' },
      },
    },
    paid: costSchema,
    inventory: inventoryResponseSchema,
    materials: materialListSchema,
  },
} as const;

type Action = 'upgrade' | 'reroll' | 'improve' | 'awaken';

interface Applied {
  /** The columns to write besides the counter. */
  patch: Partial<
    Pick<
      ItemInstance,
      | 'upgradeLevel'
      | 'upgradePity'
      | 'rerollCount'
      | 'affixes'
      | 'awakening'
      | 'awakenedAt'
      | 'locked'
    >
  >;
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
        .where(
          and(
            eq(characters.id, characterId),
            eq(characters.accountId, accountId),
            isNull(characters.deletedAt),
          ),
        );
      if (!character) throw characterNotFound();
      const [row] = await db
        .select()
        .from(itemInstances)
        .where(and(eq(itemInstances.id, itemId), eq(itemInstances.characterId, characterId)));
      if (!row) throw itemNotFound();
      assertItemInReach(row);
      const held = await loadMaterialBundle(db, characterId);
      const onHold = await heldValueOf(db, characterId, activity.now());
      return {
        characterId,
        gold: character.gold,
        materials: materialList(held),
        item: itemView(row, switches),
        forge: forgeItemView(row, character.classId, character.gold, held, onHold),
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
            // Ticket 6.5b: the awakening's check leaves out value on hold after a trade, so it
            // names what is missing before anything is paid (the spend itself refuses it anyway).
            const onHold =
              name === 'awaken'
                ? await heldValueOf(tx, characterId, now)
                : { gold: 0, materials: {} };
            const blockers = forgeCostBlockers(
              cost,
              Math.max(0, locked.gold - onHold.gold),
              spendableOf(held, onHold.materials),
            );
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
            // Ticket 6.5c: the awakening's lock is on record (manual locks aren't audited).
            if (name === 'awaken' && !row.locked) {
              await writeAudit(tx, {
                event: 'item.lock',
                accountId,
                characterId,
                data: { itemId: row.id, locked: true, via: 'awaken' },
              });
            }
            // Ticket 4.2: an upgrade can earn the +N achievements.
            if (name === 'upgrade') {
              await refreshAchievements(tx, character, ['maxUpgradeLevel'], now);
            }
            // Ticket 6.5b: the item's awakening is the hero's achievement-free endgame mark; no
            // achievement reads it (yet).
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
            const onHoldAfter = await heldValueOf(tx, characterId, now);
            return {
              character: characterView(character),
              item: itemView(updated, switches),
              forge: forgeItemView(
                updated,
                character.classId,
                character.gold,
                heldAfter,
                onHoldAfter,
              ),
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

  // Ticket 6.5b: Item Awakening (docs/AWAKENING.md). No random draw: the refusals and the price
  // are checked under the item lock before paying, and the write is guarded by the forge counter
  // like every Forge action (a retry with the same key replays the stored response; a second key
  // finds the item awakened). Binds the item (any Forge work does), so it never trades.
  action<{ itemId: string }>('awaken', 'awaken', upgradeBodySchema, (row) => {
    const refusal = awakeningRefusal(asAwakenable(row));
    if (refusal) throw awakenRefused(refusal, row.id);
    const awakening = shippedAwakening();
    const awakened = row.setId ? 'set' : 'effect';
    return {
      cost: awakenForgeCost(row),
      apply: () => ({
        // Ticket 6.5c (owner decision): awakening locks the item, so a sell, salvage or discard
        // can't throw the work away by accident. The player can unlock it like any lock.
        patch: { awakening, awakenedAt: activity.now(), locked: true },
        outcome: { action: 'awaken', awakened, effectStrength: awakening.effectStrength },
        audit: {
          awakening,
          awakened,
          effectId: row.effectId ?? null,
          setId: row.setId ?? null,
          variant: row.variant ?? null,
          upgradeLevel: row.upgradeLevel,
        },
        telemetry: [row.rarityId, awakened],
      }),
    };
  });
}
