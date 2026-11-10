import type { FastifyInstance } from 'fastify';
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import {
  DEFAULT_SHELF_CONFIG,
  MATERIAL_IDS,
  TRADE_KINDS,
  WAREHOUSE_UNLOCK,
  bundleTotal,
  isMaterialId,
  isUnlocked,
  planShelfDeposit,
  planShelfWithdraw,
  type MaterialBundle,
  type MaterialId,
  type ShelfDirection,
  type ShelfMove,
  type ShelfRefusal,
  type TradeKind,
  type TradingSwitches,
} from '@worldforge/game-core';
import {
  accountShelfMaterials,
  accounts,
  characters,
  itemInstances,
  type Character,
  type ItemInstance,
} from '../db/schema.js';
import type { Executor, Transaction } from '../db/types.js';
import { withTransaction } from '../db/transaction.js';
import { writeAudit } from '../db/audit.js';
import { ApiError } from '../errors.js';
import type { ActivityOptions } from '../activity/settle.js';
import { characterSchema, characterView, type CharacterView } from '../characters/routes.js';
import { changeGold, materialList, materialListSchema } from '../economy/shared.js';
import type { MaterialStack } from '../economy/shared.js';
import { idempotentTransaction } from '../idempotency/index.js';
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
} from '../inventory/routes.js';
import { isPackItem, itemInOffer } from '../inventory/location.js';
import { changeMaterialsTx, loadMaterialBundle } from '../materials/store.js';
import { loadTradingSettings } from '../settings/store.js';
import { recordTelemetry } from '../telemetry/record.js';
import { warehouseClosed } from '../warehouse/routes.js';
import { heldValueOf } from './held.js';

/**
 * The shared account shelf (ticket T.3, docs/TRADING.md "3. The shared account shelf",
 * docs/WAREHOUSE.md "Account shelf"): the Warehouse's second tab. It moves items, materials and gold
 * between the heroes of one account.
 *
 * - **Where things are.** An item on the shelf is the same `item_instances` row with `on_shelf` and
 *   `shelf_account_id` (4.7's marker, not a copy); its `character_id` stays the hero who put it
 *   there until another hero takes it out. Gold sits in `accounts.shelf_gold`, materials in
 *   `account_shelf_materials`; both belong to the account.
 * - **Gate.** Every route reads the Warehouse's world flag first (`409 warehouse_closed`, like 4.7).
 *   The flag is never removed and nothing can be deposited before it is set, so whenever the shelf
 *   holds anything the building is open and a withdrawal is possible.
 * - **Switches** (T.2 "Shelf: …"), read from the table inside the transaction: a kind that is off
 *   refuses deposits (`409 shelf_paused`). **Withdrawals never read a switch.**
 * - **Locks**, in this order: the account's shelf lock (`shelf:<accountId>`, a transaction-scoped
 *   advisory lock: every shelf write of the account queues here, and nothing else takes it), the
 *   hero (settling its activity first, like every inventory change), the hero's items, then the
 *   shelf's item rows in the same `(created_at, id)` order as `loadItems`, so a shelf move and an
 *   inventory action of another hero lock shared rows in one order.
 * - **Value route:** `Idempotency-Key` required (gold and materials move). All or nothing; every
 *   `update` re-checks the state it planned from, and a row count mismatch rolls the move back.
 * - **No caps, no binding, no trade:** a move changes no binding and counts toward nothing.
 *   Mutes and (from T.4) trade restrictions don't stop it: it reaches no one.
 */

const shelfLock = (accountId: string) => `shelf:${accountId}`;

export interface ShelfItemView extends ItemView {
  /** The hero who put the item on the shelf (one of the account's own heroes). */
  placedBy: { characterId: string; name: string };
}

export interface ShelfView {
  characterId: string;
  capacity: number;
  /** Items on the shelf, oldest first. */
  items: ShelfItemView[];
  gold: number;
  materials: MaterialStack[];
  /** Per kind: whether deposits are open (the "Shelf: …" switches). Withdrawals always are. */
  deposits: Record<TradeKind, boolean>;
  /** The hero this view was asked for. */
  hero: { gold: number; materials: MaterialStack[]; pack: { count: number; capacity: number } };
}

export interface ShelfMoveResponse {
  shelf: ShelfView;
  inventory: InventoryView;
  character: CharacterView;
  moved: { items: number; gold: number; materials: MaterialStack[] };
}

const kindsSchema = {
  type: 'object',
  required: [...TRADE_KINDS],
  properties: Object.fromEntries(TRADE_KINDS.map((k) => [k, { type: 'boolean' }])),
} as const;

