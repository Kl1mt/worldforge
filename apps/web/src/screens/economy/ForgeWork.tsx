import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MAX_UPGRADE_LEVEL, findAffix } from '@worldforge/game-core';
import { ItemFrame } from '../../components/ItemFrame';
import { ItemTooltip } from '../../components/ItemTooltip';
import { MaterialStack } from '../../components/MaterialStack';
import {
  describeGameFailure,
  forgeApi,
  type ForgeActionResult,
  type ForgeCostDto,
  type ForgeItemState,
  type MaterialStackDto,
} from '../../game/api';
import { ActionKeys, isUncertain } from '../../game/economy';
import { slotName, toItemView, type ItemView } from '../../game/items';
import { materialView } from '../../game/materials';
import { formatStatDelta, statDefinition } from '../../lib/format';
import { Gold, type Notice } from './ShopHeader';
import './forge-work.css';

type Load<T> =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string; itemId: string }
  | { kind: 'ready'; value: T };

const pct = (x: number) => `${Math.round(x * 100)} %`;

/** "+12 Armor" for an affix id and value; the affix's own name for class affixes. */
function affixLine(affixId: string, value: number): { value: string; name: string } {
  const def = findAffix(affixId);
  if (!def) return { value: String(value), name: 'Forgotten affix' };
  return {
    value: formatStatDelta(def.stat, value),
    name: def.classes ? def.label.replace(/^\+?\{value\}\s*/, '') : statDefinition(def.stat).name,
  };
}

function Cost({
  cost,
  held,
  gold,
}: {
  cost: ForgeCostDto;
  held: Map<string, number>;
  gold: number;
}) {
  return (
    <ul className="recipe__cost forge-cost" aria-label="Cost">
      {cost.materials.map((m) => {
        const have = held.get(m.materialId) ?? 0;
        return (
          <li key={m.materialId} className={have < m.quantity ? 'recipe__short' : ''}>
            <MaterialStack material={materialView(m.materialId)} quantity={m.quantity} />
            <span className="recipe__have">
              {have}/{m.quantity}
            </span>
          </li>
        );
      })}
      <li className={gold < cost.gold ? 'recipe__short' : ''}>
        <Gold amount={cost.gold} />
      </li>
    </ul>
  );
}

/** The upgrade track: ten notches, the filled ones engraved. */
function Track({ level }: { level: number }) {
  return (
    <ol className="forge-track" aria-label={`Upgrade level +${level} of +${MAX_UPGRADE_LEVEL}`}>
      {Array.from({ length: MAX_UPGRADE_LEVEL }, (_, i) => (
        <li key={i} className={i < level ? 'is-done' : i === level ? 'is-next' : ''}>
          <span aria-hidden="true">{i + 1}</span>
        </li>
      ))}
    </ol>
  );
}

/** Where an affix sits in its tier's range, with the cap of improvements. */
function RangeBar({ value, min, max }: { value: number; min: number; max: number }) {
  const share = max > min ? (value - min) / (max - min) : 1;
  return (
    <span className="forge-range" aria-hidden="true">
      <span className="forge-range__fill" style={{ width: `${Math.round(share * 100)}%` }} />
    </span>
  );
}

/**
 * The Forge's improvement paths (ticket 3.4, GDD §8.1): pick an item (worn or in the pack), raise
 * its upgrade level, reroll an affix or improve one. Every result is decided by the server from the
 * item's own sealed stream and revealed only after paying; repeating a request never re-rolls it.
 */
