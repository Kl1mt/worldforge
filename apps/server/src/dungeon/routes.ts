import { refreshAchievements } from '../achievements/award.js';
import { packItemsWhere } from '../inventory/routes.js';
import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  RARITY_IDS,
  hoardSource,
  DUNGEON_IDS,
  applyXp,
  bossModifierOfWeek,
  cryptTierCleared,
  tierTakesBossModifier,
  dungeonRunProgress,
  dungeonUnlockBlockers,
  filteredTotals,
  getDungeon,
  getLootTable,
  hasDungeonTier,
  isDungeonId,
  isDungeonTier,
  normalizeProfessions,
  simulateDungeonRun,
  type BossModifierId,
  type DungeonId,
  type DungeonRunProgress,
  type DungeonRunResult,
  type DungeonTier,
  type ItemVariantId,
  type LootFilterAction,
  type LootFilterRules,
  type MaterialId,
  type QuestEvent,
  type UnlockBlocker,
  type WorldProgress,
} from '@worldforge/game-core';
import {
  accounts,
  activities,
  characters,
  dungeonRuns,
  itemInstances,
  type Character,
  type DungeonRun,
  type LootFilterSummary,
} from '../db/schema.js';
import { itemBindingColumns, itemEffectColumns } from '../inventory/columns.js';
import type { Executor, Transaction } from '../db/types.js';
import { withTransaction, constraintOf } from '../db/transaction.js';
import { writeAudit } from '../db/audit.js';
import { recordTelemetry } from '../telemetry/record.js';
import {
  goldIn,
  materialCounts,
  overflowCounts,
  overCapacityCounts,
  rolledDropCounts,
  xpIn,
} from '../telemetry/counts.js';
import type { TelemetryCount } from '../telemetry/record.js';
import { uuidv7 } from '../db/uuid.js';
import { ApiError } from '../errors.js';
import { characterView, type CharacterView } from '../characters/routes.js';
import {
  endActivityTx,
  filterAudit,
  newSeedSecret,
  settleActivityTx,
  type ActivityOptions,
} from '../activity/settle.js';
import { changeMaterialsTx, grantGatheringTx } from '../materials/store.js';
import { recordQuestEventsTx } from '../quests/store.js';
import { idempotentTransaction } from '../idempotency/index.js';
import {
  bossModifierView,
  bossModifierWeekView,
  type BossModifierView,
  type BossModifierWeekView,
} from '../world/boss-modifier.js';

/** A run as clients see it: what has happened so far, never the seed or the future. */
export interface DungeonRunView {
  id: string;
  characterId: string;
  dungeonId: DungeonId;
  /** Ticket 3.6. */
  tier: DungeonTier;
  /** Ticket 6.3: the boss modifier this run fights (its start's week); null = none. */
  bossModifier: BossModifierView | null;
  startedAt: string;
  endsAt: string;
  /** Server time of this view. */
  now: string;
  bossLootEligible: boolean;
  progress: DungeonRunProgress;
}

/** What a tier favours (ticket 3.6, game-core `LootFocus`). */
export interface LootFocusView {
  id: string;
  name: string;
  description: string;
}

/** One tier of a dungeon as the character sees it (ticket 3.6). */
export interface DungeonTierView {
  tier: DungeonTier;
  name: string;
  unlocked: boolean;
  blockers: UnlockBlocker[];
  minLevel: number;
  maxLevel: number;
  bossLevel: number;
  lootFocus: LootFocusView | null;
  /** Ticket 6.3: the Heroic tier (drawn with the Heroic treatment). */
  heroic: boolean;
  /** Ticket 6.3: whether the weekly boss modifier applies here (crypt tier I: never). */
  takesModifier: boolean;
}

export interface DungeonEntryView {
  id: DungeonId;
  /** Tier I (the dungeon itself). */
  unlocked: boolean;
  blockers: UnlockBlocker[];
  /** When boss loot can drop again for this character (any tier); null = now. */
  bossLootReadyAt: string | null;
  /** Ticket 3.6: every tier, in order. */
  tiers: DungeonTierView[];
  /** Ticket 6.3: this week's boss modifier (a run started now fights it). */
  bossModifier: BossModifierView;
  /** The deepest tier this character has cleared (0 = none). */
  tierCleared: number;
}

