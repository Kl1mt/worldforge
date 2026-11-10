import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_AWAKENING_SETTINGS,
  awakeningPreview,
  awakeningRefusal,
  findEffect,
  findSet,
  type AwakeningPreview,
  type AwakeningRefusal,
  type ClassId,
} from '@worldforge/game-core';
import { ItemFrame } from '../../components/ItemFrame';
import { AWAKENED_MARK } from '../../components/itemVariant';
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
import { Gold, type Notice } from './ShopHeader';
import './awaken-panel.css';

/**
 * Ticket 6.5b: Item Awakening at the Forge (GDD §8.2, docs/AWAKENING.md). The player picks a +10
 * Legendary, Mythic or set item of item level 23 or higher, sees the price (the server's quote) and
 * what changes (game-core's `awakeningPreview` on the worn kit: the effect before and after, a
 * set's progress, and a warning when nothing would move), and confirms in a second step. The
 * server decides and pays in one transaction; repeating the request never pays twice.
 */

const S = DEFAULT_AWAKENING_SETTINGS;
const pct = (x: number) => `${Math.round(x * 1000) / 10} %`;

/** Why an item can't awaken, in plain words (the server's refusals say the same). */
export const AWAKEN_REFUSAL_TEXT: Readonly<Record<AwakeningRefusal, string>> = {
  rarity: 'Only Legendary, Mythic and set items can be awakened.',
  upgrade_level: 'Only items at +10 can be awakened.',
  item_level: `Only items of item level ${S.minItemLevel} or higher can be awakened.`,
  already_awakened: 'Already awakened.',
  nothing_to_awaken: 'This item has no effect or set bonus to awaken.',
  unknown_base: 'The smith does not know this item any more.',
  affix_missing: 'This item can’t be awakened.',
  affix_not_allowed: 'This item can’t be awakened.',
  affix_present: 'This item can’t be awakened.',
};

/** Effect-number names for the "what moves" list (`AwakeningChange.key`). */
const CHANGE_NAME: Record<string, string> = {
  critBurn: 'critical burn',
  'execute.bonus': 'damage to weakened foes',
  bossSlayer: 'damage to bosses',
  lifeOnKill: 'health on a kill',
  'bloodrush.perStack': 'bloodrush per stack',
  thorns: 'thorns',
  'fortitude.bonus': 'damage while healthy',
  skillRage: 'skill rage',
  skillSurge: 'skill surge',
  skillOpener: 'opening skill damage',
  skillRot: 'rot',
};

/** Items the hero could awaken, and those already awakened (both lists keep the pack's order). */
export function awakenCandidates(items: readonly ItemView[]) {
  const ready: ItemView[] = [];
  const done: ItemView[] = [];
  for (const i of items) {
    if (i.awakened) done.push(i);
    else if (awakeningRefusal(i.rules) === null) ready.push(i);
  }
  return { ready, done };
}

