import { useMemo } from 'react';
import { compareRarity, type RarityId } from '@worldforge/game-core';
import { ItemFrame } from '../../components/ItemFrame';
import type { ItemView } from '../../game/items';
import { routeHref } from '../../lib/route';

/**
 * A multi-select grid of the pack's unequipped items (merchant sell, forge salvage). Quick picks
 * select every item up to a rarity. Equipped items never show: they can't be sold or salvaged.
 * Locked items (ticket 3.7) show with their padlock but can't be picked.
 */
export function ItemPicker({
  items,
  picked,
  onChange,
  label,
  emptyText,
}: {
  items: readonly ItemView[];
  picked: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  label: string;
  emptyText: string;
}) {
  // Newest first, like the pack.
  const sorted = useMemo(
    () => [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [items],
  );
  const upTo = (rarity: RarityId) =>
    onChange(
      new Set(
        sorted.filter((i) => !i.locked && compareRarity(i.rarity, rarity) <= 0).map((i) => i.id),
      ),
    );
  const locked = sorted.filter((i) => i.locked).length;
  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };

  if (sorted.length === 0) {
    return (
      <div className="picker__empty">
        <p className="display">Nothing to offer.</p>
        <p>{emptyText}</p>
        <a className="btn" href={routeHref('map')}>
          Go farming
        </a>
      </div>
    );
  }
  return (
    <div className="picker">
      <div className="picker__quick" role="group" aria-label="Quick select">
        <button type="button" className="btn btn--small" onClick={() => upTo('common')}>
          All common
        </button>
        <button type="button" className="btn btn--small" onClick={() => upTo('uncommon')}>
          Up to uncommon
        </button>
        <button
          type="button"
          className="btn btn--small"
          onClick={() => onChange(new Set())}
          disabled={picked.size === 0}
        >
          Clear
        </button>
      </div>
      <ul className="picker__grid" aria-label={label}>
        {sorted.map((item) => (
          <li key={item.id}>
            <ItemFrame
              item={item}
              scale={2}
              selected={picked.has(item.id) && !item.locked}
              onSelect={() => toggle(item.id)}
              disabled={item.locked}
              context={`Level ${item.itemLevel}`}
            />
          </li>
        ))}
      </ul>
      {locked > 0 ? (
        <p className="picker__locked">
          {locked} locked {locked === 1 ? 'item stays' : 'items stay'} out of this. Unlock in the
          pack.
        </p>
      ) : null}
    </div>
  );
}
