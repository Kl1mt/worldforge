import {
  BOSS_LOOT_TABLES,
  DUNGEONS,
  describeEffect,
  findEffect,
  mythicForBase,
  getEnemy,
  CORE_STAT_IDS,
  EQUIPMENT_SLOTS,
  SECONDARY_STAT_IDS,
  STAT_GROUP_IDS,
  isCoreStatId,
  statGroup,
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
  type SecondaryStatId,
  type StatGroupId,
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
  /**
   * Display name when it differs from the stat's, e.g. a class affix "Rage-fuelled Heavy Strike
   * damage" (stat `skillDamage`).
   */
  label?: string;
}

/** Affix lines grouped for the tooltip (ticket 3.1), in offence → defence → utility order. */
export interface AffixGroup {
  group: StatGroupId;
  lines: StatLine[];
}

export const STAT_GROUP_NAMES: Readonly<Record<StatGroupId, string>> = {
  offence: 'Offence',
  defence: 'Defence',
  utility: 'Utility',
};

export function groupAffixes(lines: readonly StatLine[]): AffixGroup[] {
  return STAT_GROUP_IDS.map((group) => ({
    group,
    lines: lines.filter((l) => statGroup(l.stat) === group),
  })).filter((g) => g.lines.length > 0);
}

/** "+{value} Rage-fuelled Heavy Strike damage" → "Rage-fuelled Heavy Strike damage". */
function affixName(label: string): string {
  return label.replace(/^\+?\{value\}\s*/, '');
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
   * Crypt". Null for ordinary bases and Mythics.
   */
  uniqueSource: string | null;
  /** The Legendary effect or Mythic signature (ticket 3.2), with its rolled numbers. */
  effect: ItemEffectView | null;
}

/** An item's unique effect, as the tooltip shows it. */
export interface ItemEffectView {
  kind: 'legendary' | 'mythic';
  name: string;
  /** The effect text with the rolled values, e.g. "Deal 60 % more damage to bosses." */
  text: string;
}

/** Where Mythics come from (game-core loot tables with `mythics`), for the tooltip. */
export const MYTHIC_SOURCES = 'the depths of the Sunken Abbey and the Gravewarden’s hoard';

/** The display of an item's effect columns; null without a known effect. */
export function effectView(
  effectId: string | null | undefined,
  effectRoll: number | null | undefined,
): ItemEffectView | null {
  const effect = effectId ? findEffect(effectId) : undefined;
  if (!effect || effect.kind === 'set') return null;
  return {
    kind: effect.kind,
    name: effect.name,
    text: describeEffect({ effectId: effect.id, roll: effectRoll ?? 1 }),
  };
}

/** Where a boss-exclusive base drops, from the boss loot tables and dungeon content. */
export function uniqueSourceOf(baseId: string): string | null {
  const base = findItemBase(baseId);
  if (!base?.unique || mythicForBase(baseId)) return null;
  const table = BOSS_LOOT_TABLES.find((t) => t.entries.some((e) => e.baseId === baseId));
  const dungeon = table && DUNGEONS.find((d) => d.bossLoot.lootTableId === table.id);
  return dungeon ? `${getEnemy(dungeon.bossId).name} of ${dungeon.name}` : 'a boss';
}

function iconOf(id: string | undefined): ItemAssetId | null {
  return id && id.startsWith('item.') && id in ASSETS ? (id as ItemAssetId) : null;
}

/** The fields of a server item that the display model reads (merchant offers have no row yet). */
export type ItemDisplaySource = Pick<
  ItemDto,
  'id' | 'baseId' | 'rarityId' | 'itemLevel' | 'affixes' | 'equippedSlot' | 'source' | 'createdAt'
> &
  Partial<Pick<ItemDto, 'effectId' | 'effectRoll'>>;

export function toItemView(dto: ItemDisplaySource): ItemView {
  const base = findItemBase(dto.baseId);
  const affixes: StatLine[] = [];
  for (const rolled of dto.affixes) {
    const def = findAffix(rolled.affixId);
    if (!def) continue;
    affixes.push(
      def.classes
        ? { stat: def.stat, value: rolled.value, label: affixName(def.label) }
        : { stat: def.stat, value: rolled.value },
    );
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
    effect: effectView(dto.effectId, dto.effectRoll),
  };
}

/**
 * A gained item from a return summary (no affixes there): name, icon, rarity and, for a Legendary
 * or Mythic, the effect's name (the roll is not in the summary; the pack shows the full text).
 */
export function summaryItemView(
  item: SummaryItem,
): Pick<ItemView, 'id' | 'icon' | 'name' | 'rarity'> & { effectName: string | null } {
  const base = findItemBase(item.baseId);
  return {
    id: item.id,
    icon: iconOf(base?.icon),
    name: base?.name ?? 'Unknown relic',
    rarity: item.rarityId,
    effectName: item.effectId ? (findEffect(item.effectId)?.name ?? null) : null,
  };
}

/** Whether a drop deserves its own moment (ticket 3.2): Legendary and Mythic finds. */
export function isChaseDrop(rarity: RarityId): boolean {
  return rarity === 'legendary' || rarity === 'mythic';
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

/** Sums an item's core-stat lines (implicit + affixes) per stat. Secondary modifiers are left out. */
export function itemTotals(item: Pick<ItemView, 'base' | 'affixes'>): Map<CoreStatId, number> {
  const totals = new Map<CoreStatId, number>();
  for (const line of [...item.base, ...item.affixes]) {
    if (!isCoreStatId(line.stat)) continue;
    totals.set(line.stat, (totals.get(line.stat) ?? 0) + line.value);
  }
  return totals;
}

/** Sums an item's secondary-modifier affixes (gold find, item find, XP gain, …) per stat. */
export function itemSecondaryTotals(item: Pick<ItemView, 'affixes'>): Map<SecondaryStatId, number> {
  const totals = new Map<SecondaryStatId, number>();
  for (const line of item.affixes) {
    if (isCoreStatId(line.stat)) continue;
    totals.set(line.stat, (totals.get(line.stat) ?? 0) + line.value);
  }
  return totals;
}

/**
 * Per-stat difference if `candidate` replaced `equipped` (candidate − equipped), zeroes dropped:
 * the core stats in canonical order, then the secondary modifiers (ticket 3.1) in their order.
 * With nothing equipped the candidate's totals are the gain. Item-level only: the server caps
 * the character's summed modifiers.
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
  const sa = itemSecondaryTotals(candidate);
  const sb = equipped ? itemSecondaryTotals(equipped) : new Map<SecondaryStatId, number>();
  for (const stat of SECONDARY_STAT_IDS) {
    const value = round((sa.get(stat) ?? 0) - (sb.get(stat) ?? 0));
    if (value !== 0) deltas.push({ stat, value });
  }
  return deltas;
}

function round(n: number) {
  return Math.round(n * 10_000) / 10_000;
}
