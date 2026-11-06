import { useId, useState, type FormEvent } from 'react';
import { PRESENCE_LABELS, validatePlayerText } from '@worldforge/game-core';
import type { ApiResult } from '../lib/api';
import { routeHref } from '../lib/route';
import { ReportDialog } from '../social/ReportDialog';
import {
  describeFriendFailure,
  friendsApi,
  useFriends,
  type FriendEntry,
  type FriendsView,
} from '../social/friends';
import './gate.css';
import './friends.css';

/**
 * Friends (ticket 4.3): the fellowship roll. The roll of companions on an iron plate, each with a
 * lantern for presence (a coarse bucket, never a time); beside it the ledger of letters — add a
 * companion by name, answer requests at the door, withdraw sent ones — and the presence setting.
 * Blocked players sit at the foot, struck through. Names link to the profile route when 4.2 adds
 * it; until then they show the handle.
 */
export function FriendsScreen() {
  const { state, reload } = useFriends();
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reporting, setReporting] = useState<FriendEntry | null>(null);

  /** Runs one action, then refreshes the lists and says what happened. */
  const run = async (key: string, action: () => Promise<ApiResult<unknown>>, done: string) => {
    setBusy(key);
    setNotice(null);
    const res = await action();
    setBusy(null);
    setNotice(
      res.ok
        ? { kind: 'ok', text: done }
        : { kind: 'error', text: describeFriendFailure(res.error) },
    );
    reload();
    return res.ok;
  };

  return (
    <section className="fellowship" aria-labelledby="fellowship-title">
      <header className="fellowship__head">
        <p className="caps">Companions</p>
        <h1 id="fellowship-title" className="display">
          Your fellowship
        </h1>
        {state.kind === 'ready' ? (
          <p className="fellowship__count">
            {state.view.friends.length} of {state.view.limits.friends} companions
            {state.stale ? ' · could not refresh, showing the last list' : ''}
          </p>
        ) : null}
      </header>

      {notice ? (
        <p
          className={`fellowship__notice fellowship__notice--${notice.kind}`}
          role={notice.kind === 'error' ? 'alert' : 'status'}
        >
          {notice.text}
        </p>
      ) : null}

      {state.kind === 'loading' ? (
        <p className="fellowship__wait" role="status">
          Unrolling the fellowship roll…
        </p>
      ) : null}
      {state.kind === 'error' ? (
        <div className="gate__alert" role="alert">
          <p>{describeFriendFailure(state.error)}</p>
          <button type="button" className="btn btn--small" onClick={reload}>
            Try again
          </button>
        </div>
      ) : null}

      {state.kind === 'ready' ? (
        <div className="fellowship__body">
          <Roll
            view={state.view}
            busy={busy}
            onRemove={(f) =>
              run(
                `remove:${f.handle}`,
                () => friendsApi.remove(f.handle),
                `${nameOf(f)} is no longer a companion.`,
              )
            }
            onBlock={(f) =>
              run(
                `block:${f.handle}`,
                () => friendsApi.block(f.handle),
                `You block ${nameOf(f)}. Neither of you sees the other.`,
              )
            }
            onReport={setReporting}
          />
          <aside className="fellowship__side">
            <AddFriend
              onSend={(name) =>
                run('add', () => friendsApi.requestByName(name), `Request sent to ${name}.`)
              }
              busy={busy === 'add'}
            />
            <Letters
              view={state.view}
              busy={busy}
              onAccept={(f) =>
                run(
                  `accept:${f.handle}`,
                  () => friendsApi.accept(f.handle),
                  `${nameOf(f)} joins your fellowship.`,
                )
              }
              onDecline={(f) =>
                run(`decline:${f.handle}`, () => friendsApi.decline(f.handle), 'Request declined.')
              }
              onBlock={(f) =>
                run(
                  `block:${f.handle}`,
                  () => friendsApi.block(f.handle),
                  `You block ${nameOf(f)}.`,
                )
              }
              onCancel={(f) =>
                run(`cancel:${f.handle}`, () => friendsApi.cancel(f.handle), 'Request withdrawn.')
              }
            />
            <PresenceSetting
              hidden={state.view.presenceHidden}
              busy={busy === 'presence'}
              onChange={(hidden) =>
                run(
                  'presence',
                  () => friendsApi.setPresenceHidden(hidden),
                  hidden
                    ? 'Your companions no longer see when you were last about.'
                    : 'Your companions see when you were last about again.',
                )
              }
            />
          </aside>
          <Blocked
            entries={state.view.blocked}
            busy={busy}
            onUnblock={(f) =>
              run(
                `unblock:${f.handle}`,
                () => friendsApi.unblock(f.handle),
                `You no longer block ${nameOf(f)}.`,
              )
            }
            onReport={setReporting}
          />
        </div>
      ) : null}

      <ReportDialog
        open={reporting !== null}
        onClose={() => setReporting(null)}
        {...(reporting
          ? {
              target: {
                target: { kind: 'player' as const, handle: reporting.handle },
                label: nameOf(reporting),
              },
            }
          : {})}
      />
    </section>
  );
}

