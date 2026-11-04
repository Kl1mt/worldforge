import type { AreaId, EquipmentSlotId, RarityId, StatBlock } from '@worldforge/game-core';
import type { Character } from '../characters/api';
import { apiRequest, type ApiFailure, type ApiResult } from '../lib/api';

/** Server shapes from docs/API_CONVENTIONS.md (activity: ticket 1.6, inventory: ticket 1.7). */

export interface Activity {
  characterId: string;
  areaId: AreaId;
  startedAt: string;
  settledAt: string;
  /** Health carried between settlements; null = full. */
  health: number | null;
}

export interface SummaryItem {
  id: string;
  baseId: string;
  rarityId: RarityId;
  itemLevel: number;
}

/** Everything earned since the client last collected a summary (docs/FARMING.md). */
export interface ReturnSummary {
  since: string;
  until: string;
  settlements: number;
  simulatedMs: number;
  cappedMs: number;
  kills: number;
  deaths: number;
  xpGained: number;
  levelsGained: number;
  goldGained: number;
  goldSalvaged: number;
  itemsGained: number;
  itemsSalvaged: number;
  items: SummaryItem[];
}

export interface ActivityState {
  activity: Activity | null;
  character: Character;
}

export interface SettleResult extends ActivityState {
  summary: ReturnSummary;
}

export interface ItemAffix {
  affixId: string;
  tier: number;
  value: number;
}

export interface ItemDto {
  id: string;
  baseId: string;
  rarityId: RarityId;
  itemLevel: number;
  affixes: ItemAffix[];
  equippedSlot: EquipmentSlotId | null;
  source: string;
  createdAt: string;
}

export interface InventoryDto {
  equipped: ItemDto[];
  inventory: ItemDto[];
  stats: StatBlock;
}

const c = (id: string) => `/characters/${encodeURIComponent(id)}`;
const i = (characterId: string, itemId: string) =>
  `${c(characterId)}/items/${encodeURIComponent(itemId)}`;

type Signal = { signal?: AbortSignal };

export const activityApi = {
  get: (id: string, o: Signal = {}, f?: typeof fetch): Promise<ApiResult<ActivityState>> =>
    apiRequest(`${c(id)}/activity`, o, f),
  start: (id: string, areaId: AreaId, f?: typeof fetch): Promise<ApiResult<ActivityState>> =>
    apiRequest(`${c(id)}/activity`, { method: 'POST', body: { areaId } }, f),
  settle: (id: string, f?: typeof fetch): Promise<ApiResult<SettleResult>> =>
    apiRequest(`${c(id)}/activity/settle`, { method: 'POST' }, f),
  stop: (id: string, f?: typeof fetch): Promise<ApiResult<SettleResult>> =>
    apiRequest(`${c(id)}/activity/stop`, { method: 'POST' }, f),
};

export const inventoryApi = {
  get: (id: string, o: Signal = {}, f?: typeof fetch): Promise<ApiResult<InventoryDto>> =>
    apiRequest(`${c(id)}/inventory`, o, f),
  equip: (
    id: string,
    itemId: string,
    slot?: EquipmentSlotId,
    f?: typeof fetch,
  ): Promise<ApiResult<InventoryDto>> =>
    apiRequest(
      `${i(id, itemId)}/equip`,
      { method: 'POST', ...(slot ? { body: { slot } } : {}) },
      f,
    ),
  unequip: (id: string, itemId: string, f?: typeof fetch): Promise<ApiResult<InventoryDto>> =>
    apiRequest(`${i(id, itemId)}/unequip`, { method: 'POST' }, f),
  discard: (id: string, itemId: string, f?: typeof fetch): Promise<ApiResult<InventoryDto>> =>
    apiRequest(i(id, itemId), { method: 'DELETE' }, f),
};

/** A short sentence for a failed game action (equip, farm, …), branching on the error code. */
export function describeGameFailure(error: Pick<ApiFailure, 'code'>): string {
  switch (error.code) {
    case 'wrong_class':
      return 'Your class cannot use this item.';
    case 'wrong_slot':
      return 'That item does not fit this slot.';
    case 'item_unusable':
      return 'This item no longer exists in the world and cannot be equipped.';
    case 'item_equipped':
      return 'Take the item off before discarding it.';
    case 'character_not_active':
      return 'Select this character before sending it out to farm.';
    case 'not_farming':
      return 'This character is not farming right now.';
    case 'not_found':
    case 'forbidden':
      return 'That is no longer available. The view has been refreshed.';
    case 'unauthenticated':
      return 'Your session has ended. Log in again.';
    case 'rate_limited':
      return 'Too many requests. Wait a moment and try again.';
    case 'network':
      return 'The server cannot be reached. Check your connection and try again.';
    default:
      return 'Something went wrong on our side. Try again in a moment.';
  }
}
