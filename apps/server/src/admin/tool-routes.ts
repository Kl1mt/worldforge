import { bumpCacheVersion } from '../shared/cache-sync.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, asc, count, eq, isNull, like, sql } from 'drizzle-orm';
import {
  AREA_IDS,
  DEFAULT_LOOT_CONFIG,
  DEFAULT_PROFESSION_CONFIG,
  DUNGEON_IDS,
  DUNGEON_TIERS,
  HANDLE_RE,
  ITEM_VARIANT_IDS,
  type ItemVariantId,
  MATERIAL_IDS,
  MAX_LEVEL,
  PROFESSION_IDS,
  RARITY_IDS,
  WORLD_FLAG_IDS,
  applyXp,
  contractDay,
  duelDay,
  findItemBase,
  generateItem,
  awakenItem,
  shippedAwakening,
  type AwakeningRefusal,
  hasDungeonTier,
  isAreaUnlocked,
  isDungeonUnlocked,
  isMaterialId,
  isWorldFlagId,
  worldEra,
  worldEraIndex,
  worldFlagsFrom,
  merchantDay,
  objectiveTarget,
  validateItem,
  type GeneratedItem,
  type MaterialId,
  type ProfessionId,
  type RarityId,
  type WorldProgress,
  guildBossWeek,
} from '@worldforge/game-core';
import { bossModifierWeekView } from '../world/boss-modifier.js';
import { lockWorldFlags, recordEraChange } from '../community/era.js';
import { loadWorldState } from '../community/world-state.js';
import { projectProgressSummary } from '../community/model.js';
import { randomInt } from 'node:crypto';
import {
  accounts,
  activities,
  characterProfessions,
  characterQuests,
  characters,
  duels,
  itemInstances,
  merchantPurchases,
  worldFlags,
  type Account,
  type Character,
  type ItemInstance,
} from '../db/schema.js';
import type { Transaction } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { writeAudit } from '../db/audit.js';
import { ApiError } from '../errors.js';
import { idempotentTransaction } from '../idempotency/index.js';
import { settleActivityTx, type ActivityOptions } from '../activity/settle.js';
import { characterView } from '../characters/routes.js';
import { changeGold, inventoryFull } from '../economy/shared.js';
import { changeMaterialsTx, loadMaterialBundle } from '../materials/store.js';
import { inventoryView, loadItems, lockOwnedCharacter } from '../inventory/routes.js';
import { itemBindingColumns, itemEffectColumns } from '../inventory/columns.js';
import { isPackItem } from '../inventory/location.js';
import { lockShelf } from '../shelf/routes.js';
import { lockDuelAccount, withdrawFromDefence } from '../arena/model.js';
import { revokeSessions } from '../auth/tokens.js';
import { throttleKey } from '../auth/login-throttle.js';
import { recordTelemetry } from '../telemetry/record.js';
import { refreshAchievements, type FactCharacter, type FactKey } from '../achievements/award.js';
import { goldIn, goldOut, materialCounts, xpIn } from '../telemetry/counts.js';
import { refreshAccountHeroes, refreshHeroScores } from '../leaderboards/snapshot.js';
import { snapshotDeps } from '../leaderboards/routes.js';
import { listSeasons } from '../seasons/model.js';
import { accountFile, adminItemView, itemLocation } from './inspector.js';
import { purgeDueHint } from './purge-hint.js';
import { renameHero, restoreHero, softDeleteHero } from './heroes.js';
import { SCHEDULER_JOBS } from './scheduler-state.js';
import {
  adminAudit,
  assertCheat,
  assertConfirmed,
  lockAdmin,
  reasonSchema,
  targetAccount,
  type CheatGate,
} from './tools.js';

/**
 * The admin tools (ticket D.4, docs/API_CONVENTIONS.md "Admin tools"). Registered inside D.3's
 * `/api/admin` scope, so `requireAdmin` (the not-found `404` for everyone else, before body
 * validation) and the per-account limits already ran. Every write:
 * - needs an `Idempotency-Key` (a replay returns the stored answer and does nothing again);
 * - re-reads the admin's role inside its transaction (`lockAdmin`);
 * - takes the gameplay lock order: the shelf lock and the target account row first when it needs
 *   them, the admin's row, then the hero (settling its activity first, `lockOwnedCharacter`), then
 *   its items, so a tool never races farming, trades or the shelf into a bad state;
 * - writes one `admin.*` audit row on the target account with `by`, `reason`, `before`, `after`;
 * - records telemetry under its own sources (`admin_grant`, `admin_refund`, `admin_remove`, the
 *   `admin.item` metric) so `reconcileWithAudit` still balances.
 */

export interface ToolOptions {
  activity: ActivityOptions;
}

const handleParam = { type: 'string', pattern: HANDLE_RE.source } as const;
const uuid = { type: 'string', format: 'uuid' } as const;
const heroParams = {
  type: 'object',
  required: ['handle', 'characterId'],
  properties: { handle: handleParam, characterId: uuid },
} as const;
const body = (properties: Record<string, unknown>, required: string[]) =>
  ({ type: 'object', additionalProperties: false, required, properties }) as const;
const materialBundleSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: Object.fromEntries(
    MATERIAL_IDS.map((m) => [m, { type: 'integer', minimum: 1, maximum: 1_000_000 }]),
  ),
} as const;
/** Sanity bounds of one admin action (not game rules: no gameplay number changes). */
const MAX_GOLD_PER_ACTION = 100_000_000;
const MAX_XP_PER_ACTION = 1_000_000_000;

interface HeroParams {
  handle: string;
  characterId: string;
}

const heroNotFound = () => new ApiError(404, 'not_found', 'No such hero.');

function itemSummary(
  i: Pick<ItemInstance, 'id' | 'baseId' | 'rarityId' | 'itemLevel' | 'seed'> &
    Partial<
      Pick<
        ItemInstance,
        'variant' | 'upgradeLevel' | 'setId' | 'mythicId' | 'effectId' | 'awakening'
      >
    >,
) {
  return {
    itemId: i.id,
    baseId: i.baseId,
    rarityId: i.rarityId,
    itemLevel: i.itemLevel,
    seed: i.seed,
    variant: i.variant ?? null,
    upgradeLevel: i.upgradeLevel ?? 0,
    setId: i.setId ?? null,
    mythicId: i.mythicId ?? null,
    effectId: i.effectId ?? null,
    awakened: Boolean(i.awakening),
  };
}

