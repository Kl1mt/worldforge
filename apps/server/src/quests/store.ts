import { randomBytes } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  CONTRACTS_PER_DAY,
  MAX_ACTIVE_CONTRACTS,
  STORY_QUEST_IDS,
  applyQuestEvents,
  applyXp,
  contractDay,
  contractReward,
  dailyContracts,
  generateItem,
  generateTargetedItem,
  getStoryQuest,
  isTargetedItemReward,
  offersRewardSlot,
  targetedRewardSeed,
  targetedRewardSlots,
  type ClassId,
  type ItemSlotKind,
  initialProgress,
  isQuestComplete,
  isStoryQuestId,
  nextStoryOffer,
  type MaterialId,
  type QuestEvent,
  type QuestObjective,
  type QuestReward,
  type StoryBlocker,
  type StoryQuestId,
  type WorldProgress,
} from '@worldforge/game-core';
import {
  characterMaterials,
  characterQuests,
  characters,
  itemInstances,
  type Character,
  type CharacterQuest,
  type QuestKind,
} from '../db/schema.js';
import { itemEffectColumns } from '../inventory/columns.js';
import type { Database, Transaction } from '../db/types.js';
import { writeAudit } from '../db/audit.js';
import { recordTelemetry } from '../telemetry/record.js';
import { dropCounts, goldIn, materialCounts, xpIn } from '../telemetry/counts.js';
import { uuidv7 } from '../db/uuid.js';
import { ApiError } from '../errors.js';
// Type-only: a value import would close a cycle (settlement → quests → inventory → settlement).
import { itemView, type ItemView } from '../inventory/routes.js';

type Db = Database | Transaction;

/**
 * Applies quest events to the character's active quests (ticket 2.4). The only writer of quest
 * progress. Call inside the transaction that produced the events, after locking the character row
 * (settlement: `settleActivityTx`; dungeon runs: ticket 2.5 with
 * `{ type: 'bossDefeated', bossId: 'gravewarden' }`), so progress is granted exactly once.
 * `acceptedBy` limits the events to quests accepted at or before that time: a dungeon run's events
 * happened during the run, so quests taken after it started do not count them (ticket 2.8).
 * Returns the quests whose progress changed.
 */
export async function recordQuestEventsTx(
  tx: Transaction,
  characterId: string,
  events: readonly QuestEvent[],
  { acceptedBy }: { acceptedBy?: Date } = {},
): Promise<CharacterQuest[]> {
  if (events.length === 0) return [];
  const active = await tx
    .select()
    .from(characterQuests)
    .where(and(eq(characterQuests.characterId, characterId), eq(characterQuests.status, 'active')))
    .for('update');
  const changed: CharacterQuest[] = [];
  for (const quest of active) {
    // Events of something that began before the quest was taken (a dungeon run) never count.
    if (acceptedBy && quest.acceptedAt.getTime() > acceptedBy.getTime()) continue;
    const progress = applyQuestEvents(quest.objectives, quest.progress, events);
    if (progress.every((p, i) => p === quest.progress[i])) continue;
    await tx.update(characterQuests).set({ progress }).where(eq(characterQuests.id, quest.id));
    changed.push({ ...quest, progress });
  }
  return changed;
}

export type QuestViewStatus = 'active' | 'ready' | 'turnedIn';

export interface QuestView {
  id: string;
  kind: QuestKind;
  /** Story quest id or contract template id. */
  questId: string;
  contractDay: string | null;
  objectives: QuestObjective[];
  /** Progress per objective, capped at each target. */
  progress: number[];
  reward: QuestReward;
  /** `ready`: every objective is met and the quest can be turned in. */
  status: QuestViewStatus;
  acceptedAt: string;
  turnedInAt: string | null;
}

export interface ContractOfferView {
  slot: number;
  templateId: string;
  objective: QuestObjective;
  /** Reward at the character's current level; fixed when accepted. */
  reward: QuestReward;
  accepted: boolean;
  /**
   * Ticket 3.6: slots the player may choose for a reward item when accepting (`rewardSlot`);
   * empty when the contract offers no choice. The item is described by `targetedReward`.
   */
  rewardSlots: ItemSlotKind[];
  targetedReward: { rarityId: string; itemLevel: number } | null;
}

export interface QuestBoardResponse {
  characterId: string;
  /** The contract day (UTC). */
  day: string;
  /** Accepted quests that are not turned in yet, oldest first. */
  quests: QuestView[];
  story: {
    /** The next story quest to accept, with what still blocks it; null when none is left. */
    next: { questId: StoryQuestId; blockers: StoryBlocker[] } | null;
    /** Story quests turned in, in chain order. */
    completed: StoryQuestId[];
  };
  contracts: {
    offers: ContractOfferView[];
    perDay: number;
    /** Contracts held now, and the most a character may hold. */
    active: number;
    maxActive: number;
  };
}

