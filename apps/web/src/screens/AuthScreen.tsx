import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { describeAuthFailure } from '../auth/api';
import { useAuth } from '../auth/AuthProvider';
import { ASSETS } from '../content/assets';
import type { ApiFailure } from '../lib/api';
import { routeHref, type AuthRoute } from '../lib/route';
import { HealthLine } from '../shell/HealthLine';
import '../shell/shell.css';
import './gate.css';

/**
 * The gate: the frame around the login and register screens (and the session check). Same
 * lintel and status bar as the game shell, but no navigation, gold or character yet.
 */
export function GateLayout({ children }: { children: ReactNode }) {
  const backdrop = ASSETS['area.abandoned-fields'];
  return (
    <div className="shell gate">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar__inner">
          <span className="wordmark display">Worldforge</span>
        </div>
      </header>

      <main id="main" tabIndex={-1} className="shell__main gate__main">
        <figure className="gate__vista">
          <div
            className="gate__stage"
            style={{ backgroundImage: `url(${backdrop.path})` }}
            role="img"
            aria-label="The Abandoned Fields at dusk: a ruined farmstead behind broken fences"
          />
          <figcaption className="gate__caption">
            <span className="caps">Graumark · The Abandoned Fields</span>
            <span className="gate__lore">
              The reeve&rsquo;s farm fell silent a winter ago. Its dead did not.
            </span>
          </figcaption>
        </figure>
        <div className="gate__side">{children}</div>
      </main>

      <footer className="statusbar">
        <HealthLine />
        <span className="statusbar__note">
          Your progress is kept on the server, on every device.
        </span>
      </footer>
    </div>
  );
}

/** Loading and offline states of the session check, shown inside the gate. */
export function GateStatus({
  kind,
  onRetry,
}: {
  kind: 'checking' | 'offline';
  onRetry?: () => void;
}) {
  return (
    <GateLayout>
      <section className="gate__panel panel-iron gate__panel--status" aria-labelledby="gate-title">
        {kind === 'checking' ? (
          <>
            <h1 id="gate-title" className="gate__title display">
              Opening the gate
            </h1>
            <p className="gate__wait" role="status">
              <span className="gate__wait-mark" aria-hidden="true" /> Checking your session…
            </p>
          </>
        ) : (
          <>
            <h1 id="gate-title" className="gate__title display">
              The road is closed
            </h1>
            <p className="gate__alert" role="alert">
              The server cannot be reached, so we cannot check your account. Your progress is safe
              on the server.
            </p>
            <button type="button" className="btn btn--brass gate__submit" onClick={onRetry}>
              Try again
            </button>
          </>
        )}
      </section>
    </GateLayout>
  );
}

const COPY = {
  login: {
    tab: 'Enter',
    title: 'Return to the Graumark',
    lede: 'Your characters wait where you left them.',
    submit: 'Enter',
    busy: 'Entering…',
  },
  register: {
    tab: 'Join',
    title: 'Sign the ledger',
    lede: 'One account holds your characters, gold and world contribution.',
    submit: 'Create account',
    busy: 'Signing…',
  },
} as const;

type FieldName = 'email' | 'displayName' | 'password';

export function AuthScreen({ mode }: { mode: AuthRoute }) {
  return (
    <GateLayout>
      <AuthForm key={mode} mode={mode} />
    </GateLayout>
  );
}

