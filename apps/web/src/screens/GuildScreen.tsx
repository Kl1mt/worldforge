import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  GUILD_EMBLEMS,
  GUILD_ROLE_LABELS,
  PRESENCE_LABELS,
  guildDecision,
  guildEmblem,
  validatePlayerText,
  type GuildAction,
  type GuildRole,
  type GuildTarget,
} from '@worldforge/game-core';
import type { ApiResult } from '../lib/api';
import { guildHandleFromHash, guildHref, profileHref } from '../lib/route';
import { formatNumber } from '../lib/format';
import { useCharacters } from '../characters/CharactersProvider';
import { useAuth } from '../auth/AuthProvider';
import { ReportDialog } from '../social/ReportDialog';
import { Crest } from '../social/Crest';
import {
  describeGuildFailure,
  guildApi,
  useGuildHall,
  type GuildHallView,
  type GuildMemberEntry,
  type GuildPerson,
  type GuildProfile,
  type GuildSummary,
  type MyGuild,
} from '../social/guilds';
import { Gold, ShopHeader } from './economy/ShopHeader';
import './gate.css';
import './friends.css';
import './economy/shop.css';
import './guild.css';

/**
 * The Guild Hall (ticket 4.4). `#/guild`: your guild — a hanging banner with the crest, the guildroll
 * roll by rank with presence lanterns (guildmates only), and the officers' ledger (recruit,
 * petitions, invites sent, the banner, leaving) — or, without one, the hall's board: found a guild
 * (gold from a hero), invitations, your petitions and a search. `#/guild/<handle>`: a guild's
 * public profile with apply and report. Buttons follow game-core's `guildDecision`, the same table
 * the server enforces.
 */
export function GuildScreen() {
  const handle = useGuildHandle();
  return handle ? <GuildProfileScreen key={handle} handle={handle} /> : <GuildHall />;
}

