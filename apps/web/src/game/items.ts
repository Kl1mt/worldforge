import {
  itemBindingSource,
  type ItemBindingReason,
  BOSS_LOOT_TABLES,
  DUNGEONS,
  describeEffect,
  findEffect,
  findSet,
  mythicForBase,
  setForBase,
  ITEM_SETS,
  wornSets,
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
  activeVariant,
  type ItemVariantDefinition,
  variantAffixValue,
  type LootFilterItem,
  type ClassId,
  type CoreStatId,
  type EquipmentSlotId,
  type ItemSlotKind,
  type ItemStatId,
  type RarityId,
  type SecondaryStatId,
  type StatGroupId,
} from '@worldforge/game-core';
import { findSprite } from '../content/assets';
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
  /** Forge marks of an affix (ticket 3.4): improvement steps applied, and a reroll put it there. */
  improvements?: number;
  rerolled?: boolean;
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
  /** Asset id of the icon (registered art or a tinted stand-in, `findSprite`). */
  icon: string | null;
  name: string;
  rarity: RarityId;
  /** Null for a base that no longer exists in content. */
  slot: ItemSlotKind | null;
  itemLevel: number;
  /** Implicit stats of the base, scaled by item level, rarity and upgrade level. */
  base: StatLine[];
  /** Forge upgrade level, 0…10 (ticket 3.4). */
  upgradeLevel: number;
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
  /**
   * The set of a set piece (ticket 3.3): its `setId`, when it names the set this base belongs to
   * (the server's counting rule). Null for every other item.
   */
  setId: string | null;
  /**
   * Ticket 3.5: the item's variant (Void) when it applies (a Legendary or Mythic, game-core
   * `activeVariant`); null otherwise. Its bonuses are already in `base` and `effect`.
   */
  variant: VariantView | null;
  /** Ticket 3.7: locked items can't be sold, salvaged or discarded. */
  locked: boolean;
  /** Ticket T.1: the item's binding in plain words; null where the server sent none (offers). */
  binding: BindingView | null;
  /**
   * Ticket T.5: received in a trade and held until then (ISO): it can be worn, but not sold,
   * salvaged, discarded, forged, stored or shelved. Absent when not held.
   */
  heldUntil?: string;
  /** Ticket 3.7: the fields the loot filter reads (game-core `lootFilterHandles`), for previews. */
  filterKey: LootFilterItem;
}

/** An item's binding as the tooltip shows it (ticket T.1, docs/TRADING.md). */
export interface BindingView {
  /** `bound` (account-bound) or `open` (binds when worn or forged). */
  kind: 'bound' | 'open';
  /** "Account-bound", "Binds when worn", "Tradeable once". */
  label: string;
  /** One plain sentence: why it is bound, or what binds it. */
  detail: string | null;
}

/**
 * Ticket T.1: the binding in plain words. While trading is closed a bind-on-equip item only says
 * what binds it and that it can't be traded now; it never promises a trade.
 */
export function bindingView(
  dto: Pick<ItemDisplaySource, 'source' | 'binding' | 'bindingReason' | 'tradeable'>,
): BindingView | null {
  if (!dto.binding) return null;
  if (dto.binding === 'equip') {
    return dto.tradeable
      ? {
          kind: 'open',
          label: 'Tradeable once',
          detail: 'Binds to your account when worn or forged.',
        }
      : {
          kind: 'open',
          label: 'Binds when worn',
          detail: 'Wearing or forging it binds it to your account. It can’t be traded.',
        };
  }
  const source = itemBindingSource(dto.source);
  const detail: Record<ItemBindingReason, string | null> = {
    fresh: null,
    worn: 'Bound when first worn.',
    forged: 'Bound by work at the forge.',
    traded: 'Bound after changing hands once.',
    rarity: 'Common, uncommon and rare items are always bound.',
    source:
      source === 'hoard'
        ? 'Boss hoard loot is always bound.'
        : source === 'quest' || source === 'contract'
          ? 'Quest and contract rewards are always bound.'
          : source === 'merchant'
            ? 'Goods bought from the merchant are always bound.'
            : null,
    bound: null,
  };
  return { kind: 'bound', label: 'Account-bound', detail: detail[dto.bindingReason ?? 'bound'] };
}

/** A variant as the frame and tooltip show it (ticket 3.5; Prismatic 6.4). */
export interface VariantView {
  id: ItemVariantDefinition['id'];
  name: string;
  /** "+10 %" on base values. */
  implicitBonus: number;
  /** "+10 %" on the item's own effect magnitudes; 0 when the item has no effect. */
  effectBonus: number;
  /** Ticket 6.4: "+10 %" on the item's combat affixes (Prismatic); 0 for Void. */
  affixBonus: number;
}