export interface DungeonStateResponse {
  dungeons: DungeonEntryView[];
  /** Ticket 6.3: this week's boss modifier and its week (the same on every boss). */
  bossModifier: BossModifierWeekView;
  /** This character's unclaimed run, if any. */
  run: DungeonRunView | null;
  /** Another character of the account with an unclaimed run (it blocks starting one here). */
  busyCharacterId: string | null;
  character: CharacterView;
}

/** A drop the loot filter handled at the claim (ticket 3.7); it was never an owned item. */
export interface FilteredItemView {
  baseId: string;
  rarityId: string;
  itemLevel: number;
  action: LootFilterAction;
}

export interface DungeonResultItem {
  id: string;
  baseId: string;
  rarityId: string;
  itemLevel: number;
  /**
   * Ticket 3.5: what the drop moment shows (as in the return summary); absent on plain items and
   * in results stored before it.
   */
  effectId?: string;
  mythicId?: string;
  setId?: string;
  variant?: ItemVariantId;
}

/** What a claim granted. Stored on the run and replayed for a retried claim. */
export interface DungeonResultView {
  runId: string;
  dungeonId: DungeonId;
  /** Ticket 3.6; absent in results stored before it (tier I). */
  tier?: DungeonTier;
  /** Ticket 6.3: the modifier the run fought; absent without one (and before 6.3). */
  bossModifier?: BossModifierId;
  outcome: 'cleared' | 'failed';
  durationMs: number;
  roomsCleared: number;
  totalRooms: number;
  kills: number;
  xpGained: number;
  levelsGained: number;
  goldGained: number;
  goldSalvaged: number;
  items: DungeonResultItem[];
  itemsSalvaged: number;
  /**
   * Ticket B.2: valuable drops among `items` kept beyond the pack's capacity. Absent when none
   * (and in results claimed before B.2).
   */
  itemsOverCapacity?: number;
  materials: Partial<Record<MaterialId, number>>;
  bossDefeated: boolean;
  bossLoot: boolean;
  /** The first Gravewarden kill of this character (it opens the Sunken Abbey). */
  firstBossKill: boolean;
  /** Ticket 3.6: this claim cleared the tier for the first time (the next tier may open). */
  firstTierClear?: boolean;
  /** Game events for quests (ticket 2.4). */
  questEvents: QuestEvent[];
  /**
   * Ticket 3.7: drops the loot filter sold or salvaged at the claim (their gold is part of
   * `goldGained`, their materials are not part of `materials`). Absent when nothing was filtered.
   */
  filtered?: LootFilterSummary & { items: FilteredItemView[] };
}

export interface DungeonClaimResponse {
  result: DungeonResultView;
  character: CharacterView;
}

const idParamsSchema = {
  type: 'object',
  required: ['characterId'],
  properties: { characterId: { type: 'string', format: 'uuid' } },
} as const;

const startBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['dungeonId'],
  properties: {
    dungeonId: { type: 'string', maxLength: 64 },
    /** Ticket 3.6; default 1. */
    tier: { type: 'integer', minimum: 1, maximum: 9 },
  },
} as const;

type IdParams = { Params: { characterId: string } };

const notFound = () => new ApiError(404, 'not_found', 'No such character.');
const noRun = () =>
  new ApiError(409, 'no_dungeon_run', 'This character has no dungeon run to settle or claim.');

const HOUR = 60 * 60 * 1000;

async function lockOwnedCharacter(
  tx: Transaction,
  accountId: string,
  characterId: string,
): Promise<Character> {
  const [c] = await tx
    .select()
    .from(characters)
    .where(
      and(
        eq(characters.id, characterId),
        eq(characters.accountId, accountId),
        isNull(characters.deletedAt),
      ),
    )
    .for('no key update');
  if (!c) throw notFound();
  return c;
}

