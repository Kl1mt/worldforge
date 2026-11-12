import { useCallback, useEffect, useId, useState } from 'react';
import { ITEM_SLOT_KINDS, RARITIES } from '@worldforge/game-core';
import { slotName } from '../game/items';
import {
  DEFAULT_ITEM_QUERY,
  ITEM_QUERY_TEXT_MAX,
  ITEM_SORTS,
  SORT_LABELS,
  activeFilterCount,
  loadItemQuery,
  saveItemQuery,
  type Either,
  type ItemQuery,
  type ItemQueryScreen,
} from './query';
import './item-query.css';

/** The screen's query, remembered per screen (ticket 8.5); null = not remembered. */
export function useItemQuery(screen: ItemQueryScreen | null) {
  const [query, setQuery] = useState<ItemQuery>(() =>
    screen ? loadItemQuery(screen) : { ...DEFAULT_ITEM_QUERY },
  );
  useEffect(() => {
    if (screen) saveItemQuery(screen, query);
  }, [screen, query]);
  const update = useCallback(
    (patch: Partial<ItemQuery>) => setQuery((q) => ({ ...q, ...patch })),
    [],
  );
  const clear = useCallback(() => setQuery((q) => ({ ...DEFAULT_ITEM_QUERY, sort: q.sort })), []);
  return { query, update, clear };
}

const EITHER_WORDS: Record<
  'locked' | 'tradeable' | 'held' | 'awakened',
  { label: string; yes: string; no: string }
> = {
  locked: { label: 'Lock', yes: 'Locked', no: 'Not locked' },
  tradeable: { label: 'Binding', yes: 'Tradeable', no: 'Account-bound' },
  held: { label: 'Trade hold', yes: 'On hold', no: 'Free to use' },
  awakened: { label: 'Awakening', yes: 'Awakened', no: 'Not awakened' },
};

/**
 * Search, sort and filters over a list the screen already holds (ticket 8.5). The ledger-strip
 * look of the Pack: one line on wide screens, wrapping on phones; the filters fold away.
 */
export function ItemQueryBar({
  query,
  update,
  clear,
  shown,
  total,
  place,
  rarity = true,
  scoreSort = true,
}: {
  query: ItemQuery;
  update: (patch: Partial<ItemQuery>) => void;
  clear: () => void;
  shown: number;
  total: number;
  /** "the pack", "the shelves": the search's accessible name. */
  place: string;
  /** Whether the rarity select shows (the Pack has its own rarity row). */
  rarity?: boolean;
  /** Whether "Better than worn" is offered (only where the hero's gear is known). */
  scoreSort?: boolean;
}) {
  const id = useId();
  const filters = activeFilterCount(rarity ? query : { ...query, rarity: 'any' });
  const [open, setOpen] = useState(filters > 0);
  const narrowed = filters > 0 || query.text.trim() !== '';

  const either = (key: keyof typeof EITHER_WORDS) => (
    <label className="item-query__field">
      <span className="caps item-query__label">{EITHER_WORDS[key].label}</span>
      <select
        className="item-query__select"
        value={query[key]}
        onChange={(e) => update({ [key]: e.target.value as Either })}
      >
        <option value="any">Any</option>
        <option value="yes">{EITHER_WORDS[key].yes}</option>
        <option value="no">{EITHER_WORDS[key].no}</option>
      </select>
    </label>
  );

  return (
    <div className="item-query" role="search" aria-label={`Find in ${place}`}>
      <div className="item-query__line">
        <label className="item-query__search">
          <span className="visually-hidden">Search {place}</span>
          <input
            type="search"
            className="item-query__input"
            placeholder="Name, affix, effect or set…"
            value={query.text}
            maxLength={ITEM_QUERY_TEXT_MAX}
            onChange={(e) => update({ text: e.target.value })}
          />
        </label>
        <label className="item-query__field item-query__field--sort">
          <span className="caps item-query__label">Sort</span>
          <select
            className="item-query__select"
            value={query.sort}
            onChange={(e) => update({ sort: e.target.value as ItemQuery['sort'] })}
          >
            {ITEM_SORTS.filter((s) => scoreSort || s !== 'score').map((s) => (
              <option key={s} value={s}>
                {SORT_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn btn--small item-query__toggle"
          aria-expanded={open}
          aria-controls={`${id}-filters`}
          onClick={() => setOpen((o) => !o)}
        >
          Filters{filters > 0 ? ` (${filters})` : ''}
        </button>
        <p className="item-query__count" aria-live="polite">
          {narrowed ? `${shown} of ${total} shown` : `${total} ${total === 1 ? 'item' : 'items'}`}
        </p>
      </div>
      {open ? (
        <div className="item-query__filters" id={`${id}-filters`}>
          <label className="item-query__field">
            <span className="caps item-query__label">Slot</span>
            <select
              className="item-query__select"
              value={query.slot}
              onChange={(e) => update({ slot: e.target.value as ItemQuery['slot'] })}
            >
              <option value="any">Any</option>
              {ITEM_SLOT_KINDS.map((s) => (
                <option key={s} value={s}>
                  {slotName(s)}
                </option>
              ))}
            </select>
          </label>
          {rarity ? (
            <label className="item-query__field">
              <span className="caps item-query__label">Rarity</span>
              <select
                className="item-query__select"
                value={query.rarity}
                onChange={(e) => update({ rarity: e.target.value as ItemQuery['rarity'] })}
              >
                <option value="any">Any</option>
                {RARITIES.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="item-query__field">
            <span className="caps item-query__label">Variant</span>
            <select
              className="item-query__select"
              value={query.variant}
              onChange={(e) => update({ variant: e.target.value as ItemQuery['variant'] })}
            >
              <option value="any">Any</option>
              <option value="void">Void</option>
              <option value="prismatic">Prismatic</option>
              <option value="none">Neither</option>
            </select>
          </label>
          {either('locked')}
          {either('tradeable')}
          {either('held')}
          {either('awakened')}
          <button
            type="button"
            className="btn btn--small item-query__clear"
            onClick={clear}
            disabled={!narrowed}
          >
            Clear
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The empty state when the query hides every item (the list itself is not empty). */
export function NothingMatches({ onClear }: { onClear: () => void }) {
  return (
    <div className="item-query__none" role="status">
      <p className="display">Nothing matches.</p>
      <p>No item here fits the search and filters.</p>
      <button type="button" className="btn" onClick={onClear}>
        Clear the search
      </button>
    </div>
  );
}