function variantView(
  rarityId: RarityId,
  variant: ItemDto['variant'] | undefined,
  hasEffect: boolean,
): VariantView | null {
  const v = activeVariant({ rarityId, variant: variant ?? null });
  if (!v) return null;
  return {
    id: v.id,
    name: v.name,
    implicitBonus: v.implicitBonus,
    effectBonus: hasEffect ? Math.round((v.effectStrength - 1) * 1000) / 1000 : 0,
    affixBonus: Math.round((v.affixBonus - 1) * 1000) / 1000,
  };
}

/** An item's unique effect, as the tooltip shows it. */
export interface ItemEffectView {
  kind: 'legendary' | 'mythic';
  name: string;
  /** The effect text with the rolled values, e.g. "Deal 60 % more damage to bosses." */
  text: string;
}

/** Where set pieces come from (game-core loot tables with `setShare`), for the tooltip. */
export const SET_SOURCES = 'the Sunken Abbey, the Nameless Crypt and the Gravewarden’s hoard';

/** Where Mythics come from (game-core loot tables with `mythics`), for the tooltip. */
export const MYTHIC_SOURCES = 'the depths of the Sunken Abbey and the Gravewarden’s hoard';

/** The display of an item's effect columns; null without a known effect. */
export function effectView(
  effectId: string | null | undefined,
  effectRoll: number | null | undefined,
  /** Ticket 3.5: a Void item's effect strength (magnitudes only, as combat applies it). */
  strength = 1,
): ItemEffectView | null {
  const effect = effectId ? findEffect(effectId) : undefined;
  if (!effect || effect.kind === 'set') return null;
  return {
    kind: effect.kind,
    name: effect.name,
    text: describeEffect({
      effectId: effect.id,
      roll: effectRoll ?? 1,
      ...(strength !== 1 ? { strength } : {}),
    }),
  };
}

/** Where a boss-exclusive base drops, from the boss loot tables and dungeon content. */
export function uniqueSourceOf(baseId: string): string | null {
  const base = findItemBase(baseId);
  if (!base?.unique || mythicForBase(baseId) || setForBase(baseId)) return null;
  const table = BOSS_LOOT_TABLES.find((t) => t.entries.some((e) => e.baseId === baseId));
  const dungeon =
    table && DUNGEONS.find((d) => d.tiers.some((t) => t.bossLoot.lootTableId === table.id));
  return dungeon ? `${getEnemy(dungeon.bossId).name} of ${dungeon.name}` : 'a boss';
}

function iconOf(id: string | undefined): string | null {
  return id && id.startsWith('item.') && findSprite(id) ? id : null;
}

/** The fields of a server item that the display model reads (merchant offers have no row yet). */
export type ItemDisplaySource = Pick<
  ItemDto,
  'id' | 'baseId' | 'rarityId' | 'itemLevel' | 'affixes' | 'equippedSlot' | 'source' | 'createdAt'
> &
  Partial<
    Pick<
      ItemDto,
      | 'effectId'
      | 'effectRoll'
      | 'setId'
      | 'mythicId'
      | 'upgradeLevel'
      | 'variant'
      | 'locked'
      | 'binding'
      | 'bindingReason'
      | 'tradeable'
      | 'holdUntil'
    >
  >;

/** The set id of an item, if it really is a piece of that set (game-core `wornSets` rule). */
function setIdOf(baseId: string, setId: string | null | undefined): string | null {
  return setId && setForBase(baseId)?.id === setId ? setId : null;
}

export function toItemView(dto: ItemDisplaySource): ItemView {
  const base = findItemBase(dto.baseId);
  const affixes: StatLine[] = [];
  // Ticket 6.4: a Prismatic item's combat affixes are shown as the game reads them (× 1.1), so the
  // lines and the "if equipped" comparison match the character's stats. The Forge reads the
  // stored values from the item itself (`dto.affixes`).
  const variant = activeVariant({ rarityId: dto.rarityId, variant: dto.variant ?? null });
  for (const rolled of dto.affixes) {
    const def = findAffix(rolled.affixId);
    if (!def) continue;
    const line: StatLine = {
      stat: def.stat,
      value: variantAffixValue(variant, def.stat, rolled.value, def.step),
    };
    if (def.classes) line.label = affixName(def.label);
    if (rolled.improvements) line.improvements = rolled.improvements;
    if (rolled.rerolled) line.rerolled = true;
    affixes.push(line);
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
    upgradeLevel: dto.upgradeLevel ?? 0,
    affixes,
    classes: base?.classes ?? [],
    equippedSlot: dto.equippedSlot,
    createdAt: dto.createdAt,
    uniqueSource: uniqueSourceOf(dto.baseId),
    effect: effectView(
      dto.effectId,
      dto.effectRoll,
      activeVariant({ rarityId: dto.rarityId, variant: dto.variant ?? null })?.effectStrength,
    ),
    setId: setIdOf(dto.baseId, dto.setId),
    variant: variantView(
      dto.rarityId,
      dto.variant,
      Boolean(dto.effectId && findEffect(dto.effectId)),
    ),
    locked: dto.locked ?? false,
    binding: bindingView(dto),
    ...(dto.holdUntil && Date.parse(dto.holdUntil) > Date.now()
      ? { heldUntil: dto.holdUntil }
      : {}),
    filterKey: {
      rarityId: dto.rarityId,
      affixes: dto.affixes,
      ...(dto.effectId ? { effectId: dto.effectId } : {}),
      ...(dto.setId ? { setId: dto.setId } : {}),
      ...(dto.mythicId ? { mythicId: dto.mythicId } : {}),
      ...(dto.variant ? { variant: dto.variant } : {}),
    },
  };
}