export interface GrantItemSpec {
  baseId: string;
  rarityId: RarityId;
  itemLevel: number;
  /** Void or (ticket 6.4) Prismatic; `validateItem` refuses either on the wrong rarity. */
  variant: ItemVariantId | null;
  upgradeLevel: number;
  seed: number;
  /** Ticket 6.5b: grant it awakened (only an item the Forge could awaken: +10, eligible). */
  awakened?: boolean;
}

/**
 * Generates the item an admin grant would create, with game-core's own generator for the chosen
 * base, rarity, item level and seed (the hero's class enables its class affixes), then the variant
 * and the upgrade level, and checks it with `validateItem`. A set base is always its set's piece
 * and a Mythic base its named Mythic (game-core's rule), so "pick a set" is picking a set piece.
 */
export function generateAdminItem(
  spec: GrantItemSpec,
  classId: Character['classId'],
): GeneratedItem & { upgradeLevel: number } {
  const base = findItemBase(spec.baseId);
  if (!base) {
    throw new ApiError(400, 'validation_failed', 'Unknown item base.', {
      fields: { baseId: 'Choose an item base from the list.' },
    });
  }
  if (spec.itemLevel < base.minItemLevel) {
    throw new ApiError(
      400,
      'validation_failed',
      `This base starts at item level ${base.minItemLevel}.`,
      {
        fields: { itemLevel: `At least ${base.minItemLevel}.` },
      },
    );
  }
  const item = generateItem({
    seed: spec.seed,
    itemLevel: spec.itemLevel,
    baseId: base.id,
    rarityId: spec.rarityId,
    classId,
  });
  if (!item) throw new ApiError(422, 'invalid_item', 'This item can’t be generated.');
  if (spec.variant) item.variant = spec.variant;
  if (spec.awakened) {
    // Ticket 6.5b: the Forge's own eligibility rule, so a test item is one a player could own.
    const r = awakenItem({ ...item, upgradeLevel: spec.upgradeLevel });
    if (!r.ok) {
      throw new ApiError(422, 'invalid_item', AWAKEN_GRANT_REFUSALS[r.reason], {
        fields: { awakened: AWAKEN_GRANT_REFUSALS[r.reason] },
      });
    }
    item.awakening = shippedAwakening();
  }
  const problems = validateItem(item);
  if (problems.length > 0) {
    throw new ApiError(422, 'invalid_item', 'This combination isn’t a valid item.', { problems });
  }
  return { ...item, upgradeLevel: spec.upgradeLevel };
}

/** Ticket 6.5b: why an admin grant can't be awakened (the Forge's rule). */
const AWAKEN_GRANT_REFUSALS: Record<AwakeningRefusal, string> = {
  rarity: 'Only Legendary, Mythic and set items can be awakened.',
  upgrade_level: 'Only items at +10 can be awakened.',
  item_level: 'Only items of item level 23 or higher can be awakened.',
  already_awakened: 'Already awakened.',
  nothing_to_awaken: 'This item has no effect or set bonus to awaken.',
  unknown_base: 'Unknown item base.',
  affix_missing: 'This item can’t be awakened.',
  affix_not_allowed: 'This item can’t be awakened.',
  affix_present: 'This item can’t be awakened.',
};

const grantSpecSchema = {
  baseId: { type: 'string', minLength: 1, maxLength: 64 },
  rarityId: { type: 'string', enum: [...RARITY_IDS] },
  itemLevel: { type: 'integer', minimum: 1, maximum: DEFAULT_LOOT_CONFIG.maxItemLevel },
  variant: { type: ['string', 'null'], enum: [...ITEM_VARIANT_IDS, null] },
  upgradeLevel: { type: 'integer', minimum: 0, maximum: 10 },
  awakened: { type: 'boolean' },
};

