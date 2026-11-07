import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import {
  PROFILE_FIELD_LABELS,
  REPORT_REASONS,
  REPORT_TARGET_KINDS,
  SANCTION_DURATIONS,
  SANCTION_FOR_ACTION,
  SANCTION_LABELS,
  type SanctionAction,
} from '@worldforge/game-core';
import type { ApiFailure } from '../lib/api';
import {
  describeSocialFailure,
  formatWhen,
  socialApi,
  type ModCase,
  type ModQueue,
  type ResolveBody,
} from '../social/api';
import './gate.css';
import '../social/social.css';
import './moderation.css';

type QueueState =
  { kind: 'loading' } | { kind: 'ready'; queue: ModQueue } | { kind: 'error'; error: ApiFailure };

const REASON_LABEL = Object.fromEntries(REPORT_REASONS.map((r) => [r.id, r.label])) as Record<
  string,
  string
>;

type CaseAction = 'dismiss' | SanctionAction | 'renameGuild' | 'disbandGuild';

const ACTIONS: { id: CaseAction; label: string; hint: string }[] = [
  { id: 'dismiss', label: 'Dismiss', hint: 'Nothing wrong. Closes the case.' },
  { id: 'mute', label: 'Mute', hint: 'No posts or social actions; play and reports still work.' },
  { id: 'suspend', label: 'Suspend', hint: 'No login; every session stops at once.' },
  {
    id: 'forceRename',
    label: 'Force rename',
    hint: 'Name replaced now; the player picks a new one.',
  },
  {
    id: 'hideContent',
    label: 'Hide content',
    hint: 'Hides the reported field from other players.',
  },
  // Ticket 4.4: guild cases (mute and suspend still act on the leader).
  {
    id: 'renameGuild',
    label: 'Rename the guild',
    hint: 'Name and tag replaced now; the leader picks new ones.',
  },
  {
    id: 'disbandGuild',
    label: 'Disband the guild',
    hint: 'Removes every member at once; members see your reason.',
  },
];

const GUILD_ONLY: CaseAction[] = ['renameGuild', 'disbandGuild'];

/** The decisions a case offers: guild cases rename or disband instead of force-rename/hide. */
function actionsFor(kind: ModCase['target']['kind']) {
  const guild = kind === 'guild';
  return ACTIONS.filter((a) => {
    if (GUILD_ONLY.includes(a.id)) return guild;
    if (a.id === 'forceRename') return !guild;
    if (a.id === 'hideContent') return REPORT_TARGET_KINDS[kind].hideable;
    return true;
  });
}

const isGuildAction = (a: CaseAction): a is 'renameGuild' | 'disbandGuild' =>
  GUILD_ONLY.includes(a);

function hoursLabel(h: number): string {
  if (h % (24 * 365) === 0) return `${h / (24 * 365)} year`;
  if (h % 24 === 0) return `${h / 24} day${h === 24 ? '' : 's'}`;
  return `${h} hour${h === 1 ? '' : 's'}`;
}

function targetLabel(c: ModCase): string {
  if (c.target.kind === 'profileField' && 'field' in c.target) {
    return PROFILE_FIELD_LABELS[c.target.field];
  }
  if (c.target.kind === 'characterName') return `Hero name · ${c.target.name}`;
  if (c.target.kind === 'guild') return `Guild · ${c.current.value} · led by`;
  return REPORT_TARGET_KINDS[c.target.kind].label;
}

/**
 * The moderator queue (ticket 4.1): the docket of open cases (one per reported target, oldest
 * first) beside the case file of the selected one, with its reports, the subject's standing and
 * the action form. Staff only: for anyone else the route behaves like an unknown address.
 */
