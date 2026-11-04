import type {
  AreaId,
  CraftBlocker,
  ItemSlotKind,
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

/** Merchant and forge (ticket 2.6). */
export interface MaterialStackDto {
  materialId: MaterialId;
  quantity: number;
}

export interface MerchantOfferDto {
  offerId: string;
  areaId: AreaId;
  item: Pick<ItemDto, 'baseId' | 'rarityId' | 'itemLevel' | 'affixes'>;
  price: number;
  soldOut: boolean;
}

export interface MerchantState {
  characterId: string;
  day: string;
  restocksAt: string;
  gold: number;
  offers: MerchantOfferDto[];
  sellPrices: { itemId: string; price: number }[];
}

export interface RecipeDto {
  recipeId: string;
  name: string;
  description: string;
  tier: number;
  level: number;
  gold: number;
  materials: MaterialStackDto[];
  slots: ItemSlotKind[];
  blockers: CraftBlocker[];
}

export interface ForgeState {
  characterId: string;
  gold: number;
  materials: MaterialStackDto[];
  recipes: RecipeDto[];
  salvage: { itemId: string; gold: number; materials: MaterialStackDto[] }[];
}

export interface BuyResult {
  character: Character;
  item: ItemDto;
  inventory: InventoryDto;
}

export interface SellResult {
  character: Character;
  goldGained: number;
  inventory: InventoryDto;
}

export interface SalvageResult {
  character: Character;
  salvaged: { gold: number; materials: MaterialStackDto[] };
  inventory: InventoryDto;
  materials: MaterialStackDto[];
}

export interface CraftResult {
  character: Character;
  item: ItemDto;
  inventory: InventoryDto;
  materials: MaterialStackDto[];
}

/** Value-moving calls carry an `Idempotency-Key` (docs/API_CONVENTIONS.md). */
const keyed = (key: string) => ({ headers: { 'idempotency-key': key } });

export const merchantApi = {
  get: (id: string, o: Signal = {}, f?: typeof fetch): Promise<ApiResult<MerchantState>> =>
    apiRequest(`${c(id)}/merchant`, o, f),
  buy: (
    id: string,
    offerId: string,
    key: string,
    f?: typeof fetch,
  ): Promise<ApiResult<BuyResult>> =>
    apiRequest(`${c(id)}/merchant/buy`, { method: 'POST', body: { offerId }, ...keyed(key) }, f),
  sell: (
    id: string,
    itemIds: string[],
    key: string,
    f?: typeof fetch,
  ): Promise<ApiResult<SellResult>> =>
    apiRequest(`${c(id)}/merchant/sell`, { method: 'POST', body: { itemIds }, ...keyed(key) }, f),
};

export const forgeApi = {
  get: (id: string, o: Signal = {}, f?: typeof fetch): Promise<ApiResult<ForgeState>> =>
    apiRequest(`${c(id)}/forge`, o, f),
  salvage: (
    id: string,
    itemIds: string[],
    key: string,
    f?: typeof fetch,
  ): Promise<ApiResult<SalvageResult>> =>
    apiRequest(`${c(id)}/forge/salvage`, { method: 'POST', body: { itemIds }, ...keyed(key) }, f),
  craft: (
    id: string,
    recipeId: string,
    slot: ItemSlotKind,
    key: string,
    f?: typeof fetch,
  ): Promise<ApiResult<CraftResult>> =>
    apiRequest(
      `${c(id)}/forge/craft`,
      { method: 'POST', body: { recipeId, slot }, ...keyed(key) },
      f,
    ),
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
    case 'insufficient_gold':
      return 'Not enough gold.';
    case 'insufficient_materials':
      return 'Not enough materials for this recipe.';
    case 'recipe_locked':
      return 'Your hero is not experienced enough for this recipe yet.';
    case 'inventory_full':
      return 'The pack is full. Sell or salvage something first.';
    case 'offer_sold_out':
      return 'You already bought that today.';
    case 'offer_expired':
      return 'The merchant has restocked. The wares have been refreshed.';
    case 'idempotency_conflict':
      return 'That action clashed with an earlier one. Try again.';
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
