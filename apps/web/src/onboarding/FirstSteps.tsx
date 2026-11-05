import { GUIDE_STEP_IDS, nextGuideStep } from '@worldforge/game-core';
import { useAuth } from '../auth/AuthProvider';
import { useActiveCharacter } from '../characters/CharactersProvider';
import { routeHref, type GameRoute } from '../lib/route';
import { guideStepCopy } from './guide';
import './onboarding.css';

/**
 * The first-session guide (ticket 2.7): one slim waymarker strip at the top of the game
 * screens with the next step of create → farm → first drop → equip → Tavern. Closing it is
 * remembered per account (server); it can be brought back from the status bar.
 */
export function FirstSteps({ route }: { route: GameRoute }) {
  const auth = useAuth();
  const hero = useActiveCharacter();
  if (auth.state.kind !== 'authenticated') return null;
  const { guide } = auth.state.account;
  if (guide.dismissed) return null;
  const close = () => auth.updateGuide({ dismissed: true });
  const next = nextGuideStep(guide.steps);
  const doneCount = GUIDE_STEP_IDS.filter((s) => guide.steps.includes(s)).length;

  return (
    <aside className="guide" aria-labelledby="guide-title">
      <div className="guide__head">
        <h2 id="guide-title" className="caps guide__title">
          {next ? `First steps · ${doneCount} of ${GUIDE_STEP_IDS.length}` : 'First steps · done'}
        </h2>
        <ol className="guide__track">
          {GUIDE_STEP_IDS.map((id) => {
            const state = guide.steps.includes(id) ? 'done' : id === next ? 'now' : 'todo';
            const { title } = guideStepCopy(id, hero.name);
            return (
              <li key={id} className={`guide__pip guide__pip--${state}`} title={title}>
                <span className="visually-hidden">
                  {title}
                  {state === 'done' ? ', done' : state === 'now' ? ', next' : ''}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
      {next ? (
        <Step id={next} route={route} heroName={hero.name} />
      ) : (
        <p className="guide__step">
          <strong className="guide__name display">The road is yours.</strong>{' '}
          <span className="guide__text">
            Farm, fill the pack, take contracts. New places open on the map as {hero.name} grows.
          </span>
        </p>
      )}
      <button type="button" className="guide__close" onClick={close}>
        {next ? 'Hide guide' : 'Close'}
      </button>
    </aside>
  );
}

function Step({
  id,
  route,
  heroName,
}: {
  id: (typeof GUIDE_STEP_IDS)[number];
  route: GameRoute;
  heroName: string;
}) {
  const step = guideStepCopy(id, heroName);
  const go = step.go && step.go.route !== route ? step.go : null;
  return (
    <p className="guide__step" aria-live="polite">
      <strong className="guide__name display">{step.title}.</strong>{' '}
      <span className="guide__text">{step.text}</span>
      {go ? (
        <a className="btn guide__go" href={routeHref(go.route)}>
          {go.label}
        </a>
      ) : null}
    </p>
  );
}

/** Status-bar link that brings a hidden, unfinished guide back. */
export function ReopenGuide() {
  const auth = useAuth();
  if (auth.state.kind !== 'authenticated') return null;
  const { guide } = auth.state.account;
  if (!guide.dismissed || nextGuideStep(guide.steps) === null) return null;
  return (
    <button
      type="button"
      className="statusbar__link"
      onClick={() => auth.updateGuide({ dismissed: false })}
    >
      Show first steps
    </button>
  );
}
