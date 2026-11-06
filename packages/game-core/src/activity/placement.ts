import type { GeneratedItem } from '../loot/generate.js';
import type { MaterialId } from '../world/materials.js';
import {
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

export interface DropPlacement {
  /** Items for the pack, in drop order. */
  items: GeneratedItem[];
  /** Items that did not fit (pack full) and were salvaged to gold. */
  salvaged: GeneratedItem[];
  goldSalvaged: number;
  /** Drops the loot filter handled; present only when a filter was given. */
  filtered?: FilteredDrop[];
}

/**
 * Places new drops, in drop order (ticket 3.7): a drop the loot filter handles is sold or salvaged
 * and takes no pack space; any other drop goes into the pack while there is room, and is salvaged
 * to gold (the capacity rule, docs/FARMING.md) once it is full. The filter only decides what
 * happens to an item after it was rolled, so the drops themselves never depend on it. Without a
 * filter this is exactly the pre-3.7 capacity rule.
 */
export function createDropPlacer(
  inventoryCount: number,
  inventory: InventoryConfig,
  filter: LootFilterRules | null | undefined,
) {
  let free = Math.max(0, inventory.capacity - inventoryCount);
  const out: DropPlacement = { items: [], salvaged: [], goldSalvaged: 0 };
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
