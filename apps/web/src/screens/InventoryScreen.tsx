import { useMemo, useState } from 'react';
import {
  CLASSES,
  DEFAULT_ACTIVITY_CONFIG,
  RARITIES,
  type ClassId,
  type RarityId,
} from '@worldforge/game-core';
import { useActiveCharacter } from '../characters/CharactersProvider';
import { ItemFrame } from '../components/ItemFrame';
import { ItemTooltip } from '../components/ItemTooltip';
import { useElementWidth } from '../components/useElementWidth';
import { useGame } from '../game/GameProvider';
import { canUse, equippedBySlot, slotName, targetSlot, type ItemView } from '../game/items';
import { PACK_LARGE_MIN_WIDTH, STASH_LARGE, socketSize } from '../lib/pixel';
import { routeHref } from '../lib/route';
import './inventory.css';

type Filter = 'all' | RarityId;
type Notice = { kind: 'ok' | 'error'; text: string };

/** Server rule (game-core activity config): drops beyond this are salvaged to gold. */
const CAPACITY = DEFAULT_ACTIVITY_CONFIG.inventory.capacity;
/** Sockets drawn at least (the approved 8 × 5 chest); more rows appear as the pack fills. */
const MIN_SOCKETS = 40;
const CLASS_NAME = new Map(CLASSES.map((c) => [c.id, c.name]));

function usableBy(classes: readonly ClassId[]): string {
  return classes.map((c) => CLASS_NAME.get(c) ?? c).join(' and ');
}

