import { useCallback, useEffect, useState } from 'react';
import type { ApiFailure } from '../lib/api';
import { capText } from '../onboarding/guide';
import { formatWhen } from '../social/api';
import {
  SLOT_SOURCE_LABELS,
  accountGrowthApi,
  describeGrowthFailure,
  type AccountGrowth,
  type GrowthEntry,
} from '../account/growth';
import { routeHref } from '../lib/route';
import './account-growth.css';

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; failure: ApiFailure }
  | { kind: 'ready'; growth: AccountGrowth };

const ORDINAL = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];
const ordinal = (n: number) => ORDINAL[n - 1] ?? `${n}th`;

/**
 * Ticket 9.4: the account page's muster ledger. Character slots and the hours a hero keeps
 * farming while you are away: what is earned, what comes next, and how to get it. Everything
 * here is earned in play; the server grants it, the page only reads it.
 */
export function AccountGrowthPanel() {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => {
    setLoad({ kind: 'loading' });
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    accountGrowthApi.get(controller.signal).then(
      (r) =>
        setLoad(r.ok ? { kind: 'ready', growth: r.value } : { kind: 'error', failure: r.error }),
      () => {
        /* aborted */
      },
    );
    return () => controller.abort();
  }, [attempt]);

  return (
    <section className="muster-ledger panel-iron" aria-labelledby="muster-ledger-title">
      <h2 id="muster-ledger-title" className="rule-heading">
        Muster &amp; vigil
      </h2>
      {load.kind === 'loading' ? (
        <p className="muster-ledger__wait" role="status">
          Unrolling the muster ledger…
        </p>
      ) : load.kind === 'error' ? (
        <div className="gate__alert" role="alert">
          <p>{describeGrowthFailure(load.failure)}</p>
          <button type="button" className="btn btn--small" onClick={reload}>
            Try again
          </button>
        </div>
      ) : (
        <>
          <Slots growth={load.growth} />
          <Vigil growth={load.growth} />
        </>
      )}
    </section>
  );
}

function Slots({ growth }: { growth: AccountGrowth }) {
  const { base, total, used, entries } = growth.slots;
  const earned = entries.filter((e) => e.grantedAt !== null);
  const locked = entries.filter((e) => e.grantedAt === null);
  return (
    <div className="muster-ledger__part">
      <h3 className="muster-ledger__sub">Hero slots</h3>
      <p className="muster-ledger__lede">
        {total} {total === 1 ? 'slot' : 'slots'}, {used} filled.{' '}
        <a href={routeHref('characters')}>Muster roll</a>
      </p>
      <ol className="muster-ledger__slots" aria-label="Hero slots">
        {Array.from({ length: base }, (_, i) => (
          <li key={`base-${i}`} className="muster-ledger__slot muster-ledger__slot--open">
            <span className="muster-ledger__pip" aria-hidden="true" />
            <span className="muster-ledger__slot-name">
              {cap(ordinal(i + 1))} slot
              <span className="muster-ledger__slot-how">Every account</span>
            </span>
          </li>
        ))}
        {earned.map((e, i) => (
          <SlotRow key={e.source} entry={e} n={base + i + 1} />
        ))}
        {locked.map((e, i) => (
          <SlotRow key={e.source} entry={e} n={base + earned.length + i + 1} next={i === 0} />
        ))}
      </ol>
    </div>
  );
}

function SlotRow({ entry, n, next = false }: { entry: GrowthEntry; n: number; next?: boolean }) {
  const label = SLOT_SOURCE_LABELS[entry.source] ?? 'Earned';
  const state = entry.grantedAt ? 'open' : entry.available ? (next ? 'next' : 'locked') : 'sealed';
  return (
    <li className={`muster-ledger__slot muster-ledger__slot--${state}`}>
      <span className="muster-ledger__pip" aria-hidden="true" />
      <span className="muster-ledger__slot-name">
        {cap(ordinal(n))} slot · {label}
        <span className="visually-hidden">{entry.grantedAt ? ': earned' : ': not yet'}</span>
        <span className="muster-ledger__slot-how">
          {entry.grantedAt
            ? `Earned ${formatWhen(entry.grantedAt)}`
            : next
              ? `Next: ${entry.description}`
              : entry.description}
        </span>
      </span>
    </li>
  );
}

function Vigil({ growth }: { growth: AccountGrowth }) {
  const { capMs, nextCapMs, stepsMs, deeds } = growth.offline;
  const done = deeds.filter((d) => d.grantedAt !== null).length;
  return (
    <div className="muster-ledger__part">
      <h3 className="muster-ledger__sub">Hours away</h3>
      <p className="muster-ledger__lede">
        While you are away, your hero farms for up to <strong>{capText(capMs)}</strong>.{' '}
        {nextCapMs !== null
          ? `Each deed below adds a step; the next one raises it to ${capText(nextCapMs)}.`
          : 'Every step is earned.'}
      </p>
      <ol className="muster-ledger__steps" aria-label="Offline hours by step">
        {stepsMs.map((ms, i) => (
          <li
            key={ms}
            className={`muster-ledger__step${i <= done ? ' muster-ledger__step--lit' : ''}${
              i === done ? ' muster-ledger__step--now' : ''
            }`}
            aria-current={i === done ? 'step' : undefined}
          >
            {Math.round(ms / 3_600_000)} h
          </li>
        ))}
      </ol>
      <ul className="muster-ledger__deeds">
        {deeds.map((d) => (
          <li key={d.source} className="muster-ledger__deed">
            <span
              className={`muster-ledger__seal${d.grantedAt ? ' muster-ledger__seal--ok' : ''}`}
              aria-hidden="true"
            />
            <div>
              <p className="muster-ledger__deed-text">
                {d.description}
                <span className="visually-hidden">{d.grantedAt ? ': done' : ': not yet'}</span>
              </p>
              {d.grantedAt ? (
                <p className="muster-ledger__deed-when">Done {formatWhen(d.grantedAt)}</p>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <p className="muster-ledger__fine">
        A new step counts from the moment it is earned. Hours already past the old limit are not
        given back. Keep the game open and nothing is capped at all.
      </p>
    </div>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
