import type {
  ItemBinding,
  ItemBindingReason,
  AreaId,
  CraftBlocker,
  ItemSlotKind,
  DungeonId,
  EquipmentSlotId,
  ItemVariantId,
  LootFilterRules,
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
  /** Legendary effect / Mythic signature and named Mythic (ticket 3.2); absent on other items. */
  effectId?: string;
  mythicId?: string;
  /** The set of a set piece (ticket 3.3); absent on other items. */
  setId?: string;
  /** Ticket 3.5: a Void item's variant; absent on other items. */
  variant?: ItemVariantId;
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
  /**
   * Ticket B.2: valuable drops (Legendary, Mythic, set, Void) that found no room and were kept
   * beyond the pack's capacity (part of `itemsGained`). Missing when none.
   */
  itemsOverCapacity?: number;
  items: SummaryItem[];
  /** Materials gathered (ticket 2.3). Missing in summaries from before 2.3. */
  materials?: Partial<Record<MaterialId, number>>;
  /** Profession XP and level-ups (ticket 2.3). */
  professions?: Partial<Record<ProfessionId, { xpGained: number; levelsGained: number }>>;
  /** Ticket 3.7: new drops the loot filter sold or salvaged (gold is in `goldGained`). */
  filtered?: LootFilterTally;
}

/** What the loot filter did with new drops (ticket 3.7). */
export interface LootFilterTally {
  sold: number;
  salvaged: number;
  gold: number;
  materials: Partial<Record<MaterialId, number>>;
}

/** `GET/POST …/loot-filter` (ticket 3.7). */
export interface LootFilterState {
  characterId: string;
  rules: LootFilterRules | null;
  active: boolean;
}

export interface ActivityState {
  activity: Activity | null;
  character: Character;
  /** Only on `GET …/activity` (ticket 2.7): how long farming keeps counting offline. */
  offlineCapMs?: number;
}

export interface SettleResult extends ActivityState {
  summary: ReturnSummary;
}

export interface ItemAffix {
  affixId: string;
  tier: number;
  value: number;
  /** Forge state (ticket 3.4 onward); absent on fresh affixes. */
  improvements?: number;
  rerolled?: boolean;
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
  /** Item model v2 (ticket 3.1); defaults until the Phase 3 ticket that writes each field. */
  upgradeLevel: number;
  variant: ItemVariantId | null;
  effectId: string | null;
  /** The Legendary effect's rolled strength, 0…1 (ticket 3.2); null for Mythics and others. */
  effectRoll: number | null;
  setId: string | null;
  mythicId: string | null;
  locked: boolean;
  /** Ticket T.1: game-core `ItemBinding`, why, and whether trading may take it right now. */
  binding: ItemBinding;
  bindingReason: ItemBindingReason;
  tradeable: boolean;
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
  /** Ticket 3.7: lock or unlock (both idempotent). */
  setLocked: (
    id: string,
    itemId: string,
    locked: boolean,
    f?: typeof fetch,
  ): Promise<ApiResult<InventoryDto>> =>
    apiRequest(`${i(id, itemId)}/${locked ? 'lock' : 'unlock'}`, { method: 'POST' }, f),
};

