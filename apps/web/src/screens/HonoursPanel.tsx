import { useEffect, useId, useState, type FormEvent } from 'react';
import {
  BOARD_METRICS,
  SEASON_TITLES,
  findPrestigeTier,
  prestigeTitle,
  seasonName,
  type PrestigeMetric,
} from '@worldforge/game-core';
import { describeSocialFailure } from '../social/api';
import { CosmeticTitle, FramedPlate, TitleBadge } from '../social/Prestige';
import { eventsApi, type CosmeticUnlock } from '../events/api';
import { prestigeSprite } from '../content/assets';
import {
  seasonsApi,
  type EarnedAward,
  type PrestigeChoice,
  type PrestigeSettings,
} from '../social/seasons';
import type { ApiFailure } from '../lib/api';
import { boardHref, routeHref } from '../lib/route';

/**
 * Ticket 5.3: the owner's season honours on their profile. Every award earned (season, roll,
 * place, the hero who earned it), and which title and which frame to show beside the name on the
 * boards, the profile and guild rosters. Honours are cosmetic; showing none is a choice too.
 */

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; settings: PrestigeSettings; unlocks: CosmeticUnlock[] }
  | { kind: 'error'; error: ApiFailure };

/** Ticket 6.6: a cosmetic title's value in the title select (season awards are `season:metric`). */
const COSMETIC = 'cosmetic:';

const BOARD_NAME = new Map<PrestigeMetric, string>([
  ...BOARD_METRICS.map((m) => [m.id, m.name] as const),
  // Ticket 5.6: the season's rated duel ladder.
  ['arena', 'Arena Ladder'],
]);
const keyOf = (c: { season: number; metric: PrestigeMetric } | null) =>
  c ? `${c.season}:${c.metric}` : '';
function choiceOf(key: string): PrestigeChoice {
  if (!key) return null;
  const [season, metric] = key.split(':');
  return { season: Number(season), metric: metric as PrestigeMetric };
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

  const apply = (s: PrestigeSettings, unlocks: CosmeticUnlock[]) => {
    setLoad({ kind: 'ready', settings: s, unlocks });
    setTitle(s.shown.cosmeticTitle ? `${COSMETIC}${s.shown.cosmeticTitle}` : keyOf(s.shown.title));
    setFrame(keyOf(s.shown.frame));
  };

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      seasonsApi.prestige(controller.signal),
      eventsApi.cosmetics(controller.signal),
    ]).then(
      ([res, cos]) => {
        if (!res.ok) return setLoad({ kind: 'error', error: res.error });
        if (!cos.ok) return setLoad({ kind: 'error', error: cos.error });
        apply(res.value, cos.value.unlocks);
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [attempt]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const cosmetic = title.startsWith(COSMETIC) ? title.slice(COSMETIC.length) : null;
    const res = await seasonsApi.savePrestige({
      title: cosmetic ? null : choiceOf(title),
      frame: choiceOf(frame),
      cosmeticTitle: cosmetic,
    });
    setBusy(false);
    if (!res.ok) {
      setMessage({ ok: false, text: describeSocialFailure(res.error) });
      return;
    }
    apply(res.value, load.kind === 'ready' ? load.unlocks : []);
    setMessage({ ok: true, text: 'Your honours are hung.' });
    onSaved();
  };

  const earned = load.kind === 'ready' ? load.settings.earned : [];
  const unlocks = load.kind === 'ready' ? load.unlocks : [];
  const titles = unlocks.filter((u) => u.kind === 'title');
  const find = (key: string) => earned.find((a) => keyOf(a) === key) ?? null;
  const previewTitle = find(title);
  const previewCosmetic = title.startsWith(COSMETIC) ? title.slice(COSMETIC.length) : null;
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
      {load.kind === 'ready' && earned.length === 0 && titles.length === 0 ? (
        <div className="honours__none">
          <p>No honours yet.</p>
          <p className="herald__hint">
            When a season ends, every hero on its rolls is honoured by place: Champion (first),
            Exalted (top 2 %), Renowned (top 10 %) and Veteran (level 10 or more). See the{' '}
            <a href={boardHref('level', { season: 'current' })}>season rolls</a>.
          </p>
        </div>
      ) : null}
      {load.kind === 'ready' && (earned.length > 0 || titles.length > 0) ? (
        <form className="herald__form" onSubmit={submit} noValidate>
          <div className="honours__preview" aria-label="Preview">
            {previewFrame ? (
              <FramedPlate frame={previewFrame} scale={1}>
                <FrameCharge award={previewFrame} />
              </FramedPlate>
            ) : (
              <span className="herald__hint">No frame</span>
            )}
            {previewCosmetic ? (
              <CosmeticTitle id={previewCosmetic} />
            ) : previewTitle ? (
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
                {titles.map((u) => (
                  <option key={u.id} value={`${COSMETIC}${u.id}`}>
                    {u.name} · event title
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
          {unlocks.length > 0 ? (
            <div className="honours__keepsakes">
              <p className="caps">Event keepsakes</p>
              <ul className="honours__list">
                {unlocks.map((u) => (
                  <li key={u.id}>
                    <span className="display">{u.name}</span>
                    <span className="herald__hint">
                      {u.kind === 'title' ? (
                        'A title: choose it above.'
                      ) : (
                        <>
                          Worn from your <a href={routeHref('collection')}>collection book</a>.
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
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
