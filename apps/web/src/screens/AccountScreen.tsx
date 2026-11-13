import { useId, useState, type FormEvent } from 'react';
import { SANCTION_LABELS, validatePlayerText } from '@worldforge/game-core';
import { useAuth } from '../auth/AuthProvider';
import { routeHref } from '../lib/route';
import { describeSanction, describeSocialFailure, formatWhen, socialApi } from '../social/api';
import { ReportDialog } from '../social/ReportDialog';
import { useStanding } from '../social/useStanding';
import { AccountGrowthPanel } from './AccountGrowthPanel';
import { SecurityPanel } from './SecurityPanel';
import { TradingPanel } from './TradingPanel';
import './gate.css';
import '../social/social.css';

const ROLE_LABEL = { player: 'Player', moderator: 'Moderator', admin: 'Administrator' } as const;

/**
 * Account standing (ticket 4.1): "why can't I post?". The writ lists every active sanction with
 * its reason and expiry, holds the forced-rename form, and is where a player reports someone.
 */
export function AccountScreen() {
  const auth = useAuth();
  const account = auth.state.kind === 'authenticated' ? auth.state.account : null;
  const { state, reload } = useStanding();
  const [reporting, setReporting] = useState(false);

  return (
    <section className="writ" aria-labelledby="writ-title">
      <header className="writ__head">
        <p className="caps">Account</p>
        <h1 id="writ-title" className="display">
          Your standing
        </h1>
        {account ? (
          <p className="writ__who">
            {account.displayName} · <span className="writ__handle">@{account.handle}</span> ·{' '}
            {ROLE_LABEL[account.role]}
          </p>
        ) : null}
      </header>

      <div className="writ__body">
        <div className="acct-sec-col">
          <div className="writ__plate panel-iron">
            <h2 className="rule-heading">Sanctions</h2>
            {state.kind === 'loading' ? (
              <p className="writ__wait" role="status">
                Reading the ledger of the wardens…
              </p>
            ) : null}
            {state.kind === 'error' ? (
              <div className="gate__alert" role="alert">
                <p>{describeSocialFailure(state.error)}</p>
                <button type="button" className="btn btn--small" onClick={reload}>
                  Try again
                </button>
              </div>
            ) : null}
            {state.kind === 'ready' && state.standing.sanctions.length === 0 ? (
              <p className="writ__clear">
                <span className="writ__seal writ__seal--clear" aria-hidden="true" />
                In good standing. Nothing limits what you can do.
              </p>
            ) : null}
            {state.kind === 'ready' && state.standing.sanctions.length > 0 ? (
              <ul className="writ__list">
                {state.standing.sanctions.map((s) => (
                  <li key={s.id} className={`writ__entry writ__entry--${s.kind}`}>
                    <span className={`writ__seal writ__seal--${s.kind}`} aria-hidden="true" />
                    <div>
                      <p className="writ__kind display">{SANCTION_LABELS[s.kind]}</p>
                      <p>{describeSanction(s)}</p>
                      <p className="writ__reason">
                        <span className="caps">Reason</span> {s.reason}
                      </p>
                      <p className="writ__dates">
                        Since {formatWhen(s.createdAt)} · ends {formatWhen(s.expiresAt)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
            {state.kind === 'ready' && state.standing.renameRequired ? (
              <RenameForm
                onDone={() => {
                  reload();
                  void auth.refresh();
                }}
              />
            ) : null}
          </div>
          {/* Ticket 9.4: hero slots and offline hours, earned in play. */}
          <AccountGrowthPanel />
          {/* Ticket 5.7: email verification, email change, other devices. */}
          <SecurityPanel />
          {/* Ticket T.4: where you stand for trading (trading itself may still be closed). */}
          <TradingPanel />
        </div>

        <aside className="writ__side panel-ledger" aria-labelledby="writ-report">
          <h2 id="writ-report" className="rule-heading">
            Report a player
          </h2>
          <p>
            Someone harassing you, spamming, cheating or using a hateful name? Tell the wardens.
            Reports go to the moderators only; the player is not told who reported them.
          </p>
          <button type="button" className="btn btn--brass" onClick={() => setReporting(true)}>
            Report a player
          </button>
          <p className="writ__fine">
            <a href={routeHref('profile')}>Your public profile</a> ·{' '}
            <a href={routeHref('hub')}>Back to town</a>
          </p>
        </aside>
      </div>
      <ReportDialog open={reporting} onClose={() => setReporting(false)} />
    </section>
  );
}

function RenameForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const id = useId();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const check = validatePlayerText('displayName', name);
    if (!check.ok) {
      setError(check.message);
      return;
    }
    setBusy(true);
    setError(null);
    const res = await socialApi.rename(check.value);
    setBusy(false);
    if (!res.ok) {
      setError(res.error.fields.displayName ?? describeSocialFailure(res.error));
      return;
    }
    setDone(res.value.displayName);
    onDone();
  };

  if (done) {
    return (
      <p className="writ__done" role="status">
        You are now known as {done}.
      </p>
    );
  }
  return (
    <form className="writ__rename" onSubmit={submit} noValidate>
      <div className={`field${error ? ' field--invalid' : ''}`}>
        <label className="field__label caps" htmlFor={id}>
          New display name
        </label>
        <div className="field__well">
          <input
            id={id}
            className="field__input"
            value={name}
            maxLength={64}
            aria-invalid={Boolean(error)}
            aria-describedby={`${id}-msg`}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <p
          id={`${id}-msg`}
          className={error ? 'field__error' : 'field__hint'}
          role={error ? 'alert' : undefined}
        >
          {error ?? '3–20 letters or numbers; single spaces, hyphens and apostrophes inside.'}
        </p>
      </div>
      <button type="submit" className="btn btn--brass" disabled={busy} aria-busy={busy}>
        {busy ? 'Signing…' : 'Take this name'}
      </button>
    </form>
  );
}
