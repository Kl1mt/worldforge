import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  DUNGEON_IDS,
  applyXp,
  dungeonRunProgress,
  dungeonUnlockBlockers,
  getDungeon,
  isDungeonId,
  normalizeProfessions,
  simulateDungeonRun,
  type DungeonId,
  type DungeonRunProgress,
  type DungeonRunResult,
  type GameEvent,
  type MaterialId,
  type UnlockBlocker,
} from '@worldforge/game-core';
import {
  accounts,
  activities,
  characters,
  dungeonRuns,
  itemInstances,
  type Character,
  type DungeonRun,
} from '../db/schema.js';
import type { Executor, Transaction } from '../db/types.js';
import { withTransaction, constraintOf } from '../db/transaction.js';
import { writeAudit } from '../db/audit.js';
import { uuidv7 } from '../db/uuid.js';
import { ApiError } from '../errors.js';
import { characterView, type CharacterView } from '../characters/routes.js';
import {
  endActivityTx,
  newSeedSecret,
  settleActivityTx,
  type ActivityOptions,
} from '../activity/settle.js';
import { grantGatheringTx } from '../materials/store.js';
import { idempotencyRequest, idempotent } from '../idempotency/index.js';

/** A run as clients see it: what has happened so far, never the seed or the future. */
export interface DungeonRunView {
  id: string;
  characterId: string;
  dungeonId: DungeonId;
  startedAt: string;
  endsAt: string;
  /** Server time of this view. */
  now: string;
  bossLootEligible: boolean;
  progress: DungeonRunProgress;
}

export interface DungeonEntryView {
  id: DungeonId;
  unlocked: boolean;
  blockers: UnlockBlocker[];
  /** When boss loot can drop again for this character; null = now. */
  bossLootReadyAt: string | null;
}

export interface DungeonStateResponse {
  dungeons: DungeonEntryView[];
  /** This character's unclaimed run, if any. */
  run: DungeonRunView | null;
  /** Another character of the account with an unclaimed run (it blocks starting one here). */
  busyCharacterId: string | null;
  character: CharacterView;
}

export interface DungeonResultItem {
  id: string;
  baseId: string;
  rarityId: string;
  itemLevel: number;
}

/** What a claim granted. Stored on the run and replayed for a retried claim. */
export interface DungeonResultView {
  runId: string;
  dungeonId: DungeonId;
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
  materials: Partial<Record<MaterialId, number>>;
  bossDefeated: boolean;
  bossLoot: boolean;
  /** The first Gravewarden kill of this character (it opens the Sunken Abbey). */
  firstBossKill: boolean;
  /** Game events for quests (ticket 2.4). */
  questEvents: GameEvent[];
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
  properties: { dungeonId: { type: 'string', maxLength: 64 } },
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
    .where(and(eq(characters.id, characterId), eq(characters.accountId, accountId)))
    .for('no key update');
  if (!c) throw notFound();
  return c;
}

/** Replays the run from its seed and snapshot (pure; the stored row is all it needs). */
export function replayRun(run: DungeonRun, inventoryCount = 0): DungeonRunResult {
  return simulateDungeonRun({
    dungeonId: run.dungeonId,
    character: {
      classId: run.snapshot.classId,
      level: run.snapshot.level,
      xp: run.snapshot.xp,
    },
    equipment: run.snapshot.equipment,
    seed: run.seedSecret,
    bossLootEligible: run.bossLootEligible,
    inventoryCount,
  });
}

export function runView(run: DungeonRun, now: Date): DungeonRunView {
  const elapsed = now.getTime() - run.startedAt.getTime();
  return {
    id: run.id,
    characterId: run.characterId,
    dungeonId: run.dungeonId,
    startedAt: run.startedAt.toISOString(),
    endsAt: run.endsAt.toISOString(),
    now: now.toISOString(),
    bossLootEligible: run.bossLootEligible,
    progress: dungeonRunProgress(replayRun(run), elapsed),
  };
}

