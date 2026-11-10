import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { newActionKey } from '../admin/tools-api';
import {
  REASON_MAX,
  REASON_MIN,
  confirmMatches,
  describeToolFailure,
  reasonValid,
  type CheatAccess,
} from '../admin/tools-view';
import type { ApiFailure, ApiResult } from '../lib/api';

/**
 * Shared pieces of the admin tools (ticket D.4): a load hook that keeps the old value while it
 * reloads, the waiting and failure lines, and the action writ, the one place every write goes
 * through: what changes, the reason, the typed confirmation, the idempotency key and the answer.
 */

export type Loaded<T> =
  | { kind: 'loading' }
  | { kind: 'ready'; value: T; refreshing: boolean }
  | { kind: 'error'; error: ApiFailure };

/**
 * Loads with `fetcher` (keep it stable with `useCallback`). `refresh` loads again but keeps the
 * value on screen meanwhile (`refreshing`), so a reload after an action doesn't blank the file.
 */
export function useAdminLoad<T>(fetcher: (signal: AbortSignal) => Promise<ApiResult<T>>) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    of: unknown;
    attempt: number;
    res: ApiResult<T>;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetcher(controller.signal).then(
      (res) => setResult({ of: fetcher, attempt, res }),
      () => {
        /* aborted */
      },
    );
    return () => controller.abort();
  }, [fetcher, attempt]);
  let state: Loaded<T> = { kind: 'loading' };
  if (result && result.of === fetcher) {
    const current = result.attempt === attempt;
    if (result.res.ok) state = { kind: 'ready', value: result.res.value, refreshing: !current };
    else if (current) state = { kind: 'error', error: result.res.error };
  }
  const refresh = useCallback(() => setAttempt((n) => n + 1), []);
  return [state, refresh] as const;
}

export function Waiting({ children }: { children: string }) {
  return (
    <p className="strong__wait" role="status">
      {children}
    </p>
  );
}

export function Failed({
  what,
  error,
  onRetry,
}: {
  what: string;
  error: ApiFailure;
  onRetry: () => void;
}) {
  return (
    <div className="gate__alert strong__alert" role="alert">
      <p>
        {what} {describeToolFailure(error)}
      </p>
      <button type="button" className="btn btn--small" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

/** Maps a tool's answer to the success line the writ shows. */
export function answered<T>(
  p: Promise<ApiResult<T>>,
  say: (value: T) => string,
): Promise<ApiResult<string>> {
  return p.then((r) => (r.ok ? { ok: true, value: say(r.value) } : r));
}

/** The "public boards" note a cheat answer carries on the admin's own account. */
export function boardsNote(answer: { warning?: 'public_boards' }): string {
  return answer.warning === 'public_boards'
    ? ' This is your own account: the change shows on public boards.'
    : '';
}

/** One action, ready for the writ. */
export interface WritSpec {
  /** Caps line, e.g. "Testing · Grimwald". */
  caps: string;
  title: string;
  /** Exactly what will change, one item per line. */
  changes: ReactNode[];
  /** Crimson treatment and wording; also asks for the typed confirmation if `confirm` is set. */
  destructive?: boolean;
  /** The text the admin has to type (hero name, handle or flag id) and what it is. */
  confirm?: { expected: string; what: string };
  /** A prominent warning above the changes. */
  warning?: ReactNode;
  /** Shows the preview (e.g. the item) under the changes. */
  detail?: ReactNode;
  action: string;
  busy: string;
  run: (key: string, reason: string, confirm: string) => Promise<ApiResult<string>>;
}

type WritState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'error'; message: string; locked: boolean }
  | { kind: 'done'; message: string };

const WritContext = createContext<(spec: WritSpec) => void>(() => {});

/** Opens the writ for an action (provided by the inspector or the world folio). */
export const useWrit = () => useContext(WritContext);

/**
 * Holds at most one open writ over `children`; `onSuccess` runs after a confirmed answer (reload
 * the file there). The success line stays in the writ until the admin closes it.
 */
export function WritHost({
  children,
  onSuccess,
}: {
  children: ReactNode;
  onSuccess: (message: string) => void;
}) {
  const [spec, setSpec] = useState<WritSpec | null>(null);
  // A new key per opened writ: `n` remounts the writ even for the same spec object.
  const [n, setN] = useState(0);
  const open = useCallback((s: WritSpec) => {
    setSpec(s);
    setN((x) => x + 1);
  }, []);
  return (
    <WritContext.Provider value={open}>
      {children}
      {spec ? (
        <ActionWrit key={n} spec={spec} onSuccess={onSuccess} onClose={() => setSpec(null)} />
      ) : null}
    </WritContext.Provider>
  );
}

/**
 * The full-view confirmation: a native modal dialog over the folio (the report plate's pattern).
 * The idempotency key is made when it opens and reused for every retry of this action. After a
 * network or server failure the fields lock, so the retry is the identical request (a replay if
 * the first one went through).
 */
function ActionWrit({
  spec,
  onSuccess,
  onClose,
}: {
  spec: WritSpec;
  onSuccess: (message: string) => void;
  onClose: () => void;
}) {
  const ids = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const [key] = useState(newActionKey);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [touched, setTouched] = useState(false);
  const [state, setState] = useState<WritState>({ kind: 'idle' });

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open && typeof d.showModal === 'function') d.showModal();
    return () => {
      if (d?.open) d.close();
    };
  }, []);

  const busy = state.kind === 'busy';
  const done = state.kind === 'done';
  const locked = busy || done || (state.kind === 'error' && state.locked);
  const reasonOk = reasonValid(reason);
  const confirmOk = !spec.confirm || confirmMatches(spec.confirm.expected, typed);
  const ready = reasonOk && confirmOk && !busy && !done;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!ready) return;
    setState({ kind: 'busy' });
    const res = await spec.run(key, reason.trim(), typed.trim());
    if (res.ok) {
      setState({ kind: 'done', message: res.value });
      onSuccess(res.value);
    } else {
      const unsure = res.error.code === 'network' || res.error.status >= 500;
      setState({ kind: 'error', message: describeToolFailure(res.error), locked: unsure });
    }
  };

  return (
    <dialog
      ref={ref}
      className={`adt-writ${spec.destructive ? ' adt-writ--grave' : ''}`}
      aria-labelledby={`${ids}-t`}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form className="adt-writ__plate" onSubmit={submit} noValidate>
        <header className="adt-writ__head">
          <p className="caps">{spec.caps}</p>
          <h2 id={`${ids}-t`} className="display">
            {spec.title}
          </h2>
        </header>
        {spec.warning ? (
          <p className="adt-writ__warning" role="note">
            {spec.warning}
          </p>
        ) : null}
        <h3 className="caps adt-writ__sub">What happens</h3>
        <ul className="adt-changes">
          {spec.changes.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
        {spec.detail ? <div className="adt-writ__detail">{spec.detail}</div> : null}

        <ReasonField
          id={`${ids}-reason`}
          value={reason}
          onChange={setReason}
          disabled={locked}
          showError={touched}
        />
        {spec.confirm ? (
          <div className={`field${touched && !confirmOk ? ' field--invalid' : ''}`}>
            <label className="field__label caps" htmlFor={`${ids}-confirm`}>
              Type {spec.confirm.what} to confirm: <strong>{spec.confirm.expected}</strong>
            </label>
            <div className="field__well">
              <input
                id={`${ids}-confirm`}
                className="field__input"
                value={typed}
                autoComplete="off"
                spellCheck={false}
                maxLength={64}
                disabled={locked}
                onChange={(e) => setTyped(e.target.value)}
                aria-invalid={touched && !confirmOk}
              />
            </div>
          </div>
        ) : null}

        {state.kind === 'error' ? (
          <div className="gate__alert strong__alert" role="alert">
            <p>{state.message}</p>
            {state.locked ? (
              <p className="adt-dim">
                It may have gone through. Try again sends the same request: the server does it at
                most once.
              </p>
            ) : null}
          </div>
        ) : null}
        {done ? (
          <p className="adt-flash" role="status">
            {state.message}
          </p>
        ) : null}

        <div className="adt-writ__act">
          {done ? (
            <button type="button" className="btn btn--brass" onClick={onClose} autoFocus>
              Back to the file
            </button>
          ) : (
            <>
              <button type="button" className="btn" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button
                type="submit"
                className={`btn${spec.destructive ? ' adt-btn--grave' : ' btn--brass'}`}
                disabled={!ready}
                aria-busy={busy}
              >
                {busy ? spec.busy : state.kind === 'error' ? 'Try again' : spec.action}
              </button>
            </>
          )}
        </div>
        {!done ? (
          <p className="adt-dim adt-writ__fine">
            Every action is written to the audit log with your reason.
          </p>
        ) : null}
      </form>
    </dialog>
  );
}

