import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_AWAKENING_SETTINGS,
  ENGRAVINGS,
  ENGRAVING_FINISHES,
  findEngraving,
  parseEngraving,
  type EngravingFinish,
} from '@worldforge/game-core';
import { ItemFrame } from '../../components/ItemFrame';
import { MaterialStack } from '../../components/MaterialStack';
import {
  describeGameFailure,
  forgeApi,
  type ForgeActionResult,
  type ForgeItemState,
  type MaterialStackDto,
} from '../../game/api';
import { ActionKeys, isUncertain } from '../../game/economy';
import { slotName, toItemView, type ItemView } from '../../game/items';
import { materialView } from '../../game/materials';
import { awakenCandidates } from './AwakenPanel';
import type { Notice } from './ShopHeader';
import './seal-sinks.css';

/**
 * Ticket 6.11: the engraver at the Forge (docs/COSMETICS.md "The exchange and engravings"). The
 * player picks a worn or packed item, words from the engraver's list and a finish: pressed in
 * seal-wax (Gravewarden's Seals) or inlaid in silver (Abbey silver). Cosmetic only: the words show
 * in the item's tooltip and change nothing else. Repeatable; each engraving pays. The price and
 * what is missing are the server's quote; a warning shows when Seal-wax would eat into the Seals
 * the hero's ready-to-awaken items still need.
 */

export const FINISH_NAME: Readonly<Record<EngravingFinish, string>> = {
  seal: 'Seal-wax',
  silver: 'Silver inlay',
};

