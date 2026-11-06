import type { GeneratedItem } from '../loot/generate.js';
import type { MaterialId } from '../world/materials.js';
import {
  lootFilterCategories,
  lootFilterHandles,
  lootFilterYield,
  type LootFilterAction,
  type LootFilterRules,
} from '../economy/lootFilter.js';
import { DEFAULT_ACTIVITY_CONFIG, type InventoryConfig } from './config.js';

/** Gold an overflow item is salvaged for. */
export function salvageValue(
  item: Pick<GeneratedItem, 'rarityId' | 'itemLevel'>,
  config: InventoryConfig = DEFAULT_ACTIVITY_CONFIG.inventory,
): number {
  const { base, perItemLevel, rarityMultiplier } = config.salvage;
  return Math.max(
    1,
    Math.round((base + perItemLevel * item.itemLevel) * rarityMultiplier[item.rarityId]),
  );
}

/** A new drop the loot filter sold or salvaged (ticket 3.7). */
export interface FilteredDrop {
  item: GeneratedItem;
  action: LootFilterAction;
  gold: number;
  materials: Partial<Record<MaterialId, number>>;
}

/**
 * Whether a drop is valuable (ticket B.2): Legendary, Mythic, a set piece or Void, i.e. one of the
 * loot filter's protected categories. A valuable drop that finds no room is kept beyond the pack's
 * capacity instead of being overflow-salvaged.
 */
export function isValuableDrop(item: Parameters<typeof lootFilterCategories>[0]): boolean {
  return lootFilterCategories(item).length > 0;
}

export interface DropPlacement {
  /** Items for the pack, in drop order (valuable drops kept beyond capacity included). */
  items: GeneratedItem[];
  /**
   * Ticket B.2: the valuable drops among `items` that found no free slot and were kept beyond the
   * pack's capacity (the pack is then over capacity), in drop order.
   */
  overCapacity: GeneratedItem[];
  /** Ordinary items that did not fit (pack full) and were salvaged to gold. */
  salvaged: GeneratedItem[];
  goldSalvaged: number;
  /** Drops the loot filter handled; present only when a filter was given. */
  filtered?: FilteredDrop[];
}

/**
 * Places new drops, in drop order (ticket 3.7): a drop the loot filter handles is sold or salvaged
 * and takes no pack space; any other drop goes into the pack while there is room, and is salvaged
 * to gold (the capacity rule, docs/FARMING.md) once it is full, unless it is valuable
 * (`isValuableDrop`, ticket B.2): those are kept beyond the capacity. The filter runs first, so a
 * player who ticked a protected category still has those drops sold or salvaged. The filter only
 * decides what happens to an item after it was rolled, so the drops themselves never depend on it.
 * The placement depends only on the pack count at the start and the drop order, and a settlement
 * hands its new count to the next one, so splitting a window changes nothing.
 */
export function createDropPlacer(
  inventoryCount: number,
  inventory: InventoryConfig,
  filter: LootFilterRules | null | undefined,
) {
  let free = Math.max(0, inventory.capacity - inventoryCount);
  const out: DropPlacement = { items: [], overCapacity: [], salvaged: [], goldSalvaged: 0 };
  const filtered: FilteredDrop[] = [];
  if (filter) out.filtered = filtered;
  return {
    place(item: GeneratedItem): void {
      if (filter && lootFilterHandles(item, filter)) {
        const y = lootFilterYield(item, filter.action);
        filtered.push({ item, action: filter.action, gold: y.gold, materials: y.materials });
      } else if (free > 0) {
        out.items.push(item);
        free--;
      } else if (isValuableDrop(item)) {
        out.items.push(item);
        out.overCapacity.push(item);
      } else {
        out.salvaged.push(item);
        out.goldSalvaged += salvageValue(item, inventory);
      }
    },
    result: (): DropPlacement => out,
  };
}

/** Totals of filtered drops: items sold, items salvaged, gold, materials. */
export function filteredTotals(filtered: readonly FilteredDrop[] | undefined) {
  const totals = {
    sold: 0,
    salvaged: 0,
    gold: 0,
    materials: {} as Partial<Record<MaterialId, number>>,
  };
  for (const f of filtered ?? []) {
    if (f.action === 'sell') totals.sold++;
    else totals.salvaged++;
    totals.gold += f.gold;
    for (const [id, n] of Object.entries(f.materials) as [MaterialId, number][]) {
      totals.materials[id] = (totals.materials[id] ?? 0) + n;
    }
  }
  return totals;
}