function AuthForm({ mode }: { mode: AuthRoute }) {
  const auth = useAuth();
  const copy = COPY[mode];
  const [values, setValues] = useState({ email: '', displayName: '', password: '' });
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);

  const fields: FieldName[] =
    mode === 'register' ? ['email', 'displayName', 'password'] : ['email', 'password'];

  const update = (name: FieldName, value: string) => {
    setValues((v) => ({ ...v, [name]: value }));
    if (fieldErrors[name]) setFieldErrors(({ [name]: _cleared, ...rest }) => rest);
  };

  const focusFirstProblem = (errors: Partial<Record<FieldName, string>>) => {
    requestAnimationFrame(() => {
      const first = fields.find((f) => errors[f]);
      const el = first ? formRef.current?.elements.namedItem(first) : null;
      if (el instanceof HTMLElement) el.focus();
      else alertRef.current?.focus();
    });
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;

    // Only emptiness is checked here; the server owns the rules and reports the rest.
    const missing: Partial<Record<FieldName, string>> = {};
    for (const f of fields)
      if (values[f].trim() === '') missing[f] = `Enter your ${LABELS[f].toLowerCase()}.`;
    if (Object.keys(missing).length > 0) {
      setFieldErrors(missing);
      setFormError(null);
      focusFirstProblem(missing);
      return;
    }

    setBusy(true);
    setFormError(null);
    let failure: ApiFailure | null;
    try {
      failure =
        mode === 'login'
          ? await auth.login({ email: values.email, password: values.password })
          : await auth.register(values);
    } finally {
      setBusy(false);
    }
    if (!failure) return; // The route guard moves the player into the game.

    const errors = failure.fields as Partial<Record<FieldName, string>>;
    setFieldErrors(errors);
    setFormError(describeAuthFailure(failure));
    if (failure.code === 'invalid_credentials') setValues((v) => ({ ...v, password: '' }));
    focusFirstProblem(failure.code === 'invalid_credentials' ? {} : errors);
  };

  const otherMode: AuthRoute = mode === 'login' ? 'register' : 'login';

  return (
    <section className="gate__panel panel-iron" aria-labelledby="gate-title">
      <nav className="gate__tabs" aria-label="Account">
        {(['login', 'register'] as const).map((m) => (
          <a
            key={m}
            href={routeHref(m)}
            className="gate__tab"
            aria-current={m === mode ? 'page' : undefined}
          >
            {COPY[m].tab}
          </a>
        ))}
      </nav>

      <h1 id="gate-title" className="gate__title display">
        {copy.title}
      </h1>
      <p className="gate__lede">{copy.lede}</p>

      {formError ? (
        <p ref={alertRef} className="gate__alert" role="alert" tabIndex={-1}>
          {formError}
        </p>
      ) : null}

      <form ref={formRef} className="gate__form" onSubmit={onSubmit} noValidate aria-busy={busy}>
        {fields.map((name) => (
          <Field
            key={name}
            mode={mode}
            name={name}
            value={values[name]}
            error={fieldErrors[name]}
            disabled={busy}
            showPassword={showPassword}
            onToggleShow={() => setShowPassword((s) => !s)}
            onChange={(v) => update(name, v)}
          />
        ))}
        <button type="submit" className="btn btn--brass gate__submit" disabled={busy}>
          {busy ? copy.busy : copy.submit}
        </button>
      </form>

      <p className="gate__switch">
        {mode === 'login' ? 'New to the Graumark? ' : 'Already signed the ledger? '}
        <a href={routeHref(otherMode)}>
          {mode === 'login' ? 'Create an account' : 'Enter instead'}
        </a>
      </p>
      {mode === 'login' ? (
        <p className="gate__fine">Password recovery is not available yet.</p>
      ) : null}
    </section>
  );
}

const LABELS: Record<FieldName, string> = {
  email: 'Email',
  displayName: 'Display name',
  password: 'Password',
};

const HINTS: Partial<Record<FieldName, string>> = {
  displayName: '3–20 letters or numbers. Shown to other players.',
  password: 'At least 10 characters.',
};

function Field({
  mode,
  name,
  value,
  error,
  disabled,
  showPassword,
  onToggleShow,
  onChange,
}: {
  mode: AuthRoute;
  name: FieldName;
  value: string;
  error: string | undefined;
  disabled: boolean;
  showPassword: boolean;
  onToggleShow: () => void;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const hint = mode === 'register' ? HINTS[name] : undefined;
  const isPassword = name === 'password';
  // Only one of error/hint is rendered at a time; describe the input by whichever is shown.
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <div className={`field${error ? ' field--invalid' : ''}`}>
      <label className="field__label caps" htmlFor={id}>
        {LABELS[name]}
      </label>
      <div className="field__well">
        <input
          id={id}
          name={name}
          className="field__input"
          type={
            isPassword ? (showPassword ? 'text' : 'password') : name === 'email' ? 'email' : 'text'
          }
          autoComplete={
            name === 'email'
              ? 'email'
              : name === 'displayName'
                ? 'nickname'
                : mode === 'login'
                  ? 'current-password'
                  : 'new-password'
          }
          autoCapitalize={name === 'displayName' ? 'words' : 'none'}
          spellCheck={false}
          inputMode={name === 'email' ? 'email' : undefined}
          value={value}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
        />
        {isPassword ? (
          <button
            type="button"
            className="field__reveal"
            aria-pressed={showPassword}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            onClick={onToggleShow}
          >
            {showPassword ? 'Hide' : 'Show'}
          </button>
        ) : null}
      </div>
      {error ? (
        <p id={`${id}-error`} className="field__error">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="field__hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
