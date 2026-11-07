import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  findAchievement,
  findCommunityProject,
  getWorldFlag,
  isWorldFlagId,
  type MaterialId,
  type ProjectResource,
} from '@worldforge/game-core';
import { useActiveCharacter, useCharacters } from '../characters/CharactersProvider';
import { useGame } from '../game/GameProvider';
import { materialView } from '../game/materials';
import { MaterialStack } from '../components/MaterialStack';
import { LabeledMeter } from '../components/Meter';
import { formatNumber } from '../lib/format';
import {
  communityApi,
  describeContributionFailure,
  maxGift,
  projectProgress,
  useProjectBoard,
  type NeedView,
  type ProjectBoard,
  type ProjectView,
} from '../community/api';
import { Gold, ShopHeader } from './economy/ShopHeader';
import './economy/shop.css';
import './works.css';

/**
 * The town works (ticket 4.6): the community projects of Graumark as a builder's ledger. Each
 * project shows its stages, the current stage's needs with the town's progress, your share today
 * and its cap, and a form to give from the active hero's purse and pack. The server decides what
 * is taken (never more than the stage needs or your cap allows); the page only shows the result.
 */
export function WorksScreen() {
  const { state, reload } = useProjectBoard();
  return (
    <div className="shop works">
      <ShopHeader building="warehouse" title="Town works">
        What the town builds together. Every hero may give gold and materials, a fair share a day,
        so no single hand finishes the work. When a work is done, it opens for everyone.
      </ShopHeader>
      {state.kind === 'loading' ? (
        <p className="works__wait">Reading the works ledger…</p>
      ) : state.kind === 'error' ? (
        <div className="shop__notice shop__notice--error" role="alert">
          <p>
            The works ledger cannot be read right now ({describeContributionFailure(state.error)}).
          </p>
          <button type="button" className="btn btn--small" onClick={reload}>
            Try again
          </button>
        </div>
      ) : (
        <>
          {state.stale ? (
            <p className="works__stale" role="status">
              Showing the ledger as it was a moment ago; the town is not answering.
            </p>
          ) : null}
          {state.board.projects.map((p) => (
            <ProjectPanel key={p.id} project={p} board={state.board} reload={reload} />
          ))}
        </>
      )}
    </div>
  );
}

function resourceName(r: ProjectResource): string {
  return r === 'gold' ? 'Gold' : materialView(r).name;
}

function ResourceIcon({ resource, amount }: { resource: ProjectResource; amount: number }) {
  if (resource === 'gold') return <Gold amount={amount} />;
  return <MaterialStack material={materialView(resource)} quantity={amount} scale={1} />;
}

function opensText(flag: string): string {
  return isWorldFlagId(flag) ? getWorldFlag(flag).opens : 'Something new';
}

