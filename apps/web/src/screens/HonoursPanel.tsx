import { useEffect, useId, useState, type FormEvent } from 'react';
import {
  BOARD_METRICS,
  SEASON_TITLES,
  findPrestigeTier,
  prestigeTitle,
  seasonName,
  type ScoreMetric,
} from '@worldforge/game-core';
import { describeSocialFailure } from '../social/api';
import { FramedPlate, TitleBadge } from '../social/Prestige';
import { prestigeSprite } from '../content/assets';
import {
  seasonsApi,
  type EarnedAward,
  type PrestigeChoice,
  type PrestigeSettings,
} from '../social/seasons';
import type { ApiFailure } from '../lib/api';
import { boardHref } from '../lib/route';

/**
 * Ticket 5.3: the owner's season honours on their profile. Every award earned (season, roll,
 * place, the hero who earned it), and which title and which frame to show beside the name on the
 * boards, the profile and guild rosters. Honours are cosmetic; showing none is a choice too.
 */

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; settings: PrestigeSettings }
  | { kind: 'error'; error: ApiFailure };

const BOARD_NAME = new Map(BOARD_METRICS.map((m) => [m.id, m.name]));
const keyOf = (c: { season: number; metric: ScoreMetric } | null) =>
  c ? `${c.season}:${c.metric}` : '';
function choiceOf(key: string): PrestigeChoice {
  if (!key) return null;
  const [season, metric] = key.split(':');
  return { season: Number(season), metric: metric as ScoreMetric };
}

function awardLabel(a: EarnedAward): string {
  return `${prestigeTitle(a.metric, a.tier)} · ${seasonName(a.season)}`;
}

export function HonoursPanel({ onSaved }: { onSaved: () => void }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [title, setTitle] = useState('');
  const [frame, setFrame] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const ids = useId();

  const apply = (s: PrestigeSettings) => {
    setLoad({ kind: 'ready', settings: s });
    setTitle(keyOf(s.shown.title));
    setFrame(keyOf(s.shown.frame));
  };

  useEffect(() => {
    const controller = new AbortController();
    seasonsApi.prestige(controller.signal).then(
      (res) => (res.ok ? apply(res.value) : setLoad({ kind: 'error', error: res.error })),
      () => undefined,
    );
    return () => controller.abort();
  }, [attempt]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const res = await seasonsApi.savePrestige({ title: choiceOf(title), frame: choiceOf(frame) });
    setBusy(false);
    if (!res.ok) {
      setMessage({ ok: false, text: describeSocialFailure(res.error) });
      return;
    }
    apply(res.value);
    setMessage({ ok: true, text: 'Your honours are hung.' });
    onSaved();
  };

  const earned = load.kind === 'ready' ? load.settings.earned : [];
  const find = (key: string) => earned.find((a) => keyOf(a) === key) ?? null;
  const previewTitle = find(title);
  const previewFrame = find(frame);

  return (
    <section className="honours panel-iron" aria-labelledby={`${ids}-title`}>
      <h2 id={`${ids}-title`} className="rule-heading">
        Season honours
      </h2>
      {load.kind === 'loading' ? (
        <p className="herald__wait" role="status">
          The clerk looks for your name in the sealed rolls…
        </p>
      ) : null}
      {load.kind === 'error' ? (
        <div className="gate__alert" role="alert">
          <p>{describeSocialFailure(load.error)}</p>
          <button type="button" className="btn btn--small" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      ) : null}
      {load.kind === 'ready' && earned.length === 0 ? (
        <div className="honours__none">
          <p>No honours yet.</p>
          <p className="herald__hint">
            When a season ends, every hero on its rolls is honoured by place: Champion, Exalted (top
            10), Renowned (top 100) and Veteran (level 10 or more). See the{' '}
            <a href={boardHref('level', { season: 'current' })}>season rolls</a>.
          </p>
        </div>
      ) : null}
      {load.kind === 'ready' && earned.length > 0 ? (
        <form className="herald__form" onSubmit={submit} noValidate>
          <div className="honours__preview" aria-label="Preview">
            {previewFrame ? (
              <FramedPlate frame={previewFrame} scale={1}>
                <FrameCharge award={previewFrame} />
              </FramedPlate>
            ) : (
              <span className="herald__hint">No frame</span>
            )}
            {previewTitle ? (
              <TitleBadge badge={previewTitle} />
            ) : (
              <span className="herald__hint">No title</span>
            )}
          </div>
          <div className="field">
            <label className="field__label caps" htmlFor={`${ids}-t`}>
              Title
            </label>
            <div className="field__well">
              <select
                id={`${ids}-t`}
                className="field__input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              >
                <option value="">No title</option>
                {earned.map((a) => (
                  <option key={keyOf(a)} value={keyOf(a)}>
                    {awardLabel(a)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <label className="field__label caps" htmlFor={`${ids}-f`}>
              Frame
            </label>
            <div className="field__well">
              <select
                id={`${ids}-f`}
                className="field__input"
                value={frame}
                onChange={(e) => setFrame(e.target.value)}
              >
                <option value="">No frame</option>
                {earned.map((a) => (
                  <option key={keyOf(a)} value={keyOf(a)}>
                    {findPrestigeTier(a.tier)!.name} frame · {seasonName(a.season)},{' '}
                    {BOARD_NAME.get(a.metric)}
                  </option>
                ))}
              </select>
            </div>
            <p className="field__hint">
              Shown beside your name on the rolls, your profile and your guild&rsquo;s roster.
            </p>
          </div>
          <ul className="honours__list">
            {earned.map((a) => (
              <li key={keyOf(a)}>
                <TitleBadge badge={a} />
                <span className="herald__hint">
                  Place {a.rank} on {BOARD_NAME.get(a.metric)}
                  {a.heroName ? ` with ${a.heroName}` : ''}
                </span>
              </li>
            ))}
          </ul>
          {message ? (
            <p
              className={message.ok ? 'herald__saved' : 'gate__alert'}
              role={message.ok ? 'status' : 'alert'}
            >
              {message.text}
            </p>
          ) : null}
          <button type="submit" className="btn btn--brass" disabled={busy} aria-busy={busy}>
            {busy ? 'Hanging…' : 'Show these'}
          </button>
        </form>
      ) : null}
    </section>
  );
}

/** The 32 px charge inside a ×1 frame: the board's badge, else the tier's initial. */
function FrameCharge({ award }: { award: EarnedAward }) {
  const badge = prestigeSprite(SEASON_TITLES[award.metric].badgeAsset);
  if (badge) {
    return (
      <img className="pixel" src={badge.path} alt="" width={32} height={32} draggable={false} />
    );
  }
  return <span className="honours__charge display">{findPrestigeTier(award.tier)!.name[0]}</span>;
}
