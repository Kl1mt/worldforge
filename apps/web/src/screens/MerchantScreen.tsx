import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { compareRarity, getArea } from '@worldforge/game-core';
import { useActiveCharacter, useCharacters } from '../characters/CharactersProvider';
import { ItemFrame } from '../components/ItemFrame';
import { ItemTooltip } from '../components/ItemTooltip';
import { useGame, type Load } from '../game/GameProvider';
import type { ApiResult } from '../lib/api';
import { describeGameFailure, merchantApi, type MerchantState } from '../game/api';
import { ActionKeys, isUncertain, itemsAction, restockIn } from '../game/economy';
import { canUse, equippedBySlot, slotName, targetSlot, toItemView } from '../game/items';
import { ItemPicker } from './economy/ItemPicker';
import { Gold, NoticeLine, ShopHeader, type Notice } from './economy/ShopHeader';
import './economy/shop.css';

/**
 * The Merchant (ticket 2.6): today's wares per unlocked area, and selling from the pack. Prices
 * and stock come from the server; the client sends offer and item ids with an Idempotency-Key.
 */
export function MerchantScreen() {
  const hero = useActiveCharacter();
  const { updateCharacter } = useCharacters();
  const { inventory, applyInventory } = useGame();
  const [state, setState] = useState<Load<MerchantState>>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [selectedOffer, setSelectedOffer] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirmSell, setConfirmSell] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const keys = useRef(new ActionKeys()).current;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const apply = useCallback((res: ApiResult<MerchantState>) => {
    setState((prev) =>
      res.ok
        ? { kind: 'ready', value: res.value }
        : // A failed refresh keeps the shown state; only a first load shows the error.
          prev.kind === 'ready'
          ? prev
          : { kind: 'error', message: describeGameFailure(res.error) },
    );
  }, []);
  /** Re-reads the building after an action (sold-out flags, quotes, blockers). */
  const load = useCallback(() => {
    void merchantApi.get(hero.id).then(apply);
  }, [hero.id, apply]);

  useEffect(() => {
    const controller = new AbortController();
    merchantApi.get(hero.id, { signal: controller.signal }).then(apply, () => {
      /* aborted */
    });
    return () => controller.abort();
  }, [hero.id, apply, attempt]);

  const ready = state.kind === 'ready' ? state.value : null;
  const pack = inventory.kind === 'ready' ? inventory.value : null;
  const equipped = useMemo(() => equippedBySlot(pack?.equipped ?? []), [pack]);
  const offers = useMemo(
    () =>
      (ready?.offers ?? []).map((o) => ({
        ...o,
        view: toItemView({
          ...o.item,
          id: o.offerId,
          equippedSlot: null,
          source: 'merchant',
          createdAt: '',
        }),
      })),
    [ready],
  );
  const quotes = useMemo(
    () => new Map((ready?.sellPrices ?? []).map((q) => [q.itemId, q.price])),
    [ready],
  );
  const sellable = useMemo(() => pack?.items ?? [], [pack]);
  // Drop picks of items that left the pack.
  const pickedIds = [...picked].filter((id) => sellable.some((i) => i.id === id));
  const total = pickedIds.reduce((s, id) => s + (quotes.get(id) ?? 0), 0);
  const precious = pickedIds.filter((id) => {
    const item = sellable.find((i) => i.id === id);
    return item && compareRarity(item.rarity, 'rare') >= 0;
  }).length;

  const selected = offers.find((o) => o.offerId === selectedOffer) ?? offers[0];
  const selectedSlot = selected ? targetSlot(selected.view, equipped) : undefined;
  const usable = selected ? canUse(selected.view, hero.classId) : false;

  const buy = async (offerId: string, name: string, price: number) => {
    const action = `buy:${offerId}`;
    setBusy(action);
    setNotice(null);
    const res = await merchantApi.buy(hero.id, offerId, keys.keyFor(action));
    keys.settle(action, res.ok ? null : res.error);
    setBusy(null);
    if (res.ok) {
      updateCharacter(res.value.character);
      applyInventory(res.value.inventory);
      setNotice({ kind: 'ok', text: `Bought ${name} for ${price} gold. It is in your pack.` });
    } else {
      setNotice({
        kind: 'error',
        text: isUncertain(res.error)
          ? `${describeGameFailure(res.error)} Buying again is safe: you will not pay twice.`
          : describeGameFailure(res.error),
      });
    }
    load();
  };

  const sell = async () => {
    if (precious > 0 && !confirmSell) {
      setConfirmSell(true);
      return;
    }
    const action = itemsAction('sell', pickedIds);
    setBusy('sell');
    setNotice(null);
    setConfirmSell(false);
    const res = await merchantApi.sell(hero.id, pickedIds, keys.keyFor(action));
    keys.settle(action, res.ok ? null : res.error);
    setBusy(null);
    if (res.ok) {
      updateCharacter(res.value.character);
      applyInventory(res.value.inventory);
      setPicked(new Set());
      const n = pickedIds.length;
      setNotice({
        kind: 'ok',
        text: `Sold ${n} ${n === 1 ? 'item' : 'items'} for ${res.value.goldGained} gold.`,
      });
    } else {
      setNotice({ kind: 'error', text: describeGameFailure(res.error) });
    }
    load();
  };

  let wares;
  if (state.kind === 'loading') {
    wares = (
      <div className="shop__empty" role="status">
        <p className="display">Unpacking the cart…</p>
      </div>
    );
  } else if (state.kind === 'error') {
    wares = (
      <div className="shop__empty" role="alert">
        <p className="display">The stall stays shut.</p>
        <p>{state.message}</p>
        <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </button>
      </div>
    );
  } else if (offers.length === 0) {
    wares = (
      <div className="shop__empty">
        <p className="display">Nothing for your trade today.</p>
        <p>The wagons bring new goods at dawn.</p>
      </div>
    );
  } else {
    wares = (
      <ul className="wares">
        {offers.map((o) => (
          <li
            key={o.offerId}
            className={`ware${o.soldOut ? ' ware--sold' : ''}${o.offerId === selected?.offerId ? ' ware--selected' : ''}`}
          >
            <ItemFrame
              item={o.view}
              scale={2}
              selected={o.offerId === selected?.offerId}
              onSelect={() => setSelectedOffer(o.offerId)}
            />
            <div className="ware__text">
              <p className={`ware__name rarity-${o.view.rarity}`}>{o.view.name}</p>
              <p className="ware__meta">
                {o.view.slot ? slotName(o.view.slot) : 'Item'} · level {o.view.itemLevel} ·{' '}
                {getArea(o.areaId).name}
              </p>
            </div>
            <Gold amount={o.price} />
            {o.soldOut ? (
              <span className="ware__sold caps">Sold</span>
            ) : (
              <button
                type="button"
                className="btn btn--brass ware__buy"
                disabled={busy !== null || hero.gold < o.price}
                aria-busy={busy === `buy:${o.offerId}`}
                aria-label={`Buy ${o.view.name} for ${o.price} gold`}
                onClick={() => void buy(o.offerId, o.view.name, o.price)}
              >
                {busy === `buy:${o.offerId}` ? 'Buying…' : hero.gold < o.price ? 'Too dear' : 'Buy'}
              </button>
            )}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="shop">
      <ShopHeader building="merchant" title="The Merchant">
        Basic gear from every road you have opened, a fresh cartload each dawn. He buys whatever you
        drag back from the fields, at a fair price for him.
      </ShopHeader>
      <NoticeLine notice={notice} />

      <div className="shop__cols">
        <section className="shop__panel panel-iron" aria-labelledby="wares-title">
          <header className="shop__panel-head">
            <h2 id="wares-title" className="display shop__panel-title">
              Today’s wares
            </h2>
            {ready ? (
              <p className="shop__panel-note">Restocks in {restockIn(ready.restocksAt, now)}</p>
            ) : null}
          </header>
          {wares}
          {selected ? (
            <div className="shop__inspect">
              <ItemTooltip
                item={selected.view}
                caption={`On the stall · ${getArea(selected.areaId).name}`}
                {...(usable && selectedSlot !== undefined
                  ? { compareTo: equipped[selectedSlot] ?? null }
                  : {})}
              />
            </div>
          ) : null}
        </section>

        <section className="shop__panel panel-iron" aria-labelledby="sell-title">
          <header className="shop__panel-head">
            <h2 id="sell-title" className="display shop__panel-title">
              Sell from your pack
            </h2>
            <p className="shop__panel-note">Equipped gear stays on your hero.</p>
          </header>
          {inventory.kind === 'ready' ? (
            <ItemPicker
              items={sellable}
              picked={new Set(pickedIds)}
              onChange={(next) => {
                setPicked(next);
                setConfirmSell(false);
              }}
              label="Items to sell"
              emptyText="Your pack is empty. Bring something back from the fields."
            />
          ) : (
            <div className="shop__empty" role="status">
              <p className="display">Opening the pack…</p>
            </div>
          )}
          <footer className="shop__tally">
            <p>
              {pickedIds.length === 0 ? (
                'Pick items to sell.'
              ) : (
                <>
                  {pickedIds.length} {pickedIds.length === 1 ? 'item' : 'items'} for{' '}
                  <Gold amount={total} />
                </>
              )}
            </p>
            <button
              type="button"
              className={`btn btn--brass${confirmSell ? ' shop__confirm' : ''}`}
              disabled={pickedIds.length === 0 || busy !== null}
              aria-busy={busy === 'sell'}
              onClick={() => void sell()}
            >
              {busy === 'sell'
                ? 'Selling…'
                : confirmSell
                  ? `Sell ${precious} rare or better?`
                  : 'Sell'}
            </button>
            {confirmSell && busy === null ? (
              <button type="button" className="btn" onClick={() => setConfirmSell(false)}>
                Keep them
              </button>
            ) : null}
          </footer>
        </section>
      </div>
    </div>
  );
}
