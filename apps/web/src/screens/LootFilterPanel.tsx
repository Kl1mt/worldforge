import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EMPTY_LOOT_FILTER,
  LOOT_FILTER_CATEGORIES,
  isLootFilterActive,
  lootFilterHandles,
  parseLootFilter,
  type LootFilterCategory,
  type LootFilterRules,
  type RarityId,
} from '@worldforge/game-core';
import { useActiveCharacter } from '../characters/CharactersProvider';
import { useGame } from '../game/GameProvider';
import { describeGameFailure, lootFilterApi, type LootFilterState } from '../game/api';
import {
  CATEGORY_TEXT,
  FILTER_AFFIXES,
  FILTER_EFFECTS,
  FILTER_RARITIES,
  describeRules,
} from '../game/lootFilter';
import type { Load } from '../game/GameProvider';
import './loot-filter.css';

type Notice = { kind: 'ok' | 'error'; text: string };

/** Rules in game-core's normal form (content order), or null when they would filter nothing. */
function normal(rules: LootFilterRules | null): LootFilterRules | null {
  if (!rules || !isLootFilterActive(rules)) return null;
  const parsed = parseLootFilter(rules);
  return parsed.ok ? parsed.rules : rules;
}
const same = (a: LootFilterRules | null, b: LootFilterRules | null) =>
  JSON.stringify(normal(a)) === JSON.stringify(normal(b));

function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/**
 * The loot filter (ticket 3.7): what happens to **new** drops before they reach the pack. The
 * server applies the saved rules at every settlement and crypt claim; this panel only edits them.
 * Legendary, Mythic, set and Void drops are always kept unless a category is opted in, and items
 * already carried are never touched.
 */