/** One piece of a set as the tracker shows it. */
export interface SetPieceView {
  baseId: string;
  name: string;
  slot: ItemSlotKind;
  /** Worn now (counts toward the bonuses). */
  equipped: boolean;
  /** In the pack (not worn). */
  inPack: boolean;
}

/** One set bonus as the tracker shows it. */
export interface SetBonusView {
  pieces: number;
  name: string;
  text: string;
  active: boolean;
}

/** A set's progress for the character: pieces owned and worn, bonuses active (ticket 3.3). */
export interface SetTrackerView {
  id: string;
  name: string;
  theme: string;
  /** Distinct pieces worn, as the server counts them. */
  worn: number;
  pieces: SetPieceView[];
  bonuses: SetBonusView[];
}

/**
 * The tracker of one set from the character's equipped items and pack. Counting is game-core's
 * (`wornSets`): each piece once, by set id and base, never by variant.
 */
export function setTracker(
  setId: string,
  equipped: readonly ItemView[],
  pack: readonly ItemView[],
): SetTrackerView | null {
  const set = findSet(setId);
  if (!set) return null;
  const worn = wornSets(equipped.map((i) => ({ baseId: i.baseId, setId: i.setId }))).find(
    (w) => w.set.id === setId,
  );
  const wornIds = new Set(worn?.pieces ?? []);
  const packIds = new Set(pack.filter((i) => i.setId === setId).map((i) => i.baseId));
  return {
    id: set.id,
    name: set.name,
    theme: set.theme,
    worn: wornIds.size,
    pieces: set.pieces.map((baseId) => {
      const base = findItemBase(baseId);
      return {
        baseId,
        name: base?.name ?? baseId,
        slot: base?.slot ?? 'ring',
        equipped: wornIds.has(baseId),
        inPack: !wornIds.has(baseId) && packIds.has(baseId),
      };
    }),
    bonuses: set.bonuses.map((b) => ({
      pieces: b.pieces,
      name: findEffect(b.effectId)?.name ?? b.effectId,
      text: describeEffect({ effectId: b.effectId, roll: 1 }),
      active: wornIds.size >= b.pieces,
    })),
  };
}

/** Trackers of every set the character owns at least one piece of, in content order. */
export function setTrackers(
  equipped: readonly ItemView[],
  pack: readonly ItemView[],
): SetTrackerView[] {
  const owned = new Set([...equipped, ...pack].map((i) => i.setId).filter((id) => id !== null));
  return ITEM_SETS.filter((s) => owned.has(s.id)).flatMap((s) => {
    const view = setTracker(s.id, equipped, pack);
    return view ? [view] : [];
  });
}

/**
 * A gained item from a return summary (no affixes there): name, icon, rarity and, for a Legendary
 * or Mythic, the effect's name (the roll is not in the summary; the pack shows the full text); for
 * a set piece (ticket 3.3), its set's name.
 */
export function summaryItemView(item: SummaryItem): Pick<
  ItemView,
  'id' | 'icon' | 'name' | 'rarity' | 'variant'
> & {
  effectName: string | null;
  setName: string | null;
} {
  const base = findItemBase(item.baseId);
  const setId = setIdOf(item.baseId, item.setId);
  return {
    id: item.id,
    icon: iconOf(base?.icon),
    name: base?.name ?? 'Unknown relic',
    rarity: item.rarityId,
    effectName: item.effectId ? (findEffect(item.effectId)?.name ?? null) : null,
    setName: setId ? (findSet(setId)?.name ?? null) : null,
    variant: variantView(item.rarityId, item.variant, Boolean(item.effectId)),
  };
}

/**
 * Whether a drop deserves its own moment (ticket 3.2): Legendary and Mythic finds (set pieces are
 * Legendary-rarity, ticket 3.3).
 */
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