export function ReasonField({
  id,
  value,
  onChange,
  disabled,
  showError,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  showError?: boolean;
}) {
  const invalid = Boolean(showError) && !reasonValid(value);
  return (
    <div className={`field${invalid ? ' field--invalid' : ''}`}>
      <label className="field__label caps" htmlFor={id}>
        Reason (required, kept in the audit log)
      </label>
      <div className="field__well">
        <textarea
          id={id}
          className="field__input adt-reason"
          value={value}
          rows={2}
          maxLength={REASON_MAX}
          disabled={disabled}
          placeholder="e.g. Refund for the lost upgrade, ticket #12"
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={invalid}
          aria-describedby={invalid ? `${id}-err` : undefined}
        />
      </div>
      {invalid ? (
        <p id={`${id}-err`} className="field__error">
          At least {REASON_MIN} characters.
        </p>
      ) : null}
    </div>
  );
}

/** A tool on the bench: support (moss edge) or testing (brass edge, gated by `cheat`). */
export function Tool({
  title,
  kind,
  cheat,
  children,
  onSubmit,
  lede,
}: {
  title: string;
  kind: 'support' | 'testing';
  cheat: CheatAccess;
  lede?: ReactNode;
  children: ReactNode;
  onSubmit: () => void;
}) {
  const ids = useId();
  const blocked = kind === 'testing' && cheat === 'blocked';
  return (
    <form
      className={`adt-tool adt-tool--${kind}`}
      aria-labelledby={`${ids}-t`}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!blocked) onSubmit();
      }}
    >
      <p className="caps adt-tool__kind">{kind === 'support' ? 'Support' : 'Testing'}</p>
      <h4 id={`${ids}-t`} className="adt-tool__title">
        {title}
      </h4>
      {lede ? <p className="adt-dim">{lede}</p> : null}
      <fieldset className="adt-tool__body" disabled={blocked}>
        {children}
      </fieldset>
      {blocked ? (
        <p className="adt-tool__blocked">Test accounts and your own account only.</p>
      ) : null}
    </form>
  );
}

/** A small labelled input for tool forms. */
export function SmallField({
  label,
  hint,
  invalid,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  invalid?: boolean;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className={`field adt-field${invalid ? ' field--invalid' : ''}`}>
      <label className="field__label caps" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="field__well">{children}</div>
      {hint ? <p className="field__hint">{hint}</p> : null}
    </div>
  );
}