/** Loot filter rules (ticket 3.7). Setting the same rules again is harmless, so no key. */
export const lootFilterApi = {
  get: (id: string, o: Signal = {}, f?: typeof fetch): Promise<ApiResult<LootFilterState>> =>
    apiRequest(`${c(id)}/loot-filter`, o, f),
  set: (
    id: string,
    rules: LootFilterRules | null,
    f?: typeof fetch,
  ): Promise<ApiResult<LootFilterState>> =>
    apiRequest(`${c(id)}/loot-filter`, { method: 'POST', body: { rules } }, f),
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

/** Gold and materials of a forge action (ticket 3.4). */
export interface ForgeCostDto {
  gold: number;
  materials: MaterialStackDto[];
}

export type ForgeBlockerDto =
  | { kind: 'gold'; required: number; held: number }
  | { kind: 'material'; materialId: MaterialId; required: number; held: number };

/** The Forge's view of one item (ticket 3.4): the next upgrade, reroll options, improvements. */
export interface ForgeItemDto {
  itemId: string;
  upgradeLevel: number;
  upgradePity: number;
  rerollCount: number;
  upgrade: {
    fromLevel: number;
    toLevel: number;
    chance: number;
    pity: number;
    pityThreshold: number;
    guaranteed: boolean;
    bonusNow: number;
    bonusNext: number;
    cost: ForgeCostDto;
    blockers: ForgeBlockerDto[];
  } | null;
  reroll: {
    cost: ForgeCostDto;
    blockers: ForgeBlockerDto[];
    options: { affixId: string; tiers: { tier: number; min: number; max: number }[] }[][];
  } | null;
  improve: {
    index: number;
    affixId: string;
    tier: number;
    value: number;
    min: number;
    max: number;
    improvements: number;
    maxImprovements: number;
    refusal: 'improvement_cap' | 'affix_at_max' | 'unknown_affix' | null;
    next: { low: number; high: number } | null;
    cost: ForgeCostDto | null;
    blockers: ForgeBlockerDto[];
  }[];
}

export interface ForgeItemState {
  characterId: string;
  gold: number;
  materials: MaterialStackDto[];
  item: ItemDto;
  forge: ForgeItemDto;
}

export type ForgeOutcomeDto =
  | {
      action: 'upgrade';
      success: boolean;
      guaranteed: boolean;
      fromLevel: number;
      upgradeLevel: number;
      upgradePity: number;
    }
  | { action: 'reroll' | 'improve'; affixIndex: number; before: ItemAffix; after: ItemAffix };

export interface ForgeActionResult {
  character: Character;
  item: ItemDto;
  forge: ForgeItemDto;
  outcome: ForgeOutcomeDto;
  paid: ForgeCostDto;
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

/** Ticket 4.7: the Warehouse (per-character storage). */
export interface WarehouseState {
  characterId: string;
  level: number;
  maxLevel: number;
  capacity: number;
  items: ItemDto[];
  nextUpgrade: { toLevel: number; gold: number; slots: number; capacity: number } | null;
  gold: number;
  pack: { count: number; capacity: number };
}

export interface WarehouseMoveResult {
  warehouse: WarehouseState;
  inventory: InventoryDto;
  moved: number;
}

export interface WarehouseUpgradeResult {
  warehouse: WarehouseState;
  character: Character;
  goldSpent: number;
}

export const warehouseApi = {
  get: (id: string, o: Signal = {}, f?: typeof fetch): Promise<ApiResult<WarehouseState>> =>
    apiRequest(`${c(id)}/warehouse`, o, f),
  /** Moves move no value: no key; a repeated move finds the items moved and changes nothing. */
  move: (
    id: string,
    direction: 'deposit' | 'withdraw',
    itemIds: string[],
    f?: typeof fetch,
  ): Promise<ApiResult<WarehouseMoveResult>> =>
    apiRequest(`${c(id)}/warehouse/${direction}`, { method: 'POST', body: { itemIds } }, f),
  upgrade: (
    id: string,
    level: number,
    key: string,
    f?: typeof fetch,
  ): Promise<ApiResult<WarehouseUpgradeResult>> =>
    apiRequest(`${c(id)}/warehouse/upgrade`, { method: 'POST', body: { level }, ...keyed(key) }, f),
};

/** Ticket T.3: the shared account shelf (the Warehouse's second tab). */
export type ShelfKind = 'items' | 'materials' | 'gold';

export interface ShelfItemDto extends ItemDto {
  /** The hero of this account who put it on the shelf. */
  placedBy: { characterId: string; name: string };
}

export interface ShelfState {
  characterId: string;
  capacity: number;
  items: ShelfItemDto[];
  gold: number;
  materials: MaterialStackDto[];
  /** Per kind: whether deposits are open. Withdrawals always are. */
  deposits: Record<ShelfKind, boolean>;
  hero: { gold: number; materials: MaterialStackDto[]; pack: { count: number; capacity: number } };
}

export interface ShelfMoveBody {
  itemIds?: string[];
  gold?: number;
  materials?: Partial<Record<MaterialId, number>>;
}

export interface ShelfMoveResult {
  shelf: ShelfState;
  inventory: InventoryDto;
  character: Character;
  moved: { items: number; gold: number; materials: MaterialStackDto[] };
}

export const shelfApi = {
  get: (id: string, o: Signal = {}, f?: typeof fetch): Promise<ApiResult<ShelfState>> =>
    apiRequest(`${c(id)}/shelf`, o, f),
  /** Gold and materials move: one key per action (a retry with it never moves twice). */
  move: (
    id: string,
    direction: 'deposit' | 'withdraw',
    body: ShelfMoveBody,
    key: string,
    f?: typeof fetch,
  ): Promise<ApiResult<ShelfMoveResult>> =>
    apiRequest(`${c(id)}/shelf/${direction}`, { method: 'POST', body, ...keyed(key) }, f),
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
  /** Ticket 3.4: the Forge's view of one item. */
  item: (
    id: string,
    itemId: string,
    o: Signal = {},
    f?: typeof fetch,
  ): Promise<ApiResult<ForgeItemState>> => apiRequest(`${c(id)}/forge/items/${itemId}`, o, f),
  upgrade: (
    id: string,
    itemId: string,
    key: string,
    f?: typeof fetch,
  ): Promise<ApiResult<ForgeActionResult>> =>
    apiRequest(`${c(id)}/forge/upgrade`, { method: 'POST', body: { itemId }, ...keyed(key) }, f),
  reroll: (
    id: string,
    itemId: string,
    affixIndex: number,
    key: string,
    f?: typeof fetch,
  ): Promise<ApiResult<ForgeActionResult>> =>
    apiRequest(
      `${c(id)}/forge/reroll`,
      { method: 'POST', body: { itemId, affixIndex }, ...keyed(key) },
      f,
    ),
  improve: (
    id: string,
    itemId: string,
    affixIndex: number,
    key: string,
    f?: typeof fetch,
  ): Promise<ApiResult<ForgeActionResult>> =>
    apiRequest(
      `${c(id)}/forge/improve`,
      { method: 'POST', body: { itemId, affixIndex }, ...keyed(key) },
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
    case 'item_locked':
      return 'That item is locked. Unlock it in the pack first.';
    case 'character_not_active':
      return 'Select this character before sending it out to farm.';
    case 'area_locked':
      return 'Your hero is not ready for that place yet. The map shows what it takes.';
    case 'in_dungeon':
      return 'Your hero is in the Nameless Crypt. Finish the run and claim it first.';
    case 'not_farming':
      return 'This character is not farming right now.';
    case 'insufficient_gold':
      return 'Not enough gold.';
    case 'insufficient_materials':
      return 'Not enough materials.';
    case 'max_upgrade':
      return 'This item is already at +10.';
    case 'improvement_cap':
      return 'This affix has been improved as far as it goes.';
    case 'affix_at_max':
      return 'This affix is already at the top of its range.';
    case 'no_such_affix':
    case 'item_unforgeable':
      return 'The smith cannot work this item. The view has been refreshed.';
    case 'recipe_locked':
      return 'Your hero is not experienced enough for this recipe yet.';
    case 'inventory_full':
      return 'The pack is full. Sell or salvage something first.';
    // Ticket 4.7: the Warehouse.
    case 'warehouse_closed':
      return 'The Warehouse is not open yet. The town must restore it first (Town works).';
    case 'warehouse_full':
      return 'The warehouse has no room for that many. Take something out or extend it.';
    case 'item_in_warehouse':
      return 'That item is in the warehouse. Take it out first.';
    case 'item_on_shelf':
      return 'That item is on the account shelf. Take it out to a hero first.';
    case 'shelf_paused':
      return 'The town keeps the account shelf closed for that for now. Anything on it can still be taken out.';
    case 'shelf_full':
      return 'The account shelf has no room for that many. Take something out first.';
    case 'item_held':
      return 'That item was received in a trade and is held for now. It can go on the shelf once the hold ends.';
    case 'nothing_to_move':
      return 'Choose something to move first.';
    case 'level_changed':
      return 'The warehouse was extended meanwhile. The view has been refreshed.';
    case 'warehouse_max_level':
      return 'The warehouse is fully extended.';
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