function useGuildHandle(): string | null {
  const [handle, setHandle] = useState(() => guildHandleFromHash(window.location.hash));
  useEffect(() => {
    const on = () => setHandle(guildHandleFromHash(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return handle;
}

type Notice = { kind: 'ok' | 'error'; text: string } | null;

/** Runs one action at a time, then refreshes and says what happened. */
function useRunner(reload: () => void) {
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, action: () => Promise<ApiResult<unknown>>, done: string) => {
    setBusy(key);
    setNotice(null);
    const res = await action();
    setBusy(null);
    setNotice(
      res.ok
        ? { kind: 'ok', text: done }
        : { kind: 'error', text: describeGuildFailure(res.error) },
    );
    reload();
    return res.ok;
  };
  /** A success that happened elsewhere (founding): say so and refresh. */
  const announce = (text: string) => {
    setNotice({ kind: 'ok', text });
    reload();
  };
  return { notice, busy, run, announce };
}

function NoticeLine({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return (
    <p
      className={`fellowship__notice fellowship__notice--${notice.kind}`}
      role={notice.kind === 'error' ? 'alert' : 'status'}
    >
      {notice.text}
    </p>
  );
}

const nameOf = (p: GuildPerson) => p.displayName ?? 'A player whose name is hidden';

function GuildName({ guild }: { guild: Pick<GuildSummary, 'name' | 'tag'> }) {
  return (
    <>
      {guild.name} <span className="guild-tag">[{guild.tag}]</span>
    </>
  );
}

function Who({ person, link = true }: { person: GuildPerson; link?: boolean }) {
  const cls = `fellow__name${person.displayName ? '' : ' fellow__name--hidden'}`;
  const name = person.displayName ?? 'Name withheld';
  return (
    <span className="fellow__who">
      {link && person.displayName ? (
        <a className={cls} href={profileHref(person.handle)}>
          {name}
        </a>
      ) : (
        <span className={cls}>{name}</span>
      )}
      <span className="fellow__handle">@{person.handle}</span>
    </span>
  );
}

/** A destructive button that asks once more before acting. */
function ConfirmButton({
  label,
  confirm,
  busy,
  onConfirm,
}: {
  label: string;
  confirm: string;
  busy: boolean;
  onConfirm: () => void;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button
        type="button"
        className="btn btn--small"
        onClick={() => setAsking(true)}
        disabled={busy}
      >
        {label}
      </button>
    );
  }
  return (
    <span className="fellow__confirm">
      <button
        type="button"
        className="btn btn--small btn--danger"
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
        disabled={busy}
        aria-busy={busy}
      >
        {confirm}
      </button>
      <button type="button" className="btn btn--small" onClick={() => setAsking(false)}>
        Keep
      </button>
    </span>
  );
}

// -----------------------------------------------------------------------------------------------
// The hall: your guild, or the board

function GuildHall() {
  const { state, reload } = useGuildHall();
  const runner = useRunner(reload);
  return (
    <section className="guildhall" aria-labelledby="guild-title">
      {state.kind === 'loading' ? (
        <>
          <HallHeader />
          <p className="fellowship__wait" role="status">
            The steward unrolls the hall’s ledgers…
          </p>
        </>
      ) : null}
      {state.kind === 'error' ? (
        <>
          <HallHeader />
          <div className="gate__alert" role="alert">
            <p>{describeGuildFailure(state.error)}</p>
            <button type="button" className="btn btn--small" onClick={reload}>
              Try again
            </button>
          </div>
        </>
      ) : null}
      {state.kind === 'ready' && state.view.guild ? (
        <MyGuildPage guild={state.view.guild} stale={state.stale} runner={runner} />
      ) : null}
      {state.kind === 'ready' && !state.view.guild ? (
        <HallBoard view={state.view} runner={runner} />
      ) : null}
    </section>
  );
}

function HallHeader() {
  return (
    <ShopHeader building="guildHall" title="The Guild Hall">
      Banners hang from the rafters, one for every company sworn in Graumark. Found your own, or
      find one that will have you.
    </ShopHeader>
  );
}

type Runner = ReturnType<typeof useRunner>;

function HallBoard({ view, runner }: { view: GuildHallView; runner: Runner }) {
  const { notice, busy, run } = runner;
  return (
    <>
      <HallHeader />
      {view.notice ? <LeftNotice notice={view.notice} /> : null}
      <NoticeLine notice={notice} />
      <div className="guildhall__body">
        <FoundGuild cost={view.createCost} onDone={runner.announce} />
        <aside className="guildhall__side">
          <div className="letters panel-ledger">
            <h2 className="rule-heading">
              Invitations
              {view.invites.length ? <span className="new-tag">{view.invites.length}</span> : null}
            </h2>
            {view.invites.length === 0 ? (
              <p className="fellowship__empty">No guild has sent for you.</p>
            ) : (
              <ul className="letters__list">
                {view.invites.map((i) => (
                  <li key={i.guild.handle} className="letters__row">
                    <GuildLine guild={i.guild} by={i.invitedBy} />
                    <span className="letters__actions">
                      <button
                        type="button"
                        className="btn btn--small btn--brass"
                        disabled={busy === `accept:${i.guild.handle}`}
                        onClick={() =>
                          run(
                            `accept:${i.guild.handle}`,
                            () => guildApi.acceptInvite(i.guild.handle),
                            `You swear yourself to ${i.guild.name}.`,
                          )
                        }
                      >
                        Join
                      </button>
                      <button
                        type="button"
                        className="btn btn--small"
                        disabled={busy === `decline:${i.guild.handle}`}
                        onClick={() =>
                          run(
                            `decline:${i.guild.handle}`,
                            () => guildApi.declineInvite(i.guild.handle),
                            'Invitation declined.',
                          )
                        }
                      >
                        Decline
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {view.applications.length > 0 ? (
              <>
                <h3 className="caps letters__sub">
                  Your petitions ({view.applications.length} of {view.limits.applicationsPerAccount}
                  )
                </h3>
                <ul className="letters__list">
                  {view.applications.map((a) => (
                    <li key={a.guild.handle} className="letters__row">
                      <GuildLine guild={a.guild} />
                      <button
                        type="button"
                        className="btn btn--small"
                        disabled={busy === `withdraw:${a.guild.handle}`}
                        onClick={() =>
                          run(
                            `withdraw:${a.guild.handle}`,
                            () => guildApi.withdraw(a.guild.handle),
                            'Petition withdrawn.',
                          )
                        }
                      >
                        Withdraw
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
          <FindGuild limit={view.limits.members} />
        </aside>
      </div>
    </>
  );
}

function LeftNotice({ notice }: { notice: NonNullable<GuildHallView['notice']> }) {
  const text =
    notice.kind === 'kicked'
      ? `You were struck from the roll of ${notice.guildName} on ${notice.on}.`
      : notice.kind === 'disbanded'
        ? `${notice.guildName} was disbanded by its leader on ${notice.on}.`
        : `The wardens disbanded ${notice.guildName} on ${notice.on}.`;
  return (
    <p className="guild-strip guild-strip--crimson" role="status">
      {text}
      {notice.reason ? <span className="guild-strip__reason"> Reason: {notice.reason}</span> : null}
    </p>
  );
}

function GuildLine({ guild, by }: { guild: GuildSummary; by?: GuildPerson | null }) {
  return (
    <span className="guildline">
      <Crest emblem={guild.emblem} size="sm" />
      <span className="fellow__who">
        <a className="fellow__name" href={guildHref(guild.handle)}>
          <GuildName guild={guild} />
        </a>
        <span className="guildline__meta">
          {guild.memberCount} {guild.memberCount === 1 ? 'member' : 'members'}
          {by ? ` · sent by ${nameOf(by)}` : ''}
        </span>
      </span>
    </span>
  );
}

function FoundGuild({ cost, onDone }: { cost: number; onDone: (text: string) => void }) {
  const roster = useCharacters();
  const heroes = roster.state.kind === 'ready' ? roster.state.roster.characters : [];
  const [heroId, setHeroId] = useState(() => roster.active?.id ?? heroes[0]?.id ?? '');
  const [name, setName] = useState('');
  const [tag, setTag] = useState('');
  const [emblem, setEmblem] = useState<string>(GUILD_EMBLEMS[0].id);
  const [errors, setErrors] = useState<{ name?: string; tag?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  // One key per founding attempt: a retry after a lost answer replays instead of paying twice.
  const key = useRef<string>(crypto.randomUUID());
  const id = useId();
  const hero = heroes.find((h) => h.id === heroId);
  const short = hero ? hero.gold < cost : true;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = validatePlayerText('guildName', name);
    const t = validatePlayerText('guildTag', tag.toUpperCase());
    const next = {
      ...(n.ok ? {} : { name: n.message }),
      ...(t.ok ? {} : { tag: t.message }),
    };
    setErrors(next);
    if (!n.ok || !t.ok || !hero) return;
    setBusy(true);
    const res = await guildApi.found(
      { characterId: hero.id, name: n.value, tag: t.value, emblem },
      key.current,
    );
    setBusy(false);
    if (res.ok) {
      key.current = crypto.randomUUID();
      roster.updateCharacter(res.value.character);
      onDone(`${res.value.guild.name} is founded. Its banner hangs in the hall.`);
      return;
    }
    // A refusal stored nothing; the next attempt is a new action.
    key.current = crypto.randomUUID();
    const f = res.error.fields ?? {};
    setErrors({
      ...(f.name ? { name: f.name } : {}),
      ...(f.tag ? { tag: f.tag } : {}),
      ...(f.name || f.tag ? {} : { form: describeGuildFailure(res.error) }),
    });
  };

  return (
    <form className="founding panel-iron" onSubmit={submit} noValidate aria-labelledby={`${id}-t`}>
      <h2 id={`${id}-t`} className="rule-heading">
        Found a guild
      </h2>
      <p className="fellowship__fine">
        The steward records the charter for <Gold amount={cost} />, paid from one hero’s purse. You
        lead it; up to 30 may swear to it. One guild per account.
      </p>
      <div className="founding__crest">
        <Crest emblem={emblem} size="lg" />
        <p className="founding__preview display">
          {name.trim() || 'Your guild'}{' '}
          <span className="guild-tag">[{tag.toUpperCase() || '—'}]</span>
        </p>
      </div>
      <Field
        id={`${id}-name`}
        label="Guild name"
        error={errors.name}
        hint="3–24 letters, numbers, spaces."
      >
        <input
          id={`${id}-name`}
          className="field__input"
          value={name}
          maxLength={40}
          autoComplete="off"
          aria-invalid={Boolean(errors.name)}
          aria-describedby={`${id}-name-msg`}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field
        id={`${id}-tag`}
        label="Tag"
        error={errors.tag}
        hint="2–5 capitals or digits, shown as [TAG]."
      >
        <input
          id={`${id}-tag`}
          className="field__input field__input--tag"
          value={tag}
          maxLength={5}
          autoComplete="off"
          aria-invalid={Boolean(errors.tag)}
          aria-describedby={`${id}-tag-msg`}
          onChange={(e) => setTag(e.target.value.toUpperCase())}
        />
      </Field>
      <fieldset className="emblems">
        <legend className="field__label caps">Crest</legend>
        <div className="emblems__row">
          {GUILD_EMBLEMS.map((e) => (
            <label
              key={e.id}
              className={`emblems__chip${emblem === e.id ? ' emblems__chip--on' : ''}`}
            >
              <input
                type="radio"
                name={`${id}-emblem`}
                value={e.id}
                checked={emblem === e.id}
                onChange={() => setEmblem(e.id)}
              />
              <Crest emblem={e.id} size="sm" />
              <span>{e.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="field">
        <label className="field__label caps" htmlFor={`${id}-hero`}>
          Paid by
        </label>
        <div className="field__well">
          <select
            id={`${id}-hero`}
            className="field__input"
            value={heroId}
            onChange={(e) => setHeroId(e.target.value)}
          >
            {heroes.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name} — {formatNumber(h.gold)} gold
              </option>
            ))}
          </select>
        </div>
        <p className={short ? 'field__error' : 'field__hint'}>
          {short
            ? `${hero?.name ?? 'This hero'} needs ${formatNumber(cost - (hero?.gold ?? 0))} more gold.`
            : `${hero!.name} keeps ${formatNumber(hero!.gold - cost)} gold afterwards.`}
        </p>
      </div>
      {errors.form ? (
        <p className="field__error" role="alert">
          {errors.form}
        </p>
      ) : null}
      <button type="submit" className="btn btn--brass" disabled={busy || short} aria-busy={busy}>
        {busy ? 'Sealing the charter…' : `Found the guild · ${formatNumber(cost)} gold`}
      </button>
    </form>
  );
}

function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error: string | undefined;
  hint: string;
  children: ReactNode;
}) {
  return (
    <div className={`field${error ? ' field--invalid' : ''}`}>
      <label className="field__label caps" htmlFor={id}>
        {label}
      </label>
      <div className="field__well">{children}</div>
      <p id={`${id}-msg`} className={error ? 'field__error' : 'field__hint'}>
        {error ?? hint}
      </p>
    </div>
  );
}

function FindGuild({ limit }: { limit: number }) {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; guilds: GuildSummary[] }
    | { kind: 'error'; text: string }
  >({ kind: 'loading' });
  const id = useId();
  useEffect(() => {
    const controller = new AbortController();
    guildApi.search(query, controller.signal).then(
      (res) =>
        setResult(
          res.ok
            ? { kind: 'ready', guilds: res.value.guilds }
            : { kind: 'error', text: describeGuildFailure(res.error) },
        ),
      () => {
        /* aborted */
      },
    );
    return () => controller.abort();
  }, [query]);
  return (
    <div className="letters panel-ledger">
      <h2 className="rule-heading">Banners in the hall</h2>
      <form
        className="findguild"
        onSubmit={(e) => {
          e.preventDefault();
          setResult({ kind: 'loading' });
          setQuery(q.trim());
        }}
      >
        <label className="field__label caps" htmlFor={id}>
          Name or tag
        </label>
        <div className="findguild__row">
          <div className="field__well">
            <input
              id={id}
              className="field__input"
              value={q}
              maxLength={40}
              autoComplete="off"
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <button type="submit" className="btn btn--small">
            Search
          </button>
        </div>
      </form>
      {result.kind === 'loading' ? <p className="fellowship__wait">Reading the banners…</p> : null}
      {result.kind === 'error' ? (
        <p className="field__error" role="alert">
          {result.text}
        </p>
      ) : null}
      {result.kind === 'ready' && result.guilds.length === 0 ? (
        <p className="fellowship__empty">
          {query ? 'No banner by that name.' : 'No guild has room right now. Found the first.'}
        </p>
      ) : null}
      {result.kind === 'ready' && result.guilds.length > 0 ? (
        <ul className="letters__list">
          {result.guilds.map((g) => (
            <li key={g.handle} className="letters__row">
              <GuildLine guild={g} />
              <span className="guildline__count">
                {g.memberCount}/{limit}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// -----------------------------------------------------------------------------------------------
// Your guild

const RANKS: { role: GuildRole; title: string }[] = [
  { role: 'leader', title: 'Leader' },
  { role: 'officer', title: 'Officers' },
  { role: 'member', title: 'Sworn members' },
];

function MyGuildPage({ guild, stale, runner }: { guild: MyGuild; stale: boolean; runner: Runner }) {
  const { notice, busy, run } = runner;
  const [reporting, setReporting] = useState<GuildMemberEntry | null>(null);
  const me = guild.role;
  const auth = useAuth();
  const selfHandle = auth.state.kind === 'authenticated' ? auth.state.account.handle : null;
  const can = (action: GuildAction, target?: GuildTarget) =>
    guildDecision(me, action, target) === 'allowed';
  const officer = can('viewRequests');

  return (
    <>
      <header className={`guildbanner guildbanner--${guildEmblem(guild.emblem).id}`}>
        <div className="guildbanner__cloth">
          <Crest emblem={guild.emblem} size="lg" />
        </div>
        <div className="guildbanner__intro">
          <p className="caps guildbanner__where">Guild Hall · founded {guild.foundedOn}</p>
          <h1 id="guild-title" className="display guildbanner__title">
            <GuildName guild={guild} />
          </h1>
          <p className="guildbanner__meta">
            {guild.memberCount} of 30 sworn · you are {GUILD_ROLE_LABELS[me].toLowerCase()}
            {stale ? ' · could not refresh, showing the last roll' : ''}
          </p>
          <p className="fellowship__fine">
            <a href={guildHref(guild.handle)}>The guild as others see it</a>
          </p>
        </div>
      </header>

      {guild.renameRequired ? (
        <RenameStrip guild={guild} canRename={can('rename')} run={run} busy={busy} />
      ) : null}
      <NoticeLine notice={notice} />

      <div className="guildhall__body">
        <div className="guildroll panel-iron">
          {RANKS.map(({ role, title }) => {
            const rows = guild.members.filter((m) => m.role === role);
            if (rows.length === 0 && role !== 'member') return null;
            return (
              <section
                key={role}
                className={`guildroll__rank guildroll__rank--${role}`}
                aria-label={title}
              >
                <h2 className="rule-heading">
                  {title} <span className="guildroll__count">{rows.length}</span>
                </h2>
                {rows.length === 0 ? (
                  <p className="fellowship__empty">
                    No one has sworn in yet. Officers send for recruits.
                  </p>
                ) : (
                  <ul className="roll">
                    {rows.map((m) => (
                      <MemberRow
                        key={m.handle}
                        member={m}
                        self={m.handle === selfHandle}
                        can={can}
                        busy={busy}
                        run={run}
                        onReport={setReporting}
                      />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
          <p className="fellowship__fine">
            Guildmates see each other’s lantern (“online now”, “today”, “this week”), never a time.
            Hide yours on the Companions screen.
          </p>
        </div>

        <aside className="guildhall__side">
          {officer ? <Recruit guild={guild} run={run} busy={busy} /> : null}
          {officer ? <Petitions guild={guild} run={run} busy={busy} /> : null}
          {can('setEmblem') ? <BannerPicker guild={guild} run={run} busy={busy} /> : null}
          <Departure guild={guild} me={me} run={run} busy={busy} />
        </aside>
      </div>

      <ReportDialog
        open={reporting !== null}
        onClose={() => setReporting(null)}
        {...(reporting
          ? {
              target: {
                target: { kind: 'player' as const, handle: reporting.handle },
                label: nameOf(reporting),
              },
            }
          : {})}
      />
    </>
  );
}

type Run = Runner['run'];

function MemberRow({
  member: m,
  self,
  can,
  busy,
  run,
  onReport,
}: {
  member: GuildMemberEntry;
  self: boolean;
  can: (action: GuildAction, target?: GuildTarget) => boolean;
  busy: string | null;
  run: Run;
  onReport: (m: GuildMemberEntry) => void;
}) {
  const target: GuildTarget = self ? 'self' : m.role;
  const presence = m.presence ?? 'hidden';
  const who = nameOf(m);
  return (
    <li className={`roll__row guildroll__row${m.blocked ? ' letters__row--struck' : ''}`}>
      <span className={`lantern lantern--${presence}`} aria-hidden="true" />
      <Who person={m} link={!m.blocked} />
      <span className={`roll__presence roll__presence--${presence}`}>
        {self
          ? 'You'
          : m.blocked
            ? 'You block them'
            : m.presence
              ? PRESENCE_LABELS[m.presence]
              : 'Keeps to the shadows'}
      </span>
      <span className="roll__actions">
        {can('promote', target) ? (
          <button
            type="button"
            className="btn btn--small"
            disabled={busy === `promote:${m.handle}`}
            onClick={() =>
              run(
                `promote:${m.handle}`,
                () => guildApi.promote(m.handle),
                `${who} is now an officer.`,
              )
            }
          >
            Make officer
          </button>
        ) : null}
        {can('demote', target) ? (
          <button
            type="button"
            className="btn btn--small"
            disabled={busy === `demote:${m.handle}`}
            onClick={() =>
              run(
                `demote:${m.handle}`,
                () => guildApi.demote(m.handle),
                `${who} is a member again.`,
              )
            }
          >
            Demote
          </button>
        ) : null}
        {can('transferLeadership', target) ? (
          <ConfirmButton
            label="Hand over"
            confirm="Make them leader?"
            busy={busy === `transfer:${m.handle}`}
            onConfirm={() =>
              run(
                `transfer:${m.handle}`,
                () => guildApi.transfer(m.handle),
                `${who} leads the guild now; you are an officer.`,
              )
            }
          />
        ) : null}
        {can('kick', target) ? (
          <ConfirmButton
            label="Strike off"
            confirm="Remove them?"
            busy={busy === `kick:${m.handle}`}
            onConfirm={() =>
              run(
                `kick:${m.handle}`,
                () => guildApi.kick(m.handle),
                `${who} is struck from the roll.`,
              )
            }
          />
        ) : null}
        {!self ? (
          <button type="button" className="btn btn--small" onClick={() => onReport(m)}>
            Report
          </button>
        ) : null}
      </span>
    </li>
  );
}

function RenameStrip({
  guild,
  canRename,
  run,
  busy,
}: {
  guild: MyGuild;
  canRename: boolean;
  run: Run;
  busy: string | null;
}) {
  const [name, setName] = useState('');
  const [tag, setTag] = useState('');
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  return (
    <div className="guild-strip guild-strip--brass" role="status">
      <p>
        <strong>The wardens renamed this guild.</strong>
        {guild.renameReason ? ` Reason: ${guild.renameReason}.` : ''}{' '}
        {canRename ? 'Choose a new name and tag.' : 'The leader chooses a new name.'}
      </p>
      {canRename ? (
        <form
          className="guild-strip__form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const n = validatePlayerText('guildName', name);
            const t = validatePlayerText('guildTag', tag.toUpperCase());
            if (!n.ok || !t.ok) {
              setError(!n.ok ? n.message : (t as { message: string }).message);
              return;
            }
            setError(null);
            void run(
              'rename',
              () => guildApi.rename(n.value, t.value),
              `The guild is now ${n.value}.`,
            );
          }}
        >
          <label className="field__label caps" htmlFor={`${id}-n`}>
            New name
          </label>
          <div className="field__well">
            <input
              id={`${id}-n`}
              className="field__input"
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <label className="field__label caps" htmlFor={`${id}-t`}>
            Tag
          </label>
          <div className="field__well">
            <input
              id={`${id}-t`}
              className="field__input field__input--tag"
              value={tag}
              maxLength={5}
              onChange={(e) => setTag(e.target.value.toUpperCase())}
            />
          </div>
          <button type="submit" className="btn btn--small btn--brass" disabled={busy === 'rename'}>
            Rename
          </button>
          {error ? <p className="field__error">{error}</p> : null}
        </form>
      ) : null}
    </div>
  );
}

function Recruit({ guild, run, busy }: { guild: MyGuild; run: Run; busy: string | null }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const full = guild.memberCount >= 30;
  return (
    <form
      className="letters panel-ledger"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        const check = validatePlayerText('displayName', name);
        if (!check.ok) {
          setError(check.problem === 'too_short' ? 'Enter a display name.' : check.message);
          return;
        }
        setError(null);
        if (
          await run(
            'invite',
            () => guildApi.inviteByName(check.value),
            `An invitation is on its way to ${check.value}.`,
          )
        ) {
          setName('');
        }
      }}
    >
      <h2 className="rule-heading">Send for a recruit</h2>
      <div className={`field${error ? ' field--invalid' : ''}`}>
        <label className="field__label caps" htmlFor={id}>
          Display name
        </label>
        <div className="field__well">
          <input
            id={id}
            className="field__input"
            value={name}
            maxLength={64}
            autoComplete="off"
            aria-invalid={Boolean(error)}
            aria-describedby={`${id}-msg`}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <p id={`${id}-msg`} className={error ? 'field__error' : 'field__hint'}>
          {error ??
            (full ? 'The roll is full (30).' : 'They find the invitation in their Guild Hall.')}
        </p>
      </div>
      <button
        type="submit"
        className="btn btn--brass"
        disabled={busy === 'invite' || full}
        aria-busy={busy === 'invite'}
      >
        {busy === 'invite' ? 'Sending…' : 'Invite'}
      </button>
    </form>
  );
}

function Petitions({ guild, run, busy }: { guild: MyGuild; run: Run; busy: string | null }) {
  return (
    <div className="letters panel-ledger">
      <h2 className="rule-heading">
        Petitions at the door
        {guild.applications.length ? (
          <span className="new-tag">{guild.applications.length}</span>
        ) : null}
      </h2>
      {guild.applications.length === 0 ? (
        <p className="fellowship__empty">No one is asking to join.</p>
      ) : (
        <ul className="letters__list">
          {guild.applications.map((a) => (
            <li key={a.player.handle} className="letters__row">
              <Who person={a.player} />
              <span className="letters__actions">
                <button
                  type="button"
                  className="btn btn--small btn--brass"
                  disabled={busy === `take:${a.player.handle}`}
                  onClick={() =>
                    run(
                      `take:${a.player.handle}`,
                      () => guildApi.acceptApplication(a.player.handle),
                      `${nameOf(a.player)} swears in.`,
                    )
                  }
                >
                  Take in
                </button>
                <button
                  type="button"
                  className="btn btn--small"
                  disabled={busy === `turn:${a.player.handle}`}
                  onClick={() =>
                    run(
                      `turn:${a.player.handle}`,
                      () => guildApi.declineApplication(a.player.handle),
                      'Petition turned away.',
                    )
                  }
                >
                  Turn away
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {guild.invites.length > 0 ? (
        <>
          <h3 className="caps letters__sub">Invitations sent ({guild.invites.length})</h3>
          <ul className="letters__list">
            {guild.invites.map((i) => (
              <li key={i.player.handle} className="letters__row">
                <Who person={i.player} />
                <button
                  type="button"
                  className="btn btn--small"
                  disabled={busy === `cancel:${i.player.handle}`}
                  onClick={() =>
                    run(
                      `cancel:${i.player.handle}`,
                      () => guildApi.cancelInvite(i.player.handle),
                      'Invitation withdrawn.',
                    )
                  }
                >
                  Withdraw
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function BannerPicker({ guild, run, busy }: { guild: MyGuild; run: Run; busy: string | null }) {
  return (
    <div className="letters panel-ledger">
      <h2 className="rule-heading">The banner</h2>
      <div className="emblems__row" role="group" aria-label="Choose the guild’s crest">
        {GUILD_EMBLEMS.map((e) => (
          <button
            key={e.id}
            type="button"
            className={`emblems__chip${guild.emblem === e.id ? ' emblems__chip--on' : ''}`}
            aria-pressed={guild.emblem === e.id}
            disabled={busy === 'emblem'}
            onClick={() =>
              run(
                'emblem',
                () => guildApi.emblem(e.id),
                `The banner now shows the ${e.label.toLowerCase()}.`,
              )
            }
          >
            <Crest emblem={e.id} size="sm" />
            <span>{e.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Departure({
  guild,
  me,
  run,
  busy,
}: {
  guild: MyGuild;
  me: GuildRole;
  run: Run;
  busy: string | null;
}) {
  const [typed, setTyped] = useState('');
  const id = useId();
  if (me !== 'leader') {
    return (
      <div className="letters panel-ledger">
        <h2 className="rule-heading">Leave the guild</h2>
        <p className="fellowship__fine">
          You can join another afterwards; your place here is not kept.
        </p>
        <ConfirmButton
          label="Leave"
          confirm={`Leave ${guild.name}?`}
          busy={busy === 'leave'}
          onConfirm={() => run('leave', () => guildApi.leave(), `You left ${guild.name}.`)}
        />
      </div>
    );
  }
  return (
    <details className="letters panel-ledger departure">
      <summary className="caps">Leaving or disbanding</summary>
      <p className="fellowship__fine">
        A leader cannot simply leave: hand the leadership to a member on the roll (“Hand over”), or
        disband the guild. Disbanding removes everyone and frees the name; the gold is not returned.
      </p>
      <form
        className="departure__form"
        onSubmit={(e) => {
          e.preventDefault();
          void run('disband', () => guildApi.disband(typed), `${guild.name} is disbanded.`);
        }}
      >
        <label className="field__label caps" htmlFor={id}>
          Type “{guild.name}” to disband
        </label>
        <div className="field__well">
          <input
            id={id}
            className="field__input"
            value={typed}
            autoComplete="off"
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>
        <button
          type="submit"
          className="btn btn--small btn--danger"
          disabled={busy === 'disband' || typed.trim().toLowerCase() !== guild.name.toLowerCase()}
        >
          Disband the guild
        </button>
      </form>
    </details>
  );
}

// -----------------------------------------------------------------------------------------------
// A guild's public profile

function GuildProfileScreen({ handle }: { handle: string }) {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; profile: GuildProfile }
    | { kind: 'missing' }
    | { kind: 'error'; text: string }
  >({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const reload = () => setAttempt((n) => n + 1);
  const { notice, busy, run } = useRunner(reload);
  const [reporting, setReporting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    guildApi.profile(handle, controller.signal).then(
      (res) =>
        setState(
          res.ok
            ? { kind: 'ready', profile: res.value }
            : res.error.status === 404
              ? { kind: 'missing' }
              : { kind: 'error', text: describeGuildFailure(res.error) },
        ),
      () => {
        /* aborted */
      },
    );
    return () => controller.abort();
  }, [handle, attempt]);

  if (state.kind === 'loading') {
    return (
      <section className="guildhall" aria-busy="true">
        <p className="fellowship__wait" role="status">
          Looking for the banner…
        </p>
      </section>
    );
  }
  if (state.kind === 'missing' || state.kind === 'error') {
    return (
      <section className="guildhall" aria-labelledby="guild-title">
        <h1 id="guild-title" className="display guildbanner__title">
          {state.kind === 'missing' ? 'No such banner' : 'The hall is closed'}
        </h1>
        <div className="gate__alert" role="alert">
          <p>
            {state.kind === 'missing'
              ? 'No guild hangs that banner. It may have been disbanded.'
              : state.text}
          </p>
          {state.kind === 'error' ? (
            <button type="button" className="btn btn--small" onClick={reload}>
              Try again
            </button>
          ) : null}
        </div>
        <p className="fellowship__fine">
          <a href={guildHref()}>Back to the Guild Hall</a>
        </p>
      </section>
    );
  }

  const { guild, members, standing } = state.profile;
  return (
    <section className="guildhall" aria-labelledby="guild-title">
      <header className={`guildbanner guildbanner--${guildEmblem(guild.emblem).id}`}>
        <div className="guildbanner__cloth">
          <Crest emblem={guild.emblem} size="lg" />
        </div>
        <div className="guildbanner__intro">
          <p className="caps guildbanner__where">Guild · founded {guild.foundedOn}</p>
          <h1 id="guild-title" className="display guildbanner__title">
            <GuildName guild={guild} />
          </h1>
          <p className="guildbanner__meta">{guild.memberCount} of 30 sworn</p>
          <div className="guildbanner__actions">
            <StandingAction guild={guild} standing={standing} run={run} busy={busy} />
            {standing !== 'member' ? (
              <button type="button" className="btn btn--small" onClick={() => setReporting(true)}>
                Report this guild
              </button>
            ) : null}
          </div>
        </div>
      </header>
      <NoticeLine notice={notice} />
      <div className="guildroll guildroll--public panel-iron">
        {RANKS.map(({ role, title }) => {
          const rows = members.filter((m) => m.role === role);
          if (rows.length === 0) return null;
          return (
            <section key={role} className="guildroll__rank" aria-label={title}>
              <h2 className="rule-heading">
                {title} <span className="guildroll__count">{rows.length}</span>
              </h2>
              <ul className="roll">
                {rows.map((m) => (
                  <li key={m.handle} className="roll__row guildroll__row guildroll__row--public">
                    <span className="guildroll__pip" aria-hidden="true" />
                    <Who person={m} />
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      <p className="fellowship__fine">
        <a href={guildHref()}>Back to the Guild Hall</a>
      </p>
      <ReportDialog
        open={reporting}
        onClose={() => setReporting(false)}
        target={{
          target: { kind: 'guild', handle: guild.handle },
          label: `${guild.name} [${guild.tag}]`,
        }}
      />
    </section>
  );
}

function StandingAction({
  guild,
  standing,
  run,
  busy,
}: {
  guild: GuildSummary;
  standing: GuildProfile['standing'];
  run: Run;
  busy: string | null;
}) {
  switch (standing) {
    case 'member':
      return (
        <a className="btn btn--small" href={guildHref()}>
          Your guild
        </a>
      );
    case 'otherGuild':
      return <p className="fellowship__fine">You are sworn to another guild.</p>;
    case 'invited':
      return (
        <>
          <button
            type="button"
            className="btn btn--brass btn--small"
            disabled={busy === 'join'}
            onClick={() =>
              run(
                'join',
                () => guildApi.acceptInvite(guild.handle),
                `You swear yourself to ${guild.name}.`,
              )
            }
          >
            Accept the invitation
          </button>
          <button
            type="button"
            className="btn btn--small"
            disabled={busy === 'decline'}
            onClick={() =>
              run('decline', () => guildApi.declineInvite(guild.handle), 'Invitation declined.')
            }
          >
            Decline
          </button>
        </>
      );
    case 'applied':
      return (
        <button
          type="button"
          className="btn btn--small"
          disabled={busy === 'withdraw'}
          onClick={() =>
            run('withdraw', () => guildApi.withdraw(guild.handle), 'Petition withdrawn.')
          }
        >
          Withdraw your petition
        </button>
      );
    case 'none':
      return (
        <button
          type="button"
          className="btn btn--brass btn--small"
          disabled={busy === 'apply' || guild.memberCount >= 30}
          onClick={() =>
            run('apply', () => guildApi.apply(guild.handle), 'Your petition is with the officers.')
          }
        >
          {guild.memberCount >= 30 ? 'The roll is full' : 'Petition to join'}
        </button>
      );
  }
}
