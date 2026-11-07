import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { REPORT_REASONS, SANCTION_LABELS, getClass } from '@worldforge/game-core';
import {
  adminApi,
  describeAdminFailure,
  formatUptime,
  inviteLink,
  type AdminInvite,
  type InviteStatus,
  type PlayerFile,
  type PlayerRow,
  type ServerStatus,
  type StaffMember,
  type TelemetryReport,
  type TelemetrySection,
} from '../admin/api';
import type { ApiFailure, ApiResult } from '../lib/api';
import {
  ADMIN_SECTIONS,
  adminHref,
  adminLocation,
  moderationCaseHref,
  type AdminSection,
} from '../lib/route';
import { formatWhen } from '../social/api';
import './gate.css';
import './admin.css';

const SECTION_LABELS: Record<AdminSection, { label: string; hint: string }> = {
  invites: { label: 'Invites', hint: 'Who may join' },
  players: { label: 'Players', hint: 'Look someone up' },
  telemetry: { label: 'Telemetry', hint: 'Loot & economy' },
  status: { label: 'Server', hint: 'Health & version' },
  roles: { label: 'Roles', hint: 'Wardens & admins' },
};

const REASON_LABEL = Object.fromEntries(REPORT_REASONS.map((r) => [r.id, r.label])) as Record<
  string,
  string
>;

const DAY = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const day = (iso: string) => DAY.format(new Date(iso));
const plural = (n: number, word: string) =>
  `${n.toLocaleString('en-GB')} ${word}${n === 1 ? '' : 's'}`;

/** A load of one section: loading, ready or failed, with a retry. */
type Load<T> =
  { kind: 'loading' } | { kind: 'ready'; value: T } | { kind: 'error'; error: ApiFailure };

/**
 * Loads with `fetcher` (keep it stable with `useCallback`; a new fetcher loads again). The state
 * is derived: until the answer for the current fetcher and attempt arrives, it is `loading`.
 */
function useLoad<T>(fetcher: (signal: AbortSignal) => Promise<ApiResult<T>>) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ of: unknown; attempt: number; load: Load<T> } | null>(
    null,
  );
  useEffect(() => {
    const controller = new AbortController();
    fetcher(controller.signal).then(
      (res) =>
        setResult({
          of: fetcher,
          attempt,
          load: res.ok ? { kind: 'ready', value: res.value } : { kind: 'error', error: res.error },
        }),
      () => {
        /* aborted */
      },
    );
    return () => controller.abort();
  }, [fetcher, attempt]);
  const state: Load<T> =
    result && result.of === fetcher && result.attempt === attempt
      ? result.load
      : { kind: 'loading' };
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  /** Updates a loaded value in place (after a create or revoke). */
  const patch = useCallback(
    (fn: (value: T) => T) =>
      setResult((r) =>
        r && r.load.kind === 'ready'
          ? { ...r, load: { kind: 'ready', value: fn(r.load.value) } }
          : r,
      ),
    [],
  );
  return [state, reload, patch] as const;
}

function Waiting({ children }: { children: string }) {
  return (
    <p className="strong__wait" role="status">
      {children}
    </p>
  );
}

