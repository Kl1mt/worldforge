import type {
  ItemSlotKind,
  MaterialId,
  QuestObjective,
  QuestReward,
  RarityId,
  StoryBlocker,
  StoryQuestId,
} from '@worldforge/game-core';
import type { Character } from '../characters/api';
import type { ItemDto } from '../game/api';
import { apiRequest, type ApiFailure, type ApiResult } from '../lib/api';

/** Server shapes of the quest endpoints (ticket 2.4, docs/API_CONVENTIONS.md). */

export type QuestStatus = 'active' | 'ready' | 'turnedIn';

export interface QuestDto {
  /** The accepted quest's id (used for turn-in). */
  id: string;
  kind: 'story' | 'contract';
  /** Story quest id or contract template id. */
  questId: string;
  contractDay: string | null;
  objectives: QuestObjective[];
  progress: number[];
  reward: QuestReward;
  status: QuestStatus;
  acceptedAt: string;
  turnedInAt: string | null;
}

export interface ContractOfferDto {
  slot: number;
  templateId: string;
  objective: QuestObjective;
  reward: QuestReward;
  accepted: boolean;
  /** Ticket 3.6: slots to choose a reward item from (Abbey contracts); empty otherwise. */
  rewardSlots: ItemSlotKind[];
  targetedReward: { rarityId: RarityId; itemLevel: number } | null;
}

export interface QuestBoard {
  characterId: string;
  day: string;
  quests: QuestDto[];
  story: {
    next: { questId: StoryQuestId; blockers: StoryBlocker[] } | null;
    completed: StoryQuestId[];
  };
  contracts: { offers: ContractOfferDto[]; perDay: number; active: number; maxActive: number };
}

export interface TurnInResult {
  quests: QuestBoard;
  character: Character;
  reward: {
    xp: number;
    levelsGained: number;
    gold: number;
    materials: Partial<Record<MaterialId, number>>;
    item: ItemDto | null;
  };
}

export type AcceptIntent =
  | { kind: 'story'; questId: StoryQuestId }
  /** `rewardSlot` (ticket 3.6): the chosen reward item slot of an Abbey contract. */
  | { kind: 'contract'; slot: number; rewardSlot?: ItemSlotKind };

const q = (id: string) => `/characters/${encodeURIComponent(id)}/quests`;

export const questsApi = {
  get: (
    id: string,
    o: { signal?: AbortSignal } = {},
    f?: typeof fetch,
  ): Promise<ApiResult<QuestBoard>> => apiRequest(q(id), o, f),
  accept: (id: string, intent: AcceptIntent, f?: typeof fetch): Promise<ApiResult<QuestBoard>> =>
    apiRequest(q(id), { method: 'POST', body: intent }, f),
  /** `key` is the Idempotency-Key: reuse it when retrying the same turn-in. */
  turnIn: (
    id: string,
    questRowId: string,
    key: string,
    f?: typeof fetch,
  ): Promise<ApiResult<TurnInResult>> =>
    apiRequest(
      `${q(id)}/${encodeURIComponent(questRowId)}/turn-in`,
      { method: 'POST', headers: { 'Idempotency-Key': key } },
      f,
    ),
};

/** A short sentence for a failed quest action. */
export function describeQuestFailure(error: Pick<ApiFailure, 'code'>): string {
  switch (error.code) {
    case 'quest_already_accepted':
      return 'You already took that one. The board has been refreshed.';
    case 'quest_locked':
    case 'quest_not_offered':
      return 'That notice is not for you yet.';
    case 'contract_limit':
      return 'You carry three contracts already. Finish one first.';
    case 'reward_slot_unavailable':
      return 'That reward is not offered for this contract. The board has been refreshed.';
    case 'quest_incomplete':
      return 'The work is not done yet.';
    case 'quest_already_turned_in':
      return 'You were already paid for that one.';
    case 'inventory_full':
      return 'Your pack is full. Make room for the reward, then come back.';
    case 'not_found':
      return 'That notice is gone. The board has been refreshed.';
    case 'network':
      return 'The server cannot be reached. Check your connection and try again.';
    case 'unauthenticated':
      return 'Your session has ended. Log in again.';
    default:
      return 'Something went wrong on our side. Try again in a moment.';
  }
}
