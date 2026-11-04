import { formatNumber } from '../lib/format';
import { routeHref } from '../lib/route';
import { objectiveLabel, objectiveTarget, questTitle } from './text';
import { useQuests } from './useQuests';
import './quest-tracker.css';

/**
 * Quest tracker on the area screen (ticket 2.4): each accepted quest with its first unfinished
 * objective, refreshed after every settlement. Ready quests point to the Tavern.
 */
export function QuestTracker() {
  const { board } = useQuests();
  if (board.kind !== 'ready') return null;
  const quests = board.value.quests;
  if (quests.length === 0) {
    return (
      <p className="tracker tracker--empty">
        <span className="caps">Quests</span> None in hand.{' '}
        <a href={routeHref('tavern')}>The Tavern has notices.</a>
      </p>
    );
  }
  return (
    <section className="tracker" aria-labelledby="tracker-title">
      <h2 id="tracker-title" className="caps tracker__title">
        Quests
      </h2>
      <ul className="tracker__list">
        {quests.map((q) => {
          const ready = q.status === 'ready';
          const i = q.objectives.findIndex((o, k) => (q.progress[k] ?? 0) < objectiveTarget(o));
          const objective = q.objectives[i === -1 ? 0 : i]!;
          const value = q.progress[i === -1 ? 0 : i] ?? 0;
          return (
            <li key={q.id} className={`tracker__quest${ready ? ' tracker__quest--ready' : ''}`}>
              <span className="tracker__name">
                {questTitle(q.kind, q.questId, q.objectives[0])}
              </span>
              {ready ? (
                <a className="tracker__ready" href={routeHref('tavern')}>
                  Done — turn in at the Tavern
                </a>
              ) : (
                <span className="tracker__step">
                  {objectiveLabel(objective)}{' '}
                  <strong>
                    {formatNumber(value)}/{formatNumber(objectiveTarget(objective))}
                  </strong>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