function Failed({
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
        {what} {describeAdminFailure(error)}
      </p>
      <button type="button" className="btn btn--small" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

/**
 * The admin panel (ticket D.3): the strongroom of the keep. A row of ledger tabs (invites,
 * players, telemetry, server, roles) over one folio at a time. Admins only: for everyone else the
 * route behaves like an unknown address, and the server answers 404 to every admin route.
 */
export function AdminScreen() {
  const [loc, setLoc] = useState(() => adminLocation(window.location.hash));
  useEffect(() => {
    const onHash = () => setLoc(adminLocation(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return (
    <section className="strong" aria-labelledby="strong-title">
      <header className="strong__head">
        <p className="caps">The keep · Admin panel</p>
        <h1 id="strong-title" className="display">
          The strongroom
        </h1>
      </header>

      <nav className="strong__tabs" aria-label="Admin sections">
        {ADMIN_SECTIONS.map((s) => (
          <a
            key={s}
            className="strong__tab"
            href={adminHref(s)}
            aria-current={loc.section === s ? 'page' : undefined}
          >
            <span className="strong__tab-label">{SECTION_LABELS[s].label}</span>
            <span className="strong__tab-hint">{SECTION_LABELS[s].hint}</span>
          </a>
        ))}
      </nav>

      <div className="strong__folio">
        {loc.section === 'invites' ? <InvitesFolio /> : null}
        {loc.section === 'players' ? <PlayersFolio handle={loc.arg} /> : null}
        {loc.section === 'telemetry' ? <TelemetryFolio /> : null}
        {loc.section === 'status' ? <StatusFolio /> : null}
        {loc.section === 'roles' ? <RolesFolio /> : null}
      </div>
    </section>
  );
}

// ---- Invites -------------------------------------------------------------------------------

const EXPIRY_CHOICES: { label: string; hours: number | null }[] = [
  { label: '1 day', hours: 24 },
  { label: '7 days', hours: 7 * 24 },
  { label: '14 days', hours: 14 * 24 },
  { label: '30 days', hours: 30 * 24 },
  { label: 'Never', hours: null },
];

const STATUS_LABEL: Record<InviteStatus, string> = {
  active: 'Active',
  used_up: 'Used up',
  expired: 'Expired',
  revoked: 'Revoked',
};

function InvitesFolio() {
  const [state, reload, patch] = useLoad(adminApi.invites);
  const [fresh, setFresh] = useState<{ code: string; invite: AdminInvite } | null>(null);

  const onCreated = (created: { code: string; invite: AdminInvite }) => {
    setFresh(created);
    patch((v) => ({ ...v, invites: [created.invite, ...v.invites] }));
  };
  const onRevoked = (invite: AdminInvite) =>
    patch((v) => ({ ...v, invites: v.invites.map((i) => (i.id === invite.id ? invite : i)) }));

  return (
    <div className="strong__split">
      <div className="strong__side">
        <CreateInvite onCreated={onCreated} />
        {fresh ? (
          <FreshCode code={fresh.code} invite={fresh.invite} onDone={() => setFresh(null)} />
        ) : null}
      </div>
      <div className="strong__main">
        <div className="strong__bar">
          <h2 className="rule-heading">Invite codes</h2>
          <button type="button" className="btn btn--small" onClick={reload}>
            Refresh
          </button>
        </div>
        {state.kind === 'loading' ? <Waiting>Reading the invite book…</Waiting> : null}
        {state.kind === 'error' ? (
          <Failed what="The invites could not be read." error={state.error} onRetry={reload} />
        ) : null}
        {state.kind === 'ready' && state.value.invites.length === 0 ? (
          <div className="strong__empty panel-ledger">
            <p className="display">No invites yet.</p>
            <p>Create one on the left. The code is shown once; send the link to the player.</p>
          </div>
        ) : null}
        {state.kind === 'ready' && state.value.invites.length > 0 ? (
          <ol className="invites" aria-label="Invite codes, newest first">
            {state.value.invites.map((i) => (
              <InviteRow key={i.id} invite={i} onRevoked={onRevoked} />
            ))}
          </ol>
        ) : null}
        {state.kind === 'ready' && state.value.nextCursor ? (
          <p className="strong__note">
            Showing the newest 200. Older codes: <code>deploy/admin.sh invite list</code>.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function CreateInvite({
  onCreated,
}: {
  onCreated: (c: { code: string; invite: AdminInvite }) => void;
}) {
  const ids = useId();
  const [uses, setUses] = useState('1');
  const [expiry, setExpiry] = useState<number | null>(14 * 24);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const usesValid = /^\d{1,5}$/.test(uses) && Number(uses) >= 1 && Number(uses) <= 10_000;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!usesValid) return setError('Uses must be a whole number from 1 to 10,000.');
    setBusy(true);
    setError(null);
    const res = await adminApi.createInvite({
      maxUses: Number(uses),
      expiresInHours: expiry,
      note: note.trim(),
    });
    setBusy(false);
    if (!res.ok) return setError(describeAdminFailure(res.error));
    setNote('');
    onCreated(res.value);
  };

  return (
    <form className="mint panel-iron" onSubmit={submit} noValidate aria-labelledby={`${ids}-t`}>
      <p className="caps">New invite</p>
      <h2 id={`${ids}-t`} className="display mint__title">
        Seal an invitation
      </h2>
      <div className={`field${usesValid ? '' : ' field--invalid'}`}>
        <label className="field__label caps" htmlFor={`${ids}-uses`}>
          Uses
        </label>
        <div className="field__well">
          <input
            id={`${ids}-uses`}
            className="field__input"
            inputMode="numeric"
            value={uses}
            onChange={(e) => setUses(e.target.value.trim())}
            aria-invalid={!usesValid}
            aria-describedby={`${ids}-uses-hint`}
          />
        </div>
        <p id={`${ids}-uses-hint`} className="field__hint">
          How many accounts it may create (1 for one friend).
        </p>
      </div>
      <fieldset className="mint__group">
        <legend className="field__label caps">Expires after</legend>
        <div className="mint__chips">
          {EXPIRY_CHOICES.map((c) => (
            <button
              key={c.label}
              type="button"
              className="btn btn--small"
              aria-pressed={expiry === c.hours}
              onClick={() => setExpiry(c.hours)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="field">
        <label className="field__label caps" htmlFor={`${ids}-note`}>
          Note (only admins see it)
        </label>
        <div className="field__well">
          <input
            id={`${ids}-note`}
            className="field__input"
            value={note}
            maxLength={200}
            placeholder="Who it is for"
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </div>
      {error ? (
        <p className="gate__alert" role="alert">
          {error}
        </p>
      ) : null}
      <button type="submit" className="btn btn--brass" disabled={busy} aria-busy={busy}>
        {busy ? 'Sealing…' : 'Create invite'}
      </button>
    </form>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState<'copied' | 'failed' | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone('copied');
    } catch {
      setDone('failed');
    }
  };
  return (
    <button type="button" className="btn btn--small" onClick={copy} aria-live="polite">
      {done === 'copied' ? 'Copied ✓' : done === 'failed' ? 'Select and copy' : label}
    </button>
  );
}

/** The new code and link, shown once: the server keeps only a hash. */
function FreshCode({
  code,
  invite,
  onDone,
}: {
  code: string;
  invite: AdminInvite;
  onDone: () => void;
}) {
  const link = inviteLink(code, window.location.origin);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div
      className="keepseal"
      role="status"
      tabIndex={-1}
      ref={ref}
      aria-labelledby="keepseal-title"
    >
      <p className="caps keepseal__caps">Shown once · copy it now</p>
      <p
        id="keepseal-title"
        className="keepseal__code"
        aria-label={`Invite code ${code.split('').join(' ')}`}
      >
        {code}
      </p>
      <div className="keepseal__row">
        <CopyButton text={code} label="Copy code" />
      </div>
      <p className="keepseal__link">
        <span className="caps">Link</span> <code>{link}</code>
      </p>
      <div className="keepseal__row">
        <CopyButton text={link} label="Copy link" />
        <button type="button" className="btn btn--small keepseal__done" onClick={onDone}>
          I have copied it
        </button>
      </div>
      <p className="keepseal__fine">
        {plural(invite.maxUses, 'use')}
        {invite.expiresAt ? `, expires ${formatWhen(invite.expiresAt)}` : ', never expires'}. Only
        its hash is stored: if it is lost, revoke it and create another.
      </p>
    </div>
  );
}

function InviteRow({
  invite: i,
  onRevoked,
}: {
  invite: AdminInvite;
  onRevoked: (i: AdminInvite) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revoke = async () => {
    setBusy(true);
    setError(null);
    const res = await adminApi.revokeInvite(i.id);
    setBusy(false);
    if (!res.ok) return setError(describeAdminFailure(res.error));
    setConfirm(false);
    onRevoked(res.value.invite);
  };
  return (
    <li className={`invite invite--${i.status}`}>
      <div className="invite__head">
        <span className={`invite__status invite__status--${i.status}`}>
          {STATUS_LABEL[i.status]}
        </span>
        <span className="invite__note">{i.note || <em>No note</em>}</span>
        <span className="invite__uses">
          {i.uses} / {i.maxUses} used
        </span>
      </div>
      <p className="invite__meta">
        Created {day(i.createdAt)} by{' '}
        {i.createdBy ? (
          <a href={adminHref('players', i.createdBy.handle)}>{i.createdBy.displayName}</a>
        ) : (
          'the server CLI'
        )}
        {' · '}
        {i.revokedAt
          ? `revoked ${day(i.revokedAt)}`
          : i.expiresAt
            ? `${i.status === 'expired' ? 'expired' : 'expires'} ${day(i.expiresAt)}`
            : 'never expires'}
      </p>
      {i.redeemedBy.length > 0 ? (
        <p className="invite__redeemed">
          <span className="caps">Joined with it</span>{' '}
          {i.redeemedBy.map((r, n) => (
            <span key={r.handle}>
              {n > 0 ? ', ' : ''}
              <a href={adminHref('players', r.handle)}>{r.displayName}</a>{' '}
              <span className="invite__handle">@{r.handle}</span>
            </span>
          ))}
        </p>
      ) : null}
      {i.status === 'active' || i.status === 'used_up' ? (
        <div className="invite__act">
          {confirm ? (
            <>
              <span>Revoke it? Accounts it created stay.</span>
              <button
                type="button"
                className="btn btn--small invite__revoke"
                onClick={revoke}
                disabled={busy}
                aria-busy={busy}
              >
                {busy ? 'Revoking…' : 'Revoke'}
              </button>
              <button
                type="button"
                className="btn btn--small"
                onClick={() => setConfirm(false)}
                disabled={busy}
              >
                Keep it
              </button>
            </>
          ) : (
            <button type="button" className="btn btn--small" onClick={() => setConfirm(true)}>
              Revoke…
            </button>
          )}
        </div>
      ) : null}
      {error ? (
        <p className="gate__alert" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}

// ---- Players -------------------------------------------------------------------------------

function PlayersFolio({ handle }: { handle: string | null }) {
  const ids = useId();
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<Load<{
    players: PlayerRow[];
    truncated: boolean;
    limit: number;
  }> | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setSearch({ kind: 'loading' });
    const res = await adminApi.searchPlayers(query.trim());
    setSearch(res.ok ? { kind: 'ready', value: res.value } : { kind: 'error', error: res.error });
  };

  return (
    <div className="strong__split">
      <div className="strong__side">
        <form
          className="seek panel-ledger"
          onSubmit={submit}
          role="search"
          aria-label="Find a player"
        >
          <div className="field">
            <label className="field__label caps" htmlFor={`${ids}-q`}>
              Display name or handle
            </label>
            <div className="field__well">
              <input
                id={`${ids}-q`}
                className="field__input"
                value={query}
                maxLength={64}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="e.g. Grim or d8amyqhw7jnh"
              />
            </div>
          </div>
          <button
            type="submit"
            className="btn"
            disabled={search?.kind === 'loading' || !query.trim()}
          >
            {search?.kind === 'loading' ? 'Searching…' : 'Search'}
          </button>
          {search?.kind === 'error' ? (
            <p className="gate__alert" role="alert">
              {describeAdminFailure(search.error)}
            </p>
          ) : null}
          {search?.kind === 'ready' && search.value.players.length === 0 ? (
            <p className="strong__note" role="status">
              Nobody by that name or handle.
            </p>
          ) : null}
          {search?.kind === 'ready' && search.value.players.length > 0 ? (
            <ol className="seek__list" aria-label="Matching players">
              {search.value.players.map((p) => (
                <li key={p.handle}>
                  <a
                    className="seek__row"
                    href={adminHref('players', p.handle)}
                    aria-current={p.handle === handle ? 'true' : undefined}
                  >
                    <span className="seek__name">{p.displayName}</span>
                    <span className="seek__meta">
                      @{p.handle} · {p.role} · joined {day(p.createdAt)}
                    </span>
                  </a>
                </li>
              ))}
            </ol>
          ) : null}
          {search?.kind === 'ready' && search.value.truncated ? (
            <p className="strong__note">First {search.value.limit} shown; narrow the search.</p>
          ) : null}
        </form>
      </div>
      <div className="strong__main">
        {handle ? (
          <PlayerFileView handle={handle} />
        ) : (
          <div className="strong__empty panel-ledger">
            <p className="display">Look a player up.</p>
            <p>
              Search by display name or handle. Their file shows account age, how they joined, their
              heroes, sanctions and reports. Read-only: act on reports in the moderator queue.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function accountAge(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return days < 1 ? 'less than a day' : plural(days, 'day');
}

function PlayerFileView({ handle }: { handle: string }) {
  const fetcher = useCallback((signal: AbortSignal) => adminApi.player(handle, signal), [handle]);
  const [state, reload] = useLoad(fetcher);
  if (state.kind === 'loading') return <Waiting>Opening the file…</Waiting>;
  if (state.kind === 'error') {
    return state.error.code === 'not_found' ? (
      <div className="strong__empty panel-ledger">
        <p className="display">No such player.</p>
        <p>No account has the handle @{handle}.</p>
      </div>
    ) : (
      <Failed what="The file could not be read." error={state.error} onRetry={reload} />
    );
  }
  const p: PlayerFile = state.value.player;
  const active = p.sanctions.filter((s) => s.status === 'active');
  const past = p.sanctions.filter((s) => s.status !== 'active');
  const open = p.reports.filter((r) => r.status === 'open');
  const closed = p.reports.filter((r) => r.status !== 'open');
  return (
    <article className="dossier panel-iron" aria-labelledby="dossier-title">
      <header className="dossier__head">
        <p className="caps">Player file · {p.role}</p>
        <h2 id="dossier-title" className="display">
          {p.displayName}
        </h2>
        <p className="dossier__sub">
          @{p.handle} · <a href={`#/profile/${p.handle}`}>Public profile</a>
        </p>
      </header>
      <dl className="dossier__facts">
        <div>
          <dt className="caps">Account age</dt>
          <dd>
            {accountAge(p.createdAt)}{' '}
            <span className="dossier__dim">(since {day(p.createdAt)})</span>
          </dd>
        </div>
        <div>
          <dt className="caps">Joined with</dt>
          <dd>
            {p.registration?.invite
              ? `Invite “${p.registration.invite.note || 'no note'}”`
              : p.registration
                ? 'No invite (open registration)'
                : 'Not recorded'}
          </dd>
        </div>
        <div>
          <dt className="caps">Heroes</dt>
          <dd>{p.characters.length === 0 ? 'None yet' : plural(p.characters.length, 'hero')}</dd>
        </div>
      </dl>

      {p.characters.length > 0 ? (
        <ul className="dossier__heroes" aria-label="Heroes">
          {p.characters.map((c) => (
            <li key={`${c.name}-${c.createdAt}`}>
              <span className="dossier__hero">{c.name}</span>
              <span className="dossier__dim">
                Level {c.level} {getClass(c.classId).name}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <h3 className="rule-heading">Sanctions</h3>
      {p.sanctions.length === 0 ? <p className="dossier__none">Never sanctioned.</p> : null}
      {active.length > 0 ? (
        <ul className="dossier__list" aria-label="Active sanctions">
          {active.map((s) => (
            <li key={s.id} className="dossier__entry dossier__entry--active">
              <p className="dossier__entry-head">
                <strong>{SANCTION_LABELS[s.kind]}</strong> · until {formatWhen(s.expiresAt)}
              </p>
              <p>“{s.reason}”</p>
              <p className="dossier__dim">
                Issued {day(s.createdAt)} by {s.issuedBy?.displayName ?? 'a removed account'}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
      {past.length > 0 ? (
        <ul className="dossier__list" aria-label="Past sanctions">
          {past.map((s) => (
            <li key={s.id} className="dossier__entry">
              <p className="dossier__entry-head">
                <strong>{SANCTION_LABELS[s.kind]}</strong> ·{' '}
                {s.status === 'lifted'
                  ? `lifted ${day(s.liftedAt!)}${s.liftedBy ? ` by ${s.liftedBy.displayName}` : ''}`
                  : `ended ${day(s.expiresAt)}`}
              </p>
              <p>“{s.reason}”</p>
              {s.liftReason ? <p className="dossier__dim">Lifted because: {s.liftReason}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {active.length > 0 && p.actionable ? (
        <p className="dossier__dim">Lift a sanction from the case in the moderator queue.</p>
      ) : null}

      <h3 className="rule-heading">Reports about them</h3>
      {p.reports.length === 0 ? <p className="dossier__none">No reports.</p> : null}
      {open.length > 0 ? (
        <ul className="dossier__list" aria-label="Open reports">
          {open.map((r) => (
            <li key={r.id} className="dossier__entry dossier__entry--open">
              <p className="dossier__entry-head">
                <strong>{REASON_LABEL[r.reason] ?? r.reason}</strong> · open since{' '}
                {day(r.createdAt)}
                {r.reporter ? ` · by ${r.reporter.displayName}` : ''}
              </p>
              {r.note ? <p className="dossier__note">{r.note}</p> : null}
              {p.actionable ? (
                <a className="btn btn--small" href={moderationCaseHref(r.id)}>
                  Open the case in the queue
                </a>
              ) : (
                <p className="dossier__dim">Reports about admins are handled outside the app.</p>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {closed.length > 0 ? (
        <ul className="dossier__list" aria-label="Closed reports">
          {closed.map((r) => (
            <li key={r.id} className="dossier__entry">
              <p className="dossier__entry-head">
                <strong>{REASON_LABEL[r.reason] ?? r.reason}</strong> ·{' '}
                {r.status === 'dismissed' ? 'dismissed' : 'actioned'}
                {r.resolvedAt ? ` ${day(r.resolvedAt)}` : ''}
                {r.resolvedBy ? ` by ${r.resolvedBy.displayName}` : ''}
              </p>
              {r.note ? <p className="dossier__note">{r.note}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {p.reportsTruncated ? <p className="dossier__dim">Showing the newest 100 reports.</p> : null}
    </article>
  );
}

// ---- Telemetry -----------------------------------------------------------------------------

function TelemetryFolio() {
  const ids = useId();
  const [form, setForm] = useState({ from: '', to: '', reconcile: false });
  const [query, setQuery] = useState(form);
  const fetcher = useCallback((signal: AbortSignal) => adminApi.telemetry(query, signal), [query]);
  const [state, reload] = useLoad(fetcher);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (JSON.stringify(form) === JSON.stringify(query)) reload();
    else setQuery(form);
  };
  return (
    <div className="almanac">
      <form className="almanac__form" onSubmit={submit} aria-label="Telemetry window">
        <div className="field">
          <label className="field__label caps" htmlFor={`${ids}-from`}>
            From (UTC day)
          </label>
          <div className="field__well">
            <input
              id={`${ids}-from`}
              type="date"
              className="field__input"
              value={form.from}
              onChange={(e) => setForm({ ...form, from: e.target.value })}
            />
          </div>
        </div>
        <div className="field">
          <label className="field__label caps" htmlFor={`${ids}-to`}>
            To (inclusive)
          </label>
          <div className="field__well">
            <input
              id={`${ids}-to`}
              type="date"
              className="field__input"
              value={form.to}
              onChange={(e) => setForm({ ...form, to: e.target.value })}
            />
          </div>
        </div>
        <label className="almanac__check">
          <input
            type="checkbox"
            checked={form.reconcile}
            onChange={(e) => setForm({ ...form, reconcile: e.target.checked })}
          />{' '}
          Check against the audit log (slow; 3 per 5 min)
        </label>
        <button type="submit" className="btn" disabled={state.kind === 'loading'}>
          {state.kind === 'loading' ? 'Counting…' : 'Show report'}
        </button>
      </form>
      {state.kind === 'loading' ? <Waiting>Adding up the rollups…</Waiting> : null}
      {state.kind === 'error' ? (
        <Failed what="The report could not be built." error={state.error} onRetry={reload} />
      ) : null}
      {state.kind === 'ready' ? (
        <TelemetryView report={state.value.report} sections={state.value.sections} />
      ) : null}
    </div>
  );
}

const numeric = (c: string | number) => typeof c === 'number' || /^(?:[+-]?[\d,.]+%?|—)$/.test(c);

function TelemetryView({
  report,
  sections,
}: {
  report: TelemetryReport;
  sections: TelemetrySection[];
}) {
  const w = report.window;
  const classes = [...new Set(report.snapshot.usage.map((u) => u.classId))].sort();
  return (
    <div className="almanac__body">
      <p className="almanac__window">
        <span className="caps">Window</span> {w.from ?? 'first day'} … {w.to ?? 'last day'}
        {w.days > 0 ? ` · recorded days ${w.firstDay} … ${w.lastDay} (${w.days})` : ''}
        <span className="dossier__dim"> · server-side aggregates, no player data</span>
      </p>
      {report.reconcile ? <Reconcile checks={report.reconcile} /> : null}
      {sections.length === 0 ? (
        <div className="strong__empty panel-ledger">
          <p className="display">No telemetry recorded in this window.</p>
          <p>
            Counters are written by farming settlements, crypt runs, quest turn-ins, the merchant
            and the forge. Widen the window or wait for play.
          </p>
        </div>
      ) : null}
      {sections.map((s) => (
        <section key={s.title} className="almanac__section panel-ledger" aria-label={s.title}>
          <h3 className="almanac__title">{s.title}</h3>
          {s.tables.map((t, n) => (
            <div
              key={n}
              className="almanac__scroll"
              tabIndex={0}
              role="region"
              aria-label={`${s.title}, table ${n + 1}`}
            >
              <table className="almanac__table">
                <thead>
                  <tr>
                    {t.headers.map((h, i) => (
                      <th
                        key={h}
                        scope="col"
                        className={
                          i > 0 && t.rows.some((r) => numeric(r[i] ?? '')) ? 'num' : undefined
                        }
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {t.rows.map((r, ri) => (
                    <tr key={ri}>
                      {r.map((c, ci) =>
                        ci === 0 ? (
                          <th key={ci} scope="row">
                            {c}
                          </th>
                        ) : (
                          <td key={ci} className={numeric(c) ? 'num' : undefined}>
                            {typeof c === 'number' ? c.toLocaleString('en-US') : c}
                          </td>
                        ),
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          {s.notes.map((n) => (
            <p key={n} className="almanac__note">
              {n}
            </p>
          ))}
        </section>
      ))}
      <section className="almanac__section panel-ledger" aria-label="Equipped now">
        <h3 className="almanac__title">
          Equipped now (snapshot, {plural(report.snapshot.equippedCharacters, 'hero')} with gear)
        </h3>
        {report.snapshot.equippedCharacters === 0 ? (
          <p className="almanac__note">Nobody has anything equipped yet.</p>
        ) : (
          <div className="almanac__classes">
            {classes.map((c) => {
              const top = (kind: string) =>
                report.snapshot.usage
                  .filter((u) => u.classId === c && u.kind === kind)
                  .slice(0, 6)
                  .map((u) => `${u.id} ${u.equipped}`)
                  .join(', ') || '—';
              const builds = report.snapshot.builds.filter((b) => b.classId === c);
              const heroes = builds.reduce((s, b) => s + b.characters, 0);
              return (
                <div key={c} className="almanac__class">
                  <h4 className="caps">{c}</h4>
                  <p>
                    <span className="dossier__dim">Bases</span> {top('base')}
                  </p>
                  <p>
                    <span className="dossier__dim">Effects</span> {top('effect')}
                  </p>
                  <p>
                    <span className="dossier__dim">Sets</span> {top('set')}
                  </p>
                  <p className="dossier__dim">
                    {plural(builds.length, 'distinct build')} among {plural(heroes, 'hero')}
                  </p>
                  <ol className="almanac__builds">
                    {builds.slice(0, 5).map((b) => (
                      <li key={b.signature}>
                        <span className="num">
                          {((100 * b.characters) / Math.max(1, heroes)).toFixed(0)}%
                        </span>{' '}
                        <code>{b.signature}</code>
                      </li>
                    ))}
                  </ol>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function Reconcile({ checks }: { checks: NonNullable<TelemetryReport['reconcile']> }) {
  const bad = checks.filter((c) => !c.ok);
  return (
    <div className={`tally${bad.length ? ' tally--bad' : ''}`} role="status">
      <p className="tally__head">
        {bad.length === 0
          ? `Audit log reconciliation: all ${checks.length} checks match (all time).`
          : `Audit log reconciliation: ${bad.length} of ${checks.length} checks differ (all time).`}
      </p>
      {bad.length > 0 ? (
        <ul>
          {bad.map((c) => (
            <li key={c.check}>
              {c.check}: audit {c.audit.toLocaleString('en-US')} vs rollup{' '}
              {c.rollup.toLocaleString('en-US')}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ---- Server status -------------------------------------------------------------------------

const MODE_TEXT: Record<ServerStatus['registrationMode'], string> = {
  open: 'Open: anyone can register',
  invite: 'Invite only',
  closed: 'Closed: no new accounts',
};

function StatusFolio() {
  const [state, reload] = useLoad(adminApi.status);
  return (
    <div>
      <div className="strong__bar">
        <h2 className="rule-heading">The keep&rsquo;s gauges</h2>
        <button
          type="button"
          className="btn btn--small"
          onClick={reload}
          disabled={state.kind === 'loading'}
        >
          Refresh
        </button>
      </div>
      {state.kind === 'loading' ? <Waiting>Reading the gauges…</Waiting> : null}
      {state.kind === 'error' ? (
        <Failed what="The status could not be read." error={state.error} onRetry={reload} />
      ) : null}
      {state.kind === 'ready' ? <StatusView s={state.value} /> : null}
    </div>
  );
}

function StatusView({ s }: { s: ServerStatus }) {
  const m = s.migrations;
  return (
    <div className="gauges">
      <div className="gauge">
        <p className="caps">Version</p>
        <p className="gauge__value">
          {s.build.gitSha ? s.build.gitSha.slice(0, 12) : 'Not recorded'}
        </p>
        <p className="gauge__fine">
          {s.build.buildTime
            ? `Built ${formatWhen(s.build.buildTime)}`
            : 'A development build (no image labels).'}
        </p>
      </div>
      <div className="gauge">
        <p className="caps">Uptime</p>
        <p className="gauge__value">{formatUptime(s.uptimeSeconds)}</p>
        <p className="gauge__fine">Since {formatWhen(s.startedAt)}</p>
      </div>
      <div className={`gauge gauge--${s.db.status === 'up' ? 'good' : 'bad'}`}>
        <p className="caps">Database</p>
        <p className="gauge__value">{s.db.status === 'up' ? 'Up' : 'Down'}</p>
        <p className="gauge__fine">
          {s.db.latencyMs !== null ? `Answered in ${s.db.latencyMs} ms` : 'No answer'}
        </p>
      </div>
      <div className="gauge">
        <p className="caps">Registration</p>
        <p className="gauge__value">{MODE_TEXT[s.registrationMode]}</p>
        <p className="gauge__fine">
          <code>REGISTRATION_MODE</code> in deploy/.env
        </p>
      </div>
      <div className="gauge gauge--wide">
        <p className="caps">Population</p>
        {s.counts ? (
          <dl className="gauge__counts">
            <div>
              <dt>Accounts</dt>
              <dd>{s.counts.accounts.toLocaleString('en-GB')}</dd>
            </div>
            <div>
              <dt>Heroes</dt>
              <dd>{s.counts.characters.toLocaleString('en-GB')}</dd>
            </div>
            <div>
              <dt>Active 24 h</dt>
              <dd>{s.counts.active24h.toLocaleString('en-GB')}</dd>
            </div>
            <div>
              <dt>Active 7 d</dt>
              <dd>{s.counts.active7d.toLocaleString('en-GB')}</dd>
            </div>
          </dl>
        ) : (
          <p className="gauge__fine">Not available while the database is down.</p>
        )}
        <p className="gauge__fine">Active = any signed-in request in the window (counts only).</p>
      </div>
      <div className={`gauge gauge--wide${m && m.pending.length > 0 ? ' gauge--bad' : ''}`}>
        <p className="caps">Migrations</p>
        {m ? (
          <>
            <p className="gauge__value">
              {m.pending.length === 0
                ? 'Up to date'
                : `${plural(m.pending.length, 'migration')} pending`}
            </p>
            <p className="gauge__fine">
              {m.applied} applied of {m.available} shipped · newest {m.latest ?? '—'}
            </p>
            {m.pending.length > 0 ? (
              <p className="gauge__fine">
                Pending: {m.pending.join(', ')}. Run <code>deploy/deploy.sh</code>.
              </p>
            ) : null}
          </>
        ) : (
          <p className="gauge__fine">Could not be read.</p>
        )}
      </div>
      {s.projects && s.projects.length > 0 ? (
        <div className="gauge gauge--wide">
          <p className="caps">Town works</p>
          <dl className="gauge__counts">
            {s.projects.map((p) => (
              <div key={p.id}>
                <dt>{p.name}</dt>
                <dd>
                  {p.status === 'complete'
                    ? `Done ${p.completedOn ?? ''}`
                    : p.status === 'locked'
                      ? 'Not begun'
                      : `Stage ${p.stage}/${p.stages}: ${p.current
                          .map(
                            (n) =>
                              `${n.resource} ${n.delivered.toLocaleString('en-GB')}/${n.required.toLocaleString('en-GB')}`,
                          )
                          .join(', ')}`}
                </dd>
              </div>
            ))}
          </dl>
          <p className="gauge__fine">
            Contributors: {s.projects.map((p) => p.contributors).join(' · ')}. Playtest only:{' '}
            <code>deploy/admin.sh project complete &lt;id&gt;</code>.
          </p>
        </div>
      ) : null}
    </div>
  );
}

// ---- Roles ---------------------------------------------------------------------------------

function RolesFolio() {
  const [state, reload] = useLoad(adminApi.roles);
  return (
    <div className="strong__split strong__split--roles">
      <div className="strong__main">
        <h2 className="rule-heading">Wardens and admins</h2>
        {state.kind === 'loading' ? <Waiting>Calling the roll…</Waiting> : null}
        {state.kind === 'error' ? (
          <Failed what="The roll could not be read." error={state.error} onRetry={reload} />
        ) : null}
        {state.kind === 'ready' ? <RolesList staff={state.value.staff} /> : null}
      </div>
      <aside className="strong__side writ-cli panel-iron" aria-labelledby="cli-title">
        <p className="caps">Read-only here</p>
        <h2 id="cli-title" className="display">
          Roles change on the server
        </h2>
        <p>
          No button grants or revokes a role, and no API route does: a stolen admin session must not
          be able to make more admins. Change roles on the VPS:
        </p>
        <pre className="writ-cli__code">
          <code>
            deploy/admin.sh grant &lt;email|handle&gt; moderator{'\n'}deploy/admin.sh grant
            &lt;email|handle&gt; admin
            {'\n'}deploy/admin.sh revoke &lt;email|handle&gt;
          </code>
        </pre>
        <p className="dossier__dim">
          In development: <code>pnpm admin:role grant …</code>. Every change is audited.
        </p>
      </aside>
    </div>
  );
}

function RolesList({ staff }: { staff: StaffMember[] }) {
  if (staff.length === 0) return <p className="dossier__none">Nobody holds a role.</p>;
  return (
    <ul className="staffroll">
      {staff.map((s) => (
        <li key={s.handle} className={`staffroll__row roll__row--${s.role}`}>
          <span className={`staffroll__role roll__role--${s.role}`}>
            {s.role === 'admin' ? 'Admin' : 'Moderator'}
          </span>
          <a className="staffroll__name" href={adminHref('players', s.handle)}>
            {s.displayName}
          </a>
          <span className="staffroll__meta">
            @{s.handle} ·{' '}
            {s.grantedAt
              ? `granted ${day(s.grantedAt)}`
              : `account since ${day(s.accountCreatedAt)}`}
          </span>
        </li>
      ))}
    </ul>
  );
}