const shelfItemSchema = {
  ...itemSchema,
  required: [...itemSchema.required, 'placedBy'],
  properties: {
    ...itemSchema.properties,
    placedBy: {
      type: 'object',
      required: ['characterId', 'name'],
      properties: { characterId: { type: 'string' }, name: { type: 'string' } },
    },
  },
} as const;

const shelfSchema = {
  type: 'object',
  required: ['characterId', 'capacity', 'items', 'gold', 'materials', 'deposits', 'hero'],
  properties: {
    characterId: { type: 'string' },
    capacity: { type: 'integer' },
    items: { type: 'array', items: shelfItemSchema },
    gold: { type: 'integer' },
    materials: materialListSchema,
    deposits: kindsSchema,
    hero: {
      type: 'object',
      required: ['gold', 'materials', 'pack'],
      properties: {
        gold: { type: 'integer' },
        materials: materialListSchema,
        pack: {
          type: 'object',
          required: ['count', 'capacity'],
          properties: { count: { type: 'integer' }, capacity: { type: 'integer' } },
        },
      },
    },
  },
} as const;

const moveResponseSchema = {
  type: 'object',
  required: ['shelf', 'inventory', 'character', 'moved'],
  properties: {
    shelf: shelfSchema,
    inventory: inventoryResponseSchema,
    character: characterSchema,
    moved: {
      type: 'object',
      required: ['items', 'gold', 'materials'],
      properties: {
        items: { type: 'integer' },
        gold: { type: 'integer' },
        materials: materialListSchema,
      },
    },
  },
} as const;

/** One request may name items, gold and materials; at least one must be non-empty. */
const moveBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    itemIds: {
      type: 'array',
      maxItems: DEFAULT_SHELF_CONFIG.maxItemsPerRequest,
      uniqueItems: true,
      items: { type: 'string', format: 'uuid' },
    },
    gold: { type: 'integer', minimum: 0, maximum: DEFAULT_SHELF_CONFIG.maxGoldPerRequest },
    materials: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(
        MATERIAL_IDS.map((id) => [
          id,
          { type: 'integer', minimum: 0, maximum: DEFAULT_SHELF_CONFIG.maxMaterialPerRequest },
        ]),
      ),
    },
  },
} as const;

interface MoveBody {
  itemIds?: string[];
  gold?: number;
  materials?: Partial<Record<MaterialId, number>>;
}

const KIND_WORDS: Record<TradeKind, string> = {
  items: 'items',
  materials: 'materials',
  gold: 'gold',
};

/** The plain refusal for each planned case. */
export function shelfRefusalError(r: ShelfRefusal): ApiError {
  switch (r.kind) {
    case 'nothing_to_move':
      return new ApiError(400, 'nothing_to_move', 'Choose something to move.');
    case 'shelf_paused':
      return new ApiError(
        409,
        'shelf_paused',
        `Putting ${KIND_WORDS[r.what]} on the account shelf is paused for now. Anything already on the shelf can still be taken out.`,
        { kind: r.what },
      );
    case 'not_found':
      return new ApiError(404, 'not_found', 'No such item.', { itemId: r.itemId });
    case 'item_equipped':
      return new ApiError(409, 'item_equipped', 'Unequip this item first.', { itemId: r.itemId });
    case 'item_in_warehouse':
      return new ApiError(
        409,
        'item_in_warehouse',
        'This item is in the warehouse. Take it out first.',
        { itemId: r.itemId },
      );
    case 'item_on_shelf':
      return new ApiError(409, 'item_on_shelf', 'This item is already on the account shelf.', {
        itemId: r.itemId,
      });
    case 'item_held':
      return new ApiError(
        409,
        'item_held',
        'This item was received in a trade and is held for now. It can go on the shelf once the hold ends.',
        { itemId: r.itemId, holdUntil: new Date(r.holdUntilMs).toISOString() },
      );
    case 'shelf_full':
      return new ApiError(422, 'shelf_full', 'Not enough room on the account shelf.', {
        capacity: r.capacity,
        free: r.free,
        needed: r.needed,
      });
    case 'inventory_full':
      return new ApiError(422, 'inventory_full', 'Not enough room in your pack.', {
        capacity: r.capacity,
        free: r.free,
        needed: r.needed,
      });
    case 'insufficient_gold':
      return new ApiError(422, 'insufficient_gold', 'Not enough gold.', {
        needed: r.needed,
        available: r.available,
        held: r.held,
      });
    case 'insufficient_materials':
      return new ApiError(422, 'insufficient_materials', 'Not enough materials.', {
        materialId: r.materialId,
        needed: r.needed,
        available: r.available,
        held: r.held,
      });
  }
}

