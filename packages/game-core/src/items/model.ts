/**
 * Item model v2 (ticket 3.1, docs/DATA_MODEL.md `item_instances`): the Phase 3 per-item state that
 * sits next to the generated item. Every field defaults to "untouched" on a fresh drop; the ticket
 * named next to each field is the first one that writes it.
 */

/** Highest upgrade level (ticket 3.4; GDD §8.1, +0 to +10). */
export const MAX_UPGRADE_LEVEL = 10;

/**
 * Ticket 3.4: the bonus an upgrade level adds to the item's implicit (base) stats, as a fraction,
 * indexed by level (`[0]` = +0 = none). Cumulative: a +10 item has +50 % base values. Affixes and
 * effects are untouched; upgrades raise base values only (GDD §8.1).
 */
export const UPGRADE_IMPLICIT_BONUS: readonly number[] = [
  0, 0.04, 0.08, 0.12, 0.16, 0.21, 0.26, 0.31, 0.37, 0.43, 0.5,
];

/**
 * The implicit-stat bonus of an upgrade level. Missing, null, 0 or out-of-range values give 0
 * (stored rows are checked to 0…10; older crypt snapshots carry no level).
 */
export function upgradeImplicitBonus(upgradeLevel: number | null | undefined): number {
  if (!upgradeLevel || !Number.isInteger(upgradeLevel) || upgradeLevel < 0) return 0;
  return UPGRADE_IMPLICIT_BONUS[Math.min(upgradeLevel, MAX_UPGRADE_LEVEL)] ?? 0;
}

/** Item variants (GDD §7.5). Only Void in Phase 3 (ticket 3.5); Prismatic is deferred. */
export const ITEM_VARIANT_IDS = ['void'] as const;

export type ItemVariantId = (typeof ITEM_VARIANT_IDS)[number];

export function isItemVariantId(value: unknown): value is ItemVariantId {
  return typeof value === 'string' && (ITEM_VARIANT_IDS as readonly string[]).includes(value);
}

/** Phase 3 item state as the API shows it. */
export interface ItemProgressState {
  /** 0…`MAX_UPGRADE_LEVEL` (ticket 3.4). */
  upgradeLevel: number;
  /** Null or a variant (ticket 3.5). */
  variant: ItemVariantId | null;
  /** Legendary effect or Mythic signature effect id in the effect registry (ticket 3.2). */
  effectId: string | null;
  /** Set id (ticket 3.3). */
  setId: string | null;
  /** Named Mythic item id (ticket 3.2). */
  mythicId: string | null;
  /** Locked items can't be sold, salvaged or discarded (ticket 3.7). */
  locked: boolean;
}

/** The state of a freshly generated item. */
export const DEFAULT_ITEM_PROGRESS: Readonly<ItemProgressState> = {
  upgradeLevel: 0,
  variant: null,
  effectId: null,
  setId: null,
  mythicId: null,
  locked: false,
};