export async function registerAdminTools(admin: FastifyInstance, options: ToolOptions) {
  const app = admin;
  const { activity } = options;
  const gameNow = () => activity.now();
  const deps = snapshotDeps(app);

  /** After a commit: the target's board rows follow its new state (errors only logged). */
  const refreshBoards = async (
    request: FastifyRequest,
    accountId: string,
    characterId?: string,
  ) => {
    try {
      await refreshAccountHeroes(deps, accountId, gameNow(), characterId);
    } catch (err) {
      request.log.error({ err }, 'admin: leaderboard refresh failed');
    }
  };

  /** Runs a tool write: Idempotency-Key, transaction, the admin re-read is up to `fn`. */
  const tool = <T>(
    request: FastifyRequest,
    reply: FastifyReply,
    fn: (tx: Transaction, adminId: string) => Promise<T>,
  ) =>
    idempotentTransaction(app, request, reply, { now: () => app.authNow() }, (tx) =>
      fn(tx, request.auth!.account.id),
    );

  /** A live hero of `account`, locked and settled (the gameplay chokepoint), or `404`. */
  const lockHero = async (tx: Transaction, account: Account, characterId: string) => {
    try {
      return await lockOwnedCharacter(tx, account.id, characterId, activity);
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 404) throw heroNotFound();
      throw err;
    }
  };

  /** Common start of a cheat tool on one hero: target, role re-read, gate, hero lock. */
  const cheatStart = async (tx: Transaction, adminId: string, p: HeroParams) => {
    const account = await targetAccount(tx, p.handle);
    await lockAdmin(tx, adminId);
    const gate = assertCheat(account, adminId);
    const hero = await lockHero(tx, account, p.characterId);
    return { account, gate, hero };
  };
  const warning = (gate: CheatGate) => (gate.ownPublic ? { warning: 'public_boards' } : {});

  /**
   * Ticket D.4b: after a progress write, the same refresh the gameplay paths run (achievements,
   * their deed cosmetics and the milestone cosmetics), in the tool's transaction, so what the new
   * state earns arrives now, exactly once, audited with its normal source. `hero` is the row as it
   * is after the write. Nothing is taken back when a write lowers progress (6.8).
   */
  const grantEarned = async (tx: Transaction, hero: FactCharacter, keys: readonly FactKey[]) => {
    const cosmetics: string[] = [];
    const achievements = await refreshAchievements(tx, hero, keys, gameNow(), cosmetics);
    return { achievements, cosmetics };
  };

  // ---- Inspector ------------------------------------------------------------------------------
  admin.get(
    '/accounts/:handle',
    {
      schema: {
        params: { type: 'object', required: ['handle'], properties: { handle: handleParam } },
      },
    },
    async (request) => {
      const { handle } = request.params as { handle: string };
      const account = await targetAccount(app.db, handle);
      const file = await accountFile(app.db, account, {
        switches: await app.gameSettings.tradingSwitches(),
        now: gameNow(),
        authNow: app.authNow(),
        adminId: request.auth!.account.id,
        // Computed from the stored address here; the address itself never leaves the server.
        loginLockedForMs: await app.loginThrottle.lockedFor(throttleKey(account.email)),
      });
      await writeAudit(app.db, {
        event: 'admin.player.inspect',
        accountId: request.auth!.account.id,
        data: { handle },
      });
      return { account: file };
    },
  );

  // ---- View as player (read-only) ---------------------------------------------------------------
  admin.get(
    '/accounts/:handle/heroes/:characterId/view',
    { schema: { params: heroParams } },
    async (request) => {
      const p = request.params as HeroParams;
      const account = await targetAccount(app.db, p.handle);
      // Plain reads, no lock and no settlement: the hero exactly as last settled.
      const [hero] = await app.db
        .select()
        .from(characters)
        .where(and(eq(characters.id, p.characterId), eq(characters.accountId, account.id)));
      if (!hero) throw heroNotFound();
      const switches = await app.gameSettings.tradingSwitches();
      const items = await app.db
        .select()
        .from(itemInstances)
        .where(eq(itemInstances.characterId, hero.id))
        .orderBy(asc(itemInstances.createdAt), asc(itemInstances.id));
      const [running] = await app.db
        .select()
        .from(activities)
        .where(eq(activities.characterId, hero.id));
      const world = await app.worldState.flags();
      const who = { level: hero.level, world };
      await writeAudit(app.db, {
        event: 'admin.view',
        accountId: request.auth!.account.id,
        data: { section: 'view_as', handle: p.handle },
      });
      return {
        readOnly: true,
        deleted: hero.deletedAt !== null,
        character: characterView(hero),
        inventory: inventoryView(hero, items, switches),
        warehouse: items
          .filter((i) => i.inWarehouse)
          .map((i) => adminItemView(i, switches, app.authNow())),
        materials: await loadMaterialBundle(app.db, hero.id),
        activity: running
          ? {
              areaId: running.areaId,
              settledAt: running.settledAt.toISOString(),
              summary: running.summary,
            }
          : null,
        areas: AREA_IDS.map((id) => ({ id, unlocked: isAreaUnlocked(id, who, hero.progress) })),
        dungeons: DUNGEON_IDS.flatMap((id) =>
          DUNGEON_TIERS.filter((t) => hasDungeonTier(id, t)).map((tier) => ({
            id,
            tier,
            unlocked: isDungeonUnlocked(id, who, hero.progress, tier),
          })),
        ),
      };
    },
  );

  // ---- Items -----------------------------------------------------------------------------------
  admin.post(
    '/accounts/:handle/heroes/:characterId/items/preview',
    {
      schema: {
        params: heroParams,
        body: body(
          { ...grantSpecSchema, seed: { type: 'integer', minimum: 0, maximum: 0xffffffff } },
          ['baseId', 'rarityId', 'itemLevel', 'variant', 'upgradeLevel'],
        ),
      },
    },
    async (request) => {
      const p = request.params as HeroParams;
      const spec = request.body as Omit<GrantItemSpec, 'seed'> & { seed?: number };
      const account = await targetAccount(app.db, p.handle);
      const [hero] = await app.db
        .select()
        .from(characters)
        .where(
          and(
            eq(characters.id, p.characterId),
            eq(characters.accountId, account.id),
            isNull(characters.deletedAt),
          ),
        );
      if (!hero) throw heroNotFound();
      const seed = spec.seed ?? randomInt(0, 0xffffffff);
      const item = generateAdminItem({ ...spec, seed }, hero.classId);
      return { seed, item };
    },
  );

  admin.post(
    '/accounts/:handle/heroes/:characterId/items/grant',
    {
      schema: {
        params: heroParams,
        body: body(
          {
            ...grantSpecSchema,
            seed: { type: 'integer', minimum: 0, maximum: 0xffffffff },
            reason: reasonSchema,
          },
          ['baseId', 'rarityId', 'itemLevel', 'variant', 'upgradeLevel', 'seed', 'reason'],
        ),
      },
    },
    async (request, reply) => {
      const p = request.params as HeroParams;
      const spec = request.body as GrantItemSpec & { reason: string };
      // Before the transaction: the cache may query the pool (PGlite has one connection).
      const switches = await app.gameSettings.tradingSwitches();
      const out = await tool(request, reply, async (tx, adminId) => {
        const { account, gate, hero } = await cheatStart(tx, adminId, p);
        const generated = generateAdminItem(spec, hero.classId);
        const items = await loadItems(tx, hero.id);
        const capacity = activity.rules.inventory.capacity;
        if (items.filter(isPackItem).length >= capacity) throw inventoryFull(capacity);
        const now = gameNow();
        const binding = itemBindingColumns(generated, 'admin', account.id);
        // Admin-granted items are account-bound for good (source `admin`: game-core's rule).
        if (binding.binding !== 'account') throw new Error('admin item must be account-bound');
        const [row] = await tx
          .insert(itemInstances)
          .values({
            id: uuidv7(),
            characterId: hero.id,
            baseId: generated.baseId,
            rarityId: generated.rarityId,
            itemLevel: generated.itemLevel,
            affixes: generated.affixes,
            seed: generated.seed,
            ...itemEffectColumns(generated),
            upgradeLevel: generated.upgradeLevel,
            ...binding,
            ...(generated.awakening ? { awakening: generated.awakening, awakenedAt: now } : {}),
            source: 'admin',
            createdAt: now,
          })
          .returning();
        const item = row!;
        // A Legendary or a +10 is a deed (as a drop, a forge or a purchase is).
        const earned = await grantEarned(tx, hero, ['maxRarity', 'maxUpgradeLevel']);
        await adminAudit(tx, {
          event: 'admin.item.grant',
          adminId,
          target: account,
          characterId: hero.id,
          reason: spec.reason,
          after: itemSummary(item),
          data: { earned },
        });
        // Provenance (T.1): the creation is on record, so the item never reads as unprovenanced.
        await writeAudit(tx, {
          event: 'item.provenance',
          accountId: account.id,
          characterId: hero.id,
          data: { from: 'admin', itemIds: [item.id] },
        });
        recordTelemetry(tx, now, [
          { metric: 'admin.item', dims: ['grant', item.rarityId], amount: 1 },
        ]);
        return {
          item: adminItemView(item, switches, app.authNow()),
          earned,
          ...warning(gate),
        };
      });
      await refreshBoards(request, (await targetAccount(app.db, p.handle)).id, p.characterId);
      return out;
    },
  );

  admin.post(
    '/accounts/:handle/items/:itemId/remove',
    {
      schema: {
        params: {
          type: 'object',
          required: ['handle', 'itemId'],
          properties: { handle: handleParam, itemId: uuid },
        },
        body: body({ confirm: { type: 'string', maxLength: 64 }, reason: reasonSchema }, [
          'confirm',
          'reason',
        ]),
      },
    },
    async (request, reply) => {
      const { handle, itemId } = request.params as { handle: string; itemId: string };
      const { confirm, reason } = request.body as { confirm: string; reason: string };
      const out = await tool(request, reply, async (tx, adminId) => {
        const account = await targetAccount(tx, handle);
        const [peek] = await tx
          .select()
          .from(itemInstances)
          .innerJoin(characters, eq(characters.id, itemInstances.characterId))
          .where(and(eq(itemInstances.id, itemId), eq(characters.accountId, account.id)));
        if (!peek) throw new ApiError(404, 'not_found', 'No such item on this account.');
        const onShelf = peek.item_instances.onShelf;
        // The shelf's order: its lock, then the account row, before any hero (T.3, T.5).
        if (onShelf) {
          await lockShelf(tx, account.id);
          await tx.execute(sql`select 1 from accounts where id = ${account.id} for no key update`);
        }
        await lockAdmin(tx, adminId);
        const hero = await lockHero(tx, account, peek.characters.id);
        const [item] = await tx
          .select()
          .from(itemInstances)
          .where(and(eq(itemInstances.id, itemId), eq(itemInstances.characterId, hero.id)))
          .for('update');
        if (!item) throw new ApiError(404, 'not_found', 'No such item on this account.');
        assertConfirmed(item.onShelf ? account.handle : hero.name, confirm);
        if (item.escrowOfferId) {
          throw new ApiError(
            409,
            'item_in_escrow',
            'This item is in an open trade offer. Wait for it to end (or cancel it) first.',
            { itemId },
          );
        }
        if (item.holdUntil && item.holdUntil.getTime() > app.authNow().getTime()) {
          throw new ApiError(
            409,
            'item_held',
            'This item was received in a trade and is held until its hold ends.',
            { itemId, holdUntil: item.holdUntil.toISOString() },
          );
        }
        const location = itemLocation(item);
        if (item.equippedSlot) {
          // T.7: an item leaving the hero leaves its arena defence too.
          await withdrawFromDefence(tx, hero.id, [item]);
        }
        const gone = await tx
          .delete(itemInstances)
          .where(and(eq(itemInstances.id, item.id), isNull(itemInstances.escrowOfferId)))
          .returning({ id: itemInstances.id });
        if (gone.length !== 1) throw new ApiError(409, 'conflict', 'The item changed. Try again.');
        await adminAudit(tx, {
          event: 'admin.item.remove',
          adminId,
          target: account,
          characterId: hero.id,
          reason,
          before: { ...itemSummary(item), location, slot: item.equippedSlot },
          after: null,
          data: { location },
        });
        recordTelemetry(tx, gameNow(), [
          { metric: 'admin.item', dims: ['remove', item.rarityId], amount: 1 },
        ]);
        return { removed: { itemId: item.id, location, characterId: hero.id } };
      });
      await refreshBoards(request, (await targetAccount(app.db, handle)).id);
      return out;
    },
  );

  // ---- Currencies ------------------------------------------------------------------------------
  /**
   * `grant` is a cheat (test or own account); `refund` gives back what a player lost (support, any
   * account, its own telemetry source); `remove` takes away (support, any account, typed
   * confirmation): never below 0 and never into gold or materials held after a trade.
   */
  admin.post(
    '/accounts/:handle/heroes/:characterId/gold',
    {
      schema: {
        params: heroParams,
        body: body(
          {
            mode: { type: 'string', enum: ['grant', 'refund', 'remove'] },
            amount: { type: 'integer', minimum: 1, maximum: MAX_GOLD_PER_ACTION },
            confirm: { type: 'string', maxLength: 64 },
            reason: reasonSchema,
          },
          ['mode', 'amount', 'reason'],
        ),
      },
    },
    async (request, reply) => {
      const p = request.params as HeroParams;
      const b = request.body as {
        mode: 'grant' | 'refund' | 'remove';
        amount: number;
        confirm?: string;
        reason: string;
      };
      const out = await tool(request, reply, async (tx, adminId) => {
        const account = await targetAccount(tx, p.handle);
        await lockAdmin(tx, adminId);
        const gate = b.mode === 'grant' ? assertCheat(account, adminId) : { ownPublic: false };
        const hero = await lockHero(tx, account, p.characterId);
        const now = gameNow();
        if (b.mode === 'remove') {
          assertConfirmed(hero.name, b.confirm);
          if (hero.gold < b.amount) {
            throw new ApiError(422, 'insufficient_gold', 'The hero doesn’t have that much gold.', {
              required: b.amount,
              held: hero.gold,
            });
          }
        }
        const delta = b.mode === 'remove' ? -b.amount : b.amount;
        // `changeGold` refuses a removal that would dip into gold held after a trade (T.5).
        const after = await changeGold(tx, hero, delta, now);
        await adminAudit(tx, {
          event: 'admin.gold',
          adminId,
          target: account,
          characterId: hero.id,
          reason: b.reason,
          before: { gold: hero.gold },
          after: { gold: after.gold },
          data: { mode: b.mode, amount: b.amount },
        });
        recordTelemetry(
          tx,
          now,
          b.mode === 'remove'
            ? goldOut('admin_remove', '', b.amount)
            : goldIn(b.mode === 'grant' ? 'admin_grant' : 'admin_refund', '', b.amount),
        );
        return { gold: { before: hero.gold, after: after.gold }, ...warning(gate) };
      });
      await refreshBoards(request, (await targetAccount(app.db, p.handle)).id, p.characterId);
      return out;
    },
  );

  admin.post(
    '/accounts/:handle/heroes/:characterId/materials',
    {
      schema: {
        params: heroParams,
        body: body(
          {
            mode: { type: 'string', enum: ['grant', 'refund', 'remove'] },
            materials: materialBundleSchema,
            confirm: { type: 'string', maxLength: 64 },
            reason: reasonSchema,
          },
          ['mode', 'materials', 'reason'],
        ),
      },
    },
    async (request, reply) => {
      const p = request.params as HeroParams;
      const b = request.body as {
        mode: 'grant' | 'refund' | 'remove';
        materials: Partial<Record<MaterialId, number>>;
        confirm?: string;
        reason: string;
      };
      return tool(request, reply, async (tx, adminId) => {
        const account = await targetAccount(tx, p.handle);
        await lockAdmin(tx, adminId);
        const gate = b.mode === 'grant' ? assertCheat(account, adminId) : { ownPublic: false };
        const hero = await lockHero(tx, account, p.characterId);
        const now = gameNow();
        const before = await loadMaterialBundle(tx, hero.id);
        const entries = Object.entries(b.materials).filter(([m]) => isMaterialId(m)) as [
          MaterialId,
          number,
        ][];
        if (b.mode === 'remove') {
          assertConfirmed(hero.name, b.confirm);
          for (const [m, n] of entries) {
            if ((before[m] ?? 0) < n) {
              throw new ApiError(
                422,
                'insufficient_materials',
                'The hero doesn’t have that many.',
                {
                  materialId: m,
                  needed: n,
                  held: before[m] ?? 0,
                },
              );
            }
          }
        }
        const sign = b.mode === 'remove' ? -1 : 1;
        // Spends respect materials held after a trade (`changeMaterialsTx`, T.5).
        await changeMaterialsTx(
          tx,
          hero.id,
          Object.fromEntries(entries.map(([m, n]) => [m, sign * n])),
          now,
        );
        const after = await loadMaterialBundle(tx, hero.id);
        const moved = Object.fromEntries(entries);
        await adminAudit(tx, {
          event: 'admin.materials',
          adminId,
          target: account,
          characterId: hero.id,
          reason: b.reason,
          before,
          after,
          data: { mode: b.mode, materials: moved },
        });
        recordTelemetry(
          tx,
          now,
          b.mode === 'remove'
            ? materialCounts('material.out', 'admin_remove', moved)
            : materialCounts(
                'material.in',
                b.mode === 'grant' ? 'admin_grant' : 'admin_refund',
                moved,
              ),
        );
        return { materials: { before, after }, ...warning(gate) };
      });
    },
  );

  admin.post(
    '/accounts/:handle/heroes/:characterId/xp',
    {
      schema: {
        params: heroParams,
        body: body(
          { xp: { type: 'integer', minimum: 1, maximum: MAX_XP_PER_ACTION }, reason: reasonSchema },
          ['xp', 'reason'],
        ),
      },
    },
    async (request, reply) => {
      const p = request.params as HeroParams;
      const b = request.body as { xp: number; reason: string };
      const out = await tool(request, reply, async (tx, adminId) => {
        const { account, gate, hero } = await cheatStart(tx, adminId, p);
        const now = gameNow();
        // The normal level-up rule (game-core `applyXp`; XP beyond the cap is discarded).
        const next = applyXp({ level: hero.level, xp: hero.experience }, b.xp);
        await tx
          .update(characters)
          .set({
            level: next.level,
            experience: next.xp,
            version: sql`${characters.version} + 1`,
            updatedAt: now,
          })
          .where(eq(characters.id, hero.id));
        const earned = await grantEarned(tx, { ...hero, level: next.level }, ['maxCharacterLevel']);
        await adminAudit(tx, {
          event: 'admin.xp',
          adminId,
          target: account,
          characterId: hero.id,
          reason: b.reason,
          before: { level: hero.level, experience: hero.experience },
          after: { level: next.level, experience: next.xp },
          data: { xp: b.xp, earned },
        });
        recordTelemetry(tx, now, xpIn('admin', '', b.xp));
        return {
          before: { level: hero.level, experience: hero.experience },
          after: { level: next.level, experience: next.xp },
          earned,
          ...warning(gate),
        };
      });
      await refreshBoards(request, (await targetAccount(app.db, p.handle)).id, p.characterId);
      return out;
    },
  );

  admin.post(
    '/accounts/:handle/heroes/:characterId/level',
    {
      schema: {
        params: heroParams,
        body: body(
          { level: { type: 'integer', minimum: 1, maximum: MAX_LEVEL }, reason: reasonSchema },
          ['level', 'reason'],
        ),
      },
    },
    async (request, reply) => {
      const p = request.params as HeroParams;
      const b = request.body as { level: number; reason: string };
      const out = await tool(request, reply, async (tx, adminId) => {
        const { account, gate, hero } = await cheatStart(tx, adminId, p);
        await tx
          .update(characters)
          .set({
            level: b.level,
            experience: 0,
            version: sql`${characters.version} + 1`,
            updatedAt: gameNow(),
          })
          .where(eq(characters.id, hero.id));
        const earned = await grantEarned(tx, { ...hero, level: b.level }, ['maxCharacterLevel']);
        await adminAudit(tx, {
          event: 'admin.level',
          adminId,
          target: account,
          characterId: hero.id,
          reason: b.reason,
          before: { level: hero.level, experience: hero.experience },
          after: { level: b.level, experience: 0 },
          data: { earned },
        });
        return {
          before: { level: hero.level, experience: hero.experience },
          after: { level: b.level, experience: 0 },
          earned,
          ...warning(gate),
        };
      });
      await refreshBoards(request, (await targetAccount(app.db, p.handle)).id, p.characterId);
      return out;
    },
  );

  // ---- Hero management -------------------------------------------------------------------------
  admin.post(
    '/accounts/:handle/heroes/:characterId/delete',
    {
      schema: {
        params: heroParams,
        body: body({ confirm: { type: 'string', maxLength: 64 }, reason: reasonSchema }, [
          'confirm',
          'reason',
        ]),
      },
    },
    async (request, reply) => {
      const p = request.params as HeroParams;
      const b = request.body as { confirm: string; reason: string };
      const out = await tool(request, reply, (tx, adminId) =>
        softDeleteHero(tx, { adminId, ...p, ...b }, activity, app.authNow()),
      );
      // The account's other heroes may have gained shelf items; nothing on the boards moves.
      return { deleted: out };
    },
  );

  admin.post(
    '/accounts/:handle/heroes/:characterId/restore',
    { schema: { params: heroParams, body: body({ reason: reasonSchema }, ['reason']) } },
    async (request, reply) => {
      const p = request.params as HeroParams;
      const b = request.body as { reason: string };
      const out = await tool(request, reply, (tx, adminId) =>
        restoreHero(tx, { adminId, ...p, ...b }, app.authNow()),
      );
      try {
        await refreshHeroScores(deps, p.characterId, gameNow());
      } catch (err) {
        request.log.error({ err }, 'admin: leaderboard refresh after restore failed');
      }
      return { restored: out };
    },
  );

  admin.post(
    '/accounts/:handle/heroes/:characterId/rename',
    {
      schema: {
        params: heroParams,
        body: body(
          { name: { type: 'string', minLength: 1, maxLength: 32 }, reason: reasonSchema },
          ['name', 'reason'],
        ),
      },
    },
    async (request, reply) => {
      const p = request.params as HeroParams;
      const b = request.body as { name: string; reason: string };
      const out = await tool(request, reply, (tx, adminId) =>
        renameHero(tx, { adminId, ...p, ...b }, app.authNow()),
      );
      return { renamed: out };
    },
  );

  // ---- Progress (cheat tools) ------------------------------------------------------------------
  admin.post(
    '/accounts/:handle/heroes/:characterId/progress',
    {
      schema: {
        params: heroParams,
        body: body(
          {
            gravewardenDefeated: { type: 'boolean' },
            cryptTierCleared: { type: 'integer', minimum: 0, maximum: DUNGEON_TIERS.length },
            ashenWardenDefeated: { type: 'boolean' },
            // Ticket 6.2: optional (absent = unchanged), so older clients keep working.
            forgeTyrantDefeated: { type: 'boolean' },
            // Ticket 8.2: likewise optional.
            hollowSovereignDefeated: { type: 'boolean' },
            reason: reasonSchema,
          },
          ['gravewardenDefeated', 'cryptTierCleared', 'ashenWardenDefeated', 'reason'],
        ),
      },
    },
    async (request, reply) => {
      const p = request.params as HeroParams;
      const b = request.body as {
        gravewardenDefeated: boolean;
        cryptTierCleared: number;
        ashenWardenDefeated: boolean;
        forgeTyrantDefeated?: boolean;
        hollowSovereignDefeated?: boolean;
        reason: string;
      };
      const out = await tool(request, reply, async (tx, adminId) => {
        const { account, gate, hero } = await cheatStart(tx, adminId, p);
        // The stored shape (`cryptTierCleared` counts a Gravewarden kill as tier I on read).
        const progress: WorldProgress = {
          ...hero.progress,
          gravewardenDefeated: b.gravewardenDefeated,
          cryptTierCleared: b.cryptTierCleared,
          ashenWardenDefeated: b.ashenWardenDefeated,
          ...(b.forgeTyrantDefeated !== undefined
            ? { forgeTyrantDefeated: b.forgeTyrantDefeated }
            : {}),
          ...(b.hollowSovereignDefeated !== undefined
            ? { hollowSovereignDefeated: b.hollowSovereignDefeated }
            : {}),
        };
        await tx
          .update(characters)
          .set({ progress, version: sql`${characters.version} + 1`, updatedAt: gameNow() })
          .where(eq(characters.id, hero.id));
        const earned = await grantEarned(tx, { ...hero, progress }, [
          'gravewardenDefeated',
          'cryptTierCleared',
        ]);
        await adminAudit(tx, {
          event: 'admin.progress',
          adminId,
          target: account,
          characterId: hero.id,
          reason: b.reason,
          before: hero.progress,
          after: progress,
          data: { earned },
        });
        return { before: hero.progress, after: progress, earned, ...warning(gate) };
      });
      await refreshBoards(request, (await targetAccount(app.db, p.handle)).id, p.characterId);
      return out;
    },
  );

  admin.post(
    '/accounts/:handle/heroes/:characterId/professions',
    {
      schema: {
        params: heroParams,
        body: body(
          {
            professions: {
              type: 'object',
              additionalProperties: false,
              minProperties: 1,
              properties: Object.fromEntries(
                PROFESSION_IDS.map((id) => [
                  id,
                  { type: 'integer', minimum: 1, maximum: DEFAULT_PROFESSION_CONFIG.maxLevel },
                ]),
              ),
            },
            reason: reasonSchema,
          },
          ['professions', 'reason'],
        ),
      },
    },
    async (request, reply) => {
      const p = request.params as HeroParams;
      const b = request.body as {
        professions: Partial<Record<ProfessionId, number>>;
        reason: string;
      };
      return tool(request, reply, async (tx, adminId) => {
        const { account, gate, hero } = await cheatStart(tx, adminId, p);
        const now = gameNow();
        const before = await tx
          .select({
            professionId: characterProfessions.professionId,
            level: characterProfessions.level,
          })
          .from(characterProfessions)
          .where(eq(characterProfessions.characterId, hero.id));
        const rows = (Object.entries(b.professions) as [ProfessionId, number][]).map(
          ([professionId, level]) => ({
            characterId: hero.id,
            professionId,
            level,
            experience: 0,
            updatedAt: now,
          }),
        );
        await tx
          .insert(characterProfessions)
          .values(rows)
          .onConflictDoUpdate({
            target: [characterProfessions.characterId, characterProfessions.professionId],
            set: { level: sql`excluded.level`, experience: 0, updatedAt: now },
          });
        await adminAudit(tx, {
          event: 'admin.professions',
          adminId,
          target: account,
          characterId: hero.id,
          reason: b.reason,
          before: Object.fromEntries(before.map((r) => [r.professionId, r.level])),
          after: b.professions,
        });
        return { professions: b.professions, ...warning(gate) };
      });
    },
  );

  admin.post(
    '/accounts/:handle/heroes/:characterId/daily-reset',
    {
      schema: {
        params: heroParams,
        body: body(
          {
            limits: {
              type: 'array',
              minItems: 1,
              uniqueItems: true,
              items: { type: 'string', enum: ['ratedDuels', 'contracts', 'merchant'] },
            },
            reason: reasonSchema,
          },
          ['limits', 'reason'],
        ),
      },
    },
    async (request, reply) => {
      const p = request.params as HeroParams;
      const b = request.body as {
        limits: ('ratedDuels' | 'contracts' | 'merchant')[];
        reason: string;
      };
      return tool(request, reply, async (tx, adminId) => {
        const account = await targetAccount(tx, p.handle);
        // Rated duels are counted per account under the duel lock: take it before the hero.
        if (b.limits.includes('ratedDuels')) await lockDuelAccount(tx, account.id);
        await lockAdmin(tx, adminId);
        const gate = assertCheat(account, adminId);
        const hero = await lockHero(tx, account, p.characterId);
        const now = gameNow();
        const done: Record<string, number> = {};
        if (b.limits.includes('ratedDuels')) {
          const day = duelDay(now);
          const [row] = await tx
            .select({ n: count() })
            .from(duels)
            .where(
              and(
                eq(duels.challengerAccountId, account.id),
                eq(duels.day, day),
                eq(duels.kind, 'rated'),
              ),
            );
          await tx
            .update(accounts)
            .set({ duelResetDay: day, duelResetCount: row?.n ?? 0 })
            .where(eq(accounts.id, account.id));
          done.ratedDuels = row?.n ?? 0;
        }
        if (b.limits.includes('contracts')) {
          const gone = await tx
            .delete(characterQuests)
            .where(
              and(
                eq(characterQuests.characterId, hero.id),
                eq(characterQuests.kind, 'contract'),
                eq(characterQuests.contractDay, contractDay(now)),
              ),
            )
            .returning({ id: characterQuests.id });
          done.contracts = gone.length;
        }
        if (b.limits.includes('merchant')) {
          const gone = await tx
            .delete(merchantPurchases)
            .where(
              and(
                eq(merchantPurchases.characterId, hero.id),
                like(merchantPurchases.offerId, `${merchantDay(now)}.%`),
              ),
            )
            .returning({ id: merchantPurchases.offerId });
          done.merchant = gone.length;
        }
        await adminAudit(tx, {
          event: 'admin.daily_reset',
          adminId,
          target: account,
          characterId: hero.id,
          reason: b.reason,
          before: done,
          after: Object.fromEntries(Object.keys(done).map((k) => [k, 0])),
          data: { limits: b.limits },
        });
        return { reset: done, ...warning(gate) };
      });
    },
  );

  admin.post(
    '/accounts/:handle/heroes/:characterId/quests/:questRowId/:action',
    {
      schema: {
        params: {
          type: 'object',
          required: ['handle', 'characterId', 'questRowId', 'action'],
          properties: {
            handle: handleParam,
            characterId: uuid,
            questRowId: uuid,
            action: { type: 'string', enum: ['complete', 'reset'] },
          },
        },
        body: body({ reason: reasonSchema }, ['reason']),
      },
    },
    async (request, reply) => {
      const p = request.params as HeroParams & { questRowId: string; action: 'complete' | 'reset' };
      const b = request.body as { reason: string };
      return tool(request, reply, async (tx, adminId) => {
        const { account, gate, hero } = await cheatStart(tx, adminId, p);
        const [quest] = await tx
          .select()
          .from(characterQuests)
          .where(
            and(eq(characterQuests.id, p.questRowId), eq(characterQuests.characterId, hero.id)),
          )
          .for('update');
        if (!quest) throw new ApiError(404, 'not_found', 'No such quest.');
        let after: unknown = null;
        if (p.action === 'complete') {
          // Objectives met; the player turns it in through the normal path (rewards there).
          if (quest.status !== 'active') {
            throw new ApiError(409, 'quest_not_active', 'Only an active quest can be completed.');
          }
          const progress = quest.objectives.map((o) => objectiveTarget(o));
          await tx
            .update(characterQuests)
            .set({ progress })
            .where(eq(characterQuests.id, quest.id));
          after = { status: quest.status, progress };
        } else {
          // Gone: a story quest can be accepted again, a contract slot taken again today.
          await tx.delete(characterQuests).where(eq(characterQuests.id, quest.id));
        }
        await adminAudit(tx, {
          event: `admin.quest.${p.action}`,
          adminId,
          target: account,
          characterId: hero.id,
          reason: b.reason,
          before: {
            questId: quest.questId,
            kind: quest.kind,
            status: quest.status,
            progress: quest.progress,
          },
          after,
        });
        return {
          quest: { id: quest.id, questId: quest.questId, action: p.action },
          ...warning(gate),
        };
      });
    },
  );

  admin.post(
    '/accounts/:handle/heroes/:characterId/fast-forward',
    {
      schema: {
        params: heroParams,
        body: body(
          {
            minutes: {
              type: 'integer',
              minimum: 1,
              maximum: Math.max(1, Math.floor(activity.offlineCapMs / 60_000)),
            },
            reason: reasonSchema,
          },
          ['minutes', 'reason'],
        ),
      },
    },
    async (request, reply) => {
      const p = request.params as HeroParams;
      const b = request.body as { minutes: number; reason: string };
      const out = await tool(request, reply, async (tx, adminId) => {
        // `lockHero` settles up to now (and marks contact), so only the moved window is new.
        const { account, gate, hero } = await cheatStart(tx, adminId, p);
        const [running] = await tx
          .select()
          .from(activities)
          .where(eq(activities.characterId, hero.id))
          .for('update');
        if (!running) {
          throw new ApiError(
            409,
            'no_activity',
            'The hero isn’t farming. Start an activity first.',
          );
        }
        const ms = b.minutes * 60_000;
        const back = (d: Date) => new Date(d.getTime() - ms);
        // Only the activity's clock moves back; the rewards come from the normal settlement.
        await tx
          .update(activities)
          .set({
            startedAt: back(running.startedAt),
            settledAt: back(running.settledAt),
            lastSeenAt: back(running.lastSeenAt),
          })
          .where(eq(activities.characterId, hero.id));
        const settled = await settleActivityTx(tx, hero.id, activity, { touch: false });
        const afterHero = settled?.character ?? hero;
        const before = { level: hero.level, experience: hero.experience, gold: hero.gold };
        const after = {
          level: afterHero.level,
          experience: afterHero.experience,
          gold: afterHero.gold,
        };
        await adminAudit(tx, {
          event: 'admin.fast_forward',
          adminId,
          target: account,
          characterId: hero.id,
          reason: b.reason,
          before,
          after,
          data: { minutes: b.minutes, creditedMs: settled?.creditedMs ?? 0 },
        });
        return {
          minutes: b.minutes,
          creditedMs: settled?.creditedMs ?? 0,
          before,
          after,
          ...warning(gate),
        };
      });
      await refreshBoards(request, (await targetAccount(app.db, p.handle)).id, p.characterId);
      return out;
    },
  );

  // ---- Sessions (support) ----------------------------------------------------------------------
  admin.post(
    '/accounts/:handle/sessions/revoke',
    {
      schema: {
        params: { type: 'object', required: ['handle'], properties: { handle: handleParam } },
        body: body({ confirm: { type: 'string', maxLength: 64 }, reason: reasonSchema }, [
          'confirm',
          'reason',
        ]),
      },
    },
    async (request, reply) => {
      const { handle } = request.params as { handle: string };
      const b = request.body as { confirm: string; reason: string };
      return tool(request, reply, async (tx, adminId) => {
        const account = await targetAccount(tx, handle);
        await lockAdmin(tx, adminId);
        assertConfirmed(account.handle, b.confirm);
        // Revoking the admin's own sessions would end this one too: keep the current session.
        const keep = account.id === adminId ? (request.auth?.sessionId ?? null) : null;
        const n = await revokeSessions(tx, account.id, app.authNow(), keep);
        await adminAudit(tx, {
          event: 'admin.sessions.revoke',
          adminId,
          target: account,
          reason: b.reason,
          before: { sessions: n + (keep ? 1 : 0) },
          after: { sessions: keep ? 1 : 0 },
        });
        return { revoked: n };
      });
    },
  );

  admin.post(
    '/accounts/:handle/login-lock/clear',
    {
      schema: {
        params: { type: 'object', required: ['handle'], properties: { handle: handleParam } },
        body: body({ reason: reasonSchema }, ['reason']),
      },
    },
    async (request, reply) => {
      const { handle } = request.params as { handle: string };
      const b = request.body as { reason: string };
      return tool(request, reply, async (tx, adminId) => {
        const account = await targetAccount(tx, handle);
        await lockAdmin(tx, adminId);
        const key = throttleKey(account.email);
        // Ticket 6.9: read and cleared in this transaction (the shared store's row).
        const lockedForMs = await app.loginThrottle.lockedFor(key, tx);
        await app.loginThrottle.clear(key, tx);
        await adminAudit(tx, {
          event: 'admin.login_lock.clear',
          adminId,
          target: account,
          reason: b.reason,
          before: { lockedForMs },
          after: { lockedForMs: 0 },
        });
        return { wasLockedForMs: lockedForMs };
      });
    },
  );

  // ---- World ------------------------------------------------------------------------------------
  admin.get('/world', async (request) => {
    const rows = await app.db.select().from(worldFlags);
    const now = gameNow();
    const seasons = await listSeasons(app.db);
    const t = now.getTime();
    const current = seasons.find((s) => s.startsAt.getTime() <= t && t < s.endsAt.getTime());
    const next = seasons
      .filter((s) => s.startsAt.getTime() > t)
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0];
    const pendingArchive = seasons.filter((s) => s.endsAt.getTime() <= t && !s.archivedAt).length;
    const state = app.schedulerState;
    const [deleted] = await app.db
      .select({ n: count() })
      .from(characters)
      .where(sql`${characters.deletedAt} is not null`);
    await writeAudit(app.db, {
      event: 'admin.view',
      accountId: request.auth!.account.id,
      data: { section: 'world' },
    });
    return {
      gameNow: now.toISOString(),
      flags: WORLD_FLAG_IDS.map((id) => {
        const row = rows.find((r) => r.flagId === id);
        return {
          id,
          set: !!row,
          setAt: row?.setAt.toISOString() ?? null,
          projectId: row?.projectId ?? null,
        };
      }),
      scheduler: {
        running: state.intervalMs > 0,
        intervalMs: state.intervalMs,
        lastTickAt: state.lastTickAt?.toISOString() ?? null,
        nextTickAt: state.nextTickAt(now),
        jobs: SCHEDULER_JOBS.map((j) => ({ job: j, ...state.jobs[j] })),
      },
      seasons: {
        current: current ? { number: current.number, endsAt: current.endsAt.toISOString() } : null,
        next: next ? { number: next.number, startsAt: next.startsAt.toISOString() } : null,
        pendingArchive,
      },
      deletedHeroes: { total: deleted?.n ?? 0, ...(await purgeDueHint(app.db, app.authNow())) },
      // Ticket 6.7: the era (derived from the flags above) and every project's stage.
      era: (() => {
        const era = worldEra(worldFlagsFrom(rows.map((r) => r.flagId)));
        return { id: era.id, name: era.name, title: era.title, index: worldEraIndex(era.id) };
      })(),
      projects: (await projectProgressSummary(app.db)).map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        stage: p.stage,
        stages: p.stages,
        completedOn: p.completedOn,
        contributors: p.contributors,
      })),
      // Ticket 6.3: this week's boss modifier and next week's (public rotation, game clock).
      bossModifiers: {
        current: bossModifierWeekView(t),
        next: bossModifierWeekView(guildBossWeek(t).endMs),
      },
    };
  });

  admin.post(
    '/world/flags/:flagId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['flagId'],
          properties: { flagId: { type: 'string', enum: [...WORLD_FLAG_IDS] } },
        },
        body: body(
          {
            set: { type: 'boolean' },
            confirm: { type: 'string', maxLength: 64 },
            reason: reasonSchema,
          },
          ['set', 'confirm', 'reason'],
        ),
      },
    },
    async (request, reply) => {
      const { flagId } = request.params as { flagId: string };
      const b = request.body as { set: boolean; confirm: string; reason: string };
      if (!isWorldFlagId(flagId)) throw new ApiError(404, 'not_found', 'No such world flag.');
      const out = await tool(request, reply, async (tx, adminId) => {
        await lockAdmin(tx, adminId);
        assertConfirmed(flagId, b.confirm);
        // Ticket 6.7: the world lock, then the flags before, for the era this toggle may move.
        await lockWorldFlags(tx);
        const flagsBefore = (await loadWorldState(tx)).flags;
        const [row] = await tx
          .select()
          .from(worldFlags)
          .where(eq(worldFlags.flagId, flagId))
          .for('update');
        const was = !!row;
        if (b.set && !was) {
          await tx.insert(worldFlags).values({ flagId, projectId: null, setAt: gameNow() });
        } else if (!b.set && was) {
          await tx.delete(worldFlags).where(eq(worldFlags.flagId, flagId));
        }
        // Ticket 6.9: every instance's world state reloads when this commits.
        if (b.set !== was) await bumpCacheVersion(tx, 'world');
        // World-wide: the row sits on the admin's own account.
        await adminAudit(tx, {
          event: 'admin.world.flag',
          adminId,
          target: { id: adminId },
          reason: b.reason,
          before: { [flagId]: was },
          after: { [flagId]: b.set },
          data: { flagId, projectId: row?.projectId ?? null },
        });
        const era = await recordEraChange(
          tx,
          flagsBefore,
          { ...flagsBefore, [flagId]: b.set },
          gameNow(),
          { flagId, by: 'admin' },
        );
        return { flagId, before: was, after: b.set, era };
      });
      app.worldState.invalidate();
      return out;
    },
  );
}