function untilReset(resetsAt: string): string {
  const ms = Math.max(0, Date.parse(resetsAt) - Date.now());
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

function ProjectPanel({
  project,
  board,
  reload,
}: {
  project: ProjectView;
  board: ProjectBoard;
  reload: () => void;
}) {
  const reward = findAchievement(project.reward.achievementId);
  const pct = Math.round(projectProgress(project) * 100);
  const required = project.requires ? findCommunityProject(project.requires) : undefined;
  const current = project.status === 'open' ? project.stages[project.stageIndex] : undefined;
  const eyebrow =
    project.status === 'complete'
      ? `Finished on ${project.completedOn}`
      : project.status === 'locked'
        ? 'Not begun'
        : `Under way · stage ${project.stageIndex + 1} of ${project.stages.length}`;
  return (
    <section
      className={`works__project panel-ledger works__project--${project.status}`}
      aria-labelledby={`works-${project.id}`}
    >
      <header className="works__project-head">
        <p className="caps works__eyebrow">{eyebrow}</p>
        <h2 className="display works__name" id={`works-${project.id}`}>
          {project.name}
        </h2>
        <p className="works__text">{project.description}</p>
      </header>

      <ol className="works__stages" aria-label="Stages">
        {project.stages.map((s, i) => (
          <li key={s.id} className={`works__stage works__stage--${s.status}`}>
            <span className="works__stage-mark" aria-hidden="true">
              {s.status === 'done' ? '✓' : i + 1}
            </span>
            <span className="works__stage-name">
              {s.name}
              <span className="visually-hidden">
                {s.status === 'done' ? ' (done)' : s.status === 'current' ? ' (under way)' : ''}
              </span>
            </span>
          </li>
        ))}
      </ol>

      <LabeledMeter
        className="works__meter"
        variant="xp"
        label="The whole work"
        value={`${pct} %`}
        current={pct}
        max={100}
      />

      {project.status === 'locked' ? (
        <p className="works__locked">
          Begins when the town has finished {required ? `“${required.name}”` : 'the work before it'}
          .
        </p>
      ) : null}

      {project.status === 'complete' ? (
        <p className="works__done">
          Done, by {formatNumber(project.contributors)}{' '}
          {project.contributors === 1 ? 'player' : 'players'}. {opensText(project.grantsFlag)}{' '}
          stands open to every hero.
        </p>
      ) : null}

      {current ? (
        <CurrentStage project={project} stage={current} board={board} reload={reload} />
      ) : null}

      <dl className="works__facts">
        <div>
          <dt className="caps">Opens for everyone</dt>
          <dd>{opensText(project.grantsFlag)}</dd>
        </div>
        <div>
          <dt className="caps">Your mark</dt>
          <dd>
            {reward ? (
              <>
                The achievement “{reward.name}” for every player who gave{' '}
                {project.reward.earned ? <strong>(yours)</strong> : null}
              </>
            ) : (
              '—'
            )}
          </dd>
        </div>
        <div>
          <dt className="caps">You gave</dt>
          <dd>
            {project.yours.length === 0 ? (
              'Nothing yet.'
            ) : (
              <span className="works__yours">
                {project.yours.map((y) => (
                  <ResourceIcon key={y.resource} resource={y.resource} amount={y.amount} />
                ))}
              </span>
            )}
          </dd>
        </div>
        {project.status === 'open' ? (
          <div>
            <dt className="caps">Hands so far</dt>
            <dd>
              {formatNumber(project.contributors)}{' '}
              {project.contributors === 1 ? 'player' : 'players'}
            </dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}

type Notice = { kind: 'ok' | 'error'; text: string } | null;

function CurrentStage({
  project,
  stage,
  board,
  reload,
}: {
  project: ProjectView;
  stage: ProjectView['stages'][number];
  board: ProjectBoard;
  reload: () => void;
}) {
  const hero = useActiveCharacter();
  const { updateCharacter } = useCharacters();
  const { materials, refreshMaterials } = useGame();
  const held = (r: ProjectResource): number | null => {
    if (r === 'gold') return hero.gold;
    if (materials.kind !== 'ready') return null;
    return materials.value.materials.find((m) => m.materialId === (r as MaterialId))?.quantity ?? 0;
  };
  const suggested = (n: NeedView) => maxGift(n, held(n.resource) ?? 0);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  // One key per intended gift: a retry after a network failure replays instead of paying twice.
  const key = useRef<string | null>(null);
  const stageKey = `${stage.id}:${board.window.day}`;
  const lastStage = useRef(stageKey);
  useEffect(() => {
    if (lastStage.current !== stageKey) {
      lastStage.current = stageKey;
      setAmounts({});
      key.current = null;
    }
  }, [stageKey]);

  const valueOf = (n: NeedView) => amounts[n.resource] ?? String(suggested(n));
  const capFull = stage.needs.every((n) => n.givenToday >= n.cap || n.delivered >= n.required);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const offer = stage.needs
      .map((n) => ({ resource: n.resource, amount: Math.floor(Number(valueOf(n))) }))
      .filter((o) => Number.isFinite(o.amount) && o.amount > 0);
    if (offer.length === 0) {
      setNotice({ kind: 'error', text: 'Choose how much to give first.' });
      return;
    }
    key.current ??= crypto.randomUUID();
    setBusy(true);
    setNotice(null);
    const res = await communityApi.contribute(
      project.id,
      { characterId: hero.id, stageId: stage.id, offer },
      key.current,
    );
    setBusy(false);
    if (!res.ok) {
      if (res.error.code !== 'network') key.current = null;
      setNotice({ kind: 'error', text: describeContributionFailure(res.error) });
      if (res.error.code !== 'network') reload();
      return;
    }
    key.current = null;
    setAmounts({});
    updateCharacter(res.value.character);
    refreshMaterials();
    reload();
    const given = res.value.accepted
      .map((a) => `${formatNumber(a.amount)} ${resourceName(a.resource).toLowerCase()}`)
      .join(', ');
    const cut = Object.values(res.value.limited).includes('cap')
      ? ' The rest stays with your hero: that is your share for today.'
      : Object.keys(res.value.limited).length > 0
        ? ' The stage needed no more than that; the rest stays with your hero.'
        : '';
    const done = res.value.projectCompleted
      ? ` ${project.name} is finished!`
      : res.value.stagesCompleted.length > 0
        ? ' That finished the stage — the workers move on.'
        : '';
    setNotice({ kind: 'ok', text: `Given: ${given}.${cut}${done}` });
  };

  return (
    <form className="works__current" onSubmit={(e) => void submit(e)}>
      <h3 className="works__current-title">
        <span className="caps">Now</span> {stage.name}
      </h3>
      <p className="works__text">{stage.description}</p>
      <ul className="works__needs">
        {stage.needs.map((n) => {
          const have = held(n.resource);
          const id = `give-${project.id}-${n.resource}`;
          return (
            <li key={n.resource} className="works__need">
              <span className="works__need-icon">
                <ResourceIcon resource={n.resource} amount={n.required} />
              </span>
              <LabeledMeter
                className="works__need-meter"
                variant="xp"
                label={resourceName(n.resource)}
                value={`${formatNumber(n.delivered)} / ${formatNumber(n.required)}`}
                current={n.delivered}
                max={n.required}
              />
              <p className="works__share">
                Your share today: {formatNumber(n.givenToday)} / {formatNumber(n.cap)}
                {have !== null ? (
                  <>
                    {' '}
                    · {hero.name} has {formatNumber(have)}
                  </>
                ) : null}
              </p>
              <label className="works__give" htmlFor={id}>
                <span className="visually-hidden">Give {resourceName(n.resource)}</span>
                <input
                  id={id}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={maxGift(n, have ?? 0)}
                  value={valueOf(n)}
                  disabled={busy || maxGift(n, have ?? 0) === 0}
                  onChange={(e) => setAmounts((a) => ({ ...a, [n.resource]: e.target.value }))}
                />
              </label>
            </li>
          );
        })}
      </ul>
      <div className="works__actions">
        <button type="submit" className="btn btn--brass" disabled={busy || capFull}>
          {busy ? 'Giving…' : `Give from ${hero.name}`}
        </button>
        <p className="works__reset">
          {capFull
            ? `Your share for this stage is given. It renews in ${untilReset(board.window.resetsAt)} (midnight UTC).`
            : `Shares renew at midnight UTC, in ${untilReset(board.window.resetsAt)}.`}
        </p>
      </div>
      {notice ? (
        <p
          className={`shop__notice${notice.kind === 'error' ? ' shop__notice--error' : ''}`}
          role={notice.kind === 'error' ? 'alert' : 'status'}
        >
          {notice.text}
        </p>
      ) : null}
    </form>
  );
}
