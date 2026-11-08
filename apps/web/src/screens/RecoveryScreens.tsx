import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { authApi, describeAuthFailure } from '../auth/api';
import { useAuth } from '../auth/AuthProvider';
import { useMailEnabled } from '../auth/useMailEnabled';
import type { ApiFailure } from '../lib/api';
import { routeHref, tokenFromHash } from '../lib/route';
import { GateLayout } from './AuthScreen';
import './gate.css';
import './recovery.css';

/**
 * Ticket 5.7: the screens behind the links in mails, and "Forgot your password?". All live in the
 * gate's frame. Tokens come from the URL fragment (never sent to a server by the browser) and are
 * taken out of the address bar as soon as the screen has read them.
 */

/** Reads the token once and replaces the address with the bare route, so it leaves no history. */
function useHashToken(route: 'verify' | 'reset'): string | null {
  const [token] = useState(() => tokenFromHash(window.location.hash));
  useEffect(() => {
    if (window.location.hash.includes('token=')) {
      window.history.replaceState(null, '', `${window.location.pathname}${routeHref(route)}`);
    }
  }, [route]);
  return token;
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="gate__panel panel-iron recov" aria-labelledby="gate-title">
      <h1 id="gate-title" className="gate__title display">
        {title}
      </h1>
      {children}
    </section>
  );
}

function Seal({ kind }: { kind: 'ok' | 'warn' | 'bad' }) {
  return <span className={`recov__seal recov__seal--${kind}`} aria-hidden="true" />;
}

const UNAVAILABLE =
  'Email is not set up on this server yet, so no letter can be sent. Your account works as usual; ask the keeper of the game for help in the meantime.';

// --- Forgot password -----------------------------------------------------------------------

export function ForgotScreen() {
  const mail = useMailEnabled();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<
    { kind: 'form' } | { kind: 'busy' } | { kind: 'sent'; to: string } | { kind: 'unavailable' }
  >({ kind: 'form' });
  const id = useId();
  const alertRef = useRef<HTMLParagraphElement>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (state.kind === 'busy') return;
    const value = email.trim();
    if (value === '') {
      setError('Enter the email address of your account.');
      return;
    }
    setError(null);
    setState({ kind: 'busy' });
    const res = await authApi.forgotPassword(value);
    if (res.ok) {
      setState({ kind: 'sent', to: value });
      return;
    }
    if (res.error.code === 'email_unavailable') {
      setState({ kind: 'unavailable' });
      return;
    }
    setState({ kind: 'form' });
    setError(describeAuthFailure(res.error));
    requestAnimationFrame(() => alertRef.current?.focus());
  };

  const unavailable = mail === false || state.kind === 'unavailable';

  return (
    <GateLayout>
      {unavailable ? (
        <Panel title="No letters leave the Graumark yet">
          <p className="recov__state recov__state--warn" role="status">
            <Seal kind="warn" />
            <span>{UNAVAILABLE}</span>
          </p>
          <p className="gate__switch">
            <a href={routeHref('login')}>Back to the gate</a>
          </p>
        </Panel>
      ) : state.kind === 'sent' ? (
        <Panel title="A letter is on its way">
          <p className="recov__state recov__state--ok" role="status">
            <Seal kind="ok" />
            <span>
              If an account is written under <strong className="recov__addr">{state.to}</strong>, a
              letter with a link to choose a new password is on its way. The link works once and
              fades after 30 minutes.
            </span>
          </p>
          <p className="gate__fine">
            Nothing after a few minutes? Look in the spam folder, check the address, or ask again.
          </p>
          <p className="gate__switch">
            <button
              type="button"
              className="recov__link"
              onClick={() => setState({ kind: 'form' })}
            >
              Ask again
            </button>{' '}
            · <a href={routeHref('login')}>Back to the gate</a>
          </p>
        </Panel>
      ) : (
        <Panel title="Forgot your password?">
          <p className="gate__lede">
            Give the address of your account and the keeper sends you a link to choose a new one.
          </p>
          {error ? (
            <p ref={alertRef} className="gate__alert" role="alert" tabIndex={-1}>
              {error}
            </p>
          ) : null}
          <form
            className="gate__form"
            onSubmit={submit}
            noValidate
            aria-busy={state.kind === 'busy'}
          >
            <div className={`field${error ? ' field--invalid' : ''}`}>
              <label className="field__label caps" htmlFor={id}>
                Email
              </label>
              <div className="field__well">
                <input
                  id={id}
                  name="email"
                  className="field__input"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={email}
                  disabled={state.kind === 'busy'}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
            </div>
            <button
              type="submit"
              className="btn btn--brass gate__submit"
              disabled={state.kind === 'busy'}
            >
              {state.kind === 'busy' ? 'Sending…' : 'Send me a link'}
            </button>
          </form>
          <p className="gate__switch">
            Remembered it? <a href={routeHref('login')}>Enter instead</a>
          </p>
        </Panel>
      )}
    </GateLayout>
  );
}

