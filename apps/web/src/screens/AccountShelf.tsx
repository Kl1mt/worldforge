import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MATERIAL_IDS, type MaterialId } from '@worldforge/game-core';
import { useActiveCharacter, useCharacters } from '../characters/CharactersProvider';
import { Meter } from '../components/Meter';
import { useGame } from '../game/GameProvider';
import {
  describeGameFailure,
  shelfApi,
  type MaterialStackDto,
  type ShelfKind,
  type ShelfMoveBody,
  type ShelfState,
} from '../game/api';
import { ActionKeys, isUncertain } from '../game/economy';
import { toItemView } from '../game/items';
import { materialView } from '../game/materials';
import type { ApiResult } from '../lib/api';
import { formatNumber } from '../lib/format';
import { ItemPicker } from './economy/ItemPicker';
import { Gold, NoticeLine, type Notice } from './economy/ShopHeader';
import './account-shelf.css';

type Load =
  { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; value: ShelfState };

type Counts = Partial<Record<MaterialId, number>>;

const KIND_WORDS: Record<ShelfKind, string> = {
  items: 'items',
  materials: 'materials',
  gold: 'gold',
};

/** Whole, non-negative and no more than `max`. */
const clamp = (raw: string, max: number) => {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0;
};

const stackOf = (stacks: readonly MaterialStackDto[], id: MaterialId) =>
  stacks.find((s) => s.materialId === id)?.quantity ?? 0;

