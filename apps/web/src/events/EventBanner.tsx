import { useEffect, useState } from 'react';
import { routeHref } from '../lib/route';
import { eventsApi, type EventsNow } from './api';
import { timeLeft } from './text';
import './events.css';

type State = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; value: EventsNow };

/**
 * Ticket 6.6: a small pennant in the town and on the map while an event runs, pointing to the
 * Tavern. Loading or no event: nothing (it is a notice, not a section); an error: one quiet line
 * with a retry.
 */
export function EventBanner() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const ctrl = new AbortController();
    eventsApi.now(ctrl.signal).then(
      (res) => setState(res.ok ? { kind: 'ready', value: res.value } : { kind: 'error' }),
      () => {
        /* aborted */
      },
    );
    return () => ctrl.abort();
  }, [attempt]);
  if (state.kind === 'loading') return null;
  if (state.kind === 'error')
    return (
      <p className="evt-banner evt-banner--quiet" role="status">
        The town crier is hoarse.{' '}
        <button
          type="button"
          className="evt-banner__retry"
          onClick={() => setAttempt((n) => n + 1)}
        >
          Ask again
        </button>
      </p>
    );
  const e = state.value.current;
  if (!e) return null;
  return (
    <a
      className="evt-banner"
      href={routeHref('tavern')}
      aria-label={`${e.name}: ${e.tagline} Read the notice in the Tavern.`}
    >
      <span className="evt-banner__pennant" aria-hidden="true" />
      <span className="evt-banner__text">
        <span className="evt-banner__name display">{e.name}</span>
        <span className="evt-banner__tagline">{e.tagline}</span>
      </span>
      <span className="evt-banner__left caps">
        {timeLeft(e.endsAt, state.value.now)} · the Tavern
      </span>
    </a>
  );
}
