import { useCallback, useEffect, useState } from 'react';
import type { Score, ScoreMetric, Scores } from '@worldforge/game-core';
import { useGame } from '../game/GameProvider';
import { apiRequest } from '../lib/api';
import { formatNumber } from '../lib/format';
import { routeHref } from '../lib/route';

/** Board names and how the headline reads (ticket 5.1, docs/LEADERBOARDS.md). */
const METRICS: { id: ScoreMetric; name: string; headline: (s: Score) => string }[] = [
  { id: 'level', name: 'Character Level', headline: (s) => `Level ${s.value}` },
  { id: 'power', name: 'Character Power', headline: (s) => formatNumber(s.value) },
  { id: 'gearScore', name: 'Gear Score', headline: (s) => formatNumber(s.value) },
  {
    id: 'pveProgress',
    name: 'PvE Progress',
    headline: (s) => `${s.value} of ${s.lines.length - 1}`,
  },
];

const EMPTY_HINT: Partial<Record<ScoreMetric, string>> = {
  gearScore: 'Nothing equipped yet: every item you wear counts here.',
};

type Load =
  { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; value: Scores };

function Breakdown({ score }: { score: Score }) {
  const counted = score.lines.filter((l) => l.counted);
  if (score.lines.length === 0) {
    return (
      <p className="standing__empty">
        {EMPTY_HINT[score.metric]}{' '}
        {score.metric === 'gearScore' ? <a href={routeHref('inventory')}>Open the pack</a> : null}
      </p>
    );
  }
  return (
    <>
      <p className="standing__summary">{score.summary}</p>
      <ol className={`standing__lines standing__lines--${score.metric}`}>
        {score.lines.map((l) => (
          <li
            key={l.id}
            className={`standing__line${l.counted ? '' : ' is-zero'}${l.id === 'excluded' ? ' standing__line--wide' : ''}`}
          >
            <span className="standing__label">
              {l.label}
              <span className="standing__detail">{l.detail}</span>
            </span>
            <span className="standing__points">
              {score.metric === 'pveProgress' ? (
                l.counted ? (
                  <span aria-label="reached">◆</span>
                ) : (
                  <span aria-label="not yet">◇</span>
                )
              ) : (
                formatNumber(l.points)
              )}
            </span>
          </li>
        ))}
      </ol>
      {score.metric === 'gearScore' && counted.length < score.lines.length ? (
        <p className="standing__warn" role="note">
          Items marked “does not count” add nothing here or to Character Power.
        </p>
      ) : null}
    </>
  );
}

/**
 * The hero's four leaderboard scores with what counts and why (ticket 5.1). Read-only: the server
 * computes them from its own state (`GET …/scores`); the client never sends or derives a score.
 * Reloads when the equipped items or the level change.
 */
export function StandingPanel({ characterId, level }: { characterId: string; level: number }) {
  const { inventory } = useGame();
  const [state, setState] = useState<Load>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const gearKey =
    inventory.kind === 'ready'
      ? inventory.value.equipped.map((i) => `${i.id}:${i.upgradeLevel}`).join(',')
      : null;

  const retry = useCallback(() => {
    setState({ kind: 'loading' });
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void apiRequest<{ scores: Scores }>(`/characters/${characterId}/scores`, {
      signal: controller.signal,
    })
      .then((res) => {
        setState((prev) =>
          res.ok
            ? { kind: 'ready', value: res.value.scores }
            : prev.kind === 'ready'
              ? prev
              : { kind: 'error', message: res.error.message },
        );
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [characterId, level, gearKey, attempt]);

  return (
    <section className="panel-iron standing" aria-labelledby="standing-title">
      <h2 id="standing-title" className="rule-heading">
        Standing
      </h2>
      {state.kind === 'loading' ? (
        <p className="standing__state" role="status">
          Weighing your deeds…
        </p>
      ) : null}
      {state.kind === 'error' ? (
        <div className="standing__state" role="alert">
          <p>The scores could not be read: {state.message}</p>
          <button type="button" className="btn" onClick={retry}>
            Try again
          </button>
        </div>
      ) : null}
      {state.kind === 'ready' ? (
        <>
          <ul className="standing__list">
            {METRICS.map((m) => {
              const score = state.value[m.id];
              return (
                <li key={m.id}>
                  <details className="standing__metric">
                    <summary>
                      <span className="standing__name">{m.name}</span>
                      <span className={`standing__value${score.value === 0 ? ' is-zero' : ''}`}>
                        {m.headline(score)}
                      </span>
                    </summary>
                    <Breakdown score={score} />
                  </details>
                </li>
              );
            })}
          </ul>
          <p className="standing__note">
            Counted by the server from what your hero has done and wears. Open a line to see what
            counts and why. <a href={routeHref('boards')}>See the Roll of Renown</a>
          </p>
        </>
      ) : null}
    </section>
  );
}