// --- Reset password ------------------------------------------------------------------------

export function ResetScreen() {
  const auth = useAuth();
  const token = useHashToken('reset');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [state, setState] = useState<
    | { kind: 'form' }
    | { kind: 'busy' }
    | { kind: 'done' }
    | { kind: 'dead'; failure: ApiFailure | null }
    | { kind: 'error'; message: string }
  >(token ? { kind: 'form' } : { kind: 'dead', failure: null });
  const id = useId();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token || state.kind === 'busy') return;
    if (password === '') {
      setFieldError('Choose a new password.');
      return;
    }
    setFieldError(null);
    setState({ kind: 'busy' });
    const res = await authApi.resetPassword({ token, password });
    if (res.ok) {
      setState({ kind: 'done' });
      // Every session ended, this device's too: the gate checks again.
      if (auth.state.kind === 'authenticated') auth.retry();
      return;
    }
    const f = res.error;
    if (f.code === 'token_invalid' || f.code === 'token_expired') {
      setState({ kind: 'dead', failure: f });
    } else if (f.fields.password) {
      setFieldError(f.fields.password);
      setState({ kind: 'form' });
    } else {
      setState({ kind: 'error', message: describeAuthFailure(f) });
    }
  };

  if (state.kind === 'done') {
    return (
      <GateLayout>
        <Panel title="A new key is cut">
          <p className="recov__state recov__state--ok" role="status">
            <Seal kind="ok" />
            <span>
              Your new password is set. Every device was logged out, this one too; a letter tells
              your mailbox what changed.
            </span>
          </p>
          <a className="btn btn--brass gate__submit recov__cta" href={routeHref('login')}>
            Enter with the new password
          </a>
        </Panel>
      </GateLayout>
    );
  }

  if (state.kind === 'dead') {
    const expired = state.failure?.code === 'token_expired';
    return (
      <GateLayout>
        <Panel title={expired ? 'This link has faded' : 'This link does not open anything'}>
          <p className="recov__state recov__state--bad" role="alert">
            <Seal kind="bad" />
            <span>
              {state.failure
                ? describeAuthFailure(state.failure)
                : 'The link is incomplete. Open it straight from the letter, or ask for a new one.'}{' '}
              Reset links work once, for 30 minutes, and only the newest letter counts.
            </span>
          </p>
          <a className="btn btn--brass gate__submit recov__cta" href={routeHref('forgot')}>
            Ask for a new link
          </a>
          <p className="gate__switch">
            <a href={routeHref('login')}>Back to the gate</a>
          </p>
        </Panel>
      </GateLayout>
    );
  }

  const busy = state.kind === 'busy';
  return (
    <GateLayout>
      <Panel title="Choose a new password">
        <p className="gate__lede">Setting it logs out every device where your account is open.</p>
        {state.kind === 'error' ? (
          <p className="gate__alert" role="alert">
            {state.message}
          </p>
        ) : null}
        <form className="gate__form" onSubmit={submit} noValidate aria-busy={busy}>
          <div className={`field${fieldError ? ' field--invalid' : ''}`}>
            <label className="field__label caps" htmlFor={id}>
              New password
            </label>
            <div className="field__well">
              <input
                id={id}
                name="password"
                className="field__input"
                type={show ? 'text' : 'password'}
                autoComplete="new-password"
                autoCapitalize="none"
                spellCheck={false}
                value={password}
                disabled={busy}
                aria-invalid={fieldError ? true : undefined}
                aria-describedby={`${id}-msg`}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                className="field__reveal"
                aria-pressed={show}
                aria-label={show ? 'Hide password' : 'Show password'}
                onClick={() => setShow((s) => !s)}
              >
                {show ? 'Hide' : 'Show'}
              </button>
            </div>
            <p id={`${id}-msg`} className={fieldError ? 'field__error' : 'field__hint'}>
              {fieldError ?? 'At least 10 characters.'}
            </p>
          </div>
          <button type="submit" className="btn btn--brass gate__submit" disabled={busy}>
            {busy ? 'Cutting the key…' : 'Set the new password'}
          </button>
        </form>
      </Panel>
    </GateLayout>
  );
}

// --- Verify email --------------------------------------------------------------------------