/**
 * The reward as clients see it: without a targeted reward's seed (ticket 3.9), which stays on the
 * server so the item can't be computed before it is granted.
 */
function publicReward(reward: QuestReward): QuestReward {
  if (!reward.item || !isTargetedItemReward(reward.item) || reward.item.seed === undefined) {
    return reward;
  }
  const item = { ...reward.item };
  delete item.seed;
  return { ...reward, item };
}

export function questView(q: CharacterQuest): QuestView {
  return {
    id: q.id,
    kind: q.kind,
    questId: q.questId,
    contractDay: q.contractDay,
    objectives: q.objectives,
    progress: q.progress,
    reward: publicReward(q.reward),
    status:
      q.status === 'turnedIn'
        ? 'turnedIn'
        : isQuestComplete(q.objectives, q.progress)
          ? 'ready'
          : 'active',
    acceptedAt: q.acceptedAt.toISOString(),
    turnedInAt: q.turnedInAt?.toISOString() ?? null,
  };
}

interface BoardCharacter {
  id: string;
  classId: ClassId;
  level: number;
  progress: WorldProgress;
}

export async function questBoard(
  db: Db,
  character: BoardCharacter,
  now: Date,
): Promise<QuestBoardResponse> {
  const rows = await db
    .select()
    .from(characterQuests)
    .where(eq(characterQuests.characterId, character.id))
    .orderBy(asc(characterQuests.acceptedAt), asc(characterQuests.id));
  const day = contractDay(now);
  const story = rows.filter((r) => r.kind === 'story' && isStoryQuestId(r.questId));
  const accepted = new Set(story.map((r) => r.questId as StoryQuestId));
  const turnedIn = new Set(
    story.filter((r) => r.status === 'turnedIn').map((r) => r.questId as StoryQuestId),
  );
  const next = nextStoryOffer(character.level, { accepted, turnedIn });
  const takenSlots = new Set(
    rows.filter((r) => r.kind === 'contract' && r.contractDay === day).map((r) => r.contractSlot),
  );
  const offers = dailyContracts(character.id, day, character.level, character.progress);
  return {
    characterId: character.id,
    day,
    quests: rows.filter((r) => r.status === 'active').map(questView),
    story: {
      next: next ? { questId: next.quest.id, blockers: next.blockers } : null,
      completed: STORY_QUEST_IDS.filter((id) => turnedIn.has(id)),
    },
    contracts: {
      offers: offers.map((o) => {
        const rewardSlots = offersRewardSlot(o.template)
          ? targetedRewardSlots(character.classId, character.level)
          : [];
        const targeted =
          rewardSlots.length > 0
            ? contractReward(o.template, character.level, rewardSlots[0]).item
            : null;
        return {
          slot: o.slot,
          templateId: o.template.id,
          objective: o.template.objective,
          reward: contractReward(o.template, character.level),
          accepted: takenSlots.has(o.slot),
          rewardSlots,
          targetedReward: targeted
            ? { rarityId: targeted.rarityId, itemLevel: targeted.itemLevel }
            : null,
        };
      }),
      perDay: CONTRACTS_PER_DAY,
      active: rows.filter((r) => r.kind === 'contract' && r.status === 'active').length,
      maxActive: MAX_ACTIVE_CONTRACTS,
    },
  };
}

export type AcceptRequest =
  | { kind: 'story'; questId: string }
  /** `rewardSlot` (ticket 3.6): the item slot chosen for a contract that offers one. */
  | { kind: 'contract'; slot: number; rewardSlot?: string };

/**
 * Accepts a story quest or one of today's contracts. The character must be locked and settled
 * (so kills from before the acceptance never count). Repeat-safe by state: a second accept of the
 * same quest or slot is `409 quest_already_accepted` (unique indexes are the backstop).
 */