/** Start of the last run that granted boss loot in this dungeon, if still within the cooldown. */
async function bossLootReadyAt(
  db: Executor,
  characterId: string,
  dungeonId: DungeonId,
  now: Date,
): Promise<Date | null> {
  const cooldownMs = getDungeon(dungeonId).bossLoot.cooldownHours * HOUR;
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
      .where(and(eq(characters.id, characterId), eq(characters.accountId, accountId)))
      .limit(1);
    if (!character) throw notFound();
    const now = options.now();
    const open = await openRunOfAccount(app.db, accountId);
    const dungeons: DungeonEntryView[] = [];
    for (const id of DUNGEON_IDS) {
      const blockers = dungeonUnlockBlockers(id, { level: character.level }, character.progress);
      const ready = await bossLootReadyAt(app.db, characterId, id, now);
      dungeons.push({
        id,
        unlocked: blockers.length === 0,
        blockers,
        bossLootReadyAt: ready?.toISOString() ?? null,
      });
    }
    return {
      dungeons,
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
  app.post<IdParams & { Body: { dungeonId: string } }>(
    '/characters/:characterId/dungeon',
    { preHandler: app.requireAccount, schema: { params: idParamsSchema, body: startBodySchema } },
    async (request, reply) => {
      const accountId = request.auth!.account.id;
      const { characterId } = request.params;
      const { dungeonId } = request.body;
      if (!isDungeonId(dungeonId)) {
        throw new ApiError(400, 'validation_failed', 'Some fields need attention.', {
          fields: { dungeonId: `Choose one of: ${DUNGEON_IDS.join(', ')}.` },
        });
      }
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
            data: { reason: 'dungeon_started', dungeonId },
          });
        }

        // Unlocks use the level after settling.
        const character = await lockOwnedCharacter(tx, accountId, characterId);
        const blockers = dungeonUnlockBlockers(
          dungeonId,
          { level: character.level },
          character.progress,
        );
        if (blockers.length > 0) {
          throw new ApiError(409, 'dungeon_locked', 'This dungeon is not open to this hero yet.', {
            dungeonId,
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
          })
          .from(itemInstances)
          .where(
            and(eq(itemInstances.characterId, characterId), isNotNull(itemInstances.equippedSlot)),
          );
        const ready = await bossLootReadyAt(tx, characterId, dungeonId, now);
        const row = {
          id: uuidv7(),
          characterId,
          accountId,
          dungeonId,
          seedSecret: newSeedSecret(),
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
          data: { runId: run.id, dungeonId, bossLootEligible: run.bossLootEligible },
        });
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
      const idem = idempotencyRequest(request, accountId);
      const out = await withTransaction(app.db, async (tx) => {
        const character = await lockOwnedCharacter(tx, accountId, characterId);
        const now = options.now();
        return idempotent<DungeonClaimResponse>(tx, idem, now, async () => {
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
            .where(
              and(eq(itemInstances.characterId, characterId), isNull(itemInstances.equippedSlot)),
            );
          const r = replayRun(run, inventory?.n ?? 0);

          // XP is added to the character's current level and XP (the snapshot only fixed the run).
          const { level, xp } = applyXp(
            { level: character.level, xp: character.experience },
            r.xpGained,
          );

          const rows = r.items.map((item) => ({
            id: uuidv7(),
            characterId,
            baseId: item.baseId,
            rarityId: item.rarityId,
            itemLevel: item.itemLevel,
            affixes: item.affixes,
            seed: item.seed,
            equippedSlot: null,
            source: `dungeon:${run.dungeonId}`,
            createdAt: now,
          }));
          if (rows.length > 0) await tx.insert(itemInstances).values(rows);
          const none = normalizeProfessions({});
          await grantGatheringTx(tx, characterId, r.materials, none, none, now);

          const gold = r.goldLooted + r.goldSalvaged;
          const firstBossKill = r.bossDefeated && !character.progress.gravewardenDefeated;
          const [written] = await tx
            .update(characters)
            .set({
              level,
              experience: xp,
              gold: sql`${characters.gold} + ${gold}`,
              ...(r.bossDefeated
                ? { progress: { ...character.progress, gravewardenDefeated: true } }
                : {}),
              version: sql`${characters.version} + 1`,
              updatedAt: now,
            })
            .where(eq(characters.id, characterId))
            .returning();

          const result: DungeonResultView = {
            runId: run.id,
            dungeonId: run.dungeonId,
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
            })),
            itemsSalvaged: r.salvaged.length,
            materials: r.materials,
            bossDefeated: r.bossDefeated,
            bossLoot: r.bossLoot,
            firstBossKill,
            questEvents: r.questEvents,
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
              outcome: r.outcome,
              xp: r.xpGained,
              gold,
              items: rows.length,
              itemsSalvaged: r.salvaged.length,
              materials: r.materials,
              bossLoot: r.bossLoot,
              questEvents: r.questEvents,
            },
          });
          return {
            statusCode: 200,
            body: { result, character: characterView(written!) },
          };
        });
      });
      return reply.code(out.statusCode).send(out.body);
    },
  );
}
