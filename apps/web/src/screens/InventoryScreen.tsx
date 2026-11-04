import { useMemo, useState } from 'react';
import { RARITIES, type RarityId } from '@worldforge/game-core';
import { ItemFrame } from '../components/ItemFrame';
import { ItemTooltip } from '../components/ItemTooltip';
import { equippedCounterpart } from '../lib/compare';
import { EQUIPPED, INVENTORY, INVENTORY_CAPACITY } from '../mock/items';
import './inventory.css';

type Filter = 'all' | RarityId;

export function InventoryScreen() {
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedUid, setSelectedUid] = useState<string | null>(INVENTORY[0]?.uid ?? null);

  const counts = useMemo(() => {
    const map = new Map<RarityId, number>();
    for (const item of INVENTORY) map.set(item.rarity, (map.get(item.rarity) ?? 0) + 1);
    return map;
  }, []);

  const visible = filter === 'all' ? INVENTORY : INVENTORY.filter((i) => i.rarity === filter);
  const emptySockets = filter === 'all' ? Math.max(0, INVENTORY_CAPACITY - INVENTORY.length) : 0;
  const selected = INVENTORY.find((i) => i.uid === selectedUid);
  const counterpart = selected ? equippedCounterpart(selected, EQUIPPED) : undefined;

  return (
    <div className="pack">
      <header className="pack__head">
        <div>
          <p className="caps pack__eyebrow">Inventory</p>
          <h1 className="display pack__title">Pack</h1>
        </div>
        <p className="pack__capacity">
          <span className="pack__capacity-num">{INVENTORY.length}</span>
          <span className="pack__capacity-of"> / {INVENTORY_CAPACITY}</span>
          <span className="caps"> carried</span>
        </p>
      </header>

      <div className="pack__filters" role="group" aria-label="Filter by rarity">
        <button
          type="button"
          className="btn pack__filter"
          aria-pressed={filter === 'all'}
          onClick={() => setFilter('all')}
        >
          All <span className="pack__count">{INVENTORY.length}</span>
        </button>
        {RARITIES.map((r) => (
          <button
            key={r.id}
            type="button"
            className={`btn pack__filter rarity-${r.id}`}
            aria-pressed={filter === r.id}
            onClick={() => setFilter(r.id)}
          >
            <span className="pack__pip" aria-hidden="true" />
            {r.name} <span className="pack__count">{counts.get(r.id) ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="pack__body">
        <section className="stash" aria-label="Carried items">
          {visible.length === 0 ? (
            <div className="stash__empty">
              <p className="display">Nothing of that rarity.</p>
              <p>
                {filter === 'mythic'
                  ? 'Mythic items are exceptionally rare. Keep the fields burning.'
                  : 'Nothing of this rarity yet. Keep fighting to find some.'}
              </p>
              <button type="button" className="btn" onClick={() => setFilter('all')}>
                Show all items
              </button>
            </div>
          ) : (
            <ul className="stash__grid">
              {visible.map((item) => (
                <li key={item.uid}>
                  <ItemFrame
                    item={item}
                    scale={2}
                    selected={item.uid === selectedUid}
                    onSelect={() => setSelectedUid(item.uid)}
                  />
                </li>
              ))}
              {Array.from({ length: emptySockets }, (_, i) => (
                <li key={`empty-${i}`} className="stash__socket" aria-hidden="true" />
              ))}
            </ul>
          )}
          {filter === 'all' ? (
            <p className="stash__free">
              {emptySockets} free {emptySockets === 1 ? 'slot' : 'slots'}
            </p>
          ) : null}
        </section>

        <section className="pack__inspect" aria-live="polite" aria-label="Selected item">
          {selected ? (
            <>
              <ItemTooltip item={selected} compareTo={counterpart ?? null} caption="Selected" />
              {counterpart ? (
                <div className="pack__equipped">
                  <ItemTooltip item={counterpart} caption="Currently equipped" />
                </div>
              ) : null}
            </>
          ) : (
            <p className="pack__hint">Select an item to inspect it.</p>
          )}
        </section>
      </div>
    </div>
  );
}