export function LootFilterPanel() {
  const hero = useActiveCharacter();
  const { inventory } = useGame();
  const [state, setState] = useState<Load<LootFilterState>>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState<LootFilterRules>({ ...EMPTY_LOOT_FILTER });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    lootFilterApi.get(hero.id, { signal: controller.signal }).then(
      (res) => {
        if (res.ok) {
          setState({ kind: 'ready', value: res.value });
          setDraft(res.value.rules ?? { ...EMPTY_LOOT_FILTER });
        } else {
          setState({ kind: 'error', message: describeGameFailure(res.error) });
        }
      },
      () => {
        /* aborted */
      },
    );
    return () => controller.abort();
  }, [hero.id, attempt]);

  const saved = state.kind === 'ready' ? state.value.rules : null;
  const dirty = state.kind === 'ready' && !same(saved, draft);
  const affixes = FILTER_AFFIXES.filter((a) => !a.classes || a.classes.includes(hero.classId));
  const effects = FILTER_EFFECTS.filter((e) => !e.classId || e.classId === hero.classId);

  // A preview on what is carried now (display only; the server never filters owned items).
  const pack = useMemo(
    () => (inventory.kind === 'ready' ? inventory.value.items : []),
    [inventory],
  );
  const wouldHandle = useMemo(
    () =>
      isLootFilterActive(draft)
        ? pack.filter((i) => lootFilterHandles(i.filterKey, draft)).length
        : 0,
    [pack, draft],
  );

  const save = useCallback(
    async (rules: LootFilterRules | null) => {
      setBusy(true);
      setNotice(null);
      const res = await lootFilterApi.set(hero.id, rules);
      setBusy(false);
      if (res.ok) {
        setState({ kind: 'ready', value: res.value });
        setDraft(res.value.rules ?? { ...EMPTY_LOOT_FILTER });
        setNotice({
          kind: 'ok',
          text: res.value.active
            ? 'Filter saved. It applies to drops from now on; earlier drops kept the old rules.'
            : 'Filter off. Every new drop goes to your pack.',
        });
      } else {
        setNotice({ kind: 'error', text: describeGameFailure(res.error) });
      }
    },
    [hero.id],
  );

  if (state.kind === 'loading') {
    return (
      <div className="lf__empty" role="status">
        <p className="display">Reading your standing orders…</p>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="lf__empty" role="alert">
        <p className="display">The filter will not load.</p>
        <p>{state.message}</p>
        <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </button>
      </div>
    );
  }

  const set = (patch: Partial<LootFilterRules>) => {
    setNotice(null);
    setDraft((d) => ({ ...d, ...patch }));
  };

  return (
    <div className="lf">
      <header className={`lf__status${state.value.active ? ' lf__status--on' : ''}`}>
        <p className="caps">
          {state.value.active ? 'Standing orders · active' : 'No standing orders'}
        </p>
        <p className="lf__summary">{describeRules(saved)}</p>
        <p className="lf__fine">
          Applies only to new drops, when your hero’s time is settled and when a crypt run is
          claimed. Items you carry, wear or have locked are never touched, and quest rewards are
          always yours.
        </p>
      </header>

      <form
        className="lf__form"
        onSubmit={(e) => {
          e.preventDefault();
          void save(normal(draft));
        }}
      >
        <fieldset className="lf__group">
          <legend className="caps">What happens to a filtered drop</legend>
          <div className="lf__choices">
            {(
              [
                ['salvage', 'Salvage', 'Materials and a little gold, as at the Forge'],
                ['sell', 'Sell', 'The merchant’s price in gold'],
              ] as const
            ).map(([id, name, hint]) => (
              <label key={id} className="lf__choice">
                <input
                  type="radio"
                  name="lf-action"
                  checked={draft.action === id}
                  onChange={() => set({ action: id })}
                />
                <span>
                  <strong>{name}</strong>
                  <span className="lf__hint">{hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="lf__group">
          <legend className="caps">Below this rarity</legend>
          <div className="lf__chips" role="group">
            <button
              type="button"
              className="btn lf__chip"
              aria-pressed={draft.belowRarity === null}
              onClick={() => set({ belowRarity: null })}
            >
              No rarity rule
            </button>
            {FILTER_RARITIES.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`btn lf__chip rarity-${r.id}`}
                aria-pressed={draft.belowRarity === r.id}
                onClick={() => set({ belowRarity: r.id as RarityId })}
              >
                <span className="pack__pip" aria-hidden="true" />
                Below {r.name}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="lf__group">
          <legend className="caps">Or without any of these</legend>
          <p className="lf__hint">
            Pick the traits you farm for. A drop with none of them is filtered, whatever its rarity.
            Leave empty for no trait rule.
          </p>
          <div className="lf__chips" role="group" aria-label="Wanted affixes">
            {affixes.map((a) => (
              <button
                key={a.id}
                type="button"
                className="btn lf__chip lf__chip--small"
                aria-pressed={draft.wantedAffixes.includes(a.id)}
                onClick={() => set({ wantedAffixes: toggle(draft.wantedAffixes, a.id) })}
              >
                {a.name}
              </button>
            ))}
          </div>
          <div className="lf__chips" role="group" aria-label="Wanted Legendary effects">
            {effects.map((e) => (
              <button
                key={e.id}
                type="button"
                className="btn lf__chip lf__chip--small lf__chip--effect"
                aria-pressed={draft.wantedEffects.includes(e.id)}
                onClick={() => set({ wantedEffects: toggle(draft.wantedEffects, e.id) })}
              >
                {e.name}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="lf__group lf__group--guard">
          <legend className="caps">Always kept</legend>
          <p className="lf__hint">
            These are always kept unless you tick them here. A drop in two categories (a Void set
            piece) needs both ticked.
          </p>
          <div className="lf__choices lf__choices--grid">
            {LOOT_FILTER_CATEGORIES.map((c: LootFilterCategory) => (
              <label key={c} className="lf__choice">
                <input
                  type="checkbox"
                  checked={draft.include.includes(c)}
                  onChange={() => set({ include: toggle(draft.include, c) })}
                />
                <span>
                  <strong>Let it take {CATEGORY_TEXT[c].name}</strong>
                  <span className="lf__hint">{CATEGORY_TEXT[c].hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="lf__actions">
          <p className="lf__preview" aria-live="polite">
            {isLootFilterActive(draft)
              ? `${describeRules(draft)} Of the ${pack.length} items in your pack, these rules would have taken ${wouldHandle}.`
              : 'No rule set: nothing will be filtered.'}
          </p>
          {notice ? (
            <p
              className={`pack__notice pack__notice--${notice.kind}`}
              role={notice.kind === 'error' ? 'alert' : 'status'}
            >
              {notice.text}
            </p>
          ) : null}
          <div className="lf__buttons">
            <button
              type="submit"
              className="btn btn--brass"
              disabled={busy || !dirty}
              aria-busy={busy}
            >
              {busy ? 'Saving…' : 'Save filter'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || saved === null}
              onClick={() => void save(null)}
            >
              Turn off
            </button>
            {dirty ? (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => setDraft(saved ?? { ...EMPTY_LOOT_FILTER })}
              >
                Undo changes
              </button>
            ) : null}
          </div>
        </div>
      </form>
    </div>
  );
}
