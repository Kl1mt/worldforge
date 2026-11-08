import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { authApi, describeAuthFailure, type AccountSecurity } from '../auth/api';
import { useAuth } from '../auth/AuthProvider';
import type { ApiFailure } from '../lib/api';
import { formatWhen } from '../social/api';
import './security.css';

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; failure: ApiFailure }
  | { kind: 'ready'; security: AccountSecurity };

/**
 * Ticket 5.7: the account screen's security panel. The email and whether it is verified (with a
 * rate-limited "send again"), changing the email (current password required), and "log out other
 * devices".
 */
export function SecurityPanel() {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    authApi.security(controller.signal).then(
      (r) =>
        setLoad(
          r.ok
            ? { kind: 'ready', security: r.value.security }
            : { kind: 'error', failure: r.error },
        ),
      () => {
        /* aborted */
      },
    );
    return () => controller.abort();
  }, [attempt]);

  return (
    <section className="acct-sec panel-iron" aria-labelledby="acct-sec-title">
      <h2 id="acct-sec-title" className="rule-heading">
        Account security
      </h2>
      {load.kind === 'loading' ? (
        <p className="acct-sec__wait" role="status">
          Opening the strongbox…
        </p>
      ) : load.kind === 'error' ? (
        <div className="gate__alert" role="alert">
          <p>{describeAuthFailure(load.failure)}</p>
          <button
            type="button"
            className="btn btn--small"
            onClick={() => {
              setLoad({ kind: 'loading' });
              reload();
            }}
          >
            Try again
          </button>
        </div>
      ) : (
        <>
          <EmailRow security={load.security} onChanged={reload} />
          <DevicesRow security={load.security} onChanged={reload} />
        </>
      )}
    </section>
  );
}

function EmailRow({ security, onChanged }: { security: AccountSecurity; onChanged: () => void }) {
  const [resend, setResend] = useState<
    { kind: 'idle' } | { kind: 'busy' } | { kind: 'sent' } | { kind: 'failed'; message: string }
  >({ kind: 'idle' });
  const [changing, setChanging] = useState(false);

  const again = async () => {
    setResend({ kind: 'busy' });
    const res = await authApi.resendVerification();
    if (res.ok) {
      setResend({ kind: 'sent' });
      onChanged();
    } else setResend({ kind: 'failed', message: describeAuthFailure(res.error) });
  };

  const state = security.emailVerified ? 'ok' : security.mailEnabled ? 'warn' : 'off';
  return (
    <div className="acct-sec__row">
      <span className={`acct-sec__seal acct-sec__seal--${state}`} aria-hidden="true" />
      <div className="acct-sec__body">
        <p className="caps acct-sec__label">Email</p>
        <p className="acct-sec__value">{security.email}</p>
        {security.emailVerified ? (
          <p className="acct-sec__note">
            Verified
            {security.emailVerifiedAt ? ` on ${formatWhen(security.emailVerifiedAt)}` : ''}.
          </p>
        ) : !security.mailEnabled ? (
          <p className="acct-sec__note">
            Not verified yet. Email is not set up on this server yet, so no letter can be sent; you
            can play as usual and verify once it is.
          </p>
        ) : (
          <>
            <p className="acct-sec__note">
              Not verified yet.{' '}
              {security.verificationPending
                ? 'A letter with a link is out; open it to seal the address. You can play as usual meanwhile.'
                : 'Ask for a letter with a link to seal the address. You can play as usual meanwhile.'}
            </p>
            {resend.kind === 'sent' ? (
              <p className="acct-sec__done" role="status">
                A new letter is on its way to {security.email}. Only the newest link counts.
              </p>
            ) : (
              <>
                {resend.kind === 'failed' ? (
                  <p className="acct-sec__error" role="alert">
                    {resend.message}
                  </p>
                ) : null}
                <button
                  type="button"
                  className="btn btn--brass btn--small"
                  disabled={resend.kind === 'busy'}
                  aria-busy={resend.kind === 'busy'}
                  onClick={() => void again()}
                >
                  {resend.kind === 'busy'
                    ? 'Sending…'
                    : security.verificationPending
                      ? 'Send the letter again'
                      : 'Send me the letter'}
                </button>
              </>
            )}
          </>
        )}
        {changing ? (
          <EmailChangeForm
            mailEnabled={security.mailEnabled}
            onCancel={() => setChanging(false)}
            onDone={() => {
              setChanging(false);
              setResend({ kind: 'idle' });
              onChanged();
            }}
          />
        ) : (
          <button type="button" className="acct-sec__link" onClick={() => setChanging(true)}>
            Change email address
          </button>
        )}
      </div>
    </div>
  );
}