/** Replays the run from its seed and snapshot (pure; the stored row is all it needs). */
export function replayRun(
  run: DungeonRun,
  inventoryCount = 0,
  lootFilter: LootFilterRules | null = null,
): DungeonRunResult {
  return simulateDungeonRun({
    dungeonId: run.dungeonId,
    tier: run.tier,
    character: {
      classId: run.snapshot.classId,
      level: run.snapshot.level,
      xp: run.snapshot.xp,
    },
    equipment: run.snapshot.equipment,
    seed: run.seedSecret,
    bossLootEligible: run.bossLootEligible,
    inventoryCount,
    lootFilter,
    // Ticket 6.3: the run's own stored modifier (null for runs from before it: as they were).
    bossModifier: run.bossModifier ?? null,
  });
}

/**
 * Which of a run's drops (by generation seed) came from the boss hoard (tickets 3.8, T.1): when
 * the hoard dropped, the run is replayed without it (the hoard has its own RNG stream, so the
 * chambers roll the same items) and the drops it lacks are the hoard's. If content changed since
 * the run, the replay may roll other chamber items; their drops then count as the hoard's, which
 * binds them (the safe side).
 */
export function hoardDrops(run: DungeonRun, bossLoot: boolean): (seed: number) => boolean {
  if (!bossLoot) return () => false;
  const chambers = replayRun({ ...run, bossLootEligible: false });
  const seeds = new Set([...chambers.items, ...chambers.salvaged].map((i) => i.seed));
  return (seed) => !seeds.has(seed);
}

/**
 * Ticket 3.8: a claim's telemetry. Drops are split into chamber drops (`crypt`) and the boss hoard
 * (`crypt_hoard`): when the hoard dropped, the run is replayed without it (the hoard has its own
 * RNG stream, so the chambers roll the same items) and the drops it lacks are the hoard's.
 */
export function claimTelemetry(
  run: DungeonRun,
  r: DungeonRunResult,
  hoard: (seed: number) => boolean = hoardDrops(run, r.bossLoot),
): TelemetryCount[] {
  const context = `${run.dungeonId}:${run.tier}`;
  const filtered = r.filtered ?? [];
  const part = (inHoard: boolean) => ({
    items: r.items.filter((i) => hoard(i.seed) === inHoard),
    overCapacity: r.overCapacity.filter((i) => hoard(i.seed) === inHoard),
    salvaged: r.salvaged.filter((i) => hoard(i.seed) === inHoard),
    filtered: filtered.filter((f) => hoard(f.item.seed) === inHoard),
  });
  const filter = filteredTotals(r.filtered);
  const won = r.outcome === 'cleared' ? 'won' : 'lost';
  // Ticket 6.3: win rates and hoard loot per boss modifier (`none` before 6.3), for B.5.
  const modifier = run.bossModifier ?? 'none';
  const hoardItems = [...r.items, ...r.salvaged, ...filtered.map((f) => f.item)].filter((i) =>
    hoard(i.seed),
  );
  const byRarity = new Map<string, number>();
  for (const i of hoardItems) byRarity.set(i.rarityId, (byRarity.get(i.rarityId) ?? 0) + 1);
  return [
    {
      metric: 'crypt.claim',
      dims: [context, won, r.bossLoot ? 'hoard' : 'no_hoard'],
    },
    { metric: 'boss_modifier.run', dims: [modifier, context, won] },
    ...[...byRarity].map(([rarity, n]): TelemetryCount => ({
      metric: 'boss_modifier.hoard',
      dims: [modifier, context, rarity],
      amount: n,
    })),
    ...rolledDropCounts('crypt', context, part(false)),
    ...rolledDropCounts('crypt_hoard', context, part(true)),
    ...overflowCounts('crypt', context, r.salvaged.length),
    ...overCapacityCounts('crypt', context, r.overCapacity.length),
    ...goldIn('crypt_loot', context, r.goldLooted),
    ...goldIn('crypt_overflow', context, r.goldSalvaged),
    ...goldIn('crypt_filter', context, filter.gold),
    ...xpIn('crypt', context, r.xpGained),
    ...materialCounts('material.in', 'crypt_loot', r.materials),
    ...materialCounts('material.in', 'crypt_filter', filter.materials),
  ];
}

