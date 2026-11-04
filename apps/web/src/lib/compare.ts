import { CORE_STAT_IDS, type CoreStatId, type EquipmentSlotId } from '@worldforge/game-core';
import { slotKindOf, type MockItem, type StatLine } from '../mock/items';

/** Sums an item's base stats and affixes per stat. */
export function itemTotals(item: MockItem): Map<CoreStatId, number> {
  const totals = new Map<CoreStatId, number>();
  for (const line of [...item.base, ...item.affixes]) {
    totals.set(line.stat, (totals.get(line.stat) ?? 0) + line.value);
  }
  return totals;
}

/**
 * Per-stat difference between a candidate and the equipped item (candidate − equipped),
 * in canonical stat order. Zero differences are dropped. With nothing equipped, the
 * candidate's own totals are the gain.
 */
export function compareItems(candidate: MockItem, equipped: MockItem | undefined): StatLine[] {
  const a = itemTotals(candidate);
  const b = equipped ? itemTotals(equipped) : new Map<CoreStatId, number>();
  const deltas: StatLine[] = [];
  for (const stat of CORE_STAT_IDS) {
    const value = round((a.get(stat) ?? 0) - (b.get(stat) ?? 0));
    if (value !== 0) deltas.push({ stat, value });
  }
  return deltas;
}

/** The equipped item a candidate would replace: same slot; for rings, the first ring slot. */
export function equippedCounterpart(
  candidate: MockItem,
  equipped: Partial<Record<EquipmentSlotId, MockItem>>,
): MockItem | undefined {
  const slot = (Object.keys(equipped) as EquipmentSlotId[]).find(
    (s) => slotKindOf(s) === candidate.slot,
  );
  return slot ? equipped[slot] : undefined;
}

function round(n: number) {
  return Math.round(n * 100) / 100;
}
