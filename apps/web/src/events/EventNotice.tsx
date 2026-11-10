import { useCallback, useEffect, useState } from 'react';
import { useActiveCharacter } from '../characters/CharactersProvider';
import { useGame } from '../game/GameProvider';
import { Meter } from '../components/Meter';
import { eventsApi, type HeroEvent } from './api';
import { eventFrom, eventUntil, talliesLine, timeLeft, trackLines } from './text';
import './events.css';

type State = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; value: HeroEvent };

/**
 * Ticket 6.6: the event notice in the Tavern (docs/EVENTS.md). While an event runs: its story, the
 * modifier, the hero's quests (join first) and the account's reward track. Before one begins: a
 * short word of what is coming. No event: nothing.
 */
export function EventNotice() {
  const hero = useActiveCharacter();
  const { activity, reload: reloadGame } = useGame();
  const settledAt = activity.kind === 'ready' ? (activity.value?.settledAt ?? null) : null;
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    eventsApi.hero(hero.id, ctrl.signal).then(
      (res) =>
        setState((prev) =>
          res.ok
            ? { kind: 'ready', value: res.value }
            : prev.kind === 'ready'
              ? prev
              : { kind: 'error' },
        ),
      () => {
        /* aborted */
      },
    );
    return () => ctrl.abort();
  }, [hero.id, settledAt, attempt]);

  const join = useCallback(async () => {
    setJoining(true);
    setJoinError(null);
    const res = await eventsApi.join(hero.id);
    setJoining(false);
    if (!res.ok) {
      setJoinError(
        res.error.code === 'no_event'
          ? 'The Harvest is over; the Reeve has gone home.'
          : 'The Reeve could not take your name right now. Try again.',
      );
      setAttempt((n) => n + 1);
      return;
    }
    setState({ kind: 'ready', value: res.value });
    reloadGame();
  }, [hero.id, reloadGame]);

  if (state.kind === 'loading')
    return (
      <p className="evt-notice__wait" role="status">
        The keeper looks for the Reeve’s notice…
      </p>
    );
  if (state.kind === 'error')
    return (
      <div className="tavern__alert evt-notice__alert" role="alert">
        <p>The event notice cannot be read right now.</p>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setState({ kind: 'loading' });
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </button>
      </div>
    );
  const v = state.value;
  const e = v.current;
  if (!e) {
    if (!v.next) return null;
    return (
      <aside className="evt-notice evt-notice--soon" aria-label="Coming to Graumark">
        <p className="caps evt-notice__kicker">Coming · {eventFrom(v.next)}</p>
        <p className="evt-notice__name display">{v.next.name}</p>
        <p className="evt-notice__tagline">{v.next.tagline}</p>
      </aside>
    );
  }
  const lines = trackLines(e, v.track);
  return (
    <section className="evt-notice" aria-labelledby="evt-notice-title">
      <div className="evt-notice__head">
        <p className="caps evt-notice__kicker">
          An event in Graumark · {eventUntil(e)} · {timeLeft(e.endsAt, v.now)}
        </p>
        <h2 id="evt-notice-title" className="display evt-notice__name">
          {e.name}
        </h2>
        <p className="evt-notice__story">{e.description}</p>
        <p className="evt-notice__giver">— posted by {e.giver}</p>
      </div>

      <div className="evt-notice__modifier">
        <p className="caps">While it lasts · {e.modifier.name}</p>
        <p>{e.modifier.description}</p>
      </div>

      <div className="evt-notice__body">
        <div className="evt-notice__quests">
          <h3 className="caps evt-notice__sub">The Reeve’s tasks</h3>
          {!v.hero ? (
            <div className="evt-notice__join">
              <p>
                Put your name to the Harvest to take up these tasks. Only what {hero.name} does from
                now on counts, and the extra Soul Shards come only to those who take part.
              </p>
              <button
                type="button"
                className="btn btn--brass"
                onClick={() => void join()}
                disabled={joining}
              >
                {joining ? 'Signing…' : `Join the ${e.name}`}
              </button>
              {joinError ? (
                <p className="tavern__alert" role="alert">
                  {joinError}
                </p>
              ) : null}
            </div>
          ) : null}
          <ol className="evt-notice__list">
            {e.quests.map((q, i) => {
              const mine = v.hero?.quests[i];
              const done = mine?.done ?? false;
              return (
                <li key={q.id} className={`evt-task${done ? ' evt-task--done' : ''}`}>
                  <span className="evt-task__name display">{q.name}</span>
                  <span className="evt-task__tallies">
                    {q.tallies} {e.tallyName}
                  </span>
                  <span className="evt-task__desc">{q.description}</span>
                  {mine ? (
                    <Meter
                      className="evt-task__meter"
                      variant="xp"
                      current={mine.progress}
                      max={mine.target}
                      label={`${q.name}: ${mine.progress} of ${mine.target}`}
                    />
                  ) : null}
                  {mine ? (
                    <span className="evt-task__count">
                      {done
                        ? 'Done'
                        : `${mine.progress.toLocaleString('en-GB')} / ${mine.target.toLocaleString('en-GB')}`}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>
          {v.hero && (v.hero.bonus.soulShard ?? 0) > 0 ? (
            <p className="evt-notice__bonus">
              The Harvest has given {hero.name} {v.hero.bonus.soulShard} extra Soul Shard
              {v.hero.bonus.soulShard === 1 ? '' : 's'} so far.
            </p>
          ) : null}
        </div>

        <div className="evt-notice__track">
          <h3 className="caps evt-notice__sub">Your reward track</h3>
          <p className="evt-notice__tally">{talliesLine(e, v.track)}</p>
          <p className="evt-notice__fine">
            Tallies from all your heroes add up. Rewards are for show only: they change no number in
            the game.
          </p>
          <ul className="evt-notice__tiers">
            {lines.map((l) => (
              <li key={l.tier} className={`evt-tier evt-tier--${l.state}`}>
                <span className="evt-tier__mark" aria-hidden="true">
                  {l.state === 'granted' ? '✦' : l.tier}
                </span>
                <span className="evt-tier__what">
                  <span className="evt-tier__name display">{l.name}</span>
                  <span className="evt-tier__kind caps">
                    {l.kind} · {l.tallies} {e.tallyName}
                  </span>
                  {l.state === 'granted' ? (
                    <span className="evt-tier__where">{l.where}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <p className="evt-notice__fine">
        When the Harvest ends, unfinished tasks lapse. Whatever you have earned by then, shards and
        rewards alike, is yours to keep.
      </p>
    </section>
  );
}
