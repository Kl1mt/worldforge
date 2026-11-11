import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import {
  adminApi,
  describeAdminFailure,
  docHref,
  type ReadinessItem,
  type ReadinessReport,
  type ReadinessStatus,
} from '../admin/api';
import { newActionKey } from '../admin/tools-api';
import type { ApiFailure } from '../lib/api';
import { ADMIN_SECTIONS, adminHref, type AdminSection } from '../lib/route';
import './admin.css';
import './admin-readiness.css';

/**
 * Ticket 8.6: the Readiness tab, the muster roll before the gates open. One entry per step of
 * docs/GOING_LIVE.md, each with a wax seal (sealed, mind it, unset), what the state means, short
 * facts and where it is fixed. The tab only reads state; its two writes are the owner's ticks of
 * what the privacy policy mentions, and a test letter to an address that is typed, sent once and
 * kept nowhere (not in storage, not in the URL, cleared from the form once sent).
 */
type State =
  | { kind: 'loading' }
  | { kind: 'ready'; report: ReadinessReport }
  | { kind: 'error'; error: ApiFailure };

const SEAL: Record<ReadinessStatus, { word: string; glyph: string }> = {
  done: { word: 'Done', glyph: '✓' },
  attention: { word: 'Needs attention', glyph: '!' },
  not_set: { word: 'Not set', glyph: '·' },
};

const isSection = (s: string): s is AdminSection =>
  (ADMIN_SECTIONS as readonly string[]).includes(s);

export function AdminReadiness() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    adminApi.readiness(controller.signal).then(
      (res) =>
        setState(
          res.ok ? { kind: 'ready', report: res.value } : { kind: 'error', error: res.error },
        ),
      () => undefined,
    );
    return () => controller.abort();
  }, [attempt]);
  const reload = useCallback(() => {
    setState({ kind: 'loading' });
    setAttempt((n) => n + 1);
  }, []);
  /** Reads again in place (after a test letter), keeping the side forms and their messages. */
  const refresh = useCallback(() => setAttempt((n) => n + 1), []);
  const onReport = (report: ReadinessReport) => setState({ kind: 'ready', report });

  return (
    <div className="strong__split strong__split--roles">
      <div className="strong__main">
        <div className="strong__bar">
          <h2 className="rule-heading">Before the gates open</h2>
          <button type="button" className="btn btn--small" onClick={reload}>
            Read again
          </button>
        </div>
        <p className="dossier__dim">
          What the live town still needs, in the order of the{' '}
          <a href={docHref('docs/GOING_LIVE.md', '')} target="_blank" rel="noreferrer">
            going-live checklist
          </a>
          . This tab only reads the state; each entry links to the tab or the guide that changes it.
        </p>
        {state.kind === 'loading' ? (
          <p className="strong__wait" role="status">
            Calling the roll…
          </p>
        ) : null}
        {state.kind === 'error' ? (
          <div className="gate__alert strong__alert" role="alert">
            <p>The readiness board could not be read. {describeAdminFailure(state.error)}</p>
            <button type="button" className="btn btn--small" onClick={reload}>
              Try again
            </button>
          </div>
        ) : null}
        {state.kind === 'ready' ? <Roll report={state.report} /> : null}
      </div>
      <aside className="strong__side">
        {state.kind === 'ready' ? (
          <>
            <TestLetter available={state.report.testLetter.available} onSent={refresh} />
            <PrivacyChecklist report={state.report} onReport={onReport} />
          </>
        ) : null}
      </aside>
    </div>
  );
}

function Roll({ report }: { report: ReadinessReport }) {
  const tally = (s: ReadinessStatus) => report.items.filter((i) => i.status === s).length;
  return (
    <>
      <p className="readyroll__tally" role="status">
        <span className="readyroll__tally-n readyroll__tally-n--done">{tally('done')}</span> done ·{' '}
        <span className="readyroll__tally-n readyroll__tally-n--attention">
          {tally('attention')}
        </span>{' '}
        need attention ·{' '}
        <span className="readyroll__tally-n readyroll__tally-n--not_set">{tally('not_set')}</span>{' '}
        not set
        <span className="readyroll__stamp">
          read {report.generatedAt.slice(0, 16).replace('T', ' ')} UTC
        </span>
      </p>
      <ol className="readyroll">
        {report.items.map((item, n) => (
          <Entry key={item.id} item={item} n={n + 1} />
        ))}
      </ol>
    </>
  );
}

