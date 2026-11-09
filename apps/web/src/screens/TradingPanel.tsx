import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { TRADE_KINDS, type TradeCapMetric } from '@worldforge/game-core';
import type { ApiFailure } from '../lib/api';
import { formatWhen } from '../social/api';
import { friendsApi, type FriendEntry } from '../social/friends';
import {
  CAP_LABELS,
  describeTradingFailure,
  tradingApi,
  type TradeEligibility,
} from '../social/trading';
import './trading-panel.css';

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; failure: ApiFailure }
  | { kind: 'ready'; view: TradeEligibility };

/** "items", "items and gold", "items, materials and gold". */
function listWords(words: string[]): string {
  return words.length < 2
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

const KIND_WORDS = { items: 'items', materials: 'materials', gold: 'gold' } as const;

/**
 * Ticket T.4: the account screen's trading panel. Your own standing for trading (each requirement
 * met or not), whether trading is open, your limits this week once it is, and a check against one
 * friend ("can I trade with them, and if not, why"). Never promises that trading is open.
 */
export function TradingPanel() {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => {
    setLoad({ kind: 'loading' });
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    tradingApi.eligibility(undefined, controller.signal).then(
      (r) => setLoad(r.ok ? { kind: 'ready', view: r.value } : { kind: 'error', failure: r.error }),
      () => {
        /* aborted */
      },
    );
    return () => controller.abort();
  }, [attempt]);

  return (
    <section className="trade-elig panel-iron" aria-labelledby="trade-elig-title">
      <h2 id="trade-elig-title" className="rule-heading">
        Trading
      </h2>
      {load.kind === 'loading' ? (
        <p className="trade-elig__wait" role="status">
          Reading the trade ledger…
        </p>
      ) : load.kind === 'error' ? (
        <div className="gate__alert" role="alert">
          <p>{describeTradingFailure(load.failure)}</p>
          <button type="button" className="btn btn--small" onClick={reload}>
            Try again
          </button>
        </div>
      ) : (
        <Ready view={load.view} />
      )}
    </section>
  );
}

function Ready({ view }: { view: TradeEligibility }) {
  const open = view.trading.open;
  const kinds = TRADE_KINDS.filter((k) => view.trading.kinds[k]).map((k) => KIND_WORDS[k]);
  return (
    <>
      <p className={`trade-elig__state${open ? ' trade-elig__state--open' : ''}`}>
        {open
          ? kinds.length > 0
            ? `Trading between friends is open for ${listWords(kinds)}.`
            : 'Trading is open, but nothing can be offered at the moment.'
          : 'Trading between players is not open. If the wardens open it, it will be gifts and swaps with friends and guildmates of at least a week. This is where you would stand.'}
      </p>
      <ul className="trade-elig__reqs">
        {view.you.requirements.map((r) => (
          <li key={r.id} className="trade-elig__req">
            <span
              className={`trade-elig__seal${r.met ? ' trade-elig__seal--ok' : ''}`}
              aria-hidden="true"
            />
            <div>
              <p className="trade-elig__label">
                {r.label}
                <span className="visually-hidden">{r.met ? ': met' : ': not yet'}</span>
              </p>
              <p className="trade-elig__text">
                {r.text}
                {!r.met && r.metAt ? ` Met on ${formatWhen(r.metAt)}.` : ''}
              </p>
            </div>
          </li>
        ))}
      </ul>
      <p className="trade-elig__summary">
        {view.you.eligible
          ? 'You meet every requirement.'
          : 'Not every requirement is met yet. Play goes on as usual.'}
      </p>
      {open ? <Limits view={view} /> : null}
      <FriendCheck />
    </>
  );
}