/** Takes the account's shelf lock (transaction-scoped advisory lock). */
export async function lockShelf(tx: Transaction, accountId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${shelfLock(accountId)}, 0))`);
}

/** The shelf's item rows, oldest first (pass `lock` inside a move: `for update`). */
async function shelfItems(db: Executor, accountId: string, lock: boolean): Promise<ItemInstance[]> {
  const q = db
    .select()
    .from(itemInstances)
    .where(and(eq(itemInstances.shelfAccountId, accountId), eq(itemInstances.onShelf, true)))
    .orderBy(asc(itemInstances.createdAt), asc(itemInstances.id));
  return lock ? q.for('update') : q;
}

async function shelfGoldOf(db: Executor, accountId: string): Promise<number> {
  const [row] = await db
    .select({ gold: accounts.shelfGold })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  return row?.gold ?? 0;
}

async function shelfMaterialsOf(db: Executor, accountId: string): Promise<MaterialBundle> {
  const rows = await db
    .select({
      materialId: accountShelfMaterials.materialId,
      quantity: accountShelfMaterials.quantity,
    })
    .from(accountShelfMaterials)
    .where(eq(accountShelfMaterials.accountId, accountId));
  const out: MaterialBundle = {};
  for (const r of rows)
    if (isMaterialId(r.materialId) && r.quantity > 0) out[r.materialId] = r.quantity;
  return out;
}

async function heroNames(db: Executor, accountId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: characters.id, name: characters.name })
    .from(characters)
    .where(eq(characters.accountId, accountId));
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function shelfView(
  db: Executor,
  accountId: string,
  character: Character,
  heroItems: readonly ItemInstance[],
  onShelf: readonly ItemInstance[],
  packCapacity: number,
  switches: Readonly<TradingSwitches>,
  deposits: Record<TradeKind, boolean>,
): Promise<ShelfView> {
  const names = await heroNames(db, accountId);
  return {
    characterId: character.id,
    capacity: DEFAULT_SHELF_CONFIG.itemCapacity,
    items: onShelf.map((i) => ({
      ...itemView(i, switches),
      placedBy: { characterId: i.characterId, name: names.get(i.characterId) ?? '' },
    })),
    gold: await shelfGoldOf(db, accountId),
    materials: materialList(await shelfMaterialsOf(db, accountId)),
    deposits,
    hero: {
      gold: character.gold,
      materials: materialList(await loadMaterialBundle(db, character.id)),
      pack: { count: heroItems.filter(isPackItem).length, capacity: packCapacity },
    },
  };
}

const itemSnapshot = (i: ItemInstance) => ({
  itemId: i.id,
  baseId: i.baseId,
  rarityId: i.rarityId,
  itemLevel: i.itemLevel,
  variant: i.variant ?? null,
  setId: i.setId ?? null,
  mythicId: i.mythicId ?? null,
  upgradeLevel: i.upgradeLevel,
  locked: i.locked,
  binding: i.binding ?? null,
  /** Ticket 6.5b: awakened items move between the account's heroes like any bound item. */
  awakened: i.awakening !== null,
  /** The hero the item came from (deposit: the depositor; withdrawal: who had placed it). */
  fromCharacterId: i.characterId,
});

export async function registerShelf(
  app: FastifyInstance,
  activity: ActivityOptions,
): Promise<void> {
  const packCapacity = activity.rules.inventory.capacity;

  /** The Warehouse's gate (4.7): the building is open once the town has restored it. */
  async function requireOpen(): Promise<void> {
    const world = await app.worldState.flags();
    if (!isUnlocked(WAREHOUSE_UNLOCK, { level: 1, world }, { gravewardenDefeated: false })) {
      throw warehouseClosed();
    }
  }

  app.get<{ Params: { characterId: string } }>(
    '/characters/:characterId/shelf',
    {
      preHandler: app.requireAccount,
      schema: { params: characterParamsSchema, response: { 200: shelfSchema } },
    },
    async (request): Promise<ShelfView> => {
      const switches = await app.gameSettings.tradingSwitches();
      const deposits = { ...(await app.gameSettings.trading()).shelf };
      await requireOpen();
      const accountId = request.auth!.account.id;
      const { characterId } = request.params;
      return withTransaction(app.db, async (tx) => {
        const [character] = await tx
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
        const heroItems = await tx
          .select()
          .from(itemInstances)
          .where(eq(itemInstances.characterId, characterId));
        const onShelf = await shelfItems(tx, accountId, false);
        return shelfView(
          tx,
          accountId,
          character,
          heroItems,
          onShelf,
          packCapacity,
          switches,
          deposits,
        );
      });
    },
  );

  async function move(
    tx: Transaction,
    direction: ShelfDirection,
    accountId: string,
    characterId: string,
    body: MoveBody,
    switches: Readonly<TradingSwitches>,
  ): Promise<ShelfMoveResponse> {
    await lockShelf(tx, accountId);
    // Ticket T.5 lock order: account row before the hero. A gold move updates `accounts`, and
    // trade writes hold the account row (share) before they lock heroes; taking it here first
    // means a shelf move and a trade never wait on each other in opposite orders.
    await tx.execute(sql`select 1 from accounts where id = ${accountId} for no key update`);
    // Settle first (ticket 1.9): drops of the window so far are placed with the pack as it was.
    let character = await lockOwnedCharacter(tx, accountId, characterId, activity);
    const now = activity.now();
    const heroItems = await loadItems(tx, characterId);
    const onShelf = await shelfItems(tx, accountId, true);
    const shelfGold = await shelfGoldOf(tx, accountId);
    const shelfMaterials = await shelfMaterialsOf(tx, accountId);
    const heroMaterials = await loadMaterialBundle(tx, characterId);
    // Decisions read the stored switches, not the cache (T.2: exact inside a value transaction).
    const deposits = { ...(await loadTradingSettings(tx)).shelf };
    const request = {
      itemIds: body.itemIds ?? [],
      gold: body.gold ?? 0,
      materials: body.materials ?? {},
    };
    // Ticket T.5: an item in a trade offer's escrow can't go onto the shelf.
    if (direction === 'deposit') {
      const offered = heroItems.find((i) => i.escrowOfferId && request.itemIds.includes(i.id));
      if (offered) throw itemInOffer(offered.id);
    }
    const plan =
      direction === 'deposit'
        ? planShelfDeposit({
            request,
            heroItems: heroItems.map((i) => ({
              id: i.id,
              equipped: i.equippedSlot !== null,
              inWarehouse: i.inWarehouse,
              onShelf: i.onShelf,
              holdUntilMs: i.holdUntil ? i.holdUntil.getTime() : null,
            })),
            heroGold: character.gold,
            heroMaterials,
            held: await heldValueOf(tx, characterId, now),
            shelfItemCount: onShelf.length,
            switches: deposits,
            nowMs: now.getTime(),
          })
        : planShelfWithdraw({
            request,
            shelfItemIds: onShelf.map((i) => i.id),
            shelfGold,
            shelfMaterials,
            packCount: heroItems.filter(isPackItem).length,
            packCapacity,
          });
    if (!plan.ok) throw shelfRefusalError(plan.refusal);
    const m: ShelfMove = plan.move;
    const sign = direction === 'deposit' ? 1 : -1;
    const conflict = () => new ApiError(409, 'conflict', 'The shelf changed meanwhile. Try again.');

    let moved: ItemInstance[] = [];
    if (m.itemIds.length > 0) {
      if (direction === 'deposit') {
        // Re-checks everything the plan read: this hero's, in the pack, not held at this clock.
        moved = await tx
          .update(itemInstances)
          .set({ onShelf: true, shelfAccountId: accountId })
          .where(
            and(
              eq(itemInstances.characterId, characterId),
              inArray(itemInstances.id, m.itemIds),
              eq(itemInstances.onShelf, false),
              eq(itemInstances.inWarehouse, false),
              isNull(itemInstances.equippedSlot),
              or(isNull(itemInstances.holdUntil), lte(itemInstances.holdUntil, now)),
              isNull(itemInstances.escrowOfferId),
            ),
          )
          .returning();
      } else {
        const placedBy = new Map(onShelf.map((i) => [i.id, i.characterId]));
        moved = (
          await tx
            .update(itemInstances)
            .set({ onShelf: false, shelfAccountId: null, characterId })
            .where(
              and(
                inArray(itemInstances.id, m.itemIds),
                eq(itemInstances.onShelf, true),
                eq(itemInstances.shelfAccountId, accountId),
              ),
            )
            .returning()
        ).map((i) => ({ ...i, characterId: placedBy.get(i.id)! }));
      }
      if (moved.length !== m.itemIds.length) throw conflict();
    }

    if (m.gold > 0) {
      character = await changeGold(tx, character, -sign * m.gold, now);
      const [row] = await tx
        .update(accounts)
        .set({ shelfGold: sql`${accounts.shelfGold} + ${sign * m.gold}` })
        .where(eq(accounts.id, accountId))
        .returning({ gold: accounts.shelfGold });
      if (!row) throw conflict();
    }

    const materialMoves = Object.entries(m.materials) as [MaterialId, number][];
    if (materialMoves.length > 0) {
      await changeMaterialsTx(
        tx,
        characterId,
        Object.fromEntries(materialMoves.map(([id, n]) => [id, -sign * n])),
        now,
      );
      if (direction === 'deposit') {
        await tx
          .insert(accountShelfMaterials)
          .values(
            materialMoves.map(([materialId, quantity]) => ({
              accountId,
              materialId,
              quantity,
              updatedAt: now,
            })),
          )
          .onConflictDoUpdate({
            target: [accountShelfMaterials.accountId, accountShelfMaterials.materialId],
            set: {
              quantity: sql`${accountShelfMaterials.quantity} + excluded.quantity`,
              updatedAt: now,
            },
          });
      } else {
        for (const [materialId, n] of materialMoves) {
          const taken = await tx
            .update(accountShelfMaterials)
            .set({ quantity: sql`${accountShelfMaterials.quantity} - ${n}`, updatedAt: now })
            .where(
              and(
                eq(accountShelfMaterials.accountId, accountId),
                eq(accountShelfMaterials.materialId, materialId),
              ),
            )
            .returning({ quantity: accountShelfMaterials.quantity });
          if (taken.length === 0) throw conflict();
        }
      }
    }

    // State after the move, for the audit rows and the response.
    const heroAfter = await loadItems(tx, characterId);
    const shelfAfter = await shelfItems(tx, accountId, false);
    const shelfGoldAfter = await shelfGoldOf(tx, accountId);
    const shelfMaterialsAfter = await shelfMaterialsOf(tx, accountId);
    const heroMaterialsAfter = await loadMaterialBundle(tx, characterId);
    const from = direction === 'deposit' ? characterId : null;
    const to = direction === 'deposit' ? null : characterId;
    const event = `shelf.${direction}`;
    // One audit row and one telemetry count per kind moved (`TRADE_KINDS` order).
    for (const kind of m.kinds) {
      const amount =
        kind === 'items' ? moved.length : kind === 'gold' ? m.gold : bundleTotal(m.materials);
      const data: Record<string, unknown> = {
        kind,
        amount,
        fromCharacterId: from,
        toCharacterId: to,
      };
      if (kind === 'items') {
        data.items = moved.map(itemSnapshot);
        data.shelfItemsAfter = shelfAfter.length;
        data.packAfter = heroAfter.filter(isPackItem).length;
      } else if (kind === 'gold') {
        data.gold = m.gold;
        data.goldAfter = character.gold;
        data.shelfGoldAfter = shelfGoldAfter;
      } else {
        data.materials = m.materials;
        data.materialsAfter = Object.fromEntries(
          Object.keys(m.materials).map((id) => [id, heroMaterialsAfter[id as MaterialId] ?? 0]),
        );
        data.shelfMaterialsAfter = Object.fromEntries(
          Object.keys(m.materials).map((id) => [id, shelfMaterialsAfter[id as MaterialId] ?? 0]),
        );
      }
      await writeAudit(tx, { event, accountId, characterId, data });
      recordTelemetry(tx, now, [{ metric: 'shelf.move', dims: [direction, kind], amount }]);
    }

    return {
      shelf: await shelfView(
        tx,
        accountId,
        character,
        heroAfter,
        shelfAfter,
        packCapacity,
        switches,
        deposits,
      ),
      inventory: inventoryView(character, heroAfter, switches),
      character: characterView(character),
      moved: { items: moved.length, gold: m.gold, materials: materialList(m.materials) },
    };
  }

  for (const direction of ['deposit', 'withdraw'] as const) {
    app.post<{ Params: { characterId: string }; Body: MoveBody }>(
      `/characters/:characterId/shelf/${direction}`,
      {
        preHandler: app.requireAccount,
        schema: {
          params: characterParamsSchema,
          body: moveBodySchema,
          response: { 200: moveResponseSchema },
        },
      },
      async (request, reply) => {
        const switches = await app.gameSettings.tradingSwitches();
        await requireOpen();
        const accountId = request.auth!.account.id;
        const { characterId } = request.params;
        return idempotentTransaction(
          app,
          request,
          reply,
          { now: activity.now },
          (tx): Promise<ShelfMoveResponse> =>
            move(tx, direction, accountId, characterId, request.body ?? {}, switches),
        );
      },
    );
  }
}