export async function acceptQuestTx(
  tx: Transaction,
  character: Character,
  request: AcceptRequest,
  now: Date,
): Promise<CharacterQuest> {
  const rows = await tx
    .select()
    .from(characterQuests)
    .where(eq(characterQuests.characterId, character.id))
    .for('update');
  let values: typeof characterQuests.$inferInsert;
  if (request.kind === 'story') {
    if (!isStoryQuestId(request.questId)) {
      throw new ApiError(404, 'not_found', 'No such quest.');
    }
    const questId = request.questId;
    if (rows.some((r) => r.kind === 'story' && r.questId === questId)) {
      throw new ApiError(409, 'quest_already_accepted', 'You already took this quest.');
    }
    const accepted = new Set(
      rows.filter((r) => r.kind === 'story').map((r) => r.questId as StoryQuestId),
    );
    const turnedIn = new Set(
      rows
        .filter((r) => r.kind === 'story' && r.status === 'turnedIn')
        .map((r) => r.questId as StoryQuestId),
    );
    const next = nextStoryOffer(character.level, { accepted, turnedIn });
    if (!next || next.quest.id !== questId) {
      throw new ApiError(422, 'quest_not_offered', 'That quest is not on the board yet.');
    }
    if (next.blockers.length > 0) {
      throw new ApiError(422, 'quest_locked', 'You cannot take this quest yet.', {
        blockers: next.blockers,
      });
    }
    const def = getStoryQuest(questId);
    values = {
      id: uuidv7(),
      characterId: character.id,
      kind: 'story',
      questId,
      objectives: [...def.objectives],
      progress: initialProgress(def.objectives),
      reward: def.reward,
      acceptedAt: now,
    };
  } else {
    const day = contractDay(now);
    const offer = dailyContracts(character.id, day, character.level, character.progress).find(
      (o) => o.slot === request.slot,
    );
    if (!offer) throw new ApiError(404, 'not_found', 'No such contract.');
    if (
      rows.some(
        (r) => r.kind === 'contract' && r.contractDay === day && r.contractSlot === offer.slot,
      )
    ) {
      throw new ApiError(409, 'quest_already_accepted', 'You already took this contract today.');
    }
    // Ticket 3.6: a targeted reward's slot must be one the contract offers to this character.
    let rewardSlot: ItemSlotKind | undefined;
    if (request.rewardSlot !== undefined) {
      const choices = offersRewardSlot(offer.template)
        ? targetedRewardSlots(character.classId, character.level)
        : [];
      if (!choices.includes(request.rewardSlot as ItemSlotKind)) {
        throw new ApiError(422, 'reward_slot_unavailable', 'This contract offers no such reward.', {
          rewardSlots: choices,
        });
      }
      rewardSlot = request.rewardSlot as ItemSlotKind;
    }
    const active = rows.filter((r) => r.kind === 'contract' && r.status === 'active').length;
    if (active >= MAX_ACTIVE_CONTRACTS) {
      throw new ApiError(422, 'contract_limit', 'Finish a contract before taking another.', {
        maxActive: MAX_ACTIVE_CONTRACTS,
      });
    }
    values = {
      id: uuidv7(),
      characterId: character.id,
      kind: 'contract',
      questId: offer.template.id,
      contractDay: day,
      contractSlot: offer.slot,
      objectives: [offer.template.objective],
      progress: initialProgress([offer.template.objective]),
      reward: withRewardSeed(contractReward(offer.template, character.level, rewardSlot)),
      acceptedAt: now,
    };
  }
  const [row] = await tx.insert(characterQuests).values(values).returning();
  await writeAudit(tx, {
    event: 'quest.accept',
    accountId: character.accountId,
    characterId: character.id,
    data: {
      questRowId: row!.id,
      kind: row!.kind,
      questId: row!.questId,
      ...(row!.reward.item && isTargetedItemReward(row!.reward.item)
        ? { rewardSlot: row!.reward.item.slot }
        : {}),
    },
  });
  return row!;
}

/**
 * Ticket 3.9: a targeted reward gets a server-random seed at acceptance, stored with the row and
 * never shown (`publicReward`). Before, the seed was derived from the client-visible row id, so the
 * item could be computed in advance.
 */
function withRewardSeed(reward: QuestReward): QuestReward {
  if (!reward.item || !isTargetedItemReward(reward.item)) return reward;
  return { ...reward, item: { ...reward.item, seed: randomBytes(4).readUInt32BE(0) } };
}

export interface TurnInReward {
  xp: number;
  levelsGained: number;
  gold: number;
  materials: Partial<Record<MaterialId, number>>;
  item: ItemView | null;
}

export interface TurnInOutcome {
  character: Character;
  quest: CharacterQuest;
  reward: TurnInReward;
}

/**
 * Turns in a completed quest and grants its reward once: the quest row is locked and must be
 * `active` and complete; it becomes `turnedIn` in the same transaction as the grant. The caller
 * locks and settles the character first and wraps this in an `Idempotency-Key` claim.
 */
