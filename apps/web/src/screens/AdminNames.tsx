import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { adminApi, describeAdminFailure, type ReservedNameRow } from '../admin/api';
import { newActionKey } from '../admin/tools-api';
import type { ApiFailure } from '../lib/api';
import './admin.css';

/**
 * Ticket 6.9: the Names folio. The reserved names a new or changed display, hero or guild name may
 * not imitate (look-alike letters, case, digits for letters, inside a longer name): the built-in
 * ones (staff, every boss, the town's people as players meet them) and the ones admins add. Adding
 * a name never takes it from a player who already carries it.
 */
type State =
  | { kind: 'loading' }
  | { kind: 'ready'; names: ReservedNameRow[] }
  | { kind: 'error'; error: ApiFailure };

const GROUPS: { group: ReservedNameRow['group']; title: string; hint: string }[] = [
  { group: 'custom', title: 'Added by admins', hint: 'Staff names and anything else you reserve.' },
  { group: 'staff', title: 'Staff & the game', hint: 'Built in.' },
  { group: 'boss', title: 'Bosses', hint: 'Built in, from the bestiary.' },
  { group: 'npc', title: 'The town’s people', hint: 'Built in, as players meet them.' },
];

export function AdminNames() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    adminApi.reservedNames(controller.signal).then(
      (res) =>
        setState(
          res.ok ? { kind: 'ready', names: res.value.names } : { kind: 'error', error: res.error },
        ),
      () => undefined,
    );
    return () => controller.abort();
  }, [attempt]);
  const reload = useCallback(() => {
    setState({ kind: 'loading' });
    setAttempt((n) => n + 1);
  }, []);
  const onNames = (names: ReservedNameRow[]) => setState({ kind: 'ready', names });

  return (
    <div className="strong__split">
      <div className="strong__main">
        <h2 className="rule-heading">Reserved names</h2>
        <p className="dossier__dim">
          New and changed names may not imitate these: other letters that look the same (
          <code>Аdmin</code> in Cyrillic, <code>Adm1n</code>, <code>ADMlN</code>), other case, or
          the name inside a longer one. Players who already carry a name keep it; reports and
          moderation handle the rest. Two players’ names may not look alike either.
        </p>
        {state.kind === 'loading' ? (
          <p className="strong__wait" role="status">
            Reading the list…
          </p>
        ) : null}
        {state.kind === 'error' ? (
          <div className="gate__alert strong__alert" role="alert">
            <p>The list could not be read. {describeAdminFailure(state.error)}</p>
            <button type="button" className="btn btn--small" onClick={reload}>
              Try again
            </button>
          </div>
        ) : null}
        {state.kind === 'ready'
          ? GROUPS.map((g) => (
              <NameGroup
                key={g.group}
                title={g.title}
                hint={g.hint}
                names={state.names.filter((n) => n.group === g.group)}
                onNames={onNames}
              />
            ))
          : null}
      </div>
      <aside className="strong__side">
        <AddName onNames={onNames} />
        <div className="writ-cli panel-iron">
          <p className="caps">On the server</p>
          <pre className="writ-cli__code">
            <code>
              deploy/admin.sh reserved-name list{'\n'}deploy/admin.sh reserved-name add &lt;name&gt;
              {'\n'}deploy/admin.sh reserved-name remove &lt;name&gt;
            </code>
          </pre>
        </div>
      </aside>
    </div>
  );
}

function NameGroup({
  title,
  hint,
  names,
  onNames,
}: {
  title: string;
  hint: string;
  names: ReservedNameRow[];
  onNames: (names: ReservedNameRow[]) => void;
}) {
  return (
    <section className="names-group panel-ledger" aria-label={title}>
      <h3 className="caps">{title}</h3>
      <p className="dossier__dim">{hint}</p>
      {names.length === 0 ? (
        <p className="dossier__none">None yet.</p>
      ) : (
        <ul className="names-list">
          {names.map((n) => (
            <li key={n.id ?? `${n.group}:${n.name}`} className="names-list__row">
              <span className="names-list__name">{n.name}</span>
              {n.note ? <span className="dossier__dim">{n.note}</span> : null}
              {n.id ? <RemoveName id={n.id} name={n.name} onNames={onNames} /> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RemoveName({
  id,
  name,
  onNames,
}: {
  id: string;
  name: string;
  onNames: (names: ReservedNameRow[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key] = useState(newActionKey);
  const ids = useId();
  if (!open) {
    return (
      <button type="button" className="btn btn--small" onClick={() => setOpen(true)}>
        Remove…
      </button>
    );
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await adminApi.removeReservedName(id, reason.trim(), key);
    setBusy(false);
    if (res.ok) onNames(res.value.names);
    else setError(describeAdminFailure(res.error));
  };
  return (
    <form className="names-remove" onSubmit={submit} aria-label={`Remove ${name}`}>
      <label className="field__label caps" htmlFor={`${ids}-r`}>
        Why free “{name}”?
      </label>
      <div className="field__well">
        <input
          id={`${ids}-r`}
          className="field__input"
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      {error ? (
        <p className="field__error" role="alert">
          {error}
        </p>
      ) : null}
      <button type="submit" className="btn btn--small" disabled={busy || reason.trim().length < 3}>
        {busy ? 'Removing…' : 'Remove'}
      </button>
      <button type="button" className="btn btn--small" onClick={() => setOpen(false)}>
        Keep
      </button>
    </form>
  );
}

function AddName({ onNames }: { onNames: (names: ReservedNameRow[]) => void }) {
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [key, setKey] = useState(newActionKey);
  const ids = useId();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const res = await adminApi.addReservedName(
      { name: name.trim(), note: note.trim(), reason: reason.trim() },
      key,
    );
    setBusy(false);
    if (res.ok) {
      onNames(res.value.names);
      setMessage({ ok: true, text: `“${name.trim()}” is reserved. Players who carry it keep it.` });
      setName('');
      setNote('');
      setReason('');
      setKey(newActionKey());
    } else {
      setMessage({ ok: false, text: describeAdminFailure(res.error) });
    }
  };
  return (
    <form className="mint panel-iron" onSubmit={submit} noValidate aria-labelledby={`${ids}-t`}>
      <p className="caps">Reserve a name</p>
      <h2 id={`${ids}-t`} className="display mint__title">
        Keep a name for staff
      </h2>
      <div className="field">
        <label className="field__label caps" htmlFor={`${ids}-n`}>
          Name
        </label>
        <div className="field__well">
          <input
            id={`${ids}-n`}
            className="field__input"
            value={name}
            maxLength={24}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      </div>
      <div className="field">
        <label className="field__label caps" htmlFor={`${ids}-note`}>
          Note (optional)
        </label>
        <div className="field__well">
          <input
            id={`${ids}-note`}
            className="field__input"
            value={note}
            maxLength={200}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </div>
      <div className="field">
        <label className="field__label caps" htmlFor={`${ids}-why`}>
          Reason (audited)
        </label>
        <div className="field__well">
          <input
            id={`${ids}-why`}
            className="field__input"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
      </div>
      {message ? (
        <p
          className={message.ok ? 'field__hint' : 'field__error'}
          role={message.ok ? 'status' : 'alert'}
        >
          {message.text}
        </p>
      ) : null}
      <button
        type="submit"
        className="btn"
        disabled={busy || name.trim().length < 3 || reason.trim().length < 3}
      >
        {busy ? 'Sealing…' : 'Reserve'}
      </button>
    </form>
  );
}