export function runView(run: DungeonRun, now: Date): DungeonRunView {
  const elapsed = now.getTime() - run.startedAt.getTime();
  return {
    id: run.id,
    characterId: run.characterId,
    dungeonId: run.dungeonId,
    tier: run.tier,
    bossModifier: run.bossModifier ? bossModifierView(run.bossModifier) : null,
    startedAt: run.startedAt.toISOString(),
    endsAt: run.endsAt.toISOString(),
    now: now.toISOString(),
    bossLootEligible: run.bossLootEligible,
    progress: dungeonRunProgress(replayRun(run), elapsed),
  };
}

/** The deepest tier of a dungeon the character has cleared (ticket 4.8: per dungeon). */
function tierClearedIn(dungeonId: DungeonId, progress: WorldProgress): number {
  if (dungeonId === 'namelessCrypt') return cryptTierCleared(progress);
  // Ticket 6.2: a boss-only dungeon has one tier, cleared once its boss fell (its progress flag).
  return progress[getDungeon(dungeonId).bossProgress] === true ? 1 : 0;
}

/** Start of the last run that granted boss loot in this dungeon, if still within the cooldown. */
async function bossLootReadyAt(
  db: Executor,
  characterId: string,
  dungeonId: DungeonId,
  now: Date,
): Promise<Date | null> {
  // One cooldown for every tier of a dungeon (ticket 3.6).
  const cooldownMs = getDungeon(dungeonId).bossLootCooldownHours * HOUR;
  const [last] = await db
    .select({ startedAt: dungeonRuns.startedAt })
    .from(dungeonRuns)
    .where(
      and(
        eq(dungeonRuns.characterId, characterId),
        eq(dungeonRuns.dungeonId, dungeonId),
        eq(dungeonRuns.bossLootGranted, true),
        gt(dungeonRuns.startedAt, new Date(now.getTime() - cooldownMs)),
      ),
    )
    .orderBy(desc(dungeonRuns.startedAt))
    .limit(1);
  return last ? new Date(last.startedAt.getTime() + cooldownMs) : null;
}

async function openRunOfAccount(db: Executor, accountId: string): Promise<DungeonRun | undefined> {
  const [run] = await db
    .select()
    .from(dungeonRuns)
    .where(and(eq(dungeonRuns.accountId, accountId), isNull(dungeonRuns.claimedAt)))
    .limit(1);
  return run;
}

/** Refuses farming while the account has an unclaimed dungeon run (used by the activity start). */
export async function assertNoOpenDungeonRun(tx: Transaction, accountId: string): Promise<void> {
  const run = await openRunOfAccount(tx, accountId);
  if (run) {
    throw new ApiError(409, 'in_dungeon', 'A hero of this account is in a dungeon.', {
      characterId: run.characterId,
      runId: run.id,
    });
  }
}

