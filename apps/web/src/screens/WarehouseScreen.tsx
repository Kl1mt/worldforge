import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useActiveCharacter, useCharacters } from '../characters/CharactersProvider';
import { Meter } from '../components/Meter';
import { useGame } from '../game/GameProvider';
import { describeGameFailure, warehouseApi, type WarehouseState } from '../game/api';
import { ActionKeys, isUncertain } from '../game/economy';
import { toItemView } from '../game/items';
import type { ApiResult } from '../lib/api';
import { formatNumber } from '../lib/format';
import { routeHref } from '../lib/route';
import { ItemPicker } from './economy/ItemPicker';
import { Gold, NoticeLine, ShopHeader, type Notice } from './economy/ShopHeader';
import './economy/shop.css';
import './warehouse.css';

type Load =
  | { kind: 'loading' }
  | { kind: 'closed' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; value: WarehouseState };

/**
 * The Graumark Warehouse (ticket 4.7): per-character storage. Items move between the pack and
 * the shelves (single or several at once; locked and valuable items too); the server checks
 * everything, including whether the town has restored the building (`warehouse_closed`).
 */
export function WarehouseScreen() {
  const hero = useActiveCharacter();
  const { updateCharacter } = useCharacters();
  const { inventory, applyInventory } = useGame();
  const [state, setState] = useState<Load>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [toStore, setToStore] = useState<Set<string>>(new Set());
  const [toTake, setToTake] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'deposit' | 'withdraw' | 'upgrade' | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const keys = useRef(new ActionKeys()).current;

  const apply = useCallback((res: ApiResult<WarehouseState>) => {
    setState((prev) => {
      if (res.ok) return { kind: 'ready', value: res.value };
      if (res.error.code === 'warehouse_closed') return { kind: 'closed' };
      // A failed refresh keeps the shown state; only a first load shows the error.
      return prev.kind === 'ready'
        ? prev
        : { kind: 'error', message: describeGameFailure(res.error) };
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    warehouseApi.get(hero.id, { signal: controller.signal }).then(apply, () => {
      /* aborted */
    });
    return () => controller.abort();
  }, [hero.id, apply, attempt]);

  const ready = state.kind === 'ready' ? state.value : null;
  const pack = inventory.kind === 'ready' ? inventory.value : null;
  const packItems = useMemo(() => pack?.items ?? [], [pack]);
  const stored = useMemo(() => (ready?.items ?? []).map(toItemView), [ready]);
  // Drop picks of items that moved or left meanwhile.
  const storePicks = [...toStore].filter((id) => packItems.some((i) => i.id === id));
  const takePicks = [...toTake].filter((id) => stored.some((i) => i.id === id));

  const free = ready ? Math.max(0, ready.capacity - ready.items.length) : 0;
  const packFree = ready ? Math.max(0, ready.pack.capacity - packItems.length) : 0;
  const packOver = ready ? Math.max(0, packItems.length - ready.pack.capacity) : 0;

  const move = async (direction: 'deposit' | 'withdraw') => {
    const ids = direction === 'deposit' ? storePicks : takePicks;
    setBusy(direction);
    setNotice(null);
    const res = await warehouseApi.move(hero.id, direction, ids);
    setBusy(null);
    if (res.ok) {
      setState({ kind: 'ready', value: res.value.warehouse });
      applyInventory(res.value.inventory);
      (direction === 'deposit' ? setToStore : setToTake)(new Set());
      const n = res.value.moved;
      setNotice({
        kind: 'ok',
        text:
          direction === 'deposit'
            ? `Stored ${n} ${n === 1 ? 'item' : 'items'}. They wait on the shelves, safe from the filter and the merchant.`
            : `Took ${n} ${n === 1 ? 'item' : 'items'} back into the pack.`,
      });
      return;
    }
    if (res.error.code === 'warehouse_closed') setState({ kind: 'closed' });
    setNotice({
      kind: 'error',
      text:
        res.error.code === 'inventory_full'
          ? 'Your pack has no room for that many. Sell or salvage something first.'
          : res.error.code === 'item_equipped'
            ? 'Take the item off before storing it.'
            : `${describeGameFailure(res.error)} Nothing was moved.`,
    });
    setAttempt((n) => n + 1);
  };

  const upgrade = async () => {
    if (!ready) return;
    const action = `upgrade:${ready.level}`;
    setBusy('upgrade');
    setNotice(null);
    const res = await warehouseApi.upgrade(hero.id, ready.level, keys.keyFor(action));
    keys.settle(action, res.ok ? null : res.error);
    setBusy(null);
    if (res.ok) {
      setState({ kind: 'ready', value: res.value.warehouse });
      updateCharacter(res.value.character);
      setNotice({
        kind: 'ok',
        text: `The keeper clears another bay: ${res.value.warehouse.capacity} shelves now, for ${formatNumber(res.value.goldSpent)} gold.`,
      });
      return;
    }
    setNotice({
      kind: 'error',
      text: isUncertain(res.error)
        ? `${describeGameFailure(res.error)} Trying again is safe: you will not pay twice.`
        : describeGameFailure(res.error),
    });
    setAttempt((n) => n + 1);
  };

  const header = (
    <ShopHeader building="warehouse" title="The Warehouse">
      Stout shelves behind iron doors. What your hero leaves here is never sold, salvaged or swept
      up by the loot filter, and it takes no room in the pack. Each hero keeps their own shelves.
    </ShopHeader>
  );

  if (state.kind === 'loading') {
    return (
      <div className="shop">
        {header}
        <div className="shop__empty" role="status">
          <p className="display">Unbarring the doors…</p>
        </div>
      </div>
    );
  }
  if (state.kind === 'closed') {
    return (
      <div className="shop">
        {header}
        <section className="warehouse__closed panel-ledger" role="status">
          <p className="caps warehouse__locked">Locked</p>
          <p className="display warehouse__closed-title">The doors are still off their hinges.</p>
          <p>
            The Warehouse opens for everyone once the town finishes{' '}
            <strong>Restore the Graumark Warehouse</strong>. Every hero can give a share of gold and
            timber each day.
          </p>
          <a className="btn btn--brass" href={routeHref('works')}>
            See the town works
          </a>
        </section>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="shop">
        {header}
        <div className="shop__empty" role="alert">
          <p className="display">The keeper is not at the door.</p>
          <p>{state.message}</p>
          <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  const w = state.value;
  const next = w.nextUpgrade;
  return (
    <div className="shop">
      {header}
      <NoticeLine notice={notice} />
      {packOver > 0 ? (
        <p className="warehouse__over" role="status">
          Your pack is {packOver} {packOver === 1 ? 'item' : 'items'} over capacity. Store the
          valuables you are keeping here, and new drops find room again.
        </p>
      ) : null}

      <div className="shop__cols">
        <section className="shop__panel panel-iron" aria-labelledby="wh-pack-title">
          <header className="shop__panel-head">
            <h2 id="wh-pack-title" className="display shop__panel-title">
              Your pack
            </h2>
            <p className="shop__panel-note">
              {packItems.length} / {w.pack.capacity} carried · equipped gear stays on your hero
            </p>
          </header>
          {pack ? (
            <ItemPicker
              items={packItems}
              picked={new Set(storePicks)}
              onChange={setToStore}
              label="Items to store"
              emptyText="Your pack is empty. Bring something back from the fields."
              lockedPickable
            />
          ) : (
            <div className="shop__empty" role="status">
              <p className="display">Opening the pack…</p>
            </div>
          )}
          <footer className="shop__tally">
            <p>
              {storePicks.length === 0
                ? free === 0
                  ? 'The shelves are full.'
                  : `Pick items to store (${free} ${free === 1 ? 'shelf' : 'shelves'} free).`
                : `${storePicks.length} to store · ${free} free`}
            </p>
            <button
              type="button"
              className="btn btn--brass"
              disabled={storePicks.length === 0 || busy !== null || storePicks.length > free}
              aria-busy={busy === 'deposit'}
              onClick={() => void move('deposit')}
            >
              {busy === 'deposit'
                ? 'Storing…'
                : storePicks.length > free
                  ? 'Not enough room'
                  : 'Store'}
            </button>
          </footer>
        </section>

        <section className="shop__panel panel-iron" aria-labelledby="wh-shelves-title">
          <header className="shop__panel-head">
            <h2 id="wh-shelves-title" className="display shop__panel-title">
              On the shelves
            </h2>
            <p className="shop__panel-note">
              {w.items.length} / {w.capacity} stored
            </p>
          </header>
          <Meter
            variant="xp"
            label={`Warehouse: ${w.items.length} of ${w.capacity} shelves used`}
            current={w.items.length}
            max={w.capacity}
          />
          {free === 0 ? (
            <p className="warehouse__full" role="status">
              Every shelf is taken. Take something out or extend the warehouse.
            </p>
          ) : null}
          <ItemPicker
            items={stored}
            picked={new Set(takePicks)}
            onChange={setToTake}
            label="Items to take out"
            emptyText="The shelves are bare. Store what you want to keep from the pack."
            lockedPickable
            emptyAction="none"
          />
          <footer className="shop__tally">
            <p>
              {takePicks.length === 0
                ? 'Pick items to take back.'
                : `${takePicks.length} to take · ${packFree} free in the pack`}
            </p>
            <button
              type="button"
              className="btn"
              disabled={takePicks.length === 0 || busy !== null || takePicks.length > packFree}
              aria-busy={busy === 'withdraw'}
              onClick={() => void move('withdraw')}
            >
              {busy === 'withdraw'
                ? 'Taking…'
                : takePicks.length > packFree
                  ? 'No room in the pack'
                  : 'Take out'}
            </button>
          </footer>
          <div className="warehouse__extend">
            {next ? (
              <>
                <p>
                  <span className="display">Extend the warehouse</span>
                  <br />
                  Another {next.slots} shelves ({next.capacity} in all) for{' '}
                  <Gold amount={next.gold} />. Gold paid to the keeper is not returned.
                </p>
                <button
                  type="button"
                  className="btn btn--brass"
                  disabled={busy !== null || hero.gold < next.gold}
                  aria-busy={busy === 'upgrade'}
                  onClick={() => void upgrade()}
                >
                  {busy === 'upgrade' ? 'Paying…' : hero.gold < next.gold ? 'Too dear' : 'Extend'}
                </button>
              </>
            ) : (
              <p>Fully extended: {w.capacity} shelves, as many as the building holds.</p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
