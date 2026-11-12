import { useCallback, useEffect, useMemo, useState } from 'react';
import { describeGameFailure } from '../game/api';
import { routeHref } from '../lib/route';
import { inboxApi, type InboxEntry } from './api';
import { inboxText } from './text';
import { announceInboxChange } from './useInbox';
import './inbox.css';

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; entries: InboxEntry[]; unread: number };

const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

/** Entries grouped by their local day, newest first (the server's order is kept inside). */
export function groupByDay(
  entries: readonly InboxEntry[],
): { day: string; entries: InboxEntry[] }[] {
  const out: { day: string; entries: InboxEntry[] }[] = [];
  for (const e of entries) {
    const day = dayFormat.format(new Date(e.createdAt));
    const last = out.at(-1);
    if (last && last.day === day) last.entries.push(e);
    else out.push({ day, entries: [e] });
  }
  return out;
}

/**
 * The courier's satchel (ticket 8.5, docs/NOTIFICATIONS.md): drops worth seeing, trades, duels
 * against your defence, event milestones, honours, the town's works and eras, and new versions,
 * for this account only. Read and unread are kept on the server.
 */
export function InboxScreen() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    inboxApi.list(200, controller.signal).then(
      (res) => {
        if (res.ok) setState({ kind: 'ready', ...res.value });
        else setState({ kind: 'error', message: describeGameFailure(res.error) });
      },
      () => {
        /* aborted */
      },
    );
    return () => controller.abort();
  }, [attempt]);

  const markRead = useCallback(async (which: { ids: string[] } | { all: true }) => {
    setBusy(true);
    setFailure(null);
    const res = await inboxApi.read(which);
    setBusy(false);
    if (!res.ok) {
      setFailure(describeGameFailure(res.error));
      return;
    }
    setState((s) =>
      s.kind !== 'ready'
        ? s
        : {
            kind: 'ready',
            unread: res.value.unread,
            entries: s.entries.map((e) =>
              'all' in which || which.ids.includes(e.id) ? { ...e, read: true } : e,
            ),
          },
    );
    announceInboxChange();
  }, []);

  const shown = useMemo(
    () => (state.kind === 'ready' ? state.entries.filter((e) => !onlyUnread || !e.read) : []),
    [state, onlyUnread],
  );

  let body;
  if (state.kind === 'loading') {
    body = (
      <div className="inbox__empty" role="status">
        <p className="display">Opening the satchel…</p>
      </div>
    );
  } else if (state.kind === 'error') {
    body = (
      <div className="inbox__empty" role="alert">
        <p className="display">The courier did not come.</p>
        <p>{state.message}</p>
        <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </button>
      </div>
    );
  } else if (state.entries.length === 0) {
    body = (
      <div className="inbox__empty">
        <p className="display">No letters yet.</p>
        <p>
          Great finds, trades, duels against your defence, event rewards, honours and the town’s
          news arrive here.
        </p>
        <a className="btn" href={routeHref('area')}>
          Back to the fields
        </a>
      </div>
    );
  } else if (shown.length === 0) {
    body = (
      <div className="inbox__empty">
        <p className="display">All read.</p>
        <p>Nothing new since you last looked.</p>
        <button type="button" className="btn" onClick={() => setOnlyUnread(false)}>
          Show every letter
        </button>
      </div>
    );
  } else {
    body = groupByDay(shown).map((group) => (
      <section key={group.day} className="inbox__day" aria-label={group.day}>
        <h2 className="caps inbox__day-title">{group.day}</h2>
        <ul className="inbox__list">
          {group.entries.map((e) => {
            const t = inboxText(e);
            return (
              <li
                key={e.id}
                className={`inbox__slip inbox__slip--${e.kind.replace('.', '-')}${
                  e.read ? '' : ' inbox__slip--unread'
                }`}
              >
                <span className="inbox__sigil" aria-hidden="true">
                  {t.sigil}
                </span>
                <div className="inbox__words">
                  <p className="inbox__title">
                    {e.read ? null : (
                      <span className="new-tag inbox__new">
                        New<span className="visually-hidden">:</span>
                      </span>
                    )}
                    {t.title}
                  </p>
                  <p className="inbox__text">{t.text}</p>
                </div>
                <div className="inbox__side">
                  <time className="inbox__time" dateTime={e.createdAt}>
                    {timeFormat.format(new Date(e.createdAt))}
                  </time>
                  <a
                    className="btn btn--small"
                    href={t.href}
                    onClick={() => {
                      if (!e.read) void markRead({ ids: [e.id] });
                    }}
                  >
                    {t.linkLabel}
                  </a>
                  {e.read ? null : (
                    <button
                      type="button"
                      className="btn btn--small inbox__read"
                      disabled={busy}
                      onClick={() => void markRead({ ids: [e.id] })}
                    >
                      Mark read
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    ));
  }

  const unread = state.kind === 'ready' ? state.unread : 0;
  return (
    <div className="inbox">
      <header className="inbox__head">
        <div>
          <p className="caps inbox__eyebrow">The courier’s satchel</p>
          <h1 className="display inbox__heading">Letters</h1>
          <p className="inbox__lede">
            {state.kind === 'ready'
              ? unread > 0
                ? `${unread} unread. Kept for 60 days, the newest 200.`
                : 'Everything read. Kept for 60 days, the newest 200.'
              : 'News for this account, kept for 60 days.'}
          </p>
        </div>
        {state.kind === 'ready' && state.entries.length > 0 ? (
          <div className="inbox__tools">
            <label className="inbox__toggle">
              <input
                type="checkbox"
                checked={onlyUnread}
                onChange={(e) => setOnlyUnread(e.target.checked)}
              />
              Unread only
            </label>
            <button
              type="button"
              className="btn btn--brass"
              disabled={busy || unread === 0}
              aria-busy={busy}
              onClick={() => void markRead({ all: true })}
            >
              Mark all read
            </button>
          </div>
        ) : null}
      </header>
      {failure ? (
        <p className="pack__notice pack__notice--error" role="alert">
          {failure}
        </p>
      ) : null}
      <div className="inbox__body">{body}</div>
    </div>
  );
}