export async function registerDungeons(
  app: FastifyInstance,
  options: ActivityOptions,
): Promise<void> {
  async function state(accountId: string, characterId: string): Promise<DungeonStateResponse> {
    const [character] = await app.db
      .select()
      .from(characters)
      .where(
        and(
          eq(characters.id, characterId),
          eq(characters.accountId, accountId),
          isNull(characters.deletedAt),
        ),
      )
      .limit(1);
    if (!character) throw notFound();
    const now = options.now();
    const week = bossModifierWeekView(now.getTime());
    const open = await openRunOfAccount(app.db, accountId);
    // Ticket 4.8: world flags open dungeons for everyone (the Warden's Watch).
    const world = await app.worldState.flags();
    const dungeons: DungeonEntryView[] = [];
    for (const id of DUNGEON_IDS) {
      const tiers = getDungeon(id).tiers.map((t): DungeonTierView => {
        const blockers = dungeonUnlockBlockers(
          id,
          { level: character.level, world },
          character.progress,
          t.tier,
        );
        const focus = getLootTable(t.bossLoot.lootTableId).focus;
        return {
          tier: t.tier,
          name: t.name,
          unlocked: blockers.length === 0,
          blockers,
          minLevel: t.minLevel,
          maxLevel: t.maxLevel,
          bossLevel: t.bossLevel,
          lootFocus: focus
            ? { id: focus.id, name: focus.name, description: focus.description }
            : null,
          heroic: t.heroic === true,
          takesModifier: t.bossModifiers !== false,
        };
      });
      const ready = await bossLootReadyAt(app.db, characterId, id, now);
      dungeons.push({
        id,
        unlocked: tiers[0]!.unlocked,
        blockers: tiers[0]!.blockers,
        bossLootReadyAt: ready?.toISOString() ?? null,
        tiers,
        bossModifier: week.modifier,
        tierCleared: tierClearedIn(id, character.progress),
      });
    }
    return {
      dungeons,
      bossModifier: week,
      run: open && open.characterId === characterId ? runView(open, now) : null,
      busyCharacterId: open && open.characterId !== characterId ? open.characterId : null,
      character: characterView(character),
    };
  }

  /** Dungeons of the character, and its run so far (read-only). */
  app.get<IdParams>(
    '/characters/:characterId/dungeon',
    { preHandler: app.requireAccount, schema: { params: idParamsSchema } },
    async (request) => state(request.auth!.account.id, request.params.characterId),
  );

  /**
   * Enter a dungeon with the account's active character. Any farming of the account is settled
   * and stopped first (a run never stacks with farming). One unclaimed run per account.
   */
  app.post<IdParams & { Body: { dungeonId: string; tier?: number } }>(
    '/characters/:characterId/dungeon',
    { preHandler: app.requireAccount, schema: { params: idParamsSchema, body: startBodySchema } },
    async (request, reply) => {
      const accountId = request.auth!.account.id;
      const { characterId } = request.params;
      const { dungeonId } = request.body;
      const tier = request.body.tier ?? 1;
      if (!isDungeonId(dungeonId)) {
        throw new ApiError(400, 'validation_failed', 'Some fields need attention.', {
          fields: { dungeonId: `Choose one of: ${DUNGEON_IDS.join(', ')}.` },
        });
      }
      // Ticket 4.8: a tier the dungeon has (the Warden's Watch has only tier I).
      if (!isDungeonTier(tier) || !hasDungeonTier(dungeonId, tier)) {
        const tiers = getDungeon(dungeonId).tiers.map((t) => t.tier);
        throw new ApiError(400, 'validation_failed', 'Some fields need attention.', {
          fields: { tier: `Choose one of: ${tiers.join(', ')}.` },
        });
      }
      const world = await app.worldState.flags();
      const result = await withTransaction(app.db, async (tx) => {
        // Same lock order as the activity start: account, then character.
        const [account] = await tx
          .select({ activeCharacterId: accounts.activeCharacterId })
          .from(accounts)
          .where(eq(accounts.id, accountId))
          .for('no key update');
        await lockOwnedCharacter(tx, accountId, characterId);
        if (account?.activeCharacterId !== characterId) {
          throw new ApiError(
            409,
            'character_not_active',
            'Select this character before sending it into a dungeon.',
          );
        }
        const open = await openRunOfAccount(tx, accountId);
        if (open) {
          throw new ApiError(
            409,
            'dungeon_run_open',
            open.characterId === characterId
              ? 'Finish and claim the current run first.'
              : 'Another hero of this account is in a dungeon.',
            { characterId: open.characterId, runId: open.id },
          );
        }

        // Leave the fields: settle and stop every farming activity of the account.
        const farming = await tx
          .select({ characterId: activities.characterId })
          .from(activities)
          .where(eq(activities.accountId, accountId));
        for (const a of farming) {
          const settled = await settleActivityTx(tx, a.characterId, options, { touch: true });
          if (settled) await endActivityTx(tx, settled.activity);
          await writeAudit(tx, {
            event: 'activity.stop',
            accountId,
            characterId: a.characterId,
            data: { reason: 'dungeon_started', dungeonId, tier },
          });
        }

        // Unlocks use the level after settling.
        const character = await lockOwnedCharacter(tx, accountId, characterId);
        const blockers = dungeonUnlockBlockers(
          dungeonId,
          { level: character.level, world },
          character.progress,
          tier,
        );
        if (blockers.length > 0) {
          throw new ApiError(409, 'dungeon_locked', 'This dungeon is not open to this hero yet.', {
            dungeonId,
            tier,
            blockers,
          });
        }

        const now = options.now();
        const equipped = await tx
          .select({
            baseId: itemInstances.baseId,
            rarityId: itemInstances.rarityId,
            itemLevel: itemInstances.itemLevel,
            affixes: itemInstances.affixes,
            effectId: itemInstances.effectId,
            effectRoll: itemInstances.effectRoll,
            setId: itemInstances.setId,
            upgradeLevel: itemInstances.upgradeLevel,
            variant: itemInstances.variant,
            awakening: itemInstances.awakening,
          })
          .from(itemInstances)
          .where(
            and(eq(itemInstances.characterId, characterId), isNotNull(itemInstances.equippedSlot)),
          );
        const ready = await bossLootReadyAt(tx, characterId, dungeonId, now);
        // Ticket 6.3: the modifier of the week this transaction's clock reads (the window rule:
        // stored with the run, so a run that ends after Monday keeps its own week's modifier).
        // Crypt tier I never takes one (owner decision): it stores null, like a run from before 6.3.
        const bossModifier = tierTakesBossModifier(dungeonId, tier)
          ? bossModifierOfWeek(now.getTime()).id
          : null;
        const row = {
          id: uuidv7(),
          characterId,
          accountId,
          dungeonId,
          tier,
          seedSecret: newSeedSecret(),
          bossModifier,
          snapshot: {
            classId: character.classId,
            level: character.level,
            xp: character.experience,
            equipment: equipped,
          },
          bossLootEligible: ready === null,
          startedAt: now,
          endsAt: now,
          createdAt: now,
        };
        const plan = replayRun({
          ...row,
          claimedAt: null,
          outcome: null,
          bossLootGranted: false,
          result: null,
        });
        row.endsAt = new Date(now.getTime() + plan.durationMs);
        let run: DungeonRun;
        try {
          [run] = (await tx.insert(dungeonRuns).values(row).returning()) as [DungeonRun];
        } catch (err) {
          if (constraintOf(err) === 'dungeon_runs_account_open_key') {
            throw new ApiError(409, 'dungeon_run_open', 'Another run of this account is open.');
          }
          throw err;
        }
        await writeAudit(tx, {
          event: 'dungeon.start',
          accountId,
          characterId,
          data: {
            runId: run.id,
            dungeonId,
            tier,
            bossModifier,
            bossLootEligible: run.bossLootEligible,
          },
        });
        recordTelemetry(tx, now, [
          {
            metric: 'crypt.start',
            dims: [`${dungeonId}:${tier}`, run.bossLootEligible ? 'hoard_eligible' : 'on_cooldown'],
          },
        ]);
        return { run, character, now };
      });
      return reply.code(201).send({
        run: runView(result.run, result.now),
        character: characterView(result.character),
      });
    },
  );

  /**
   * Settle a run: reveal what has happened up to now. The run was fixed at its start, so this
   * writes nothing and returns the same story however often it is called.
   */
  app.post<IdParams>(
    '/characters/:characterId/dungeon/settle',
    { preHandler: app.requireAccount, schema: { params: idParamsSchema } },
    async (request): Promise<{ run: DungeonRunView }> => {
      const s = await state(request.auth!.account.id, request.params.characterId);
      if (!s.run) throw noRun();
      return { run: s.run };
    },
  );

  /**
   * Claim a finished run's result: XP, gold, items, materials and — for a boss kill —
   * `gravewardenDefeated`. Requires `Idempotency-Key`; a run is granted once (state guard:
   * `claimed_at`), and a retried claim with the same key returns the stored result.
   */
  app.post<IdParams>(
    '/characters/:characterId/dungeon/claim',
    { preHandler: app.requireAccount, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const accountId = request.auth!.account.id;
      const { characterId } = request.params;
      return idempotentTransaction<DungeonClaimResponse>(
        app,
        request,
        reply,
        { now: options.now },
        async (tx) => {
          // Character, then run row: the claim's state guard (one grant per run).
          const character = await lockOwnedCharacter(tx, accountId, characterId);
          const now = options.now();
          const [run] = await tx
            .select()
            .from(dungeonRuns)
            .where(and(eq(dungeonRuns.characterId, characterId), isNull(dungeonRuns.claimedAt)))
            .for('update');
          if (!run) throw noRun();
          if (now.getTime() < run.endsAt.getTime()) {
            throw new ApiError(409, 'run_in_progress', 'The run is not over yet.', {
              endsAt: run.endsAt.toISOString(),
            });
          }
          const [inventory] = await tx
            .select({ n: count() })
            .from(itemInstances)
            // Ticket 4.7: warehouse items take no pack slot.
            .where(packItemsWhere(characterId));
          // Ticket 3.7: the loot filter in force now, read with the locked character row.
          const r = replayRun(run, inventory?.n ?? 0, character.lootFilter);
          const filter = filteredTotals(r.filtered);
          const filteredCount = r.filtered?.length ?? 0;

          // XP is added to the character's current level and XP (the snapshot only fixed the run).
          const { level, xp } = applyXp(
            { level: character.level, xp: character.experience },
            r.xpGained,
          );

          // Ticket T.1: boss-hoard drops are stored as `hoard:<dungeon>` and are always account-bound;
          // chamber drops follow the rarity table (docs/TRADING.md "By source").
          const hoard = hoardDrops(run, r.bossLoot);
          const rows = r.items.map((item) => {
            const source = hoard(item.seed)
              ? hoardSource(run.dungeonId)
              : `dungeon:${run.dungeonId}`;
            return {
              id: uuidv7(),
              characterId,
              baseId: item.baseId,
              rarityId: item.rarityId,
              itemLevel: item.itemLevel,
              affixes: item.affixes,
              seed: item.seed,
              ...itemEffectColumns(item),
              ...itemBindingColumns(item, source, accountId),
              equippedSlot: null,
              source,
              createdAt: now,
            };
          });
          if (rows.length > 0) await tx.insert(itemInstances).values(rows);
          const none = normalizeProfessions({});
          await grantGatheringTx(tx, characterId, r.materials, none, none, now);
          await changeMaterialsTx(tx, characterId, filter.materials, now);

          // Quests (ticket 2.4): a Gravewarden kill completes the story's last step. The character
          // row is locked above, as recordQuestEventsTx requires (docs/QUESTS.md). Only quests
          // taken before the run started count it (ticket 2.8): the run was fought then, so
          // accepting the step after the run has ended but before claiming does not complete it.
          await recordQuestEventsTx(tx, characterId, r.questEvents, { acceptedBy: run.startedAt });

          const gold = r.goldLooted + r.goldSalvaged + filter.gold;
          // Ticket 4.8: each dungeon keeps its own boss progress (the crypt's gates the Abbey and
          // the deeper tiers; the Watch's the Cinderwastes). Ticket 6.2: the flag is data
          // (`bossProgress`; the Tyrant's Forge sets `forgeTyrantDefeated`).
          const crypt = run.dungeonId === 'namelessCrypt';
          const flag = getDungeon(run.dungeonId).bossProgress;
          const firstBossKill = r.bossDefeated && character.progress[flag] !== true;
          // Ticket 3.6: a boss kill clears the run's tier (the next tier's gate).
          const clearedBefore = tierClearedIn(run.dungeonId, character.progress);
          const firstTierClear = r.bossDefeated && run.tier > clearedBefore;
          const progress: WorldProgress = crypt
            ? {
                ...character.progress,
                gravewardenDefeated: true,
                cryptTierCleared: Math.max(clearedBefore, run.tier),
              }
            : { ...character.progress, [flag]: true };
          const [written] = await tx
            .update(characters)
            .set({
              level,
              experience: xp,
              gold: sql`${characters.gold} + ${gold}`,
              ...(r.bossDefeated ? { progress } : {}),
              version: sql`${characters.version} + 1`,
              updatedAt: now,
            })
            .where(eq(characters.id, characterId))
            .returning();
          // Ticket 4.2: achievements from the claim (drops, levels, the boss and the tier).
          await refreshAchievements(
            tx,
            written!,
            [
              'maxRarity',
              'maxCharacterLevel',
              ...(r.bossDefeated && crypt
                ? (['gravewardenDefeated', 'cryptTierCleared'] as const)
                : []),
            ],
            now,
          );

          const result: DungeonResultView = {
            runId: run.id,
            dungeonId: run.dungeonId,
            tier: run.tier,
            ...(r.bossModifier ? { bossModifier: r.bossModifier } : {}),
            outcome: r.outcome,
            durationMs: r.durationMs,
            roomsCleared: r.roomsCleared,
            totalRooms: r.totalRooms,
            kills: r.kills,
            xpGained: r.xpGained,
            levelsGained: level - character.level,
            goldGained: gold,
            goldSalvaged: r.goldSalvaged,
            items: rows.map((x) => ({
              id: x.id,
              baseId: x.baseId,
              rarityId: x.rarityId,
              itemLevel: x.itemLevel,
              ...(x.effectId ? { effectId: x.effectId } : {}),
              ...(x.mythicId ? { mythicId: x.mythicId } : {}),
              ...(x.setId ? { setId: x.setId } : {}),
              ...(x.variant ? { variant: x.variant } : {}),
            })),
            itemsSalvaged: r.salvaged.length,
            ...(r.overCapacity.length > 0 ? { itemsOverCapacity: r.overCapacity.length } : {}),
            materials: r.materials,
            bossDefeated: r.bossDefeated,
            bossLoot: r.bossLoot,
            firstBossKill,
            firstTierClear,
            questEvents: r.questEvents,
            ...(filteredCount > 0
              ? {
                  filtered: {
                    sold: filter.sold,
                    salvaged: filter.salvaged,
                    gold: filter.gold,
                    materials: filter.materials,
                    items: r.filtered!.map(({ item, action }) => ({
                      baseId: item.baseId,
                      rarityId: item.rarityId,
                      itemLevel: item.itemLevel,
                      action,
                    })),
                  },
                }
              : {}),
          };
          await tx
            .update(dungeonRuns)
            .set({
              claimedAt: now,
              outcome: r.outcome,
              bossLootGranted: r.bossLoot,
              result: result as unknown as Record<string, unknown>,
            })
            .where(eq(dungeonRuns.id, run.id));
          await writeAudit(tx, {
            event: 'dungeon.claim',
            accountId,
            characterId,
            data: {
              runId: run.id,
              dungeonId: run.dungeonId,
              tier: run.tier,
              bossModifier: run.bossModifier ?? null,
              outcome: r.outcome,
              xp: r.xpGained,
              gold,
              items: rows.length,
              // Ticket T.1 (provenance): every Epic and better item by id, as farming lists them.
              notableItems: rows
                .filter((x) => RARITY_IDS.indexOf(x.rarityId) >= RARITY_IDS.indexOf('epic'))
                .map((x) => ({
                  id: x.id,
                  baseId: x.baseId,
                  rarityId: x.rarityId,
                  seed: x.seed,
                  ...(x.source.startsWith('hoard:') ? { hoard: true } : {}),
                })),
              itemsSalvaged: r.salvaged.length,
              ...(r.overCapacity.length > 0 ? { itemsOverCapacity: r.overCapacity.length } : {}),
              materials: r.materials,
              bossLoot: r.bossLoot,
              questEvents: r.questEvents,
              ...(filteredCount > 0 ? { filtered: filterAudit(r.filtered!, filter) } : {}),
            },
          });
          recordTelemetry(tx, now, claimTelemetry(run, r, hoard));
          return { result, character: characterView(written!) };
        },
      );
    },
  );
}