export function EngravePanel({
  heroId,
  equipped,
  pack,
  materials,
  onApplied,
  onNotice,
  refresh = 0,
}: {
  /** Bumped when the hero's materials changed elsewhere on the screen (the exchange). */
  refresh?: number;
  heroId: string;
  equipped: readonly ItemView[];
  pack: readonly ItemView[];
  materials: readonly MaterialStackDto[];
  onApplied: (result: ForgeActionResult) => void;
  onNotice: (notice: Notice | null) => void;
}) {
  const all = useMemo(
    () => [...equipped, ...pack.filter((i) => i.slot !== null)],
    [equipped, pack],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const current = selected && all.some((i) => i.id === selected) ? selected : all[0]?.id;
  const [words, setWords] = useState<string>(ENGRAVINGS[0]!.id);
  const [finish, setFinish] = useState<EngravingFinish>('seal');
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'error'; message: string; itemId: string }
    | { kind: 'ready'; value: ForgeItemState }
  >({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const keys = useRef(new ActionKeys()).current;

  useEffect(() => {
    if (!current) return;
    const controller = new AbortController();
    forgeApi.item(heroId, current, { signal: controller.signal }).then(
      (res) =>
        setState(
          res.ok
            ? { kind: 'ready', value: res.value }
            : { kind: 'error', message: describeGameFailure(res.error), itemId: current },
        ),
      () => {
        /* aborted */
      },
    );
    return () => controller.abort();
  }, [heroId, current, attempt, refresh]);

  const held = useMemo(
    () => new Map(materials.map((m) => [m.materialId as string, m.quantity])),
    [materials],
  );
  // Seals the hero's items ready to awaken still need (2 each): the reserve the warning guards.
  const reserve =
    awakenCandidates(all).ready.length * DEFAULT_AWAKENING_SETTINGS.cost.gravewardenSeal;

  const engrave = useCallback(
    async (itemId: string, name: string) => {
      const action = `engrave:${itemId}:${finish}:${words}`;
      setBusy(true);
      onNotice(null);
      const res = await forgeApi.engrave(heroId, itemId, finish, words, keys.keyFor(action));
      keys.settle(action, res.ok ? null : res.error);
      setBusy(false);
      if (res.ok) {
        onApplied(res.value);
        onNotice({
          kind: 'ok',
          text: `The engraver cuts “${findEngraving(words)!.text}” into ${name}, ${
            finish === 'seal' ? 'pressed in seal-wax' : 'inlaid in silver'
          }.`,
        });
        setState({
          kind: 'ready',
          value: {
            characterId: heroId,
            gold: res.value.character.gold,
            materials: res.value.materials,
            item: res.value.item,
            forge: res.value.forge,
          },
        });
      } else {
        onNotice({
          kind: 'error',
          text: isUncertain(res.error)
            ? `${describeGameFailure(res.error)} Trying again is safe: nothing is paid twice.`
            : describeGameFailure(res.error),
        });
        setAttempt((n) => n + 1);
      }
    },
    [heroId, finish, words, keys, onApplied, onNotice],
  );

  if (!current) {
    return (
      <div className="engrave">
        <div className="shop__empty" role="status">
          <p className="display">Nothing to engrave.</p>
          <p>
            Wear or carry a piece of gear and the engraver will cut words into it, in seal-wax or
            silver. It changes only how the item reads.
          </p>
        </div>
      </div>
    );
  }

  let detail;
  const stale =
    (state.kind === 'ready' && state.value.item.id !== current) ||
    (state.kind === 'error' && state.itemId !== current);
  if (state.kind === 'loading' || stale) {
    detail = (
      <div className="shop__empty" role="status">
        <p className="display">The engraver squints at it…</p>
      </div>
    );
  } else if (state.kind === 'error') {
    detail = (
      <div className="shop__empty" role="alert">
        <p className="display">The burin slips.</p>
        <p>{state.message}</p>
        <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </button>
      </div>
    );
  } else {
    const item = toItemView(state.value.item);
    const quote = state.value.forge.engrave;
    const now = parseEngraving(quote.current);
    const priced = quote.finishes.find((f) => f.finish === finish)!;
    const same = now?.finish === finish && now.engravingId === words;
    const short = priced.blockers.length > 0;
    const seals = held.get('gravewardenSeal') ?? 0;
    const sealCost =
      priced.cost.materials.find((m) => m.materialId === 'gravewardenSeal')?.quantity ?? 0;
    const eatsReserve = finish === 'seal' && reserve > 0 && seals - sealCost < reserve;
    detail = (
      <div className="engrave__detail">
        <header className="engrave__head">
          <ItemFrame item={item} scale={2} />
          <div>
            <h3 className="display engrave__name">{item.name}</h3>
            <p className="engrave__where">
              {item.equippedSlot ? `Worn (${slotName(item.equippedSlot)})` : 'In the pack'}
              {now ? (
                <>
                  {' '}
                  · bears “{findEngraving(now.engravingId)!.text}” ({FINISH_NAME[now.finish]})
                </>
              ) : (
                ' · unmarked'
              )}
            </p>
          </div>
        </header>
        <fieldset className="engrave__choice">
          <legend className="caps">Words</legend>
          <div className="engrave__words" role="radiogroup" aria-label="Words to engrave">
            {ENGRAVINGS.map((e) => (
              <button
                key={e.id}
                type="button"
                role="radio"
                aria-checked={e.id === words}
                className="btn btn--small"
                onClick={() => setWords(e.id)}
              >
                {e.text}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset className="engrave__choice">
          <legend className="caps">Finish</legend>
          <div className="engrave__finishes" role="radiogroup" aria-label="Finish">
            {ENGRAVING_FINISHES.map((f) => {
              const q = quote.finishes.find((x) => x.finish === f)!;
              return (
                <button
                  key={f}
                  type="button"
                  role="radio"
                  aria-checked={f === finish}
                  className={`engrave__finish engrave__finish--${f}`}
                  onClick={() => setFinish(f)}
                >
                  <span className="engrave__finish-name">{FINISH_NAME[f]}</span>
                  {q.cost.materials.map((m) => (
                    <span key={m.materialId} className="engrave__finish-cost">
                      <MaterialStack material={materialView(m.materialId)} quantity={m.quantity} />
                      <span className={q.blockers.length > 0 ? 'recipe__short' : ''}>
                        {held.get(m.materialId) ?? 0}/{m.quantity}
                      </span>
                    </span>
                  ))}
                </button>
              );
            })}
          </div>
        </fieldset>
        <p className={`engrave__preview engrave__preview--${finish}`}>
          <span className="caps">
            {finish === 'seal' ? 'Pressed in seal-wax' : 'Inlaid in silver'}
          </span>{' '}
          “{findEngraving(words)!.text}”
        </p>
        <p className="engrave__note">
          Only the words change: no number, no binding, nothing in duels or on the boards. A new
          engraving replaces the old one and pays again.
        </p>
        {eatsReserve ? (
          <p className="engrave__warn" role="note">
            Seal-wax leaves you {Math.max(0, seals - sealCost)} of your Gravewarden’s Seals; the
            items you could awaken now need {reserve}. Silver inlay spends no Seals.
          </p>
        ) : null}
        {short ? (
          <p className="engrave__warn" role="note">
            Not enough to pay
            {priced.blockers.some(
              (b) => b.kind === 'material' && (held.get(b.materialId) ?? 0) >= b.required,
            )
              ? ' (what you received in a trade is on hold for 72 hours)'
              : ''}
            . Seals come from any crypt hoard; Abbey silver is mined in the Sunken Abbey.
          </p>
        ) : null}
        <button
          type="button"
          className="btn btn--brass engrave__go"
          disabled={short || same || busy}
          aria-busy={busy}
          onClick={() => void engrave(item.id, item.name)}
        >
          {busy
            ? 'Engraving…'
            : same
              ? 'Already engraved so'
              : short
                ? 'Not enough to pay'
                : `Engrave for ${priced.cost.materials
                    .map((m) => `${materialView(m.materialId).name} × ${m.quantity}`)
                    .join(', ')}`}
        </button>
      </div>
    );
  }

  return (
    <div className="engrave">
      <div className="engrave__pick">
        <p className="caps engrave__group">Your gear</p>
        <ul className="picker__grid" aria-label="Items to engrave">
          {all.map((i) => (
            <li key={i.id}>
              <ItemFrame
                item={i}
                scale={2}
                selected={i.id === current}
                onSelect={() => setSelected(i.id)}
                context={i.equippedSlot ? slotName(i.equippedSlot) : `Level ${i.itemLevel}`}
              />
            </li>
          ))}
        </ul>
      </div>
      {detail}
    </div>
  );
}
