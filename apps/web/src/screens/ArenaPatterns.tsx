import { profileHref } from '../lib/route';
import { describeSocialFailure } from '../social/api';
import { loadArenaPatterns, useLoad, type PatternFlag, type PatternPair } from '../social/arena';
import { signed } from '../social/ladder';

/**
 * Ticket 5.6: the arena pattern report on the moderators' docket (docs/PVP.md "Pattern report").
 * Pairs of players who met often in rated duels over the last two weeks, how lopsided and how
 * one-sided their bouts were, how much rating changed hands, and whether both accounts came from
 * the same invite. Read-only: a moderator acts through a report and the case file.
 */

const FLAG: Record<PatternFlag, { label: string; hint: string }> = {
  repeated: { label: 'Repeated', hint: 'Met many times in rated duels.' },
  lopsided: { label: 'Lopsided', hint: 'One side won almost every bout.' },
  oneWay: { label: 'One way', hint: 'Always the same player challenging.' },
};

const dayLabel = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });

export function ArenaPatterns() {
  const report = useLoad(loadArenaPatterns);
  const days = report.state.kind === 'ready' ? report.state.value.windowDays : 14;
  return (
    <section className="patterns panel-ledger" aria-labelledby="patterns-title">
      <header className="patterns__head">
        <div>
          <p className="caps">Wardens · The arena</p>
          <h2 id="patterns-title" className="display">
            Arena patterns
          </h2>
        </div>
        <button
          type="button"
          className="btn btn--small"
          onClick={report.reload}
          disabled={report.state.kind === 'loading'}
        >
          Refresh
        </button>
      </header>
      <p className="patterns__lede">
        Pairs of players who fought each other often in rated duels in the last {days} days. Their
        later bouts already count for less; look for trading wins between friends or second
        accounts. To act, open a report on the player.
      </p>
      {report.state.kind === 'loading' ? (
        <p className="patterns__wait" role="status">
          Reading the duel books…
        </p>
      ) : report.state.kind === 'error' ? (
        <div className="gate__alert" role="alert">
          <p>The pattern report could not be read. {describeSocialFailure(report.state.error)}</p>
          <button type="button" className="btn btn--small" onClick={report.reload}>
            Try again
          </button>
        </div>
      ) : report.state.value.pairs.length === 0 ? (
        <p className="patterns__empty">
          No pair met {report.state.value.rules.minDuels} or more times. The arena is quiet.
        </p>
      ) : (
        <ul className="patterns__list">
          {report.state.value.pairs.map((p) => (
            <PairRow key={`${p.a.handle}-${p.b.handle}`} p={p} />
          ))}
        </ul>
      )}
    </section>
  );
}

function Who({ who }: { who: PatternPair['a'] }) {
  return (
    <a className="patterns__name" href={profileHref(who.handle)}>
      {who.displayName}
      {who.role !== 'player' ? <span className="caps patterns__role"> {who.role}</span> : null}
    </a>
  );
}

function PairRow({ p }: { p: PatternPair }) {
  const flagged = p.flags.length > 0;
  return (
    <li className={`patterns__pair${flagged ? ' patterns__pair--flagged' : ''}`}>
      <p className="patterns__who">
        <Who who={p.a} /> <span className="patterns__vs">and</span> <Who who={p.b} />
      </p>
      <p className="patterns__flags">
        {p.flags.map((f) => (
          <span key={f} className={`caps patterns__flag patterns__flag--${f}`} title={FLAG[f].hint}>
            {FLAG[f].label}
          </span>
        ))}
        {p.sameInvite ? (
          <span
            className="caps patterns__flag patterns__flag--invite"
            title="Both accounts were created with the same invite."
          >
            Same invite
          </span>
        ) : null}
      </p>
      <dl className="patterns__facts">
        <div>
          <dt>Rated duels</dt>
          <dd>
            {p.duels}
            {p.uncounted > 0 ? ` (${p.uncounted} counted for nothing)` : ''}
          </dd>
        </div>
        <div>
          <dt>Won</dt>
          <dd>
            {p.a.displayName} {p.winsA} · {p.b.displayName} {p.winsB}
            {p.draws > 0 ? ` · ${p.draws} drawn` : ''}
          </dd>
        </div>
        <div>
          <dt>Challenged by</dt>
          <dd>
            {p.a.displayName} {p.challengesA} · {p.b.displayName} {p.duels - p.challengesA}
          </dd>
        </div>
        <div>
          <dt>Rating gained</dt>
          <dd>
            {p.a.displayName} {signed(p.ratingA)} · {p.b.displayName} {signed(p.ratingB)}
          </dd>
        </div>
        <div>
          <dt>Between</dt>
          <dd>
            {dayLabel(p.firstOn)} – {dayLabel(p.lastOn)}
          </dd>
        </div>
      </dl>
    </li>
  );
}
