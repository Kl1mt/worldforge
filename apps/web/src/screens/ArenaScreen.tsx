import { useEffect, useRef, useState } from 'react';
import { getClass, type ClassId } from '@worldforge/game-core';
import { useActiveCharacter } from '../characters/CharactersProvider';
import { PixelSprite } from '../components/PixelSprite';
import { useElementWidth } from '../components/useElementWidth';
import { arenaBackdrop } from '../content/assets';
import { ActionKeys } from '../game/economy';
import { formatNumber } from '../lib/format';
import { pixelScale } from '../lib/pixel';
import { arenaDuelFromHash, arenaFriendFromHash, arenaHref, profileHref } from '../lib/route';
import { ReportDialog } from '../social/ReportDialog';
import {
  arenaApi,
  describeArenaFailure,
  duelLogLines,
  loadDuelHistory,
  loadFriendly,
  useArena,
  useLoad,
  type ArenaHero,
  type ArenaPlayer,
  type ArenaState,
  type DuelSide,
  type DuelSideView,
  type DuelSummary,
  type DuelView,
  type FriendlyOpponent,
} from '../social/arena';
import './arena.css';

/**
 * The Proving Ring (ticket 5.5, docs/PVP.md "The arena"): the town's duel ground. The A.10 arena
 * backdrop heads the screen; below it the hero's defence (a saved copy others fight), the rated
 * slate (10 a day, from level 10, opponents named by the server), friendly challenges with
 * friends and guildmates, the last result with its blow-by-blow, and the duel book (history).
 * Everything is decided on the server; the client never computes a duel. A duel changes nothing
 * a player owns.
 */

const ARENA = arenaBackdrop();
type Notice = { kind: 'ok' | 'error'; text: string } | null;

const className = (id: ClassId) => getClass(id).name;
const dayLabel = (iso: string) =>
  new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
const timeLabel = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
const playerName = (p: ArenaPlayer | null, blocked = false) =>
  blocked ? 'A blocked player' : !p ? 'A former player' : (p.displayName ?? 'Name withheld');
const heroLine = (h: ArenaHero) =>
  `${h.name ?? `A ${className(h.classId).toLowerCase()}`} · level ${h.level} ${className(h.classId)}`;
const RESULT_WORD = { won: 'Victory', lost: 'Defeat', draw: 'Draw' } as const;

export function ArenaScreen() {
  const hero = useActiveCharacter();
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const linkedDuel = arenaDuelFromHash(hash);
  const linkedFriend = arenaFriendFromHash(hash);
  const { state, reload, show } = useArena(hero.id);
  const [duel, setDuel] = useState<DuelView | null>(null);
  const [duelError, setDuelError] = useState<string | null>(null);
  const history = useLoad(loadDuelHistory);

  // A duel opened from the book (or a link): load it once.
  useEffect(() => {
    if (!linkedDuel || duel?.id === linkedDuel) return;
    let live = true;
    void arenaApi.duel(linkedDuel).then((res) => {
      if (!live) return;
      if (res.ok) {
        setDuel(res.value.duel);
        setDuelError(null);
      } else setDuelError(describeArenaFailure(res.error));
    });
    return () => {
      live = false;
    };
  }, [linkedDuel, duel?.id]);

  const fought = (d: DuelView) => {
    setDuel(d);
    setDuelError(null);
    history.reload();
    reload();
    window.history.replaceState(null, '', arenaHref({ duel: d.id }));
    document.getElementById('arena-result')?.scrollIntoView?.({ block: 'start' });
  };

  return (
    <div className="arena">
      <ArenaHead state={state.kind === 'ready' ? state.value : null} />
      {state.kind === 'loading' ? (
        <p className="arena__quiet" aria-busy="true">
          Raking the sand of the ring…
        </p>
      ) : state.kind === 'error' ? (
        <p className="arena__strip arena__strip--crimson" role="alert">
          {describeArenaFailure(state.error)}{' '}
          <button type="button" className="btn btn--small" onClick={reload}>
            Try again
          </button>
        </p>
      ) : (
        <div className="arena__grid">
          <div className="arena__col">
            <DefencePlate view={state.value} show={show} />
            <RatedPlate view={state.value} show={show} onFought={fought} />
            <FriendlyPlate view={state.value} focus={linkedFriend} onFought={fought} />
          </div>
          <div className="arena__col">
            <section
              id="arena-result"
              className="arena-result"
              aria-labelledby="arena-result-title"
            >
              <h2 id="arena-result-title" className="rule-heading">
                The last bout
              </h2>
              {duel ? (
                <DuelResult duel={duel} />
              ) : duelError ? (
                <p className="arena__strip arena__strip--crimson" role="alert">
                  {duelError}
                </p>
              ) : (
                <p className="arena__quiet">
                  No bout open. Challenge someone, or open one from your duel book.
                </p>
              )}
            </section>
            <DuelBook history={history} openId={duel?.id ?? null} />
            <HowDuelsWork view={state.value} />
          </div>
        </div>
      )}
    </div>
  );
}

