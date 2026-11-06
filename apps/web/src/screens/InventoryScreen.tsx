import { useMemo, useRef, useState } from 'react';
import {
  CLASSES,
  DEFAULT_ACTIVITY_CONFIG,
  RARITIES,
  compareRarity,
  salvageYield,
  sellPrice,
  sumYields,
  type ClassId,
  type RarityId,
} from '@worldforge/game-core';
import { useActiveCharacter, useCharacters } from '../characters/CharactersProvider';
import { ItemFrame } from '../components/ItemFrame';
import { ItemTooltip } from '../components/ItemTooltip';
import { useElementWidth } from '../components/useElementWidth';
import { useGame } from '../game/GameProvider';
import { describeGameFailure, forgeApi, merchantApi } from '../game/api';
import { ActionKeys, isUncertain, itemsAction } from '../game/economy';
import { materialView } from '../game/materials';
import { formatNumber } from '../lib/format';
import { canUse, equippedBySlot, slotName, targetSlot, type ItemView } from '../game/items';
import { PACK_LARGE_MIN_WIDTH, STASH_LARGE, socketSize } from '../lib/pixel';
import { routeHref } from '../lib/route';
import { useOnboarding } from '../onboarding/OnboardingProvider';
import { MaterialsTab } from './MaterialsTab';
import { LootFilterPanel } from './LootFilterPanel';
import './inventory.css';

type Filter = 'all' | RarityId;
type Tab = 'items' | 'materials' | 'filter';
const TABS: { id: Tab; name: string }[] = [
  { id: 'items', name: 'Items' },
  { id: 'materials', name: 'Materials' },
  { id: 'filter', name: 'Loot filter' },
];
/** Free slots at or below which the pack shows its "nearly full" warning. */
const NEARLY_FULL = 5;
type Notice = { kind: 'ok' | 'error'; text: string };

/**
 * Server rule (game-core activity config): ordinary drops beyond this are salvaged to gold;
 * valuable ones (Legendary, Mythic, set, Void) are kept beyond it (ticket B.2).
 */
const CAPACITY = DEFAULT_ACTIVITY_CONFIG.inventory.capacity;
/** Sockets drawn at least (the approved 8 × 5 chest); more rows appear as the pack fills. */
const MIN_SOCKETS = 40;
/** The pack-full banner's "since you came back" line (overflow salvage and valuables kept). */
function sinceBack(t: { overflow: number; overflowGold: number; overCapacity: number }): string {
  const parts: string[] = [];
  if (t.overflow > 0) {
    parts.push(
      `${t.overflow} ${t.overflow === 1 ? 'drop' : 'drops'} salvaged for ${formatNumber(t.overflowGold)} gold`,
    );
  }
  if (t.overCapacity > 0) {
    parts.push(
      `${t.overCapacity} valuable ${t.overCapacity === 1 ? 'drop' : 'drops'} kept over capacity`,
    );
  }
  return parts.length > 0 ? `Since you came back: ${parts.join('; ')}.` : '';
}

const CLASS_NAME = new Map(CLASSES.map((c) => [c.id, c.name]));

function usableBy(classes: readonly ClassId[]): string {
  return classes.map((c) => CLASS_NAME.get(c) ?? c).join(' and ');
}