function Limits({ view }: { view: TradeEligibility }) {
  const rows = new Map<TradeCapMetric, { given?: string; received?: string; any?: string }>();
  for (const c of view.usage.caps) {
    const row = rows.get(c.metric) ?? {};
    row[c.direction] = `${c.used.toLocaleString('en-GB')} / ${c.max.toLocaleString('en-GB')}`;
    rows.set(c.metric, row);
  }
  return (
    <div className="trade-elig__limits">
      <h3 className="trade-elig__sub">Your limits</h3>
      <table className="trade-elig__table">
        <thead>
          <tr>
            <th scope="col">This week</th>
            <th scope="col">Given</th>
            <th scope="col">Received</th>
          </tr>
        </thead>
        <tbody>
          {[...rows].map(([metric, row]) =>
            metric === 'trades' ? null : (
              <tr key={metric}>
                <th scope="row">{CAP_LABELS[metric]}</th>
                <td>{row.given}</td>
                <td>{row.received}</td>
              </tr>
            ),
          )}
        </tbody>
      </table>
      <p className="trade-elig__fine">
        {CAP_LABELS.trades}: {rows.get('trades')?.any}. The week starts again{' '}
        {formatWhen(view.usage.weekResetsAt)}.
      </p>
    </div>
  );
}

type Friends =
  | { kind: 'loading' }
  | { kind: 'error'; failure: ApiFailure }
  | { kind: 'ready'; friends: FriendEntry[] };

type Check =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'error'; failure: ApiFailure }
  | { kind: 'done'; name: string; view: NonNullable<TradeEligibility['with']> };

function FriendCheck() {
  const id = useId();
  const [friends, setFriends] = useState<Friends>({ kind: 'loading' });
  const [handle, setHandle] = useState('');
  const [check, setCheck] = useState<Check>({ kind: 'idle' });

  useEffect(() => {
    const controller = new AbortController();
    friendsApi.list(controller.signal).then(
      (r) => {
        if (!r.ok) return setFriends({ kind: 'error', failure: r.error });
        setFriends({ kind: 'ready', friends: r.value.friends });
        setHandle(r.value.friends[0]?.handle ?? '');
      },
      () => {
        /* aborted */
      },
    );
    return () => controller.abort();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!handle || friends.kind !== 'ready') return;
    setCheck({ kind: 'busy' });
    const res = await tradingApi.eligibility(handle);
    if (!res.ok) return setCheck({ kind: 'error', failure: res.error });
    const f = friends.friends.find((x) => x.handle === handle);
    setCheck({ kind: 'done', name: f?.displayName ?? 'This player', view: res.value.with! });
  };

  return (
    <div className="trade-elig__check">
      <h3 className="trade-elig__sub">Could you trade with a friend?</h3>
      {friends.kind === 'loading' ? (
        <p className="trade-elig__wait" role="status">
          Looking up your friends…
        </p>
      ) : friends.kind === 'error' ? (
        <p className="trade-elig__text" role="alert">
          {describeTradingFailure(friends.failure)}
        </p>
      ) : friends.friends.length === 0 ? (
        <p className="trade-elig__text">
          Trading is only ever between friends and guildmates, and you have no friends listed yet.
        </p>
      ) : (
        <form className="trade-elig__form" onSubmit={(e) => void submit(e)}>
          <label htmlFor={`${id}-friend`} className="visually-hidden">
            Friend
          </label>
          <select
            id={`${id}-friend`}
            className="field__input"
            value={handle}
            onChange={(e) => {
              setHandle(e.target.value);
              setCheck({ kind: 'idle' });
            }}
          >
            {friends.friends.map((f) => (
              <option key={f.handle} value={f.handle}>
                {f.displayName ?? 'Name withheld'}
              </option>
            ))}
          </select>
          <button type="submit" className="btn btn--small" disabled={check.kind === 'busy'}>
            {check.kind === 'busy' ? 'Checking…' : 'Check'}
          </button>
        </form>
      )}
      {check.kind === 'error' ? (
        <p className="trade-elig__text" role="alert">
          {describeTradingFailure(check.failure)}
        </p>
      ) : null}
      {check.kind === 'done' ? (
        <div className="trade-elig__answer" role="status">
          {check.view.allowed ? (
            <p>
              <strong>{check.name}</strong>: nothing stands in the way.
            </p>
          ) : (
            <>
              <p>
                <strong>{check.name}</strong>: not at the moment.
              </p>
              <ul className="trade-elig__why">
                {check.view.reasons.map((r) => (
                  <li key={`${r.party}-${r.check}`}>
                    {r.text}
                    {r.metAt ? ` (from ${formatWhen(r.metAt)})` : ''}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
