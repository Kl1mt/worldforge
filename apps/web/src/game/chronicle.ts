import type { RarityId } from '@worldforge/game-core';
import { formatDuration } from '../lib/format';
import type { ReturnSummary } from './api';
import { isChaseDrop, summaryItemView } from './items';
import { materialCounts, professionName } from './materials';

/**
 * The Chronicle (area screen log) is built from settled summaries the server returns: it shows
 * what the server credited, never a client-side simulation. Entries are newest first.
 */
export type LogEntry =
  | { id: string; at: string; kind: 'kill'; kills: number; xp: number }
  | { id: string; at: string; kind: 'loot'; item: string; rarity: RarityId }
  /** A Legendary or Mythic find (ticket 3.2): its own line, never folded into "more items". */
  | {
      id: string;
      at: string;
      kind: 'chase';
      item: string;
      rarity: RarityId;
      effect: string | null;
      /** The set of a set piece (ticket 3.3). */
      set: string | null;
    }
  | { id: string; at: string; kind: 'gold'; amount: number }
  | { id: string; at: string; kind: 'level'; levels: number }
  | {
      id: string;
      at: string;
      kind: 'materials';
      materials: { name: string; rarity: RarityId; quantity: number }[];
    }
  | { id: string; at: string; kind: 'profession'; profession: string; levels: number }
  | { id: string; at: string; kind: 'death'; deaths: number }
  | { id: string; at: string; kind: 'note'; text: string };

/** Keep the log bounded; older lines fall off. */
export const CHRONICLE_LIMIT = 60;

/** Log lines for one settlement, newest first (as the list renders them). */
export function chronicleEntries(summary: ReturnSummary, seq: number): LogEntry[] {
  const at = summary.until;
  const id = (k: string) => `${seq}:${k}`;
  // Built oldest → newest within the settlement, then reversed.
  const out: LogEntry[] = [];
  if (summary.cappedMs > 0) {
    out.push({
      id: id('cap'),
      at,
      kind: 'note',
      text: `${formatDuration(summary.cappedMs)} beyond the offline limit earned nothing.`,
    });
  }
  if (summary.kills > 0) {
    out.push({ id: id('kill'), at, kind: 'kill', kills: summary.kills, xp: summary.xpGained });
  }
  if (summary.deaths > 0) out.push({ id: id('death'), at, kind: 'death', deaths: summary.deaths });
  const lootGold = summary.goldGained - summary.goldSalvaged;
  if (lootGold > 0) out.push({ id: id('gold'), at, kind: 'gold', amount: lootGold });
  // The summary lists the most recent items newest last; show at most a handful per settlement.
  // Legendary and Mythic finds always get their own line (ticket 3.2).
  const chase = summary.items.filter((item) => isChaseDrop(item.rarityId));
  const shown = summary.items.filter((item) => !isChaseDrop(item.rarityId)).slice(-6);
  for (const item of shown) {
    const view = summaryItemView(item);
    out.push({ id: id(`loot:${item.id}`), at, kind: 'loot', item: view.name, rarity: view.rarity });
  }
  const gathered = materialCounts(summary.materials);
  if (gathered.length > 0) {
    out.push({
      id: id('materials'),
      at,
      kind: 'materials',
      materials: gathered.map((g) => ({
        name: g.material.name,
        rarity: g.material.rarity,
        quantity: g.quantity,
      })),
    });
  }
  for (const item of chase) {
    const view = summaryItemView(item);
    out.push({
      id: id(`chase:${item.id}`),
      at,
      kind: 'chase',
      item: view.name,
      rarity: view.rarity,
      effect: view.effectName,
      set: view.setName,
    });
  }
  const unlisted = summary.itemsGained - shown.length - chase.length;
  if (unlisted > 0) {
    out.push({
      id: id('more'),
      at,
      kind: 'note',
      text: `${unlisted} more items went to your pack.`,
    });
  }
  if (summary.itemsSalvaged > 0) {
    out.push({
      id: id('salvage'),
      at,
      kind: 'note',
      text: `Pack full: ${summary.itemsSalvaged} ${summary.itemsSalvaged === 1 ? 'item' : 'items'} salvaged for ${summary.goldSalvaged} gold.`,
    });
  }
  if (summary.levelsGained > 0) {
    out.push({ id: id('level'), at, kind: 'level', levels: summary.levelsGained });
  }
  for (const [pid, p] of Object.entries(summary.professions ?? {})) {
    if (!p || p.levelsGained <= 0) continue;
    out.push({
      id: id(`prof:${pid}`),
      at,
      kind: 'profession',
      profession: professionName(pid as Parameters<typeof professionName>[0]),
      levels: p.levelsGained,
    });
  }
  return out.reverse();
}

/** Prepends new entries and trims the log. */
export function appendChronicle(log: readonly LogEntry[], fresh: readonly LogEntry[]): LogEntry[] {
  return [...fresh, ...log].slice(0, CHRONICLE_LIMIT);
}

/** Minimum gap between collections before a summary counts as a "return" worth a dialog. */
export const RETURN_MIN_MS = 60_000;

/** Whether a summary collected on load or return should open the return dialog. */
export function isWorthAReturnDialog(summary: ReturnSummary): boolean {
  const away = Date.parse(summary.until) - Date.parse(summary.since);
  return away >= RETURN_MIN_MS && (summary.simulatedMs > 0 || summary.cappedMs > 0);
}