export function InventoryScreen() {
  const hero = useActiveCharacter();
  const { inventory, equip, discard, reload } = useGame();
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<'equip' | 'discard' | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [bodyRef, bodyWidth] = useElementWidth<HTMLDivElement>(0);
  // Desktop with room: 8 columns at ×3. Otherwise the approved ×2 grid (phones included).
  const large = bodyWidth >= PACK_LARGE_MIN_WIDTH;
  const iconScale = large ? 3 : 2;
  const columns = large ? STASH_LARGE.columns : 10;

  const ready = inventory.kind === 'ready' ? inventory.value : null;
  // Newest first, so fresh loot is at hand.
  const items = useMemo(
    () => [...(ready?.items ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [ready],
  );
  const equipped = useMemo(() => equippedBySlot(ready?.equipped ?? []), [ready]);
  const counts = useMemo(() => {
    const map = new Map<RarityId, number>();
    for (const item of items) map.set(item.rarity, (map.get(item.rarity) ?? 0) + 1);
    return map;
  }, [items]);

  const visible = filter === 'all' ? items : items.filter((i) => i.rarity === filter);
  const sockets = Math.max(MIN_SOCKETS, Math.ceil(items.length / columns) * columns);
  const emptySockets = filter === 'all' ? Math.max(0, sockets - items.length) : 0;
  const free = Math.max(0, CAPACITY - items.length);
  // The selection falls back to the first visible item (e.g. after equipping the selected one).
  const selected = visible.find((i) => i.id === selectedId) ?? visible[0];
  const slot = selected ? targetSlot(selected, equipped) : undefined;
  const counterpart = slot ? (equipped[slot] ?? null) : undefined;
  const usable = selected ? canUse(selected, hero.classId) : false;

  const choose = (item: ItemView) => {
    setSelectedId(item.id);
    setConfirmDiscard(false);
    setNotice(null);
  };

  const onEquip = async (item: ItemView) => {
    setBusy('equip');
    setNotice(null);
    const failure = await equip(item.id);
    setBusy(null);
    if (failure) {
      setNotice({ kind: 'error', text: failure });
      return;
    }
    const replaced = counterpart ? ` ${counterpart.name} went back into the pack.` : '';
    setNotice({
      kind: 'ok',
      text: `Equipped ${item.name}${slot ? ` (${slotName(slot)})` : ''}.${replaced}`,
    });
    setSelectedId(counterpart?.id ?? null);
  };

  const onDiscard = async (item: ItemView) => {
    if (!confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    setBusy('discard');
    setNotice(null);
    const failure = await discard(item.id);
    setBusy(null);
    setConfirmDiscard(false);
    setNotice(
      failure ? { kind: 'error', text: failure } : { kind: 'ok', text: `${item.name} discarded.` },
    );
    if (!failure) setSelectedId(null);
  };

  let stash;
  if (inventory.kind === 'loading') {
    stash = (
      <div className="stash__empty" role="status">
        <p className="display">Opening the pack…</p>
        <p>Counting what you carry.</p>
      </div>
    );
  } else if (inventory.kind === 'error') {
    stash = (
      <div className="stash__empty" role="alert">
        <p className="display">The pack will not open.</p>
        <p>{inventory.message}</p>
        <button type="button" className="btn" onClick={reload}>
          Try again
        </button>
      </div>
    );
  } else if (items.length === 0) {
    stash = (
      <div className="stash__empty">
        <p className="display">Your pack is empty.</p>
        <p>Everything your hero finds in the fields lands here.</p>
        <a className="btn" href={routeHref('area')}>
          Go to the fields
        </a>
      </div>
    );
  } else if (visible.length === 0) {
    stash = (
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
    );
  } else {
    stash = (
      <ul className="stash__grid">
        {visible.map((item) => (
          <li key={item.id}>
            <ItemFrame
              item={item}
              scale={iconScale}
              selected={item.id === selected?.id}
              onSelect={() => choose(item)}
            />
          </li>
        ))}
        {Array.from({ length: emptySockets }, (_, i) => (
          <li key={`empty-${i}`} className="stash__socket" aria-hidden="true" />
        ))}
      </ul>
    );
  }

  return (
    <div className="pack">
      <header className="pack__head">
        <div>
          <p className="caps pack__eyebrow">Inventory</p>
          <h1 className="display pack__title">Pack</h1>
        </div>
        <p className="pack__capacity">
          <span className="pack__capacity-num">{ready ? items.length : '–'}</span>
          <span className="pack__capacity-of"> / {CAPACITY}</span>
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
          All <span className="pack__count">{items.length}</span>
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

      <div className={`pack__body${large ? ' pack__body--large' : ''}`} ref={bodyRef}>
        <section
          className="stash"
          aria-label="Carried items"
          style={{
            ['--socket' as string]: `${socketSize(iconScale)}px`,
            ['--stash-cols' as string]: large ? STASH_LARGE.columns : undefined,
            ['--stash-gap' as string]: large ? `${STASH_LARGE.gap}px` : undefined,
          }}
        >
          {stash}
          {ready && filter === 'all' && items.length > 0 ? (
            <p className="stash__free">
              {free} free {free === 1 ? 'slot' : 'slots'}
              {free === 0 ? ' · new drops are salvaged for gold' : ''}
            </p>
          ) : null}
        </section>

        <section className="pack__inspect" aria-label="Selected item">
          {notice ? (
            <p
              className={`pack__notice pack__notice--${notice.kind}`}
              role={notice.kind === 'error' ? 'alert' : 'status'}
            >
              {notice.text}
            </p>
          ) : null}
          {selected ? (
            <>
              <ItemTooltip
                item={selected}
                {...(usable && counterpart !== undefined ? { compareTo: counterpart } : {})}
                caption="Selected"
                {...(usable
                  ? {}
                  : {
                      note: selected.slot
                        ? `${usableBy(selected.classes)} only`
                        : 'No longer usable',
                    })}
              >
                <button
                  type="button"
                  className="btn btn--brass"
                  onClick={() => void onEquip(selected)}
                  disabled={!usable || busy !== null}
                  aria-busy={busy === 'equip'}
                >
                  {busy === 'equip' ? 'Equipping…' : 'Equip'}
                </button>
                <button
                  type="button"
                  className={`btn${confirmDiscard ? ' pack__discard--confirm' : ''}`}
                  onClick={() => void onDiscard(selected)}
                  disabled={busy !== null}
                  aria-busy={busy === 'discard'}
                >
                  {busy === 'discard'
                    ? 'Discarding…'
                    : confirmDiscard
                      ? 'Discard for good?'
                      : 'Discard'}
                </button>
                {confirmDiscard && busy === null ? (
                  <button type="button" className="btn" onClick={() => setConfirmDiscard(false)}>
                    Keep it
                  </button>
                ) : null}
              </ItemTooltip>
              {counterpart && usable ? (
                <div className="pack__equipped">
                  <ItemTooltip
                    item={counterpart}
                    caption={`Currently equipped${slot ? ` · ${slotName(slot)}` : ''}`}
                  />
                </div>
              ) : null}
            </>
          ) : (
            items.length > 0 && <p className="pack__hint">Select an item to inspect it.</p>
          )}
        </section>
      </div>
    </div>
  );
}
