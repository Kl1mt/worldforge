import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  PLAYER_TEXT_RULES,
  REPORT_REASONS,
  validatePlayerText,
  type ReportReasonId,
  type ReportTarget,
} from '@worldforge/game-core';
import { describeSocialFailure, socialApi, type PlayerRef } from './api';
import '../screens/gate.css';
import './social.css';

/**
 * The report dialog (ticket 4.1, docs/SOCIAL.md): the one way to report anything. Later tickets
 * open it with a fixed `target` from a profile, a guild or a chat line; without one it starts by
 * asking for the player's display name. A native modal `<dialog>` on the iron plate, like the
 * return summary.
 */
export interface ReportDialogProps {
  open: boolean;
  onClose: () => void;
  /** A known target and how to name it ("Wolfram's display name"); omit to ask for a name. */
  target?: { target: ReportTarget; label: string };
}

type Step = 'who' | 'what' | 'sent';

const NOTE_MAX = PLAYER_TEXT_RULES.reportNote.max;

export function ReportDialog({ open, onClose, target }: ReportDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="report"
      aria-labelledby="report-title"
      onClose={onClose}
      onCancel={onClose}
    >
      {open ? <ReportForm onClose={onClose} {...(target ? { target } : {})} /> : null}
    </dialog>
  );
}

function ReportForm({ onClose, target: fixed }: Omit<ReportDialogProps, 'open'>) {
  const [step, setStep] = useState<Step>(fixed ? 'what' : 'who');
  const [name, setName] = useState('');
  const [player, setPlayer] = useState<PlayerRef | null>(null);
  const [about, setAbout] = useState<'player' | 'displayName'>('player');
  const [reason, setReason] = useState<ReportReasonId | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const ids = useId();

  useEffect(() => {
    if (error) alertRef.current?.focus();
  }, [error]);

  const target: ReportTarget | null =
    fixed?.target ??
    (player
      ? about === 'player'
        ? { kind: 'player', handle: player.handle }
        : { kind: 'profileField', handle: player.handle, field: 'displayName' }
      : null);

  const lookup = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Enter the name the player goes by.');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await socialApi.lookup(name);
    setBusy(false);
    if (!res.ok) {
      setError(describeSocialFailure(res.error));
      return;
    }
    setPlayer(res.value.player);
    setStep('what');
  };

  const noteCheck = validatePlayerText('reportNote', note);
  const noteLength = [...noteCheck.value].length;

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!target) return;
    if (!reason) {
      setError('Choose what is wrong.');
      return;
    }
    if (!noteCheck.ok) {
      setError(noteCheck.message);
      return;
    }
    setBusy(true);
    setError(null);
    const res = await socialApi.report({
      target,
      reason,
      ...(noteCheck.value ? { note: noteCheck.value } : {}),
    });
    setBusy(false);
    if (!res.ok) {
      setError(describeSocialFailure(res.error));
      return;
    }
    setStep('sent');
  };

  const subjectLabel = fixed?.label ?? (player ? player.displayName : '');

  return (
    <div className="report__plate">
      <header className="report__head">
        <p className="caps">Report {step === 'who' ? 'a player' : subjectLabel}</p>
        <h2 id="report-title" className="display">
          {step === 'sent' ? 'Report sent' : 'Tell the wardens'}
        </h2>
      </header>

      {error ? (
        <p ref={alertRef} tabIndex={-1} className="gate__alert report__alert" role="alert">
          {error}
        </p>
      ) : null}

      {step === 'who' ? (
        <form className="report__form" onSubmit={lookup} noValidate>
          <div className="field">
            <label className="field__label caps" htmlFor={`${ids}-name`}>
              Display name
            </label>
            <div className="field__well">
              <input
                id={`${ids}-name`}
                className="field__input"
                value={name}
                maxLength={64}
                autoComplete="off"
                autoFocus
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <p className="field__hint">The name shown for the player, as you saw it.</p>
          </div>
          <div className="report__actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn--brass" disabled={busy} aria-busy={busy}>
              {busy ? 'Searching the rolls…' : 'Find player'}
            </button>
          </div>
        </form>
      ) : null}

      {step === 'what' ? (
        <form className="report__form" onSubmit={send} noValidate>
          {!fixed ? (
            <fieldset className="report__group">
              <legend className="caps">What are you reporting?</legend>
              <div className="report__choices report__choices--two">
                {(
                  [
                    ['player', `${subjectLabel} (the player)`],
                    ['displayName', 'Their display name'],
                  ] as const
                ).map(([id, label]) => (
                  <label key={id} className="report__choice">
                    <input
                      type="radio"
                      name="about"
                      checked={about === id}
                      onChange={() => setAbout(id)}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
          <fieldset className="report__group">
            <legend className="caps">What is wrong?</legend>
            <div className="report__choices">
              {REPORT_REASONS.map((r) => (
                <label key={r.id} className="report__choice">
                  <input
                    type="radio"
                    name="reason"
                    checked={reason === r.id}
                    onChange={() => setReason(r.id)}
                  />
                  <span>{r.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className={`field${noteCheck.ok ? '' : ' field--invalid'}`}>
            <label className="field__label caps" htmlFor={`${ids}-note`}>
              What happened <span className="report__optional">(optional)</span>
            </label>
            <div className="field__well">
              <textarea
                id={`${ids}-note`}
                className="field__input report__note"
                rows={4}
                value={note}
                aria-describedby={`${ids}-count`}
                aria-invalid={!noteCheck.ok}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
            <p id={`${ids}-count`} className="field__hint report__count">
              {noteLength} / {NOTE_MAX} · Only moderators read this.
            </p>
          </div>
          <div className="report__actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn--brass" disabled={busy} aria-busy={busy}>
              {busy ? 'Sending…' : 'Send report'}
            </button>
          </div>
        </form>
      ) : null}

      {step === 'sent' ? (
        <div className="report__form">
          <p className="report__done" role="status">
            Thank you. A moderator will look at it. You will not hear the outcome, but you can
            report again if it happens again.
          </p>
          <div className="report__actions">
            <button type="button" className="btn btn--brass" onClick={onClose} autoFocus>
              Close
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
