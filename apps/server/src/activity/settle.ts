import { randomBytes } from 'node:crypto';
import { and, asc, count, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import {
  DEFAULT_ACTIVITY_CONFIG,
  PROFESSION_IDS,
  RARITY_IDS,
  questEventsFromSettlement,
  settleFarming,
  type ActivityConfig,
  type FarmingSettlement,
  type MaterialId,
} from '@worldforge/game-core';
import {
  activities,
  characters,
  itemInstances,
  type Activity,
  type ActivitySummary,
  type Character,
  type FarmState,
} from '../db/schema.js';
import { itemEffectColumns } from '../inventory/columns.js';
import type { Database, Transaction } from '../db/types.js';
import { withTransaction } from '../db/transaction.js';
import { writeAudit } from '../db/audit.js';
import { uuidv7 } from '../db/uuid.js';
import { grantGatheringTx, loadProfessions } from '../materials/store.js';
import { recordQuestEventsTx } from '../quests/store.js';

export interface ActivityOptions {
  /** Offline accumulation cap (GDD §9.1: 3 h, `OFFLINE_CAP_SECONDS`). */
  offlineCapMs: number;
  /** Scheduled settlement interval; 0 disables the scheduler (`SETTLE_INTERVAL_SECONDS`). */
  settleIntervalMs: number;
  /** Server clock. Injectable for tests; never derived from client input. */
  now: () => Date;
  /** game-core rules (inventory capacity, modifier caps). */
  rules: ActivityConfig;
}

export const DEFAULT_ACTIVITY_OPTIONS: ActivityOptions = {
  offlineCapMs: 3 * 60 * 60 * 1000,
  settleIntervalMs: 0,
  now: () => new Date(),
  rules: DEFAULT_ACTIVITY_CONFIG,
};

/** Items kept in a summary's `items` list. */
const SUMMARY_ITEM_LIMIT = 100;
/** Audit every item of this rarity or better individually. */
const NOTABLE_RARITY = RARITY_IDS.indexOf('epic');

export function emptySummary(since: Date): ActivitySummary {
  return {
    since: since.toISOString(),
    settlements: 0,
    simulatedMs: 0,
    cappedMs: 0,
    kills: 0,
    deaths: 0,
    xpGained: 0,
    levelsGained: 0,
    goldGained: 0,
    goldSalvaged: 0,
    itemsGained: 0,
    itemsSalvaged: 0,
    items: [],
    materials: {},
    professions: {},
  };
}

export function newSeedSecret(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Farming state for a new activity: the character's saved state if it farmed before (same seed
 * secret, next cycle index, health), otherwise a fresh secret at full health. Restoring it means
 * stop → start neither heals the character nor re-rolls its unfinished encounter (ticket 1.9).
 */
export function initialFarmState(character: Character): FarmState {
  return character.farmState ?? { seedSecret: newSeedSecret(), cycleIndex: 0, health: null };
}

/**
 * Ends an activity: saves its farming state on the character, then deletes the row. Call after
 * settling it in the same transaction. Unsettled carry time is forfeited.
 */
export async function endActivityTx(tx: Transaction, activity: Activity): Promise<void> {
  const farmState: FarmState = {
    seedSecret: activity.seedSecret,
    cycleIndex: activity.cycleIndex,
    health: activity.health,
    momentum: activity.momentum,
    // A cycle was in progress: it stays bound to its area (ticket 2.2).
    ...(activity.carryMs > 0 ? { areaId: activity.areaId } : {}),
  };
  await tx.update(characters).set({ farmState }).where(eq(characters.id, activity.characterId));
  await tx.delete(activities).where(eq(activities.characterId, activity.characterId));
}

export interface SettleOutcome {
  activity: Activity;
  character: Character;
  /** Null when the window was too short to run a settlement (nothing changed but timestamps). */
  settlement: FarmingSettlement | null;
  creditedMs: number;
  cappedMs: number;
}

/**
 * Settles a character's activity up to `now`. Must run inside a transaction; locks the character
 * and the activity row (in that order) so concurrent settlements serialise and the second one sees
 * the first one's `settled_at` — the same span of time can never be credited twice.
 *
 * Credited time is `[settled_at, min(now, last_seen_at + offlineCap)]`; anything later is forfeited
 * (reported as `cappedMs`). `touch` marks client contact: it moves `last_seen_at` to `now` after the
 * settlement, so time while the client keeps settling is never capped.
 */
export async function settleActivityTx(
  tx: Transaction,
  characterId: string,
  options: ActivityOptions,
  { touch }: { touch: boolean },
): Promise<SettleOutcome | null> {
  const [character] = await tx
    .select()
    .from(characters)
    .where(eq(characters.id, characterId))
    .for('no key update');
  if (!character) return null;
  const [activity] = await tx
    .select()
    .from(activities)
    .where(eq(activities.characterId, characterId))
    .for('update');
  if (!activity) return null;

  const now = options.now();
  const nowMs = now.getTime();
  const settledMs = activity.settledAt.getTime();
  const capEndMs = activity.lastSeenAt.getTime() + options.offlineCapMs;
  const endMs = Math.max(settledMs, Math.min(nowMs, capEndMs));
  const creditedMs = endMs - settledMs;
  const cappedMs = Math.max(0, nowMs - Math.max(settledMs, capEndMs));
  const durationMs = activity.carryMs + creditedMs;
  // Never move settled_at backwards (clock skew between instances).
  const newSettledAt = new Date(Math.max(settledMs, nowMs));

  let settlement: FarmingSettlement | null = null;
  let updatedCharacter = character;
  const summary: ActivitySummary = {
    ...activity.summary,
    items: [...activity.summary.items],
    // Summaries written before ticket 2.3 have no material fields.
    materials: { ...activity.summary.materials },
    professions: { ...activity.summary.professions },
  };
  summary.cappedMs += cappedMs;
  const patch: Partial<Activity> = {
    settledAt: newSettledAt,
    carryMs: durationMs,
    updatedAt: now,
    ...(touch ? { lastSeenAt: new Date(Math.max(activity.lastSeenAt.getTime(), nowMs)) } : {}),
  };

  if (creditedMs > 0) {
    const equipped = await tx
      .select()
      .from(itemInstances)
      .where(
        and(eq(itemInstances.characterId, characterId), isNotNull(itemInstances.equippedSlot)),
      );
    const [inventory] = await tx
      .select({ n: count() })
      .from(itemInstances)
      .where(and(eq(itemInstances.characterId, characterId), isNull(itemInstances.equippedSlot)));

    // Safe to read before settling: the character lock above serialises settlements.
    const professionsBefore = await loadProfessions(tx, characterId);

    const seq = activity.settlementSeq + 1;
    settlement = settleFarming(
      {
        character: {
          classId: character.classId,
          level: character.level,
          xp: character.experience,
          ...(activity.health !== null ? { health: activity.health } : {}),
          momentum: activity.momentum,
        },
        equipment: equipped,
        areaId: activity.areaId,
        ...(activity.pendingAreaId ? { switchToAreaId: activity.pendingAreaId } : {}),
        seed: activity.seedSecret,
        firstCycle: activity.cycleIndex,
        durationMs,
        inventoryCount: inventory?.n ?? 0,
        professions: professionsBefore,
      },
      { activity: options.rules },
    );

    const gold = settlement.goldLooted + settlement.goldSalvaged;
    const rows = settlement.items.map((item) => ({
      id: uuidv7(),
      characterId,
      baseId: item.baseId,
      rarityId: item.rarityId,
      itemLevel: item.itemLevel,
      affixes: item.affixes,
      seed: item.seed,
      ...itemEffectColumns(item),
      equippedSlot: null,
      source: 'farming',
      createdAt: now,
    }));
    if (rows.length > 0) await tx.insert(itemInstances).values(rows);
    await grantGatheringTx(
      tx,
      characterId,
      settlement.materials,
      professionsBefore,
      settlement.professions,
      now,
    );

    // Quest progress from the same settlement, under the same character lock (ticket 2.4).
    await recordQuestEventsTx(
      tx,
      characterId,
      questEventsFromSettlement({
        startAreaId: activity.areaId,
        endAreaId: settlement.areaId,
        encounters: settlement.encounters,
        killsByEnemy: settlement.killsByEnemy,
        materials: settlement.materials,
      }),
    );

    const [written] = await tx
      .update(characters)
      .set({
        level: settlement.level,
        experience: settlement.xp,
        gold: sql`${characters.gold} + ${gold}`,
        version: sql`${characters.version} + 1`,
        updatedAt: now,
      })
      .where(eq(characters.id, characterId))
      .returning();
    updatedCharacter = written!;

    Object.assign(patch, {
      settlementSeq: seq,
      cycleIndex: activity.cycleIndex + settlement.encounters,
      carryMs: settlement.unusedMs,
      health: settlement.health,
      momentum: settlement.momentum,
    });
    if (settlement.switched) {
      // The cycle in progress finished in the old area; the character travelled on (ticket 2.2).
      const windowStartMs = settledMs - activity.carryMs;
      Object.assign(patch, {
        areaId: settlement.areaId,
        pendingAreaId: null,
        startedAt: new Date(windowStartMs + (settlement.switchedAtMs ?? 0)),
      });
      await writeAudit(tx, {
        event: 'activity.start',
        accountId: character.accountId,
        characterId,
        data: { areaId: settlement.areaId, from: activity.areaId, deferred: true },
      });
    }
    summary.settlements += 1;
    summary.simulatedMs += settlement.simulatedMs;
    summary.kills += settlement.kills;
    summary.deaths += settlement.deaths;
    summary.xpGained += settlement.xpGained;
    summary.levelsGained += settlement.levelsGained;
    summary.goldGained += gold;
    summary.goldSalvaged += settlement.goldSalvaged;
    summary.itemsGained += rows.length;
    summary.itemsSalvaged += settlement.salvaged.length;
    summary.items.push(
      ...rows.map((r) => ({
        id: r.id,
        baseId: r.baseId,
        rarityId: r.rarityId,
        itemLevel: r.itemLevel,
        ...(r.effectId ? { effectId: r.effectId } : {}),
        ...(r.mythicId ? { mythicId: r.mythicId } : {}),
        ...(r.setId ? { setId: r.setId } : {}),
      })),
    );
    summary.items = summary.items.slice(-SUMMARY_ITEM_LIMIT);
    const materials = summary.materials!;
    for (const [id, n] of Object.entries(settlement.materials) as [MaterialId, number][]) {
      materials[id] = (materials[id] ?? 0) + n;
    }
    const professions = summary.professions!;
    for (const id of PROFESSION_IDS) {
      const xpGained = settlement.professionXpGained[id] ?? 0;
      if (xpGained === 0) continue;
      const prev = professions[id] ?? { xpGained: 0, levelsGained: 0 };
      professions[id] = {
        xpGained: prev.xpGained + xpGained,
        levelsGained:
          prev.levelsGained + settlement.professions[id].level - professionsBefore[id].level,
      };
    }
    const materialsGained = Object.keys(settlement.materials).length > 0;

    if (
      settlement.xpGained > 0 ||
      gold > 0 ||
      rows.length > 0 ||
      settlement.salvaged.length > 0 ||
      materialsGained
    ) {
      await writeAudit(tx, {
        event: 'activity.reward',
        accountId: character.accountId,
        characterId,
        data: {
          areaId: activity.areaId,
          seq,
          creditedMs,
          cappedMs,
          simulatedMs: settlement.simulatedMs,
          kills: settlement.kills,
          xp: settlement.xpGained,
          level: settlement.level,
          gold,
          goldSalvaged: settlement.goldSalvaged,
          items: rows.length,
          itemsSalvaged: settlement.salvaged.length,
          materials: settlement.materials,
          notableItems: rows
            .filter((r) => RARITY_IDS.indexOf(r.rarityId) >= NOTABLE_RARITY)
            .map((r) => ({ id: r.id, baseId: r.baseId, rarityId: r.rarityId, seed: r.seed })),
        },
      });
    }
  }

  patch.summary = summary;
  const [updated] = await tx
    .update(activities)
    .set(patch)
    .where(eq(activities.characterId, characterId))
    .returning();
  return {
    activity: updated!,
    character: updatedCharacter,
    settlement,
    creditedMs,
    cappedMs,
  };
}

/**
 * Scheduled settlement: settles every activity not settled for `olderThanMs`, one transaction each,
 * without marking client contact (so the offline cap still applies). Returns how many were settled.
 */
export async function settleDueActivities(
  db: Database,
  options: ActivityOptions,
  { olderThanMs, limit = 500 }: { olderThanMs: number; limit?: number },
): Promise<number> {
  const cutoff = new Date(options.now().getTime() - olderThanMs);
  const due = await db
    .select({ characterId: activities.characterId })
    .from(activities)
    .where(lt(activities.settledAt, cutoff))
    .orderBy(asc(activities.settledAt))
    .limit(limit);
  let settled = 0;
  for (const { characterId } of due) {
    const outcome = await withTransaction(db, (tx) =>
      settleActivityTx(tx, characterId, options, { touch: false }),
    );
    if (outcome) settled++;
  }
  return settled;
}