function nameOf(f: FriendEntry): string {
  return f.displayName ?? 'A player whose name is hidden';
}

function Who({ entry }: { entry: FriendEntry }) {
  return (
    <span className="fellow__who">
      <span className={`fellow__name${entry.displayName ? '' : ' fellow__name--hidden'}`}>
        {entry.displayName ?? 'Name hidden by the wardens'}
      </span>
      <span className="fellow__handle">@{entry.handle}</span>
    </span>
  );
}

/** A destructive button that asks once more before acting. */
function ConfirmButton({
  label,
  confirm,
  busy,
  onConfirm,
}: {
  label: string;
  confirm: string;
  busy: boolean;
  onConfirm: () => void;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button
        type="button"
        className="btn btn--small"
        onClick={() => setAsking(true)}
        disabled={busy}
      >
        {label}
      </button>
    );
  }
  return (
    <span className="fellow__confirm">
      <button
        type="button"
        className="btn btn--small btn--danger"
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
        disabled={busy}
        aria-busy={busy}
      >
        {confirm}
      </button>
      <button type="button" className="btn btn--small" onClick={() => setAsking(false)}>
        Keep
      </button>
    </span>
  );
}

function Roll({
  view,
  busy,
  onRemove,
  onBlock,
  onReport,
}: {
  view: FriendsView;
  busy: string | null;
  onRemove: (f: FriendEntry) => void;
  onBlock: (f: FriendEntry) => void;
  onReport: (f: FriendEntry) => void;
}) {
  return (
    <div className="fellowship__roll panel-iron">
      <h2 className="rule-heading">The roll</h2>
      {view.friends.length === 0 ? (
        <p className="fellowship__empty">
          No companions yet. Send word to a player by their display name, and their name is written
          here once they answer.
        </p>
      ) : (
        <ul className="roll">
          {view.friends.map((f) => {
            const presence = f.presence ?? 'hidden';
            return (
              <li key={f.handle} className="roll__row">
                <span className={`lantern lantern--${presence}`} aria-hidden="true" />
                <Who entry={f} />
                <span className={`roll__presence roll__presence--${presence}`}>
                  {f.presence ? PRESENCE_LABELS[f.presence] : 'Keeps to the shadows'}
                </span>
                <span className="roll__actions">
                  <button type="button" className="btn btn--small" onClick={() => onReport(f)}>
                    Report
                  </button>
                  <ConfirmButton
                    label="Remove"
                    confirm="Remove?"
                    busy={busy === `remove:${f.handle}`}
                    onConfirm={() => onRemove(f)}
                  />
                  <ConfirmButton
                    label="Block"
                    confirm="Block?"
                    busy={busy === `block:${f.handle}`}
                    onConfirm={() => onBlock(f)}
                  />
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function AddFriend({
  onSend,
  busy,
}: {
  onSend: (name: string) => Promise<boolean>;
  busy: boolean;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const check = validatePlayerText('displayName', name);
    if (!check.ok) {
      setError(check.problem === 'too_short' ? 'Enter a display name.' : check.message);
      return;
    }
    setError(null);
    if (await onSend(check.value)) setName('');
  };
  return (
    <form className="letters panel-ledger" onSubmit={submit} noValidate>
      <h2 className="rule-heading">Send word</h2>
      <div className={`field${error ? ' field--invalid' : ''}`}>
        <label className="field__label caps" htmlFor={id}>
          Display name
        </label>
        <div className="field__well">
          <input
            id={id}
            className="field__input"
            value={name}
            maxLength={64}
            autoComplete="off"
            aria-invalid={Boolean(error)}
            aria-describedby={`${id}-msg`}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <p id={`${id}-msg`} className={error ? 'field__error' : 'field__hint'}>
          {error ?? 'They see your request and may accept or decline it.'}
        </p>
      </div>
      <button type="submit" className="btn btn--brass" disabled={busy} aria-busy={busy}>
        {busy ? 'Sending…' : 'Send a request'}
      </button>
    </form>
  );
}

function Letters({
  view,
  busy,
  onAccept,
  onDecline,
  onBlock,
  onCancel,
}: {
  view: FriendsView;
  busy: string | null;
  onAccept: (f: FriendEntry) => void;
  onDecline: (f: FriendEntry) => void;
  onBlock: (f: FriendEntry) => void;
  onCancel: (f: FriendEntry) => void;
}) {
  return (
    <div className="letters panel-ledger">
      <h2 className="rule-heading">
        At your door
        {view.incoming.length ? <span className="new-tag">{view.incoming.length}</span> : null}
      </h2>
      {view.incoming.length === 0 ? (
        <p className="fellowship__empty">No one is waiting for an answer.</p>
      ) : (
        <ul className="letters__list">
          {view.incoming.map((f) => (
            <li key={f.handle} className="letters__row">
              <Who entry={f} />
              <span className="letters__actions">
                <button
                  type="button"
                  className="btn btn--small btn--brass"
                  onClick={() => onAccept(f)}
                  disabled={busy === `accept:${f.handle}`}
                >
                  Accept
                </button>
                <button
                  type="button"
                  className="btn btn--small"
                  onClick={() => onDecline(f)}
                  disabled={busy === `decline:${f.handle}`}
                >
                  Decline
                </button>
                <ConfirmButton
                  label="Block"
                  confirm="Block?"
                  busy={busy === `block:${f.handle}`}
                  onConfirm={() => onBlock(f)}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
      {view.outgoing.length > 0 ? (
        <>
          <h3 className="caps letters__sub">
            Sent, awaiting an answer ({view.outgoing.length} of {view.limits.outgoingRequests})
          </h3>
          <ul className="letters__list">
            {view.outgoing.map((f) => (
              <li key={f.handle} className="letters__row">
                <Who entry={f} />
                <button
                  type="button"
                  className="btn btn--small"
                  onClick={() => onCancel(f)}
                  disabled={busy === `cancel:${f.handle}`}
                >
                  Withdraw
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function PresenceSetting({
  hidden,
  busy,
  onChange,
}: {
  hidden: boolean;
  busy: boolean;
  onChange: (hidden: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="letters panel-ledger">
      <h2 className="rule-heading">Your lantern</h2>
      <label className="presence-toggle" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={!hidden}
          disabled={busy}
          onChange={(e) => onChange(!e.target.checked)}
        />
        <span>Let my companions see when I was last about</span>
      </label>
      <p className="fellowship__fine">
        They see only “online now”, “today”, “this week” or “a while”, never a time. Other players
        never see it.
      </p>
    </div>
  );
}

function Blocked({
  entries,
  busy,
  onUnblock,
  onReport,
}: {
  entries: FriendEntry[];
  busy: string | null;
  onUnblock: (f: FriendEntry) => void;
  onReport: (f: FriendEntry) => void;
}) {
  return (
    <details className="fellowship__blocked" open={entries.length > 0 && entries.length <= 5}>
      <summary className="caps">Blocked players ({entries.length})</summary>
      {entries.length === 0 ? (
        <p className="fellowship__empty">
          You block no one. Blocking hides you from each other and ends any friendship or request.
        </p>
      ) : (
        <ul className="letters__list">
          {entries.map((f) => (
            <li key={f.handle} className="letters__row letters__row--struck">
              <Who entry={f} />
              <span className="letters__actions">
                <button type="button" className="btn btn--small" onClick={() => onReport(f)}>
                  Report
                </button>
                <button
                  type="button"
                  className="btn btn--small"
                  onClick={() => onUnblock(f)}
                  disabled={busy === `unblock:${f.handle}`}
                >
                  Unblock
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="fellowship__fine">
        <a href={routeHref('account')}>Account &amp; safety</a>
      </p>
    </details>
  );
}