function Entry({ item, n }: { item: ReadinessItem; n: number }) {
  const seal = SEAL[item.status];
  const ids = useId();
  return (
    <li
      className={`readyroll__entry readyroll__entry--${item.status}`}
      aria-labelledby={`${ids}-t`}
    >
      <span className="readyroll__num" aria-hidden="true">
        {String(n).padStart(2, '0')}
      </span>
      <span className="readyroll__seal" aria-hidden="true">
        {seal.glyph}
      </span>
      <div className="readyroll__body">
        <h3 id={`${ids}-t`} className="readyroll__title">
          {item.title} <span className="readyroll__state">{seal.word}</span>
        </h3>
        <p className="readyroll__summary">{item.summary}</p>
        {item.facts.length ? (
          <dl className="readyroll__facts">
            {item.facts.map((f, i) => (
              <div key={`${f.label}-${i}`} className="readyroll__fact">
                <dt className="caps">{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <p className="readyroll__links">
          {item.links.map((l) =>
            l.kind === 'tab' ? (
              isSection(l.section) ? (
                <a key={l.label} className="readyroll__link" href={adminHref(l.section)}>
                  {l.label} →
                </a>
              ) : null
            ) : (
              <a
                key={l.label}
                className="readyroll__link readyroll__link--doc"
                href={docHref(l.path, l.anchor)}
                target="_blank"
                rel="noreferrer"
              >
                {l.label} ↗
              </a>
            ),
          )}
        </p>
      </div>
    </li>
  );
}

type Sent =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'done'; outcome: 'sent' | 'failed'; code: string | null; at: string }
  | { kind: 'error'; text: string };

function TestLetter({ available, onSent }: { available: boolean; onSent: () => void }) {
  const [to, setTo] = useState('');
  const [sent, setSent] = useState<Sent>({ kind: 'idle' });
  const ids = useId();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSent({ kind: 'busy' });
    const res = await adminApi.sendTestLetter(to.trim());
    if (res.ok) {
      // The address leaves the form once sent; nothing keeps it.
      setTo('');
      setSent({ kind: 'done', ...res.value });
      onSent();
    } else {
      setSent({ kind: 'error', text: describeAdminFailure(res.error) });
    }
  };
  return (
    <form
      className="readyroll-letter panel-iron"
      onSubmit={submit}
      noValidate
      autoComplete="off"
      aria-labelledby={`${ids}-t`}
    >
      <p className="caps">Email</p>
      <h2 id={`${ids}-t`} className="display readyroll-letter__title">
        Send a test letter
      </h2>
      {available ? (
        <>
          <p className="dossier__dim">
            One short letter through the server’s mail settings. The address is sent once and stored
            nowhere, not even in the audit log. Three letters an hour.
          </p>
          <div className="field">
            <label className="field__label caps" htmlFor={`${ids}-to`}>
              Send to
            </label>
            <div className="field__well">
              <input
                id={`${ids}-to`}
                className="field__input"
                type="email"
                inputMode="email"
                autoComplete="off"
                spellCheck={false}
                value={to}
                maxLength={254}
                placeholder="you@example.com"
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
          </div>
          <button
            type="submit"
            className="btn btn--small"
            disabled={sent.kind === 'busy' || !to.includes('@')}
          >
            {sent.kind === 'busy' ? 'Sending…' : 'Send test letter'}
          </button>
          {sent.kind === 'done' ? (
            <p
              className={`readyroll-letter__result readyroll-letter__result--${sent.outcome}`}
              role="status"
            >
              {sent.outcome === 'sent'
                ? 'Handed to the mail provider. Check the inbox (and the spam folder) in a minute.'
                : `The provider refused it${sent.code ? ` (code ${sent.code})` : ''}. Check the SMTP settings and the server log.`}
            </p>
          ) : null}
          {sent.kind === 'error' ? (
            <p className="field__error" role="alert">
              {sent.text}
            </p>
          ) : null}
        </>
      ) : (
        <p className="dossier__dim">
          Email is not set up on this server, so no letter can be sent. Put the SMTP settings in{' '}
          <code>deploy/.env</code> and redeploy (
          <a href={docHref('docs/DEPLOY.md', 'email')} target="_blank" rel="noreferrer">
            DEPLOY.md · Email
          </a>
          ).
        </p>
      )}
    </form>
  );
}

function PrivacyChecklist({
  report,
  onReport,
}: {
  report: ReadinessReport;
  onReport: (r: ReadinessReport) => void;
}) {
  const saved = report.privacy.checklist.filter((c) => c.ticked).map((c) => c.id);
  const [ticked, setTicked] = useState<string[]>(saved);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [key, setKey] = useState(newActionKey);
  const ids = useId();
  const dirty = ticked.slice().sort().join() !== saved.slice().sort().join();
  const toggle = (id: string) =>
    setTicked((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const res = await adminApi.savePrivacyTicks(report.privacy.version, ticked, key);
    setBusy(false);
    setKey(newActionKey());
    if (res.ok) {
      onReport(res.value);
      setTicked(res.value.privacy.checklist.filter((c) => c.ticked).map((c) => c.id));
      setMessage({ ok: true, text: 'Saved.' });
    } else {
      setMessage({ ok: false, text: describeAdminFailure(res.error) });
    }
  };
  return (
    <form className="readyroll-privacy panel-ledger" onSubmit={submit} aria-labelledby={`${ids}-t`}>
      <p className="caps">Privacy policy</p>
      <h2 id={`${ids}-t`} className="display readyroll-letter__title">
        What the policy mentions
      </h2>
      <p className="dossier__dim">
        Tick each feature once <code>deploy/legal/datenschutz.md</code> on the server mentions it.
        Your ticks are saved and audited; the file itself is never read here.
      </p>
      <ul className="readyroll-privacy__list">
        {report.privacy.checklist.map((c) => (
          <li key={c.id}>
            <label className="readyroll-privacy__item">
              <input
                type="checkbox"
                checked={ticked.includes(c.id)}
                onChange={() => toggle(c.id)}
              />
              <span>
                <span className="readyroll-privacy__label">{c.label}</span>
                <span className="readyroll-privacy__hint">{c.hint}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <button type="submit" className="btn btn--small" disabled={busy || !dirty}>
        {busy ? 'Saving…' : 'Save ticks'}
      </button>
      {message ? (
        <p
          className={message.ok ? 'readyroll-privacy__ok' : 'field__error'}
          role={message.ok ? 'status' : 'alert'}
        >
          {message.text}
        </p>
      ) : null}
      {report.privacy.updatedAt ? (
        <p className="readyroll__stamp">
          Last saved {report.privacy.updatedAt.slice(0, 16).replace('T', ' ')} UTC
        </p>
      ) : null}
    </form>
  );
}