export function ForgeWork({
  heroId,
  gold,
  equipped,
  pack,
  materials,
  onApplied,
  onNotice,
}: {
  heroId: string;
  gold: number;
  equipped: readonly ItemView[];
  pack: readonly ItemView[];
  materials: readonly MaterialStackDto[];
  onApplied: (result: ForgeActionResult) => void;
  onNotice: (notice: Notice | null) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [state, setState] = useState<Load<ForgeItemState>>({ kind: 'idle' });
  const [busy, setBusy] = useState<string | null>(null);
  const [openReroll, setOpenReroll] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const keys = useRef(new ActionKeys()).current;

  const items = useMemo(
    () => [...equipped, ...pack.filter((i) => i.slot !== null)],
    [equipped, pack],
  );
  const current = selected ?? items[0]?.id ?? null;

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

  const run = useCallback(
    async (
      action: string,
      call: (key: string) => Promise<Awaited<ReturnType<typeof forgeApi.upgrade>>>,
      describe: (r: ForgeActionResult) => string,
    ) => {
      setBusy(action);
      onNotice(null);
      const res = await call(keys.keyFor(action));
      keys.settle(action, res.ok ? null : res.error);
      setBusy(null);
      if (res.ok) {
        onApplied(res.value);
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
        onNotice({ kind: 'ok', text: describe(res.value) });
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

  if (items.length === 0) {
    return (
      <div className="shop__empty" role="status">
        <p className="display">Nothing on the anvil.</p>
        <p>Bring gear back from the fields; the smith works what you wear or carry.</p>
      </div>
    );
  }

  // A different item is selected than the one loaded: it is loading.
  const stale =
    (state.kind === 'ready' && state.value.item.id !== current) ||
    (state.kind === 'error' && state.itemId !== current);
  let detail;
  if (state.kind === 'loading' || state.kind === 'idle' || stale) {
    detail = (
      <div className="shop__empty" role="status">
        <p className="display">Heating the iron…</p>
      </div>
    );
  } else if (state.kind === 'error') {
    detail = (
      <div className="shop__empty" role="alert">
        <p className="display">The anvil stays cold.</p>
        <p>{state.message}</p>
        <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </button>
      </div>
    );
  } else {
    const { item: dto, forge } = state.value;
    const item = toItemView(dto);
    const up = forge.upgrade;
    // Key actions by the item's forge state too: after a success the next click is a new action.
    const upAction = `upgrade:${dto.id}:${forge.upgradeLevel}:${forge.upgradePity}`;
    detail = (
      <div className="forge-work__detail">
        <div className="forge-work__item">
          <ItemTooltip item={item} caption={dto.equippedSlot ? 'Worn' : 'In the pack'} />
        </div>

        <section className="forge-step" aria-labelledby="upgrade-title">
          <header className="forge-step__head">
            <h3 id="upgrade-title" className="display forge-step__title">
              Upgrade
            </h3>
            <p className="forge-step__note">Raises base values. A failed strike keeps the item.</p>
          </header>
          <Track level={forge.upgradeLevel} />
          {up ? (
            <>
              <dl className="forge-facts">
                <div>
                  <dt>Next</dt>
                  <dd>
                    +{up.fromLevel} → +{up.toLevel} (base values +{pct(up.bonusNow)} → +
                    {pct(up.bonusNext)})
                  </dd>
                </div>
                <div>
                  <dt>Chance</dt>
                  <dd>{up.guaranteed ? 'Certain' : pct(up.chance)}</dd>
                </div>
                {up.pityThreshold > 0 ? (
                  <div>
                    <dt>Smith’s patience</dt>
                    <dd>
                      <span className="forge-pity" aria-hidden="true">
                        {Array.from({ length: up.pityThreshold }, (_, i) => (
                          <span key={i} className={i < up.pity ? 'is-spent' : ''} />
                        ))}
                      </span>{' '}
                      {up.guaranteed
                        ? 'the next strike cannot fail'
                        : `${up.pity} of ${up.pityThreshold} failures: after ${up.pityThreshold} the next strike holds`}
                    </dd>
                  </div>
                ) : null}
              </dl>
              <Cost cost={up.cost} held={held} gold={gold} />
              <button
                type="button"
                className="btn btn--brass forge-step__go"
                disabled={busy !== null || up.blockers.length > 0}
                aria-busy={busy === upAction}
                onClick={() =>
                  void run(
                    upAction,
                    (key) => forgeApi.upgrade(heroId, dto.id, key),
                    (r) =>
                      r.outcome.action !== 'upgrade'
                        ? ''
                        : r.outcome.success
                          ? `The steel takes it: ${item.name} is now +${r.outcome.upgradeLevel}.`
                          : `The steel resists. ${item.name} stays +${r.outcome.upgradeLevel}; the smith grows more careful.`,
                  )
                }
              >
                {busy === upAction
                  ? 'Striking…'
                  : up.blockers.length > 0
                    ? up.blockers.some((b) => b.kind === 'material')
                      ? 'Not enough materials'
                      : 'Not enough gold'
                    : `Strike for +${up.toLevel}`}
              </button>
            </>
          ) : (
            <p className="forge-step__done">
              This item carries all ten marks. The smith has nothing to add.
            </p>
          )}
        </section>

        <section className="forge-step" aria-labelledby="affix-title">
          <header className="forge-step__head">
            <h3 id="affix-title" className="display forge-step__title">
              Affixes
            </h3>
            <p className="forge-step__note">
              Improve one toward its range’s top, or rework it into another. The others stay.
            </p>
          </header>
          {forge.improve.length === 0 ? (
            <p className="forge-step__done">A plain item: no affixes to work.</p>
          ) : (
            <>
              {forge.reroll ? (
                <div className="forge-reroll-price">
                  <p className="caps">
                    Rework price
                    {forge.rerollCount > 0 ? ` (reworked ${forge.rerollCount}×; it rises)` : ''}
                  </p>
                  <Cost cost={forge.reroll.cost} held={held} gold={gold} />
                </div>
              ) : null}
              <ul className="forge-affixes">
                {forge.improve.map((a) => {
                  const line = affixLine(a.affixId, a.value);
                  const impAction = `improve:${dto.id}:${a.index}:${a.improvements}:${a.value}`;
                  const rerAction = `reroll:${dto.id}:${a.index}:${forge.rerollCount}`;
                  const options = forge.reroll?.options[a.index] ?? [];
                  const rolled = dto.affixes[a.index];
                  return (
                    <li key={a.index} className="forge-affix">
                      <div className="forge-affix__line">
                        <span className="tooltip__affix-value">{line.value}</span> {line.name}
                        {rolled?.rerolled ? (
                          <span className="forge-affix__mark" title="Reworked at the forge">
                            ↻<span className="visually-hidden"> reworked</span>
                          </span>
                        ) : null}
                      </div>
                      <div className="forge-affix__range">
                        <RangeBar value={a.value} min={a.min} max={a.max} />
                        <span className="forge-affix__nums">
                          tier {a.tier}: {affixLine(a.affixId, a.min).value} to{' '}
                          {affixLine(a.affixId, a.max).value} · improved {a.improvements}/
                          {a.maxImprovements}
                        </span>
                      </div>
                      <div className="forge-affix__actions">
                        {a.refusal === null && a.next && a.cost ? (
                          <>
                            <span className="forge-affix__next">
                              next: {affixLine(a.affixId, a.next.low).value}
                              {a.next.high !== a.next.low
                                ? ` to ${affixLine(a.affixId, a.next.high).value}`
                                : ''}
                            </span>
                            <Cost cost={a.cost} held={held} gold={gold} />
                            <button
                              type="button"
                              className="btn btn--small"
                              disabled={busy !== null || a.blockers.length > 0}
                              aria-busy={busy === impAction}
                              onClick={() =>
                                void run(
                                  impAction,
                                  (key) => forgeApi.improve(heroId, dto.id, a.index, key),
                                  (r) =>
                                    r.outcome.action === 'improve'
                                      ? `Honed: ${affixLine(r.outcome.after.affixId, r.outcome.before.value).value} → ${affixLine(r.outcome.after.affixId, r.outcome.after.value).value} ${line.name}.`
                                      : '',
                                )
                              }
                            >
                              {busy === impAction ? 'Honing…' : 'Improve'}
                            </button>
                          </>
                        ) : (
                          <span className="forge-affix__next">
                            {a.refusal === 'affix_at_max'
                              ? 'At the top of its range.'
                              : a.refusal === 'improvement_cap'
                                ? 'Improved as far as it goes.'
                                : 'The smith does not know this affix.'}
                          </span>
                        )}
                        {forge.reroll && options.length > 0 ? (
                          <>
                            <button
                              type="button"
                              className="btn btn--small"
                              aria-expanded={openReroll === a.index}
                              onClick={() => setOpenReroll((v) => (v === a.index ? null : a.index))}
                            >
                              Rework…
                            </button>
                          </>
                        ) : null}
                      </div>
                      {openReroll === a.index && forge.reroll ? (
                        <div className="forge-reroll">
                          <p className="forge-reroll__lead">
                            Reworking replaces <strong>{line.name}</strong> with one of these, at a
                            random tier and value:
                          </p>
                          <ul className="forge-reroll__options">
                            {options.map((o) => {
                              const lo = o.tiers[0];
                              const hi = o.tiers[o.tiers.length - 1];
                              return (
                                <li key={o.affixId}>
                                  {affixLine(o.affixId, 0).name}{' '}
                                  <span className="forge-reroll__span">
                                    {lo && hi
                                      ? `${affixLine(o.affixId, lo.min).value} to ${affixLine(o.affixId, hi.max).value}`
                                      : ''}
                                  </span>
                                </li>
                              );
                            })}
                          </ul>
                          <button
                            type="button"
                            className="btn btn--brass"
                            disabled={busy !== null || forge.reroll.blockers.length > 0}
                            aria-busy={busy === rerAction}
                            onClick={() =>
                              void run(
                                rerAction,
                                (key) => forgeApi.reroll(heroId, dto.id, a.index, key),
                                (r) => {
                                  setOpenReroll(null);
                                  if (r.outcome.action !== 'reroll') return '';
                                  const after = affixLine(
                                    r.outcome.after.affixId,
                                    r.outcome.after.value,
                                  );
                                  return `Reworked: ${line.name} became ${after.value} ${after.name}.`;
                                },
                              )
                            }
                          >
                            {busy === rerAction
                              ? 'Reworking…'
                              : forge.reroll.blockers.length > 0
                                ? 'Cannot afford the rework'
                                : `Rework ${line.name}`}
                          </button>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="forge-work">
      <div className="forge-work__pick">
        <p className="caps forge-work__group">Worn</p>
        <ul className="picker__grid" aria-label="Worn items">
          {equipped.map((i) => (
            <li key={i.id}>
              <ItemFrame
                item={i}
                scale={2}
                selected={i.id === current}
                onSelect={() => {
                  setSelected(i.id);
                  setOpenReroll(null);
                }}
                context={i.slot ? slotName(i.slot) : 'Worn'}
              />
            </li>
          ))}
        </ul>
        {pack.length > 0 ? (
          <>
            <p className="caps forge-work__group">In the pack</p>
            <ul className="picker__grid" aria-label="Pack items">
              {pack
                .filter((i) => i.slot !== null)
                .map((i) => (
                  <li key={i.id}>
                    <ItemFrame
                      item={i}
                      scale={2}
                      selected={i.id === current}
                      onSelect={() => {
                        setSelected(i.id);
                        setOpenReroll(null);
                      }}
                      context={`Level ${i.itemLevel}`}
                    />
                  </li>
                ))}
            </ul>
          </>
        ) : null}
      </div>
      {detail}
    </div>
  );
}