/** "items and gold", "items, materials and gold". */
function listWords(kinds: readonly ShelfKind[]): string {
  const words = kinds.map((k) => KIND_WORDS[k]);
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/**
 * The shared account shelf (ticket T.3, docs/TRADING.md §3): the Warehouse's second tab. One hero
 * places items, materials and gold on it; any hero of the account takes them out. Each kind opens
 * with its own switch on the server ("Shelf: …", off at first); taking out always works. The
 * server checks everything (held items, room, amounts) and every move carries an idempotency key.
 */
export function AccountShelf() {
  const hero = useActiveCharacter();
  const { updateCharacter } = useCharacters();
  const { inventory, applyInventory, refreshMaterials } = useGame();
  const [state, setState] = useState<Load>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [toPlace, setToPlace] = useState<Set<string>>(new Set());
  const [toTake, setToTake] = useState<Set<string>>(new Set());
  const [goldIn, setGoldIn] = useState(0);
  const [goldOut, setGoldOut] = useState(0);
  const [matsIn, setMatsIn] = useState<Counts>({});
  const [matsOut, setMatsOut] = useState<Counts>({});
  const [busy, setBusy] = useState<'deposit' | 'withdraw' | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const keys = useRef(new ActionKeys()).current;

  const apply = useCallback((res: ApiResult<ShelfState>) => {
    setState((prev) => {
      if (res.ok) return { kind: 'ready', value: res.value };
      return prev.kind === 'ready'
        ? prev
        : { kind: 'error', message: describeGameFailure(res.error) };
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    shelfApi.get(hero.id, { signal: controller.signal }).then(apply, () => {
      /* aborted */
    });
    return () => controller.abort();
  }, [hero.id, apply, attempt]);

  const ready = state.kind === 'ready' ? state.value : null;
  const pack = inventory.kind === 'ready' ? inventory.value : null;
  const packItems = useMemo(() => pack?.items ?? [], [pack]);
  const shelved = useMemo(() => (ready?.items ?? []).map(toItemView), [ready]);
  const placedBy = useMemo(
    () => new Map((ready?.items ?? []).map((i) => [i.id, i.placedBy.name])),
    [ready],
  );
  const placePicks = [...toPlace].filter((id) => packItems.some((i) => i.id === id));
  const takePicks = [...toTake].filter((id) => shelved.some((i) => i.id === id));

  if (state.kind === 'loading') {
    return (
      <div className="shop__empty" role="status">
        <p className="display">Reading the account ledger…</p>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="shop__empty" role="alert">
        <p className="display">The shelf keeper is not at the counter.</p>
        <p>{state.message}</p>
        <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </button>
      </div>
    );
  }

  const s = state.value;
  const open = (['items', 'materials', 'gold'] as const).filter((k) => s.deposits[k]);
  const paused = (['items', 'materials', 'gold'] as const).filter((k) => !s.deposits[k]);
  const free = Math.max(0, s.capacity - s.items.length);
  const packFree = Math.max(0, s.hero.pack.capacity - packItems.length);
  const heroMats = MATERIAL_IDS.filter((id) => stackOf(s.hero.materials, id) > 0);
  const shelfMats = MATERIAL_IDS.filter((id) => stackOf(s.materials, id) > 0);
  const sum = (c: Counts) => Object.values(c).reduce<number>((a, n) => a + (n ?? 0), 0);

  const depositBody: ShelfMoveBody = {
    ...(s.deposits.items && placePicks.length > 0 ? { itemIds: placePicks } : {}),
    ...(s.deposits.gold && goldIn > 0 ? { gold: goldIn } : {}),
    ...(s.deposits.materials && sum(matsIn) > 0 ? { materials: matsIn } : {}),
  };
  const withdrawBody: ShelfMoveBody = {
    ...(takePicks.length > 0 ? { itemIds: takePicks } : {}),
    ...(goldOut > 0 ? { gold: goldOut } : {}),
    ...(sum(matsOut) > 0 ? { materials: matsOut } : {}),
  };
  const empty = (b: ShelfMoveBody) => !b.itemIds && !b.gold && !b.materials;

  const move = async (direction: 'deposit' | 'withdraw') => {
    const body = direction === 'deposit' ? depositBody : withdrawBody;
    const action = `shelf:${direction}:${JSON.stringify(body)}`;
    setBusy(direction);
    setNotice(null);
    const res = await shelfApi.move(hero.id, direction, body, keys.keyFor(action));
    keys.settle(action, res.ok ? null : res.error);
    setBusy(null);
    if (res.ok) {
      const { moved } = res.value;
      setState({ kind: 'ready', value: res.value.shelf });
      applyInventory(res.value.inventory);
      updateCharacter(res.value.character);
      if (moved.materials.length > 0) refreshMaterials();
      if (direction === 'deposit') {
        setToPlace(new Set());
        setGoldIn(0);
        setMatsIn({});
      } else {
        setToTake(new Set());
        setGoldOut(0);
        setMatsOut({});
      }
      const parts: string[] = [];
      if (moved.items > 0) parts.push(`${moved.items} ${moved.items === 1 ? 'item' : 'items'}`);
      const units = moved.materials.reduce((a, m) => a + m.quantity, 0);
      if (units > 0) parts.push(`${formatNumber(units)} materials`);
      if (moved.gold > 0) parts.push(`${formatNumber(moved.gold)} gold`);
      setNotice({
        kind: 'ok',
        text:
          direction === 'deposit'
            ? `Placed ${parts.join(', ')} on the account shelf. Any of your heroes can take it from here.`
            : `${hero.name} took ${parts.join(', ')} from the account shelf.`,
      });
      return;
    }
    const e = res.error;
    setNotice({
      kind: 'error',
      text:
        e.code === 'inventory_full'
          ? `${hero.name}'s pack has no room for that many. Sell or salvage something first. Nothing was moved.`
          : e.code === 'shelf_full'
            ? `The shelf has room for ${s.capacity} items. Take something out first. Nothing was moved.`
            : isUncertain(e)
              ? `${describeGameFailure(e)} Trying again is safe: nothing moves twice.`
              : `${describeGameFailure(e)} Nothing was moved.`,
    });
    setAttempt((n) => n + 1);
  };

  return (
    <div className="ashelf">
      <p className="ashelf__lead">
        One shelf for the whole account. What one of your heroes leaves here, another can take:
        gear, materials and gold pass between your own heroes without a trade, and nothing gets
        bound.
      </p>
      {open.length === 0 ? (
        <p className="ashelf__paused" role="status">
          <span className="caps">Not open yet</span> The town has not opened the account shelf. When
          it does, your heroes can pass {listWords(paused)} to each other here.
          {s.items.length + s.gold + s.materials.length > 0
            ? ' Anything already on the shelf can still be taken out.'
            : null}
        </p>
      ) : paused.length > 0 ? (
        <p className="ashelf__paused" role="status">
          <span className="caps">Paused</span> Placing {listWords(paused)} on the shelf is paused
          for now. Anything already on it can still be taken out.
        </p>
      ) : null}
      <NoticeLine notice={notice} />

      <div className="shop__cols">
        <section className="shop__panel panel-iron" aria-labelledby="ashelf-hero-title">
          <header className="shop__panel-head">
            <h2 id="ashelf-hero-title" className="display shop__panel-title">
              From {hero.name}
            </h2>
            <p className="shop__panel-note">
              {packItems.length} / {s.hero.pack.capacity} carried · <Gold amount={s.hero.gold} />
            </p>
          </header>
          {open.length === 0 ? (
            <p className="ashelf__closed-note">
              Nothing can be placed on the shelf yet. Your own Warehouse shelves (the first tab)
              stay open.
            </p>
          ) : (
            <>
              {s.deposits.items ? (
                pack ? (
                  <ItemPicker
                    items={packItems}
                    picked={new Set(placePicks)}
                    onChange={setToPlace}
                    label="Items to place on the account shelf"
                    emptyText="The pack is empty. Bring something back from the fields."
                    lockedPickable
                  />
                ) : (
                  <div className="shop__empty" role="status">
                    <p className="display">Opening the pack…</p>
                  </div>
                )
              ) : null}
              {s.deposits.gold ? (
                <label className="ashelf__amount">
                  <span className="caps">Gold to place</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={s.hero.gold}
                    value={goldIn || ''}
                    placeholder="0"
                    onChange={(e) => setGoldIn(clamp(e.target.value, s.hero.gold))}
                  />
                  <span className="ashelf__of">of {formatNumber(s.hero.gold)}</span>
                </label>
              ) : null}
              {s.deposits.materials ? (
                heroMats.length === 0 ? (
                  <p className="ashelf__none">{hero.name} carries no materials.</p>
                ) : (
                  <ul className="ashelf__mats" aria-label="Materials to place">
                    {heroMats.map((id) => {
                      const have = stackOf(s.hero.materials, id);
                      return (
                        <li key={id}>
                          <label className="ashelf__amount">
                            <span>{materialView(id).name}</span>
                            <input
                              type="number"
                              inputMode="numeric"
                              min={0}
                              max={have}
                              value={matsIn[id] || ''}
                              placeholder="0"
                              onChange={(e) =>
                                setMatsIn({ ...matsIn, [id]: clamp(e.target.value, have) })
                              }
                            />
                            <span className="ashelf__of">of {formatNumber(have)}</span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )
              ) : null}
            </>
          )}
          <footer className="shop__tally">
            <p>
              {open.length === 0
                ? 'Taking out always works.'
                : `${free} of ${s.capacity} item places free on the shelf.`}
            </p>
            <button
              type="button"
              className="btn btn--brass"
              disabled={
                open.length === 0 ||
                empty(depositBody) ||
                busy !== null ||
                (depositBody.itemIds?.length ?? 0) > free
              }
              aria-busy={busy === 'deposit'}
              onClick={() => void move('deposit')}
            >
              {busy === 'deposit'
                ? 'Placing…'
                : (depositBody.itemIds?.length ?? 0) > free
                  ? 'Not enough room'
                  : 'Place on the shelf'}
            </button>
          </footer>
        </section>

        <section className="shop__panel panel-iron" aria-labelledby="ashelf-shelf-title">
          <header className="shop__panel-head">
            <h2 id="ashelf-shelf-title" className="display shop__panel-title">
              On the account shelf
            </h2>
            <p className="shop__panel-note">
              {s.items.length} / {s.capacity} items · <Gold amount={s.gold} />
            </p>
          </header>
          <Meter
            variant="xp"
            label={`Account shelf: ${s.items.length} of ${s.capacity} item places used`}
            current={s.items.length}
            max={s.capacity}
          />
          {free === 0 ? (
            <p className="ashelf__full" role="status">
              Every item place is taken. Take something out to make room.
            </p>
          ) : null}
          <ItemPicker
            items={shelved}
            picked={new Set(takePicks)}
            onChange={setToTake}
            label="Items to take out"
            emptyText="No items on the account shelf."
            lockedPickable
            emptyAction="none"
            contextOf={(item) => `Left by ${placedBy.get(item.id) ?? 'a hero'}`}
          />
          {s.gold > 0 ? (
            <label className="ashelf__amount">
              <span className="caps">Gold to take</span>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={s.gold}
                value={goldOut || ''}
                placeholder="0"
                onChange={(e) => setGoldOut(clamp(e.target.value, s.gold))}
              />
              <span className="ashelf__of">of {formatNumber(s.gold)}</span>
            </label>
          ) : null}
          {shelfMats.length > 0 ? (
            <ul className="ashelf__mats" aria-label="Materials to take">
              {shelfMats.map((id) => {
                const have = stackOf(s.materials, id);
                return (
                  <li key={id}>
                    <label className="ashelf__amount">
                      <span>{materialView(id).name}</span>
                      <input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={have}
                        value={matsOut[id] || ''}
                        placeholder="0"
                        onChange={(e) =>
                          setMatsOut({ ...matsOut, [id]: clamp(e.target.value, have) })
                        }
                      />
                      <span className="ashelf__of">of {formatNumber(have)}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          ) : null}
          <footer className="shop__tally">
            <p>
              {empty(withdrawBody)
                ? `Pick what ${hero.name} should take.`
                : `${takePicks.length} items to take · ${packFree} free in the pack`}
            </p>
            <button
              type="button"
              className="btn"
              disabled={empty(withdrawBody) || busy !== null || takePicks.length > packFree}
              aria-busy={busy === 'withdraw'}
              onClick={() => void move('withdraw')}
            >
              {busy === 'withdraw'
                ? 'Taking…'
                : takePicks.length > packFree
                  ? 'No room in the pack'
                  : `Take out to ${hero.name}`}
            </button>
          </footer>
        </section>
      </div>
    </div>
  );
}
