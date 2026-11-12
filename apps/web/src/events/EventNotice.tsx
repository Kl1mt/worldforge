import { useCallback, useEffect, useState } from 'react';
import { getMaterial, type MaterialId } from '@worldforge/game-core';
import { useActiveCharacter } from '../characters/CharactersProvider';
import { useGame } from '../game/GameProvider';
import { Meter } from '../components/Meter';
import { eventsApi, type HeroEvent } from './api';
import {
  bonusWords,
  eventFrom,
  eventUntil,
  questWeeks,
  talliesLine,
  timeLeft,
  trackLines,
  weekOpens,
} from './text';
import './events.css';

const materialName = (id: string) => {
  try {
    return getMaterial(id as MaterialId).name;
  } catch {
    return id;
  }
};

type State = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; value: HeroEvent };

/**
 * Ticket 6.6: the event notice in the Tavern (docs/EVENTS.md). While an event runs: its story, the
 * modifier, the hero's quests (join first) and the account's reward track. Before one begins: a
 * short word of what is coming. No event: nothing. Ticket 8.3: the words follow the event (its
 * giver, its modifier, its bonus); a quest line of several weeks is shown week by week, the weeks
 * to come with the day they open, and level-gated tasks with their level.
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
          ? 'The event is over; its notice has been taken down.'
          : 'Your name could not be taken right now. Try again.',
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
        The keeper looks for the event notice…
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
  const weeks = questWeeks(e);
  const bonus = v.hero ? bonusWords(v.hero.bonus, materialName) : '';
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
          <h3 className="caps evt-notice__sub">{e.giver}’s tasks</h3>
          {!v.hero ? (
            <div className="evt-notice__join">
              <p>
                Put your name to the {e.name} to take up these tasks. Only what {hero.name} does
                from now on counts, and “{e.modifier.name}” comes only to those who take part.
              </p>
              <button
                type="button"
                className="btn btn--brass"
                onClick={() => void join()}
                disabled={joining}
              >
                {joining ? 'Signing…' : `Join the ${e.name.replace(/^The /, '')}`}
              </button>
              {joinError ? (
                <p className="tavern__alert" role="alert">
                  {joinError}
                </p>
              ) : null}
            </div>
          ) : null}
          {weeks.map((g) => (
            <div
              key={g.week}
              className={`evt-week evt-week--${g.state}`}
              aria-label={e.weeks > 1 ? `Week ${g.week}` : undefined}
            >
              {e.weeks > 1 ? (
                <p className="caps evt-week__head">
                  Week {g.week} of {e.weeks}
                  {g.state === 'later' ? ` · ${weekOpens(g.opensAt)}` : null}
                  {g.state === 'now' ? ' · this week' : null}
                </p>
              ) : null}
              <ol className="evt-notice__list">
                {g.quests.map(({ quest: q, index: i }) => {
                  const mine = v.hero?.quests[i];
                  const done = mine?.done ?? false;
                  const levelShut = q.minLevel !== null && hero.level < q.minLevel;
                  const waiting = g.state === 'later';
                  return (
                    <li
                      key={q.id}
                      className={`evt-task${done ? ' evt-task--done' : ''}${waiting ? ' evt-task--later' : ''}`}
                    >
                      <span className="evt-task__name display">{q.name}</span>
                      <span className="evt-task__tallies">
                        {q.tallies} {e.tallyName}
                      </span>
                      <span className="evt-task__desc">
                        {q.description}
                        {levelShut ? (
                          <span className="evt-task__gate evt-task__gate--shut">
                            {` Needs level ${q.minLevel}: ${hero.name} is ${hero.level}.`}
                          </span>
                        ) : null}
                      </span>
                      {mine && !waiting ? (
                        <Meter
                          className="evt-task__meter"
                          variant="xp"
                          current={mine.progress}
                          max={mine.target}
                          label={`${q.name}: ${mine.progress} of ${mine.target}`}
                        />
                      ) : null}
                      {mine && !waiting ? (
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
            </div>
          ))}
          {v.hero && bonus ? (
            <p className="evt-notice__bonus">
              The {e.name.replace(/^The /, '')} has given {hero.name} {bonus} so far.
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
        {e.weeks > 1
          ? `A new week of tasks opens every seven days; earlier weeks stay open to the end. `
          : null}
        When the {e.name.replace(/^The /, '')} ends, unfinished tasks lapse. Whatever you have
        earned by then, materials and rewards alike, is yours to keep.
      </p>
    </section>
  );
}
