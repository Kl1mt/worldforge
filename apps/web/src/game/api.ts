import type {
  AreaId,
  DungeonId,
  EquipmentSlotId,
  MaterialId,
  ProfessionId,
  RarityId,
  StatBlock,
  UnlockBlocker,
  WorldProgress,
} from '@worldforge/game-core';
import type { Character } from '../characters/api';
import { apiRequest, type ApiFailure, type ApiResult } from '../lib/api';

/** Server shapes from docs/API_CONVENTIONS.md (activity: ticket 1.6, inventory: ticket 1.7). */

export interface Activity {
  characterId: string;
  /** Area of the fight in progress. */
  areaId: AreaId;
  /** Where the hero travels once the fight in progress ends (ticket 2.2); null = staying. */
  pendingAreaId: AreaId | null;
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
  /** Materials gathered (ticket 2.3). Missing in summaries from before 2.3. */
  materials?: Partial<Record<MaterialId, number>>;
  /** Profession XP and level-ups (ticket 2.3). */
  professions?: Partial<Record<ProfessionId, { xpGained: number; levelsGained: number }>>;
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

export interface WorldPlace<Id extends string> {
  id: Id;
  unlocked: boolean;
  blockers: UnlockBlocker[];
}

/** `GET /characters/:id/world` (ticket 2.2). */
export interface WorldState {
  characterId: string;
  level: number;
  progress: WorldProgress;
  current: { areaId: AreaId; pendingAreaId: AreaId | null } | null;
  areas: WorldPlace<AreaId>[];
  dungeons: (WorldPlace<DungeonId> & { available: boolean })[];
}

/** `GET /characters/:id/materials` (ticket 2.3). */
export interface MaterialsState {
  characterId: string;
  materials: { materialId: MaterialId; quantity: number }[];
  professions: {
    professionId: ProfessionId;
    level: number;
    xp: number;
    xpToNext: number;
    maxLevel: number;
  }[];
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

export const worldApi = {
  get: (id: string, o: Signal = {}, f?: typeof fetch): Promise<ApiResult<WorldState>> =>
    apiRequest(`${c(id)}/world`, o, f),
};

export const materialsApi = {
  get: (id: string, o: Signal = {}, f?: typeof fetch): Promise<ApiResult<MaterialsState>> =>
    apiRequest(`${c(id)}/materials`, o, f),
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
    case 'area_locked':
      return 'Your hero is not ready for that place yet. The map shows what it takes.';
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
