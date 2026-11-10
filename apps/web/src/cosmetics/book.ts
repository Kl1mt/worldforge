import type { CosmeticKind } from '@worldforge/game-core';
import type { Collection, CollectionEntry } from './api';

/** Ticket 6.8: the collection book's pure rules (filters, what is worn, counts). */

export type KindFilter = CosmeticKind | 'all';
export type OwnFilter = 'all' | 'owned' | 'locked';

export function filterEntries(
  entries: readonly CollectionEntry[],
  kind: KindFilter,
  own: OwnFilter,
): CollectionEntry[] {
  return entries.filter(
    (e) =>
      (kind === 'all' || e.kind === kind) &&
      (own === 'all' || (own === 'owned' ? e.owned : !e.owned)),
  );
}

/** Whether `entry` is what the account (or, for an appearance, `heroId`) wears now. */
export function isWorn(entry: CollectionEntry, c: Collection, heroId: string | null): boolean {
  switch (entry.kind) {
    case 'appearance': {
      const hero = c.heroes.find((h) => h.id === heroId);
      if (!hero) return false;
      return (hero.palette ?? 'appearance.default') === entry.id;
    }
    case 'banner':
      return c.equipped.banner === entry.id;
    case 'crest':
      return c.equipped.crest === entry.id;
    case 'titleColour':
      return c.equipped.titleColour === entry.id;
    case 'title':
      return c.equipped.cosmeticTitle === entry.id;
  }
}

export function counts(entries: readonly CollectionEntry[]): { owned: number; total: number } {
  return { owned: entries.filter((e) => e.owned).length, total: entries.length };
}

/** The account slot an entry is worn in (appearances are per hero; titles go through honours). */
export function accountSlot(kind: CosmeticKind): 'banner' | 'crest' | 'titleColour' | null {
  return kind === 'banner' || kind === 'crest' || kind === 'titleColour' ? kind : null;
}