function ArenaHead({ state }: { state: ArenaState | null }) {
  const [ref, width] = useElementWidth<HTMLDivElement>(1152);
  const scale = pixelScale(width, ARENA.width, { min: 1, max: 3 });
  const stageWidth = Math.min(Math.floor(width), ARENA.width * scale);
  const left = Math.round((stageWidth - ARENA.width * scale) / 2);
  return (
    <header className="arena__head">
      <div className="arena__frame" ref={ref}>
        <div className="arena__scene" style={{ width: stageWidth || undefined }}>
          <div
            className="arena__stage"
            style={{ width: stageWidth || undefined, height: ARENA.height * scale }}
          >
            <PixelSprite
              sprite={ARENA}
              scale={scale}
              alt="The Proving Ring of Graumark: a sand circle under torches, ringed by stone benches."
              className="arena__art"
              style={{ left }}
            />
          </div>
          <div className="arena__plaque">
            <p className="caps arena__where">Graumark · The Proving Ring</p>
            <h1 className="display arena__title">The Arena</h1>
            {state ? (
              <p className="arena__sub">
                {state.hero.name}, level {state.hero.level} · {state.hero.bracket.label}
              </p>
            ) : null}
          </div>
        </div>
      </div>
      <p className="arena__lede">
        Duel saved copies of other heroes. Nobody needs to be online, the result is there at once,
        and a loss takes nothing from you.
      </p>
    </header>
  );
}

function DefencePlate({ view, show }: { view: ArenaState; show: (v: ArenaState) => void }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const d = view.defence;
  const save = async () => {
    setBusy(true);
    setNotice(null);
    const res = await arenaApi.setDefence(view.hero.characterId);
    setBusy(false);
    if (res.ok) {
      show(res.value);
      setNotice({ kind: 'ok', text: 'Your defence is saved: others now duel this copy.' });
    } else setNotice({ kind: 'error', text: describeArenaFailure(res.error) });
  };
  return (
    <section className="arena-defence panel-iron" aria-labelledby="arena-defence-title">
      <h2 id="arena-defence-title" className="rule-heading">
        Your defence
      </h2>
      {d ? (
        <div className="arena-defence__body">
          <p className="arena-defence__line">
            <span className="display arena-defence__name">{d.heroName}</span> · level {d.level}{' '}
            {className(d.classId)} · {d.items} {d.items === 1 ? 'item' : 'items'} worn
          </p>
          <p className="arena-defence__when">
            Set on {timeLabel(d.setAt)} UTC
            {d.outdated ? ' · your hero has grown since: refresh it to fight as you are now.' : '.'}
          </p>
          {d.rejected.length > 0 ? (
            <p className="arena__strip arena__strip--crimson">
              {d.rejected.length === 1 ? 'One item counts' : `${d.rejected.length} items count`} for
              nothing (it could not have come from the game).
            </p>
          ) : null}
        </div>
      ) : (
        <p className="arena__quiet">
          No defence yet. Save what {view.hero.name} wears now: others duel that copy, even when you
          change your gear later.
        </p>
      )}
      <button type="button" className="btn" disabled={busy} onClick={save}>
        {busy ? 'Saving…' : d ? 'Refresh my defence' : 'Save my defence'}
      </button>
      {notice ? (
        <p
          className={`arena__strip arena__strip--${notice.kind === 'ok' ? 'moss' : 'crimson'}`}
          role={notice.kind === 'ok' ? 'status' : 'alert'}
        >
          {notice.text}
        </p>
      ) : null}
    </section>
  );
}