function EmailChangeForm({
  mailEnabled,
  onCancel,
  onDone,
}: {
  mailEnabled: boolean;
  onCancel: () => void;
  onDone: () => void;
}) {
  const auth = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const id = useId();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const missing: typeof errors = {};
    if (email.trim() === '') missing.email = 'Enter the new address.';
    if (password === '') missing.password = 'Enter your current password.';
    if (Object.keys(missing).length > 0) {
      setErrors(missing);
      return;
    }
    setBusy(true);
    const res = await authApi.changeEmail({ email: email.trim(), password });
    setBusy(false);
    if (!res.ok) {
      const f = res.error;
      setErrors({
        ...(f.fields.email ? { email: f.fields.email } : {}),
        ...(f.fields.password ? { password: f.fields.password } : {}),
        ...(!f.fields.email && !f.fields.password ? { form: describeAuthFailure(f) } : {}),
      });
      if (f.code === 'wrong_password') setPassword('');
      return;
    }
    await auth.refresh();
    onDone();
  };

  return (
    <form className="acct-sec__form" onSubmit={submit} noValidate aria-busy={busy}>
      {errors.form ? (
        <p className="acct-sec__error" role="alert">
          {errors.form}
        </p>
      ) : null}
      <div className={`field${errors.email ? ' field--invalid' : ''}`}>
        <label className="field__label caps" htmlFor={`${id}-email`}>
          New email
        </label>
        <div className="field__well">
          <input
            id={`${id}-email`}
            className="field__input"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            value={email}
            disabled={busy}
            aria-invalid={errors.email ? true : undefined}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <p className={errors.email ? 'field__error' : 'field__hint'}>
          {errors.email ??
            (mailEnabled
              ? 'The new address must be verified again; the old one is told of the change.'
              : 'The new address counts as unverified until it is confirmed.')}
        </p>
      </div>
      <div className={`field${errors.password ? ' field--invalid' : ''}`}>
        <label className="field__label caps" htmlFor={`${id}-pw`}>
          Current password
        </label>
        <div className="field__well">
          <input
            id={`${id}-pw`}
            className="field__input"
            type="password"
            autoComplete="current-password"
            value={password}
            disabled={busy}
            aria-invalid={errors.password ? true : undefined}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {errors.password ? <p className="field__error">{errors.password}</p> : null}
      </div>
      <div className="acct-sec__actions">
        <button type="submit" className="btn btn--brass btn--small" disabled={busy}>
          {busy ? 'Changing…' : 'Change the address'}
        </button>
        <button type="button" className="btn btn--small" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function DevicesRow({ security, onChanged }: { security: AccountSecurity; onChanged: () => void }) {
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'confirm' }
    | { kind: 'busy' }
    | { kind: 'done'; revoked: number }
    | { kind: 'failed'; message: string }
  >({ kind: 'idle' });
  const n = security.otherSessions;

  const go = async () => {
    setState({ kind: 'busy' });
    const res = await authApi.revokeOtherSessions();
    if (res.ok) {
      setState({ kind: 'done', revoked: res.value.revoked });
      onChanged();
    } else setState({ kind: 'failed', message: describeAuthFailure(res.error) });
  };

  return (
    <div className="acct-sec__row">
      <span className="acct-sec__seal acct-sec__seal--iron" aria-hidden="true" />
      <div className="acct-sec__body">
        <p className="caps acct-sec__label">Devices</p>
        <p className="acct-sec__value">
          {n === 0
            ? 'Open on this device only.'
            : `Open here and on ${n} other ${n === 1 ? 'device' : 'devices'}.`}
        </p>
        <p className="acct-sec__note">
          Lost a phone, or played on a shared computer? Log out everywhere else; this device stays
          logged in.
        </p>
        {state.kind === 'done' ? (
          <p className="acct-sec__done" role="status">
            {state.revoked === 0
              ? 'No other device was logged in.'
              : `${state.revoked} other ${state.revoked === 1 ? 'device was' : 'devices were'} logged out.`}
          </p>
        ) : null}
        {state.kind === 'failed' ? (
          <p className="acct-sec__error" role="alert">
            {state.message}
          </p>
        ) : null}
        {state.kind === 'confirm' || state.kind === 'busy' ? (
          <div className="acct-sec__actions" role="group" aria-label="Confirm logging out">
            <button
              type="button"
              className="btn btn--brass btn--small"
              disabled={state.kind === 'busy'}
              onClick={() => void go()}
            >
              {state.kind === 'busy' ? 'Logging out…' : 'Yes, log them out'}
            </button>
            <button
              type="button"
              className="btn btn--small"
              disabled={state.kind === 'busy'}
              onClick={() => setState({ kind: 'idle' })}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="btn btn--small"
            disabled={n === 0}
            onClick={() => setState({ kind: 'confirm' })}
          >
            Log out other devices
          </button>
        )}
      </div>
    </div>
  );
}