function Preview({ preview, item }: { preview: AwakeningPreview; item: ItemView }) {
  const set = preview.setProgress ? findSet(preview.setProgress.setId) : undefined;
  return (
    <div className="awaken__quote">
      {preview.effectBefore && preview.effectAfter ? (
        <dl className="awaken__compare">
          <div>
            <dt className="caps">Now</dt>
            <dd>{preview.effectBefore}</dd>
          </div>
          <div className="awaken__after">
            <dt className="caps">
              {AWAKENED_MARK} Awakened ({item.effect?.kind === 'mythic' ? 'signature' : 'effect'} +
              {pct(S.effectStrength - 1)})
            </dt>
            <dd>{preview.effectAfter}</dd>
          </div>
        </dl>
      ) : null}
      {preview.setProgress && set ? (
        <div className="awaken__set">
          <p>
            <strong>{set.name}</strong>: {preview.setProgress.awakenedAfter} of{' '}
            {preview.setProgress.worn} worn pieces awakened after this (
            {preview.setProgress.awakenedBefore} now). A bonus of n pieces grows +
            {pct(S.effectStrength - 1)} once n worn pieces are awakened.
          </p>
          <ul className="awaken__bonuses">
            {preview.setProgress.bonuses.map((b) => (
              <li
                key={b.pieces}
                className={b.after ? (b.before ? 'is-awake' : 'is-waking') : 'is-asleep'}
              >
                <span className="caps">{b.pieces} pieces</span>{' '}
                {findEffect(b.effectId)?.name ?? b.effectId}:{' '}
                {b.before
                  ? 'already awakened'
                  : b.after
                    ? 'awakens now'
                    : `needs ${b.pieces} awakened worn pieces`}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {preview.changes.length > 0 ? (
        <ul className="awaken__changes" aria-label="What changes in combat">
          {preview.changes.map((c) => (
            <li key={c.key}>
              {CHANGE_NAME[c.key] ?? c.key}: {pct(c.before)} → {pct(c.after)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="awaken__warn" role="note">
          Nothing changes for this hero now:{' '}
          {preview.setProgress
            ? 'no set bonus of this set has enough awakened worn pieces yet.'
            : 'the effect is already at its limit with the rest of your gear, or it does nothing for your class.'}{' '}
          The awakening stays with the item.
        </p>
      )}
    </div>
  );
}

export function AwakenPanel({
  heroId,
  heroName,
  classId,
  gold,
  equipped,
  pack,
  materials,
  onApplied,
  onNotice,
}: {
  heroId: string;
  heroName: string;
  classId: ClassId;
  gold: number;
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
  const { ready, done } = useMemo(() => awakenCandidates(all), [all]);
  const [selected, setSelected] = useState<string | null>(null);
  const current = selected && ready.some((i) => i.id === selected) ? selected : ready[0]?.id;
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'error'; message: string; itemId: string }
    | { kind: 'ready'; value: ForgeItemState }
  >({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [confirm, setConfirm] = useState(false);
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
  }, [heroId, current, attempt]);

  const held = useMemo(
    () => new Map(materials.map((m) => [m.materialId as string, m.quantity])),
    [materials],
  );

  const awaken = useCallback(
    async (itemId: string, name: string) => {
      const action = `awaken:${itemId}`;
      setBusy(true);
      onNotice(null);
      const res = await forgeApi.awaken(heroId, itemId, keys.keyFor(action));
      keys.settle(action, res.ok ? null : res.error);
      setBusy(false);
      setConfirm(false);
      if (res.ok) {
        onApplied(res.value);
        onNotice({
          kind: 'ok',
          text:
            res.value.outcome.action === 'awaken' && res.value.outcome.awakened === 'set'
              ? `${AWAKENED_MARK} ${name} is awakened. It now counts toward its set’s awakening.`
              : `${AWAKENED_MARK} ${name} is awakened: its effect burns ${pct(S.effectStrength - 1)} stronger.`,
        });
        setSelected(null);
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
    [heroId, keys, onApplied, onNotice],
  );

  const awakenedList =
    done.length > 0 ? (
      <div className="awaken__done">
        <p className="caps awaken__group">Awakened</p>
        <ul className="picker__grid" aria-label="Awakened items">
          {done.map((i) => (
            <li key={i.id}>
              <ItemFrame item={i} scale={2} context={i.slot ? slotName(i.slot) : 'Awakened'} />
            </li>
          ))}
        </ul>
      </div>
    ) : null;

  if (!current) {
    return (
      <div className="awaken">
        <div className="shop__empty" role="status">
          <p className="display">No item is ready to awaken.</p>
          <p>
            The rite takes a +10 Legendary, Mythic or set item of item level {S.minItemLevel} or
            higher, and {S.cost.tyrantsEmber} Tyrant’s Embers, {S.cost.gravewardenSeal}{' '}
            Gravewarden’s Seals, gold and {S.cost.soulShard} soul shards. Each item awakens once.
          </p>
        </div>
        {awakenedList}
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
        <p className="display">Banking the coals…</p>
      </div>
    );
  } else if (state.kind === 'error') {
    detail = (
      <div className="shop__empty" role="alert">
        <p className="display">The coals won’t catch.</p>
        <p>{state.message}</p>
        <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </button>
      </div>
    );
  } else {
    const dto = state.value.item;
    const item = toItemView(dto);
    const quote = state.value.forge.awaken;
    const slot = item.equippedSlot;
    // The rest of the kit: every worn item but the one in this item's place (or all, if packed).
    const others = equipped.filter((e) => e.id !== item.id && (!slot || e.equippedSlot !== slot));
    const preview = awakeningPreview(
      item.rules,
      others.map((o) => o.rules),
      classId,
    );
    const refusal = quote ? quote.refusal : 'already_awakened';
    const blocked = !quote || refusal !== null || quote.blockers.length > 0;
    detail = (
      <div className="awaken__detail">
        <header className="awaken__head">
          <ItemFrame item={item} scale={2} />
          <div>
            <h3 className="display awaken__name">{item.name}</h3>
            <p className="awaken__where">
              {slot ? `Worn (${slotName(slot)})` : 'In the pack'} · item level {item.itemLevel} · +
              {item.upgradeLevel}
            </p>
          </div>
        </header>
        <Preview preview={preview} item={item} />
        {quote ? (
          <>
            <ul className="recipe__cost forge-cost" aria-label="Price">
              {quote.cost.materials.map((m) => {
                const have = held.get(m.materialId) ?? 0;
                const short = quote.blockers.some(
                  (b) => b.kind === 'material' && b.materialId === m.materialId,
                );
                return (
                  <li key={m.materialId} className={short ? 'recipe__short' : ''}>
                    <MaterialStack material={materialView(m.materialId)} quantity={m.quantity} />
                    <span className="recipe__have">
                      {have}/{m.quantity}
                    </span>
                  </li>
                );
              })}
              <li className={quote.blockers.some((b) => b.kind === 'gold') ? 'recipe__short' : ''}>
                <Gold amount={quote.cost.gold} />
              </li>
            </ul>
            {quote.blockers.length > 0 ? (
              <p className="awaken__blocked" role="note">
                Not enough to pay
                {quote.blockers.some((b) =>
                  b.kind === 'gold'
                    ? gold >= b.required
                    : (held.get(b.materialId) ?? 0) >= b.required,
                )
                  ? ' (what you received in a trade is on hold for 72 hours)'
                  : ''}
                . Tyrant’s Embers come from the Forge Tyrant’s hoard, Seals from any crypt hoard.
              </p>
            ) : null}
          </>
        ) : null}
        {refusal ? <p className="awaken__blocked">{AWAKEN_REFUSAL_TEXT[refusal]}</p> : null}
        {confirm && !blocked ? (
          <div className="awaken__confirm" role="alertdialog" aria-labelledby="awaken-confirm">
            <p id="awaken-confirm" className="display">
              Awaken {item.name} for {heroName}?
            </p>
            <ul>
              <li>This is permanent: it can’t be undone or moved to another item.</li>
              <li>
                It pays{' '}
                {quote!.cost.materials
                  .map((m) => `${m.quantity} ${materialView(m.materialId).name}`)
                  .join(', ')}{' '}
                and {quote!.cost.gold.toLocaleString('en')} gold.
              </li>
              <li>
                The item is bound to your account for good and can never be traded. It can still go
                on your account shelf for your other heroes.
              </li>
              <li>Upgrades are done; rerolls and improvements stay possible.</li>
            </ul>
            <div className="awaken__confirm-actions">
              <button
                type="button"
                className="btn btn--brass shop__confirm"
                disabled={busy}
                aria-busy={busy}
                onClick={() => void awaken(item.id, item.name)}
              >
                {busy ? 'Awakening…' : `${AWAKENED_MARK} Awaken it`}
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => setConfirm(false)}
              >
                Not now
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="btn btn--brass awaken__go"
            disabled={blocked || busy}
            onClick={() => setConfirm(true)}
          >
            {blocked
              ? quote && quote.blockers.length > 0
                ? 'Not enough to pay'
                : 'Can’t be awakened'
              : 'Awaken…'}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="awaken">
      <div className="awaken__pick">
        <p className="caps awaken__group">Ready to awaken</p>
        <ul className="picker__grid" aria-label="Items ready to awaken">
          {ready.map((i) => (
            <li key={i.id}>
              <ItemFrame
                item={i}
                scale={2}
                selected={i.id === current}
                onSelect={() => {
                  setSelected(i.id);
                  setConfirm(false);
                }}
                context={i.slot ? slotName(i.slot) : `Level ${i.itemLevel}`}
              />
            </li>
          ))}
        </ul>
        {awakenedList}
      </div>
      {detail}
    </div>
  );
}