function useChallenge(onFought: (d: DuelView) => void) {
  const keys = useRef(new ActionKeys());
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const challenge = async (characterId: string, defenceId: string, kind: 'rated' | 'friendly') => {
    const action = `${kind}:${characterId}:${defenceId}`;
    setBusy(defenceId);
    setNotice(null);
    const res = await arenaApi.challenge(characterId, defenceId, kind, keys.current.keyFor(action));
    keys.current.settle(action, res.ok ? null : res.error);
    setBusy(null);
    if (res.ok) onFought(res.value.duel);
    else setNotice({ kind: 'error', text: describeArenaFailure(res.error) });
    return res.ok;
  };
  return { busy, notice, challenge, setNotice };
}

function RatedPlate({
  view,
  show,
  onFought,
}: {
  view: ArenaState;
  show: (v: ArenaState) => void;
  onFought: (d: DuelView) => void;
}) {
  const { busy, notice, challenge, setNotice } = useChallenge(onFought);
  const [drawing, setDrawing] = useState(false);
  const offer = view.rated.offer;
  const draw = async () => {
    setDrawing(true);
    setNotice(null);
    const res = await arenaApi.drawOpponents(view.hero.characterId);
    setDrawing(false);
    if (res.ok) show(res.value);
    else setNotice({ kind: 'error', text: describeArenaFailure(res.error) });
  };
  // A first list is drawn as soon as the slate opens.
  const asked = useRef(false);
  useEffect(() => {
    if (view.hero.ratedOpen && !offer && !asked.current) {
      asked.current = true;
      void draw();
    }
  });
  const nowMs = Date.parse(view.now);
  const canRefresh =
    !offer || offer.opponents.length === 0 || Date.parse(offer.refreshableAt) <= nowMs;

  return (
    <section className="arena-rated panel-ledger" aria-labelledby="arena-rated-title">
      <h2 id="arena-rated-title" className="rule-heading">
        Rated duels
      </h2>
      {!view.hero.ratedOpen ? (
        <p className="arena__strip arena__strip--brass">
          Rated duels open at level {view.rules.minLevel}. {view.hero.name} is level{' '}
          {view.hero.level}: friendly challenges with friends and guildmates are open now.
        </p>
      ) : (
        <>
          <p
            className="arena-pips"
            aria-label={`${view.rated.left} of ${view.rules.ratedPerDay} rated duels left today`}
          >
            {Array.from({ length: view.rules.ratedPerDay }, (_, i) => (
              <span
                key={i}
                className={`arena-pips__pip${i < view.rated.used ? ' arena-pips__pip--spent' : ''}`}
                aria-hidden="true"
              />
            ))}
            <span className="arena-pips__text" aria-hidden="true">
              {view.rated.left} of {view.rules.ratedPerDay} left today · new ones at midnight UTC
            </span>
          </p>
          {drawing && !offer ? (
            <p className="arena__quiet" aria-busy="true">
              The herald reads out the names…
            </p>
          ) : offer && offer.opponents.length > 0 ? (
            <ul className="arena-slate">
              {offer.opponents.map((o) => (
                <li key={o.defenceId} className="arena-slate__row">
                  <span className="arena-slate__who">
                    <PlayerName player={o.player} />
                    <span className="arena-slate__hero">{heroLine(o.hero)}</span>
                  </span>
                  <span className="arena-slate__set">defence of {dayLabel(o.setOn)}</span>
                  <button
                    type="button"
                    className="btn btn--brass btn--small"
                    disabled={busy !== null || view.rated.left === 0}
                    onClick={() => challenge(view.hero.characterId, o.defenceId, 'rated')}
                  >
                    {busy === o.defenceId ? 'Fighting…' : 'Challenge'}
                  </button>
                </li>
              ))}
            </ul>
          ) : offer ? (
            <p className="arena__quiet">
              Nobody else in {view.hero.bracket.label} has saved a defence
              {offer.opponents.length === 0 ? ' that you have not fought yet' : ''}. Try again
              later.
            </p>
          ) : null}
          {view.rated.left === 0 ? (
            <p className="arena__strip arena__strip--brass">
              Today’s rated duels are fought. Friendly challenges stay open.
            </p>
          ) : null}
          <button
            type="button"
            className="btn btn--small"
            disabled={drawing || !canRefresh}
            onClick={draw}
          >
            {drawing ? 'Asking…' : 'New opponents'}
          </button>
          {!canRefresh && offer ? (
            <span className="arena__fine">
              {' '}
              A fresh list from {timeLabel(offer.refreshableAt)} UTC.
            </span>
          ) : null}
        </>
      )}
      {notice ? (
        <p className="arena__strip arena__strip--crimson" role="alert">
          {notice.text}
        </p>
      ) : null}
    </section>
  );
}