export function InventoryScreen() {
  const hero = useActiveCharacter();
  const {
    inventory,
    materials,
    equip,
    discard,
    setLocked,
    reload,
    tally,
    applyInventory,
    refreshMaterials,
  } = useGame();
  const { updateCharacter } = useCharacters();
  const { newItems, markItemsSeen } = useOnboarding();
  const [tab, setTab] = useState<Tab>('items');
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<'equip' | 'discard' | 'lock' | 'sell' | 'salvage' | null>(null);
  // Ticket 3.7: several items at once (sell or salvage), locked ones excluded.
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirmBulk, setConfirmBulk] = useState<'sell' | 'salvage' | null>(null);
  const keys = useRef(new ActionKeys()).current;
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
  const over = Math.max(0, items.length - CAPACITY);
  // The selection falls back to the first visible item (e.g. after equipping the selected one).
  const selected = visible.find((i) => i.id === selectedId) ?? visible[0];
  const slot = selected ? targetSlot(selected, equipped) : undefined;
  const counterpart = slot ? (equipped[slot] ?? null) : undefined;
  const usable = selected ? canUse(selected, hero.classId) : false;

  // Picks of items that left the pack (or got locked) drop out.
  const pickedItems = items.filter((i) => picked.has(i.id) && !i.locked);
  const pickedIds = pickedItems.map((i) => i.id);
  const sellTotal = pickedItems.reduce(
    (s, i) => s + sellPrice({ rarityId: i.rarity, itemLevel: i.itemLevel }),
    0,
  );
  const salvageTotal = sumYields(
    pickedItems.map((i) =>
      salvageYield({ baseId: i.baseId, rarityId: i.rarity, itemLevel: i.itemLevel }),
    ),
  );
  const precious = pickedItems.filter((i) => compareRarity(i.rarity, 'rare') >= 0).length;
  const lockedCount = items.filter((i) => i.locked).length;

  const togglePick = (item: ItemView) => {
    if (item.locked) return;
    setConfirmBulk(null);
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
  };
  const endSelecting = () => {
    setSelecting(false);
    setPicked(new Set());
    setConfirmBulk(null);
  };

  const onBulk = async (kind: 'sell' | 'salvage') => {
    if (pickedIds.length === 0) return;
    if (precious > 0 && confirmBulk !== kind) {
      setConfirmBulk(kind);
      return;
    }
    const action = itemsAction(kind, pickedIds);
    setBusy(kind);
    setNotice(null);
    setConfirmBulk(null);
    const key = keys.keyFor(action);
    const n = pickedIds.length;
    const what = `${n} ${n === 1 ? 'item' : 'items'}`;
    if (kind === 'sell') {
      const res = await merchantApi.sell(hero.id, pickedIds, key);
      keys.settle(action, res.ok ? null : res.error);
      setBusy(null);
      if (res.ok) {
        updateCharacter(res.value.character);
        applyInventory(res.value.inventory);
        setPicked(new Set());
        setNotice({
          kind: 'ok',
          text: `Sold ${what} for ${formatNumber(res.value.goldGained)} gold.`,
        });
        return;
      }
      failBulk(res.error);
    } else {
      const res = await forgeApi.salvage(hero.id, pickedIds, key);
      keys.settle(action, res.ok ? null : res.error);
      setBusy(null);
      if (res.ok) {
        updateCharacter(res.value.character);
        applyInventory(res.value.inventory);
        refreshMaterials();
        setPicked(new Set());
        const got = res.value.salvaged.materials
          .map((m) => `${m.quantity} ${materialView(m.materialId).name}`)
          .join(', ');
        setNotice({
          kind: 'ok',
          text: `Salvaged ${what} for ${got ? `${got} and ` : ''}${formatNumber(res.value.salvaged.gold)} gold.`,
        });
        return;
      }
      failBulk(res.error);
    }
  };
  const failBulk = (error: Parameters<typeof describeGameFailure>[0] & { status: number }) => {
    if (error.status === 404 || error.status === 409) reload();
    setNotice({
      kind: 'error',
      text: isUncertain(error)
        ? `${describeGameFailure(error)} Trying again is safe: nothing is sold twice.`
        : describeGameFailure(error),
    });
  };

  const onLock = async (item: ItemView) => {
    setBusy('lock');
    setNotice(null);
    const failure = await setLocked(item.id, !item.locked);
    setBusy(null);
    setConfirmDiscard(false);
    setNotice(
      failure
        ? { kind: 'error', text: failure }
        : {
            kind: 'ok',
            text: item.locked
              ? `${item.name} unlocked.`
              : `${item.name} locked. It can't be sold, salvaged or discarded until you unlock it.`,
          },
    );
  };

  const choose = (item: ItemView) => {
    if (selecting) togglePick(item);
    setSelectedId(item.id);
    markItemsSeen([item.id]);
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
              selected={selecting ? picked.has(item.id) && !item.locked : item.id === selected?.id}
              onSelect={() => choose(item)}
              disabled={selecting && item.locked}
              isNew={newItems.has(item.id)}
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
          {ready && over > 0 ? <span className="caps pack__over">· over capacity</span> : null}
        </p>
      </header>

      <div className="pack__tabs" role="tablist" aria-label="Pack contents">
        {TABS.map((t, n) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`pack-tab-${t.id}`}
            aria-controls={`pack-panel-${t.id}`}
            aria-selected={tab === t.id}
            tabIndex={tab === t.id ? 0 : -1}
            className="pack__tab"
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
              const step = e.key === 'ArrowRight' ? 1 : TABS.length - 1;
              const next = TABS[(n + step) % TABS.length]!.id;
              setTab(next);
              document.getElementById(`pack-tab-${next}`)?.focus();
            }}
          >
            {t.name}
            {t.id === 'items' ? (
              <span className="pack__count"> {ready ? items.length : '–'}</span>
            ) : t.id === 'materials' ? (
              <span className="pack__count">
                {' '}
                {materials.kind === 'ready' ? materials.value.materials.length : '–'}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {tab === 'filter' ? (
        <section id="pack-panel-filter" role="tabpanel" aria-labelledby="pack-tab-filter">
          <LootFilterPanel />
        </section>
      ) : tab === 'materials' ? (
        <section
          id="pack-panel-materials"
          role="tabpanel"
          aria-labelledby="pack-tab-materials"
          className="pack__materials"
        >
          <MaterialsTab />
        </section>
      ) : (
        <div id="pack-panel-items" role="tabpanel" aria-labelledby="pack-tab-items">
          {ready && free <= NEARLY_FULL ? (
            <div
              className={`pack__full${free === 0 ? ' pack__full--full' : ''}`}
              role={free === 0 ? 'alert' : 'status'}
            >
              <p className="pack__full-title display">
                {over > 0
                  ? `Over capacity: ${over} ${over === 1 ? 'item' : 'items'} beyond the limit.`
                  : free === 0
                    ? 'Your pack is full.'
                    : `Nearly full: ${free} ${free === 1 ? 'slot' : 'slots'} left.`}
              </p>
              <p>
                {free === 0
                  ? 'New drops that find no room are salvaged for gold the moment they drop. Legendary, Mythic, set and Void drops are kept anyway, beyond the limit.'
                  : 'Once it is full, new drops that find no room are salvaged for gold the moment they drop (Legendary, Mythic, set and Void drops are kept anyway).'}{' '}
                {sinceBack(tally)}{' '}
                {tally.filtered > 0
                  ? `Your loot filter handled ${tally.filtered} more for ${formatNumber(tally.filteredGold)} gold; those never need room.`
                  : 'Drops your loot filter handles never need room.'}
              </p>
              <div className="pack__full-actions">
                <button
                  type="button"
                  className="btn btn--small"
                  onClick={() => {
                    setSelecting(true);
                    setNotice(null);
                  }}
                >
                  Sell or salvage several
                </button>
                <button type="button" className="btn btn--small" onClick={() => setTab('filter')}>
                  Set the loot filter
                </button>
              </div>
            </div>
          ) : null}

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
            {ready && items.length > 0 ? (
              <button
                type="button"
                className="btn pack__filter pack__select-toggle"
                aria-pressed={selecting}
                onClick={() => (selecting ? endSelecting() : setSelecting(true))}
              >
                {selecting ? 'Done selecting' : 'Select several'}
              </button>
            ) : null}
          </div>

          {selecting && ready ? (
            <div className="pack__bulk" role="region" aria-label="Several items">
              <p className="pack__bulk-count">
                <strong>{pickedItems.length}</strong> selected
                {lockedCount > 0 ? (
                  <span className="pack__count"> · {lockedCount} locked, left out</span>
                ) : null}
              </p>
              <div className="pack__bulk-quick" role="group" aria-label="Quick select">
                <button
                  type="button"
                  className="btn btn--small"
                  onClick={() => {
                    setConfirmBulk(null);
                    setPicked(new Set(visible.filter((i) => !i.locked).map((i) => i.id)));
                  }}
                >
                  {filter === 'all'
                    ? 'All shown'
                    : `All ${RARITIES.find((r) => r.id === filter)?.name}`}
                </button>
                <button
                  type="button"
                  className="btn btn--small"
                  disabled={pickedItems.length === 0}
                  onClick={() => {
                    setConfirmBulk(null);
                    setPicked(new Set());
                  }}
                >
                  Clear
                </button>
              </div>
              <div className="pack__bulk-actions">
                <button
                  type="button"
                  className={`btn btn--brass${confirmBulk === 'sell' ? ' pack__discard--confirm' : ''}`}
                  disabled={pickedItems.length === 0 || busy !== null}
                  aria-busy={busy === 'sell'}
                  onClick={() => void onBulk('sell')}
                >
                  {busy === 'sell'
                    ? 'Selling…'
                    : confirmBulk === 'sell'
                      ? `Sell ${precious} rare or better too?`
                      : `Sell for ${formatNumber(sellTotal)} gold`}
                </button>
                <button
                  type="button"
                  className={`btn${confirmBulk === 'salvage' ? ' pack__discard--confirm' : ''}`}
                  disabled={pickedItems.length === 0 || busy !== null}
                  aria-busy={busy === 'salvage'}
                  onClick={() => void onBulk('salvage')}
                >
                  {busy === 'salvage'
                    ? 'Salvaging…'
                    : confirmBulk === 'salvage'
                      ? `Salvage ${precious} rare or better too?`
                      : `Salvage for ${formatNumber(salvageTotal.gold)} gold + materials`}
                </button>
                {confirmBulk && busy === null ? (
                  <button type="button" className="btn" onClick={() => setConfirmBulk(null)}>
                    Keep them
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

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
                  {free === 0
                    ? ' · drops that find no room are salvaged for gold, except Legendary, Mythic, set and Void'
                    : ''}
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
                      className="btn pack__lock"
                      onClick={() => void onLock(selected)}
                      disabled={busy !== null}
                      aria-busy={busy === 'lock'}
                      aria-pressed={selected.locked}
                    >
                      {selected.locked ? 'Unlock' : 'Lock'}
                    </button>
                    <button
                      type="button"
                      className={`btn${confirmDiscard ? ' pack__discard--confirm' : ''}`}
                      onClick={() => void onDiscard(selected)}
                      disabled={busy !== null || selected.locked}
                      title={selected.locked ? 'Unlock it first' : undefined}
                      aria-busy={busy === 'discard'}
                    >
                      {busy === 'discard'
                        ? 'Discarding…'
                        : confirmDiscard
                          ? 'Discard for good?'
                          : 'Discard'}
                    </button>
                    {confirmDiscard && busy === null ? (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => setConfirmDiscard(false)}
                      >
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
      )}
    </div>
  );
}