export async function turnInQuestTx(
  tx: Transaction,
  character: Character,
  questRowId: string,
  { inventoryCapacity, now }: { inventoryCapacity: number; now: Date },
): Promise<TurnInOutcome> {
  const [quest] = await tx
    .select()
    .from(characterQuests)
    .where(and(eq(characterQuests.id, questRowId), eq(characterQuests.characterId, character.id)))
    .for('update');
  if (!quest) throw new ApiError(404, 'not_found', 'No such quest.');
  if (quest.status === 'turnedIn') {
    throw new ApiError(409, 'quest_already_turned_in', 'This quest was already turned in.');
  }
  if (!isQuestComplete(quest.objectives, quest.progress)) {
    throw new ApiError(422, 'quest_incomplete', 'The quest is not complete yet.');
  }
  const { reward } = quest;

  let item: ItemView | null = null;
  let itemSeed: number | null = null;
  if (reward.item) {
    const [held] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(itemInstances)
      .where(
        and(
          eq(itemInstances.characterId, character.id),
          sql`${itemInstances.equippedSlot} is null`,
        ),
      );
    if ((held?.n ?? 0) >= inventoryCapacity) {
      throw new ApiError(422, 'inventory_full', 'Make room in your pack for the reward item.', {
        capacity: inventoryCapacity,
      });
    }
    // Ticket 3.6: a targeted reward is fixed by the quest row (its stored seed, ticket 3.9;
    // deterministic, never re-rolled);
    // a fixed-base reward keeps its server-random seed (granted once by state).
    const generated = isTargetedItemReward(reward.item)
      ? generateTargetedItem(
          reward.item,
          reward.item.seed ?? targetedRewardSeed(quest.id),
          character.classId,
        )
      : generateItem({
          seed: randomBytes(4).readUInt32BE(0),
          itemLevel: reward.item.itemLevel,
          baseId: reward.item.baseId,
          rarityId: reward.item.rarityId,
          classId: character.classId,
        });
    if (!generated) throw new Error(`quest reward item cannot be generated: ${quest.questId}`);
    const [row] = await tx
      .insert(itemInstances)
      .values({
        id: uuidv7(),
        characterId: character.id,
        baseId: generated.baseId,
        rarityId: generated.rarityId,
        itemLevel: generated.itemLevel,
        affixes: generated.affixes,
        seed: generated.seed,
        ...itemEffectColumns(generated),
        equippedSlot: null,
        source: 'quest',
        createdAt: now,
      })
      .returning();
    item = itemView(row!);
    itemSeed = generated.seed;
  }

  const materials = (Object.entries(reward.materials) as [MaterialId, number][])
    .filter(([, n]) => n > 0)
    .map(([materialId, quantity]) => ({
      characterId: character.id,
      materialId,
      quantity,
      updatedAt: now,
    }));
  if (materials.length > 0) {
    await tx
      .insert(characterMaterials)
      .values(materials)
      .onConflictDoUpdate({
        target: [characterMaterials.characterId, characterMaterials.materialId],
        set: { quantity: sql`${characterMaterials.quantity} + excluded.quantity`, updatedAt: now },
      });
  }

  const levelled = applyXp({ level: character.level, xp: character.experience }, reward.xp);
  const [updatedCharacter] = await tx
    .update(characters)
    .set({
      level: levelled.level,
      experience: levelled.xp,
      gold: sql`${characters.gold} + ${reward.gold}`,
      version: sql`${characters.version} + 1`,
      updatedAt: now,
    })
    .where(eq(characters.id, character.id))
    .returning();
  const [updatedQuest] = await tx
    .update(characterQuests)
    .set({ status: 'turnedIn', turnedInAt: now })
    .where(eq(characterQuests.id, quest.id))
    .returning();

  const granted: TurnInReward = {
    xp: reward.xp,
    levelsGained: levelled.level - character.level,
    gold: reward.gold,
    materials: reward.materials,
    item,
  };
  await writeAudit(tx, {
    event: 'quest.turn_in',
    accountId: character.accountId,
    characterId: character.id,
    data: {
      questRowId: quest.id,
      kind: quest.kind,
      questId: quest.questId,
      xp: reward.xp,
      level: levelled.level,
      gold: reward.gold,
      materials: reward.materials,
      item: item
        ? { id: item.id, baseId: item.baseId, rarityId: item.rarityId, seed: itemSeed }
        : null,
    },
  });
  const source = quest.kind === 'story' ? 'quest' : 'contract';
  recordTelemetry(tx, now, [
    {
      metric: 'quest.reward',
      dims: [
        quest.kind,
        quest.questId,
        !reward.item ? 'no_item' : isTargetedItemReward(reward.item) ? 'targeted' : 'fixed',
      ],
    },
    ...(item ? dropCounts(source, quest.questId, [item]) : []),
    ...goldIn(source, quest.questId, reward.gold),
    ...xpIn(source, quest.questId, reward.xp),
    ...materialCounts('material.in', source, reward.materials),
  ]);
  return { character: updatedCharacter!, quest: updatedQuest!, reward: granted };
}