function PlayerName({ player }: { player: ArenaPlayer }) {
  const name = player.displayName ?? 'Name withheld';
  return player.profile ? (
    <a className="arena__name" href={profileHref(player.handle)}>
      {name}
    </a>
  ) : (
    <span className="arena__name">{name}</span>
  );
}

function FriendlyPlate({
  view,
  focus,
  onFought,
}: {
  view: ArenaState;
  focus: string | null;
  onFought: (d: DuelView) => void;
}) {
  const list = useLoad(loadFriendly);
  const { busy, notice, challenge } = useChallenge(onFought);
  const focused = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (focus && list.state.kind === 'ready')
      focused.current?.scrollIntoView?.({ block: 'center' });
  }, [focus, list.state.kind]);
  return (
    <section className="arena-friendly panel-iron" aria-labelledby="arena-friendly-title">
      <h2 id="arena-friendly-title" className="rule-heading">
        Friendly challenges
      </h2>
      <p className="arena__fine">
        With friends and guildmates, at any level and across brackets (both fight in the lower
        hero’s bracket). No rating, no rewards, no daily limit.
      </p>
      {list.state.kind === 'loading' ? (
        <p className="arena__quiet" aria-busy="true">
          Calling your companions…
        </p>
      ) : list.state.kind === 'error' ? (
        <p className="arena__strip arena__strip--crimson" role="alert">
          {describeArenaFailure(list.state.error)}{' '}
          <button type="button" className="btn btn--small" onClick={list.reload}>
            Try again
          </button>
        </p>
      ) : list.state.value.opponents.length === 0 ? (
        <p className="arena__quiet">
          No friends or guildmates yet. Add friends on the <a href="#/friends">Friends</a> page or
          join a guild in the <a href="#/guild">Guild Hall</a>.
        </p>
      ) : (
        <ul className="arena-friends">
          {list.state.value.opponents.map((o: FriendlyOpponent) => (
            <li
              key={o.player.handle}
              ref={o.player.handle === focus ? focused : undefined}
              className={`arena-friends__row${o.player.handle === focus ? ' arena-friends__row--focus' : ''}`}
            >
              <p className="arena-friends__who">
                <PlayerName player={o.player} />{' '}
                <span className="caps arena-friends__tag">
                  {o.relation === 'friend' ? 'Friend' : 'Guildmate'}
                </span>
              </p>
              {o.defences.length === 0 ? (
                <p className="arena__fine">No defence saved yet.</p>
              ) : (
                <ul className="arena-friends__heroes">
                  {o.defences.map((d) => (
                    <li key={d.defenceId}>
                      <span>{heroLine(d.hero)}</span>
                      <button
                        type="button"
                        className="btn btn--small"
                        disabled={busy !== null}
                        onClick={() => challenge(view.hero.characterId, d.defenceId, 'friendly')}
                      >
                        {busy === d.defenceId ? 'Fighting…' : 'Challenge'}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {notice ? (
        <p className="arena__strip arena__strip--crimson" role="alert">
          {notice.text}
        </p>
      ) : null}
    </section>
  );
}

function SideCard({ side, duel, label }: { side: DuelSideView; duel: DuelView; label: string }) {
  const pct =
    side.maxHealth > 0 ? Math.max(0, Math.round((100 * side.health) / side.maxHealth)) : 0;
  return (
    <div className="arena-side">
      <p className="caps arena-side__label">{label}</p>
      <p className="display arena-side__hero">{side.hero.name ?? className(side.hero.classId)}</p>
      <p className="arena-side__meta">
        level {side.hero.level} {className(side.hero.classId)}
        {side.player || side.blocked ? <> · {playerName(side.player, side.blocked)}</> : null}
      </p>
      <div
        className="meter arena-side__health"
        role="meter"
        aria-label={`${label}: health left`}
        aria-valuemin={0}
        aria-valuemax={side.maxHealth}
        aria-valuenow={side.health}
      >
        <span className="meter__fill" style={{ width: `${pct}%` }} />
      </div>
      <p className="arena-side__nums">
        {formatNumber(side.health)} / {formatNumber(side.maxHealth)} health · {side.attacks} blows,{' '}
        {side.crits} critical · {formatNumber(side.damageDealt)} dealt
      </p>
      {side.pveStats ? (
        <p className="arena-side__norm">
          Your {formatNumber(Math.round(side.pveStats.health))} health counted as{' '}
          {formatNumber(side.maxHealth)} in {duel.bracketLabel}.
        </p>
      ) : null}
    </div>
  );
}

function DuelResult({ duel }: { duel: DuelView }) {
  const [reporting, setReporting] = useState(false);
  const them: DuelSide = duel.you === 'challenger' ? 'defender' : 'challenger';
  const theirs = duel[them];
  const names: Record<DuelSide, string> = {
    [duel.you]: duel[duel.you].hero.name ?? 'Your hero',
    [them]: theirs.hero.name ?? `Their ${className(theirs.hero.classId).toLowerCase()}`,
  } as Record<DuelSide, string>;
  const lines = duelLogLines(duel, names);
  return (
    <div className={`arena-bout arena-bout--${duel.result}`}>
      <p className="caps arena-bout__where">
        {duel.kind === 'rated' ? 'Rated duel' : 'Friendly challenge'} · {duel.bracketLabel} ·{' '}
        {timeLabel(duel.foughtAt)} UTC
      </p>
      <p className="display arena-bout__verdict" role="status">
        {RESULT_WORD[duel.result]}
        <span className="arena-bout__why">
          {duel.reason === 'defeat'
            ? ` after ${(duel.durationMs / 1000).toFixed(1)} s`
            : ' at the time limit'}
        </span>
      </p>
      <div className="arena-bout__sides">
        <SideCard side={duel[duel.you]} duel={duel} label="You" />
        <SideCard
          side={theirs}
          duel={duel}
          label={duel.you === 'challenger' ? 'Their defence' : 'The challenger'}
        />
      </div>
      <p className="arena__fine">
        {duel.you === 'challenger'
          ? `You fought their defence as saved on ${dayLabel(duel.defenceSetOn)}.`
          : `They fought your defence as saved on ${dayLabel(duel.defenceSetOn)}.`}{' '}
        Nothing you own changed.
      </p>
      <ol className="arena-log" aria-label="Combat log">
        {lines.map((l, i) => (
          <li
            key={i}
            className={`arena-log__line arena-log__line--${l.tone}${l.crit ? ' arena-log__line--crit' : ''}`}
          >
            <span className="arena-log__t">{(l.t / 1000).toFixed(1)} s</span>
            <span>{l.text}</span>
          </li>
        ))}
      </ol>
      {theirs.player ? (
        <>
          <button
            type="button"
            className="btn btn--small arena-bout__report"
            onClick={() => setReporting(true)}
          >
            Report this player
          </button>
          <ReportDialog
            open={reporting}
            onClose={() => setReporting(false)}
            target={{
              target: { kind: 'player', handle: theirs.player.handle },
              label: playerName(theirs.player),
            }}
          />
        </>
      ) : null}
    </div>
  );
}

function DuelBook({
  history,
  openId,
}: {
  history: ReturnType<typeof useLoad<{ duels: DuelSummary[]; nextCursor: string | null }>>;
  openId: string | null;
}) {
  return (
    <section className="arena-book panel-ledger" aria-labelledby="arena-book-title">
      <h2 id="arena-book-title" className="rule-heading">
        Duel book
      </h2>
      {history.state.kind === 'loading' ? (
        <p className="arena__quiet" aria-busy="true">
          Opening the book…
        </p>
      ) : history.state.kind === 'error' ? (
        <p className="arena__strip arena__strip--crimson" role="alert">
          {describeArenaFailure(history.state.error)}{' '}
          <button type="button" className="btn btn--small" onClick={history.reload}>
            Try again
          </button>
        </p>
      ) : history.state.value.duels.length === 0 ? (
        <p className="arena__quiet">
          No duels yet. Bouts you fight, and bouts fought against your defence, are written here.
        </p>
      ) : (
        <ul className="arena-book__list">
          {history.state.value.duels.map((d) => (
            <li key={d.id}>
              <a
                className={`arena-book__row arena-book__row--${d.result}${d.id === openId ? ' arena-book__row--open' : ''}`}
                href={arenaHref({ duel: d.id })}
                aria-current={d.id === openId ? 'true' : undefined}
              >
                <span className={`caps arena-book__result`}>{RESULT_WORD[d.result]}</span>
                <span className="arena-book__who">
                  {d.you === 'challenger' ? 'You challenged' : 'Challenged by'}{' '}
                  {playerName(d.opponent.player, d.opponent.blocked)}
                  <span className="arena-book__hero">
                    {d.yourHero.name} vs {heroLine(d.opponent.hero)}
                  </span>
                </span>
                <span className="arena-book__when">
                  {d.kind === 'rated' ? 'Rated' : 'Friendly'} · {timeLabel(d.foughtAt)}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function HowDuelsWork({ view }: { view: ArenaState }) {
  return (
    <details className="arena-rules">
      <summary className="arena-rules__summary">How duels work</summary>
      <ul className="arena-rules__list">
        <li>
          You fight a <strong>saved copy</strong> of another hero, their defence. Both fight on
          their own, with the same attacks, class skill, crits, Legendary effects and set bonuses as
          against monsters. The result is there at once.
        </li>
        <li>
          <strong>Your defence</strong> is what your hero wore when you saved it. Changing your gear
          later changes nothing until you refresh it.
        </li>
        <li>
          <strong>Rated duels</strong> open at level {view.rules.minLevel}: {view.rules.ratedPerDay}{' '}
          a day (the day turns at midnight UTC), against opponents of your bracket that the arena
          names for you (levels 10–19, 20–29, 30 and above).
        </li>
        <li>
          <strong>
            Inside a bracket your level does not count, your gear does: a quarter of it.
          </strong>{' '}
          Everyone fights as a hero of the bracket’s middle level; what your gear adds above a
          standard kit counts for 25 %, and so do your Legendary effects and set bonuses.
        </li>
        <li>
          Armour and resistance count together. Every blow lands for between three quarters and one
          and a quarter of its damage, so a small edge makes you the favourite, not the winner.
        </li>
        <li>
          A duel lasts at most 60 seconds; after 30, sudden death makes every blow stronger. If time
          runs out, the larger share of health wins; an exact tie is a draw.
        </li>
        <li>
          Gold, item and experience find, boss damage and effects that act after a kill do nothing
          in a duel.
        </li>
        <li>
          <strong>Friendly challenges</strong> with friends and guildmates: any level, across
          brackets (both fight in the lower hero’s bracket), no rating, no rewards.
        </li>
        <li>
          <strong>A loss never takes anything from you:</strong> no gold, items, experience or
          score. Players you block, or who block you, never meet you here.
        </li>
      </ul>
    </details>
  );
}