export function ModerationScreen() {
  const [state, setState] = useState<QueueState>({ kind: 'loading' });
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    socialApi.queue(controller.signal).then(
      (res) => {
        if (!res.ok) return setState({ kind: 'error', error: res.error });
        setState({ kind: 'ready', queue: res.value });
        setSelected((s) =>
          res.value.cases.some((c) => c.reportId === s)
            ? s
            : (res.value.cases[0]?.reportId ?? null),
        );
      },
      () => {
        /* aborted */
      },
    );
    return () => controller.abort();
  }, [attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const cases = state.kind === 'ready' ? state.queue.cases : [];
  const current = cases.find((c) => c.reportId === selected) ?? null;

  return (
    <section className="docket" aria-labelledby="docket-title">
      <header className="docket__head">
        <div>
          <p className="caps">Wardens · Moderator queue</p>
          <h1 id="docket-title" className="display">
            The docket
          </h1>
        </div>
        <p className="docket__count">
          {state.kind === 'ready'
            ? `${state.queue.openCases} open case${state.queue.openCases === 1 ? '' : 's'}`
            : ''}
        </p>
        <button type="button" className="btn" onClick={reload} disabled={state.kind === 'loading'}>
          Refresh
        </button>
      </header>

      {notice ? (
        <p className="docket__notice" role="status">
          {notice}
        </p>
      ) : null}

      {state.kind === 'loading' ? (
        <p className="docket__wait" role="status">
          Gathering the reports…
        </p>
      ) : null}
      {state.kind === 'error' ? (
        <div className="gate__alert" role="alert">
          <p>The docket could not be read. {describeSocialFailure(state.error)}</p>
          <button type="button" className="btn btn--small" onClick={reload}>
            Try again
          </button>
        </div>
      ) : null}
      {state.kind === 'ready' && cases.length === 0 ? (
        <div className="docket__empty panel-ledger">
          <p className="display">The docket is clear.</p>
          <p>No open reports. New ones appear here oldest first.</p>
        </div>
      ) : null}

      {cases.length > 0 ? (
        <div className="docket__body">
          <ol className="docket__list" aria-label="Open cases">
            {cases.map((c) => (
              <li key={c.reportId}>
                <button
                  type="button"
                  className="docket__row"
                  aria-pressed={c.reportId === selected}
                  onClick={() => {
                    setSelected(c.reportId);
                    setNotice(null);
                  }}
                >
                  <span className="docket__row-name">{c.subject.displayName}</span>
                  <span className="docket__row-meta">
                    {targetLabel(c)} · {c.reports.length} report
                    {c.reports.length === 1 ? '' : 's'} · {REASON_LABEL[c.reports[0]!.reason]}
                  </span>
                </button>
              </li>
            ))}
          </ol>
          {current ? (
            <CaseFile
              key={current.reportId}
              c={current}
              onResolved={(message) => {
                setNotice(message);
                reload();
              }}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function CaseFile({ c, onResolved }: { c: ModCase; onResolved: (message: string) => void }) {
  const ids = useId();
  const [action, setAction] = useState<CaseAction>('dismiss');
  const kind = action === 'dismiss' || isGuildAction(action) ? null : SANCTION_FOR_ACTION[action];
  const presets = kind ? SANCTION_DURATIONS[kind].presets : [];
  const [hours, setHours] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const duration = hours !== null && presets.includes(hours) ? hours : (presets[0] ?? 0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body: ResolveBody =
      action === 'dismiss'
        ? { action, ...(text.trim() ? { note: text } : {}) }
        : isGuildAction(action)
          ? { action, reason: text }
          : { action, reason: text, durationHours: duration };
    setBusy(true);
    setError(null);
    const res = await socialApi.resolve(c.reportId, body);
    setBusy(false);
    if (!res.ok) {
      setError(describeSocialFailure(res.error));
      return;
    }
    const closed = `${res.value.closedReports} report${res.value.closedReports === 1 ? '' : 's'} closed`;
    onResolved(
      res.value.sanction
        ? `${SANCTION_LABELS[res.value.sanction.kind]}: ${c.subject.displayName} until ${formatWhen(res.value.sanction.expiresAt)}. ${closed}.`
        : action === 'renameGuild'
          ? `The guild is renamed; its leader chooses a new name. ${closed}.`
          : action === 'disbandGuild'
            ? `The guild is disbanded. ${closed}.`
            : `Dismissed. ${closed}.`,
    );
  };

  return (
    <article className="case panel-iron" aria-labelledby={`${ids}-title`}>
      <header className="case__head">
        <p className="caps">
          {targetLabel(c)} · opened {formatWhen(c.openedAt)}
        </p>
        <h2 id={`${ids}-title`} className="display">
          {c.subject.displayName}
        </h2>
        <p className="case__sub">
          @{c.subject.handle} · {c.subject.role}
          {c.current.hidden ? ' · currently hidden' : ''} · {c.subject.pastSanctions} past sanction
          {c.subject.pastSanctions === 1 ? '' : 's'}
        </p>
      </header>

      {c.subject.sanctions.length > 0 ? (
        <ul className="case__active" aria-label="Active sanctions">
          {c.subject.sanctions.map((s) => (
            <LiftRow
              key={s.id}
              sanction={s}
              subject={c.subject.displayName}
              onLifted={onResolved}
            />
          ))}
        </ul>
      ) : null}

      <ol className="case__reports" aria-label="Reports">
        {c.reports.map((r) => (
          <li key={r.id} className="case__slip">
            <p className="case__slip-head">
              <strong>{REASON_LABEL[r.reason]}</strong>
              <span>
                by {r.reporter.displayName} · {formatWhen(r.createdAt)}
              </span>
            </p>
            {r.note ? (
              <p className="case__note">{r.note}</p>
            ) : (
              <p className="case__none">No note.</p>
            )}
            {typeof r.context.displayName === 'string' &&
            r.context.displayName !== c.subject.displayName ? (
              <p className="case__then">Name when reported: {r.context.displayName}</p>
            ) : null}
          </li>
        ))}
      </ol>

      <form className="case__act" onSubmit={submit} noValidate>
        <fieldset className="report__group">
          <legend className="caps">Decision</legend>
          <div className="case__actions">
            {actionsFor(c.target.kind).map((a) => (
              <label key={a.id} className="report__choice">
                <input
                  type="radio"
                  name={`${ids}-action`}
                  checked={action === a.id}
                  onChange={() => {
                    setAction(a.id);
                    setHours(null);
                  }}
                />
                <span>
                  <strong>{a.label}</strong>
                  <span className="case__hint">{a.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {kind ? (
          <fieldset className="report__group">
            <legend className="caps">{kind === 'rename' ? 'Time to choose a name' : 'For'}</legend>
            <div className="case__durations">
              {presets.map((h) => (
                <button
                  key={h}
                  type="button"
                  className="btn btn--small"
                  aria-pressed={duration === h}
                  onClick={() => setHours(h)}
                >
                  {hoursLabel(h)}
                </button>
              ))}
            </div>
          </fieldset>
        ) : null}
        <div className="field">
          <label className="field__label caps" htmlFor={`${ids}-text`}>
            {action === 'dismiss'
              ? 'Note (moderators only, optional)'
              : isGuildAction(action)
                ? 'Reason (shown to the guild)'
                : 'Reason (shown to the player)'}
          </label>
          <div className="field__well">
            <input
              id={`${ids}-text`}
              className="field__input"
              value={text}
              maxLength={300}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
        </div>
        {error ? (
          <p className="gate__alert" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className="btn btn--brass" disabled={busy} aria-busy={busy}>
          {busy
            ? 'Recording…'
            : action === 'dismiss'
              ? 'Dismiss the case'
              : isGuildAction(action)
                ? ACTIONS.find((a) => a.id === action)!.label
                : 'Issue sanction'}
        </button>
      </form>
    </article>
  );
}

/** An active sanction on the case's subject, with an inline "Lift" form (reason required). */
function LiftRow({
  sanction: s,
  subject,
  onLifted,
}: {
  sanction: ModCase['subject']['sanctions'][number];
  subject: string;
  onLifted: (message: string) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lift = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await socialApi.lift(s.id, reason);
    setBusy(false);
    if (!res.ok) setError(describeSocialFailure(res.error));
    else onLifted(`Lifted ${SANCTION_LABELS[s.kind].toLowerCase()} on ${subject}.`);
  };
  return (
    <li>
      <span>
        <strong>{SANCTION_LABELS[s.kind]}</strong> until {formatWhen(s.expiresAt)} — {s.reason}
      </span>
      {open ? (
        <form className="case__lift" onSubmit={lift} noValidate>
          <label className="visually-hidden" htmlFor={id}>
            Why lift it
          </label>
          <input
            id={id}
            className="field__input case__lift-input"
            placeholder="Why lift it?"
            value={reason}
            maxLength={300}
            onChange={(e) => setReason(e.target.value)}
          />
          <button type="submit" className="btn btn--small" disabled={busy} aria-busy={busy}>
            {busy ? 'Lifting…' : 'Lift'}
          </button>
          {error ? (
            <span className="field__error" role="alert">
              {error}
            </span>
          ) : null}
        </form>
      ) : (
        <button type="button" className="btn btn--small" onClick={() => setOpen(true)}>
          Lift…
        </button>
      )}
    </li>
  );
}
