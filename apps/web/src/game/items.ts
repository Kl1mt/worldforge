import {
  BOSS_LOOT_TABLES,
  DUNGEONS,
  getEnemy,
  CORE_STAT_IDS,
  EQUIPMENT_SLOTS,
  defaultEquipSlot,
  equipmentSlotsForKind,
  findAffix,
  findItemBase,
  getImplicitStats,
  type ClassId,
  type CoreStatId,
  type EquipmentSlotId,
  type ItemSlotKind,
  type ItemStatId,
  type RarityId,
} from '@worldforge/game-core';
import { ASSETS, type ItemAssetId } from '../content/assets';
import type { ItemDto, SummaryItem } from './api';

/**
 * Display model for an item. Built from the server's item (base id, rarity, item level, rolled
 * affixes) plus game-core content (names, icons, implicit stats). Display only: the server owns
 * the item and derives the character's stats itself.
 */
export interface StatLine {
  stat: ItemStatId;
  value: number;
}

export interface ItemView {
  id: string;
  baseId: string;
  /** Null when the art is missing (e.g. a base that was removed from content). */
  icon: ItemAssetId | null;
  name: string;
  rarity: RarityId;
  /** Null for a base that no longer exists in content. */
  slot: ItemSlotKind | null;
  itemLevel: number;
  /** Implicit stats of the base, scaled by item level and rarity. */
  base: StatLine[];
  affixes: StatLine[];
  classes: readonly ClassId[];
  equippedSlot: EquipmentSlotId | null;
  createdAt: string;
  /**
   * For a boss-exclusive (`unique`) base: who drops it, e.g. "The Gravewarden of The Nameless
   * Crypt". Null for ordinary bases.
   */
  uniqueSource: string | null;
}

/** Where a boss-exclusive base drops, from the boss loot tables and dungeon content. */
export function uniqueSourceOf(baseId: string): string | null {
  const base = findItemBase(baseId);
  if (!base?.unique) return null;
  const table = BOSS_LOOT_TABLES.find((t) => t.entries.some((e) => e.baseId === baseId));
  const dungeon = table && DUNGEONS.find((d) => d.bossLoot.lootTableId === table.id);
  return dungeon ? `${getEnemy(dungeon.bossId).name} of ${dungeon.name}` : 'a boss';
}

function iconOf(id: string | undefined): ItemAssetId | null {
  return id && id.startsWith('item.') && id in ASSETS ? (id as ItemAssetId) : null;
}

export function toItemView(dto: ItemDto): ItemView {
  const base = findItemBase(dto.baseId);
  const affixes: StatLine[] = [];
  for (const rolled of dto.affixes) {
    const def = findAffix(rolled.affixId);
    if (def) affixes.push({ stat: def.stat, value: rolled.value });
  }
  return {
    id: dto.id,
    baseId: dto.baseId,
    icon: iconOf(base?.icon),
    name: base?.name ?? 'Unknown relic',
    rarity: dto.rarityId,
    slot: base?.slot ?? null,
    itemLevel: dto.itemLevel,
    base: base ? getImplicitStats(dto) : [],
    affixes,
    classes: base?.classes ?? [],
    equippedSlot: dto.equippedSlot,
    createdAt: dto.createdAt,
    uniqueSource: uniqueSourceOf(dto.baseId),
  };
}

/** A gained item from a return summary (no affixes there): name, icon and rarity only. */
export function summaryItemView(
  item: SummaryItem,
): Pick<ItemView, 'id' | 'icon' | 'name' | 'rarity'> {
  const base = findItemBase(item.baseId);
  return {
    id: item.id,
    icon: iconOf(base?.icon),
    name: base?.name ?? 'Unknown relic',
    rarity: item.rarityId,
  };
}

export function slotName(slot: ItemSlotKind | EquipmentSlotId): string {
  if (slot === 'ring') return 'Ring';
  return EQUIPMENT_SLOTS.find((s) => s.id === slot)?.name ?? slot;
}

export function canUse(item: ItemView, classId: ClassId): boolean {
  return item.slot !== null && item.classes.includes(classId);
}

export type EquippedMap = Partial<Record<EquipmentSlotId, ItemView>>;

export function equippedBySlot(items: readonly ItemView[]): EquippedMap {
  const map: EquippedMap = {};
  for (const item of items) if (item.equippedSlot) map[item.equippedSlot] = item;
  return map;
}

/**
 * The slot an equip without a named slot would use, mirroring the server's rule
 * (game-core `defaultEquipSlot`): the base's only slot, or the first free ring slot.
 */
export function targetSlot(item: ItemView, equipped: EquippedMap): EquipmentSlotId | undefined {
  if (!item.slot) return undefined;
  const occupied = new Set(Object.keys(equipped) as EquipmentSlotId[]);
  return defaultEquipSlot(item.baseId, occupied) ?? equipmentSlotsForKind(item.slot)[0];
}

/** Sums an item's core-stat lines (implicit + affixes) per stat. Gold find is not a combat stat. */
export function itemTotals(item: Pick<ItemView, 'base' | 'affixes'>): Map<CoreStatId, number> {
  const totals = new Map<CoreStatId, number>();
  for (const line of [...item.base, ...item.affixes]) {
    if (line.stat === 'goldFind') continue;
    totals.set(line.stat, (totals.get(line.stat) ?? 0) + line.value);
  }
  return totals;
}

/**
 * Per-stat difference if `candidate` replaced `equipped` (candidate − equipped), in canonical
 * order, zeroes dropped. With nothing equipped the candidate's totals are the gain.
 * Gold find is compared separately at the end, since it is not a core stat.
 */
export function compareItems(
  candidate: Pick<ItemView, 'base' | 'affixes'>,
  equipped: Pick<ItemView, 'base' | 'affixes'> | undefined,
): StatLine[] {
  const a = itemTotals(candidate);
  const b = equipped ? itemTotals(equipped) : new Map<CoreStatId, number>();
  const deltas: StatLine[] = [];
  for (const stat of CORE_STAT_IDS) {
    const value = round((a.get(stat) ?? 0) - (b.get(stat) ?? 0));
    if (value !== 0) deltas.push({ stat, value });
  }
  const gold = round(goldFind(candidate) - (equipped ? goldFind(equipped) : 0));
  if (gold !== 0) deltas.push({ stat: 'goldFind', value: gold });
  return deltas;
}

function goldFind(item: Pick<ItemView, 'affixes'>): number {
  return item.affixes.reduce((sum, l) => (l.stat === 'goldFind' ? sum + l.value : sum), 0);
}

function round(n: number) {
  return Math.round(n * 10_000) / 10_000;
}