/** One request per token and page, whatever React does with effects (StrictMode runs them twice). */
const verifying = new Map<string, ReturnType<typeof authApi.verifyEmail>>();

export function VerifyScreen() {
  const auth = useAuth();
  const token = useHashToken('verify');
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<
    | { kind: 'checking' }
    | { kind: 'verified' }
    | { kind: 'dead'; failure: ApiFailure | null }
    | { kind: 'error'; failure: ApiFailure }
  >(token ? { kind: 'checking' } : { kind: 'dead', failure: null });
  const loggedIn = auth.state.kind === 'authenticated';
  const { refresh } = auth;

  useEffect(() => {
    if (!token) return;
    let live = true;
    let pending = verifying.get(token);
    if (!pending) {
      pending = authApi.verifyEmail(token);
      verifying.set(token, pending);
    }
    void pending.then((res) => {
      if (!live) return;
      if (res.ok) {
        setState({ kind: 'verified' });
        void refresh();
      } else if (res.error.code === 'token_invalid' || res.error.code === 'token_expired') {
        setState({ kind: 'dead', failure: res.error });
      } else {
        // Network or server trouble: the token is unused, so trying again is safe.
        verifying.delete(token);
        setState({ kind: 'error', failure: res.error });
      }
    });
    return () => {
      live = false;
    };
  }, [token, attempt, refresh]);

  return (
    <GateLayout>
      {state.kind === 'checking' ? (
        <Panel title="Breaking the seal">
          <p className="gate__wait" role="status">
            <span className="gate__wait-mark" aria-hidden="true" /> Checking your link…
          </p>
        </Panel>
      ) : state.kind === 'verified' ? (
        <Panel title="Your name is sealed">
          <p className="recov__state recov__state--ok" role="status">
            <Seal kind="ok" />
            <span>Your email address is verified. The ledger knows the address is yours.</span>
          </p>
          <a
            className="btn btn--brass gate__submit recov__cta"
            href={routeHref(loggedIn ? 'account' : 'login')}
          >
            {loggedIn ? 'To your account' : 'Enter the Graumark'}
          </a>
        </Panel>
      ) : state.kind === 'error' ? (
        <Panel title="The seal would not break">
          <p className="gate__alert" role="alert">
            {describeAuthFailure(state.failure)}
          </p>
          <button
            type="button"
            className="btn btn--brass gate__submit"
            onClick={() => {
              setState({ kind: 'checking' });
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </button>
        </Panel>
      ) : (
        <DeadVerifyLink failure={state.failure} loggedIn={loggedIn} />
      )}
    </GateLayout>
  );
}

function DeadVerifyLink({ failure, loggedIn }: { failure: ApiFailure | null; loggedIn: boolean }) {
  const expired = failure?.code === 'token_expired';
  const [resend, setResend] = useState<
    { kind: 'idle' } | { kind: 'busy' } | { kind: 'sent' } | { kind: 'failed'; message: string }
  >({ kind: 'idle' });

  const again = async () => {
    setResend({ kind: 'busy' });
    const res = await authApi.resendVerification();
    if (res.ok) setResend({ kind: 'sent' });
    else setResend({ kind: 'failed', message: describeAuthFailure(res.error) });
  };

  return (
    <Panel title={expired ? 'This link has faded' : 'This link does not open anything'}>
      <p className="recov__state recov__state--bad" role="alert">
        <Seal kind="bad" />
        <span>
          {failure
            ? describeAuthFailure(failure)
            : 'The link is incomplete. Open it straight from the letter.'}{' '}
          Verification links work once, for 24 hours, and only the newest letter counts.
        </span>
      </p>
      {loggedIn ? (
        resend.kind === 'sent' ? (
          <p className="recov__state recov__state--ok" role="status">
            <Seal kind="ok" />
            <span>A new letter is on its way.</span>
          </p>
        ) : (
          <>
            {resend.kind === 'failed' ? (
              <p className="gate__alert" role="alert">
                {resend.message}
              </p>
            ) : null}
            <button
              type="button"
              className="btn btn--brass gate__submit"
              disabled={resend.kind === 'busy'}
              onClick={() => void again()}
            >
              {resend.kind === 'busy' ? 'Sending…' : 'Send a new letter'}
            </button>
          </>
        )
      ) : (
        <p className="gate__fine">
          Enter with your account and ask for a new letter on the account screen.
        </p>
      )}
      <p className="gate__switch">
        <a href={routeHref(loggedIn ? 'account' : 'login')}>
          {loggedIn ? 'To your account' : 'Back to the gate'}
        </a>
      </p>
    </Panel>
  );
}
