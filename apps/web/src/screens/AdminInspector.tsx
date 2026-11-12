import { useCallback, useId, useState, type FormEvent } from 'react';
import { PROFESSIONS, SANCTION_LABELS, type SanctionKind } from '@worldforge/game-core';
import { adminApi, describeAdminFailure, type PlayerRow } from '../admin/api';
import { toolsApi, type AccountFile, type HeroFile } from '../admin/tools-api';
import {
  cheatAccess,
  auditLine,
  formatLock,
  materialName,
  nf,
  type CheatAccess,
} from '../admin/tools-view';
import type { ApiFailure } from '../lib/api';
import { adminHref } from '../lib/route';
import { formatWhen } from '../social/api';
import { answered, Failed, Waiting, WritHost, useAdminLoad, useWrit } from './AdminToolKit';
import {
  DailyResetTool,
  FastForwardTool,
  GoldTool,
  MaterialsTool,
  ProfessionsTool,
  ProgressTool,
  QuestsTool,
  RenameTool,
  XpLevelTool,
  areaName,
  className,
  deleteWrit,
  restoreWrit,
  type HeroCtx,
} from './AdminHeroTools';
import { GrantItemTool, ItemLedger } from './AdminItemTools';
import { ViewAsSheet } from './AdminViewAs';
import './admin-tools.css';

/**
 * Ticket D.4: the inspector folio of the admin panel ("Support & testing"). Find an account, open
 * its file: who it is, its shelf, sanctions, offers and recent audit, and each hero with its
 * items and the tool bench. Support tools work on any account; testing (cheat) tools only on test
 * accounts and the admin's own. Every write goes through the action writ (AdminToolKit).
 */
export function AdminInspector({ handle }: { handle: string | null }) {
  return (
    <div className="strong__split adt-split">
      <div className="strong__side">
        <AccountSeek handle={handle} />
      </div>
      <div className="strong__main">
        {handle ? (
          <AccountInspector key={handle} handle={handle} />
        ) : (
          <div className="strong__empty panel-ledger">
            <p className="display">Open an account.</p>
            <p>
              Search by display name or handle. The file shows the account, its heroes and items,
              and the support and testing tools. Every action asks for a reason and lands in the
              audit log.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

const DAY = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const day = (iso: string) => DAY.format(new Date(iso));

function AccountSeek({ handle }: { handle: string | null }) {
  const ids = useId();
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; players: PlayerRow[]; truncated: boolean; limit: number }
    | { kind: 'error'; error: ApiFailure }
    | null
  >(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setSearch({ kind: 'loading' });
    const res = await adminApi.searchPlayers(query.trim());
    setSearch(res.ok ? { kind: 'ready', ...res.value } : { kind: 'error', error: res.error });
  };
  return (
    <form
      className="seek panel-ledger"
      onSubmit={submit}
      role="search"
      aria-label="Find an account"
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
      <button type="submit" className="btn" disabled={search?.kind === 'loading' || !query.trim()}>
        {search?.kind === 'loading' ? 'Searching…' : 'Search'}
      </button>
      {search?.kind === 'error' ? (
        <p className="gate__alert" role="alert">
          {describeAdminFailure(search.error)}
        </p>
      ) : null}
      {search?.kind === 'ready' && search.players.length === 0 ? (
        <p className="strong__note" role="status">
          Nobody by that name or handle.
        </p>
      ) : null}
      {search?.kind === 'ready' && search.players.length > 0 ? (
        <ol className="seek__list" aria-label="Matching accounts">
          {search.players.map((p) => (
            <li key={p.handle}>
              <a
                className="seek__row"
                href={adminHref('inspect', p.handle)}
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
      {search?.kind === 'ready' && search.truncated ? (
        <p className="strong__note">First {search.limit} shown; narrow the search.</p>
      ) : null}
    </form>
  );
}

type Tab = { kind: 'hero'; id: string } | { kind: 'shelf' } | { kind: 'deleted' };

function AccountInspector({ handle }: { handle: string }) {
  const fetcher = useCallback((signal: AbortSignal) => toolsApi.account(handle, signal), [handle]);
  const [state, refresh] = useAdminLoad(fetcher);
  const [flash, setFlash] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [viewAs, setViewAs] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab | null>(null);

  const onSuccess = useCallback(
    (message: string) => {
      setFlash(message);
      setGeneration((g) => g + 1);
      refresh();
    },
    [refresh],
  );

  if (state.kind === 'loading') return <Waiting>Opening the account file…</Waiting>;
  if (state.kind === 'error') {
    return state.error.code === 'not_found' ? (
      <div className="strong__empty panel-ledger">
        <p className="display">No such account.</p>
        <p>No account has the handle @{handle}.</p>
      </div>
    ) : (
      <Failed what="The account file could not be read." error={state.error} onRetry={refresh} />
    );
  }
  const account = state.value.account;
  if (viewAs) {
    return (
      <ViewAsSheet handle={account.handle} characterId={viewAs} onBack={() => setViewAs(null)} />
    );
  }
  const cheat = cheatAccess(account);
  const live = account.heroes.filter((h) => !h.deleted);
  const deleted = account.heroes.filter((h) => h.deleted);
  // The chosen tab, or the first hero; a hero deleted meanwhile falls back to the first.
  const current: Tab =
    tab && (tab.kind !== 'hero' || live.some((h) => h.id === tab.id))
      ? tab
      : live[0]
        ? { kind: 'hero', id: live[0].id }
        : { kind: 'shelf' };
  const hero = current.kind === 'hero' ? live.find((h) => h.id === current.id)! : null;

  return (
    <WritHost onSuccess={onSuccess}>
      <article
        className="adt-file panel-iron"
        aria-labelledby="adt-file-title"
        aria-busy={state.refreshing}
      >
        <AccountHead account={account} />
        <CheatNotice cheat={cheat} handle={account.handle} />
        {flash ? (
          <p className="adt-flash" role="status">
            {flash}{' '}
            <button type="button" className="adt-link" onClick={() => setFlash(null)}>
              Dismiss
            </button>
          </p>
        ) : null}
        {state.refreshing ? <Waiting>Reading the file again…</Waiting> : null}

        <nav className="adt-tabs" aria-label="Heroes and shelf">
          {live.map((h) => (
            <button
              key={h.id}
              type="button"
              className="adt-tab"
              aria-pressed={current.kind === 'hero' && current.id === h.id}
              onClick={() => setTab({ kind: 'hero', id: h.id })}
            >
              <span className="adt-tab__name">{h.name}</span>
              <span className="adt-tab__hint">
                Level {h.level} {className(h.classId)}
              </span>
            </button>
          ))}
          <button
            type="button"
            className="adt-tab"
            aria-pressed={current.kind === 'shelf'}
            onClick={() => setTab({ kind: 'shelf' })}
          >
            <span className="adt-tab__name">Account shelf</span>
            <span className="adt-tab__hint">
              {nf(account.shelf.gold)} gold · {account.shelf.items.length} items
            </span>
          </button>
          <button
            type="button"
            className="adt-tab"
            aria-pressed={current.kind === 'deleted'}
            onClick={() => setTab({ kind: 'deleted' })}
          >
            <span className="adt-tab__name">Deleted heroes</span>
            <span className="adt-tab__hint">{deleted.length === 0 ? 'None' : deleted.length}</span>
          </button>
        </nav>
        {live.length === 0 && current.kind === 'shelf' ? (
          <p className="adt-none">This account has no live heroes.</p>
        ) : null}

        {hero ? (
          <HeroPanel
            key={`${hero.id}-${generation}`}
            ctx={{ account, hero, cheat }}
            others={live.length - 1}
            onViewAs={() => setViewAs(hero.id)}
          />
        ) : null}
        {current.kind === 'shelf' ? <ShelfPanel account={account} /> : null}
        {current.kind === 'deleted' ? (
          <DeletedPanel account={account} heroes={deleted} onViewAs={setViewAs} />
        ) : null}

        <AccountRecords account={account} />
      </article>
    </WritHost>
  );
}

function AccountHead({ account }: { account: AccountFile }) {
  const openWrit = useWrit();
  const used = account.heroes.filter((h) => !h.deleted).length;
  const logoutAll = () =>
    openWrit({
      caps: `Support · @${account.handle}`,
      title: 'Log out everywhere',
      destructive: true,
      changes: [
        `All ${account.sessions} active sessions of ${account.displayName} end at once, on every device.`,
        'They sign in again with their password; nothing else changes.',
        ...(account.own ? ['This is your own account: you are logged out too.'] : []),
      ],
      confirm: { expected: account.handle, what: 'the account handle' },
      action: 'Log out everywhere',
      busy: 'Logging out…',
      run: (key, reason, confirm) =>
        answered(
          toolsApi.revokeSessions(account.handle, key, { confirm, reason }),
          (a) => `${a.revoked} sessions ended.`,
        ),
    });
  const clearLock = () =>
    openWrit({
      caps: `Support · @${account.handle}`,
      title: 'Clear the login lock',
      changes: [
        `Sign-in is ${formatLock(account.loginLockedForMs)} after failed attempts; this lifts it now.`,
        'Failed-attempt counting starts over.',
      ],
      action: 'Clear the lock',
      busy: 'Clearing…',
      run: (key, reason) =>
        answered(toolsApi.clearLoginLock(account.handle, key, { reason }), (a) =>
          a.wasLockedForMs > 0 ? 'The login lock is cleared.' : 'It was not locked any more.',
        ),
    });
  return (
    <header className="adt-file__head">
      <div className="adt-file__who">
        <p className="caps">Account file · {account.role}</p>
        <h2 id="adt-file-title" className="display">
          {account.displayName}
        </h2>
        <p className="adt-dim">
          @{account.handle} · <a href={adminHref('players', account.handle)}>Player file</a> ·{' '}
          <a href={`#/profile/${account.handle}`}>Public profile</a>
        </p>
      </div>
      <div className="adt-stamps">
        {account.testAccount ? (
          <span className="adt-stamp adt-stamp--test">Test account</span>
        ) : (
          <span className="adt-stamp">Normal account</span>
        )}
        {account.own ? <span className="adt-stamp adt-stamp--own">Your account</span> : null}
      </div>
      <dl className="adt-facts">
        <div>
          <dt className="caps">Created</dt>
          <dd>{day(account.createdAt)}</dd>
        </div>
        <div>
          <dt className="caps">Email verified</dt>
          <dd>{account.emailVerified ? 'Yes' : 'No'}</dd>
        </div>
        <div>
          <dt className="caps">Sessions</dt>
          <dd>{account.sessions}</dd>
        </div>
        <div>
          <dt className="caps">Login</dt>
          <dd className={account.loginLockedForMs > 0 ? 'adt-warn' : undefined}>
            {formatLock(account.loginLockedForMs)}
          </dd>
        </div>
        <div>
          <dt className="caps">Hero slots</dt>
          <dd>
            {used} of {account.characterSlots} used
          </dd>
        </div>
      </dl>
      <div className="adt-file__act">
        <button
          type="button"
          className="btn btn--small"
          onClick={logoutAll}
          disabled={account.sessions === 0}
        >
          Log out everywhere…
        </button>
        <button
          type="button"
          className="btn btn--small"
          onClick={clearLock}
          disabled={account.loginLockedForMs <= 0}
        >
          Clear login lock…
        </button>
      </div>
    </header>
  );
}

function CheatNotice({ cheat, handle }: { cheat: CheatAccess; handle: string }) {
  const tools =
    'Testing tools (grant items, gold, materials and XP, set level, progress and professions, daily resets, quests, fast-forward) work only on test accounts and on your own account.';
  return (
    <div className={`adt-notice adt-notice--${cheat}`} role="note">
      {cheat === 'test' ? (
        <p>
          <strong>Test account.</strong> Every tool works here. {tools}
        </p>
      ) : null}
      {cheat === 'own' ? (
        <p>
          <strong>Your own account, not a test account.</strong> Testing tools work, but what they
          change shows on public boards (leaderboards, profile, guild). {tools}
        </p>
      ) : null}
      {cheat === 'blocked' ? (
        <p>
          <strong>Testing tools are off for this account.</strong> {tools} Support tools (refund,
          remove, rename, delete, sessions) work here.
        </p>
      ) : null}
      <p className="adt-dim">
        Test accounts are marked on the server only:{' '}
        <code>deploy/admin.sh test-account {handle} on|off</code>.
      </p>
    </div>
  );
}

function yes(b: boolean | undefined) {
  return b ? 'yes' : 'no';
}

function HeroPanel({
  ctx,
  others,
  onViewAs,
}: {
  ctx: HeroCtx;
  others: number;
  onViewAs: () => void;
}) {
  const { account, hero, cheat } = ctx;
  const openWrit = useWrit();
  const tiers = ['none', 'I', 'II', 'III'];
  const materials = Object.entries(hero.materials).filter(([, n]) => n > 0);
  return (
    <section className="adt-hero" aria-labelledby={`adt-hero-${hero.id}`}>
      <header className="adt-hero__head">
        <div>
          <h3 id={`adt-hero-${hero.id}`} className="display adt-hero__name">
            {hero.name}
          </h3>
          <p className="adt-dim">
            Level {hero.level} {className(hero.classId)} · {nf(hero.experience)} XP ·{' '}
            {nf(hero.gold)} gold · created {day(hero.createdAt)}
          </p>
        </div>
        <div className="adt-hero__act">
          <button type="button" className="btn btn--small" onClick={onViewAs}>
            View as player (read-only)
          </button>
          <button
            type="button"
            className="btn btn--small adt-btn--grave"
            onClick={() => openWrit(deleteWrit(ctx, others))}
          >
            Delete hero…
          </button>
        </div>
      </header>

      <dl className="adt-facts adt-facts--hero">
        <div>
          <dt className="caps">Activity</dt>
          <dd>
            {hero.activity
              ? `Farming ${areaName(hero.activity.areaId)}, settled ${formatWhen(hero.activity.settledAt)}`
              : 'Not farming'}
          </dd>
        </div>
        <div>
          <dt className="caps">Progress</dt>
          <dd>
            Gravewarden {yes(hero.progress.gravewardenDefeated)} · crypt tier{' '}
            {tiers[hero.progress.cryptTierCleared ?? 0]} · Ashen Warden{' '}
            {yes(hero.progress.ashenWardenDefeated)} · Forge Tyrant{' '}
            {yes(hero.progress.forgeTyrantDefeated)} · Hollow Sovereign{' '}
            {yes(hero.progress.hollowSovereignDefeated)}
          </dd>
        </div>
        <div>
          <dt className="caps">Professions</dt>
          <dd>
            {hero.professions.length === 0
              ? 'All level 1'
              : hero.professions
                  .map(
                    (p) =>
                      `${PROFESSIONS.find((x) => x.id === p.professionId)?.name ?? p.professionId} ${p.level}`,
                  )
                  .join(' · ')}
          </dd>
        </div>
        <div>
          <dt className="caps">Today</dt>
          <dd>
            {hero.daily.ratedDuels} rated duels · {hero.daily.contracts}/
            {hero.daily.contractsPerDay} contracts · {hero.daily.merchantBought} bought
          </dd>
        </div>
        <div>
          <dt className="caps">Arena defence</dt>
          <dd>
            {hero.defence
              ? `Set at level ${hero.defence.level} (${hero.defence.bracketId})`
              : 'None'}
          </dd>
        </div>
        <div>
          <dt className="caps">Warehouse</dt>
          <dd>Level {hero.warehouseLevel}</dd>
        </div>
        <div>
          <dt className="caps">Materials</dt>
          <dd>
            {materials.length === 0
              ? 'None'
              : materials.map(([id, n]) => `${materialName(id)} ${nf(n)}`).join(' · ')}
          </dd>
        </div>
        <div>
          <dt className="caps">Trade holds</dt>
          <dd>
            {hero.holds.length === 0
              ? 'None'
              : hero.holds
                  .map(
                    (h) =>
                      `${nf(h.gold)} gold, ${h.items} items${Object.keys(h.materials).length ? ', materials' : ''} until ${formatWhen(h.heldUntil)}`,
                  )
                  .join('; ')}
          </dd>
        </div>
      </dl>

      <h4 className="rule-heading">Items</h4>
      <ItemLedger
        account={account}
        items={hero.items}
        heroes={account.heroes}
        label={`${hero.name}’s items`}
      />

      <h4 className="rule-heading">Support tools</h4>
      <div className="adt-bench">
        <GoldTool {...ctx} />
        <MaterialsTool {...ctx} />
        <RenameTool {...ctx} />
      </div>

      <h4 className="rule-heading">Testing tools</h4>
      {cheat === 'blocked' ? (
        <p className="adt-tool__blocked">
          Off for this account: test accounts and your own account only.
        </p>
      ) : null}
      <div className="adt-bench">
        <GrantItemTool account={account} hero={hero} cheat={cheat} />
        <XpLevelTool {...ctx} />
        <ProgressTool {...ctx} />
        <ProfessionsTool {...ctx} />
        <DailyResetTool {...ctx} />
        <FastForwardTool {...ctx} />
        <QuestsTool {...ctx} />
      </div>
    </section>
  );
}

function ShelfPanel({ account }: { account: AccountFile }) {
  const mats = Object.entries(account.shelf.materials).filter(([, n]) => n > 0);
  return (
    <section className="adt-hero" aria-labelledby="adt-shelf-title">
      <h3 id="adt-shelf-title" className="display adt-hero__name">
        Account shelf
      </h3>
      <p className="adt-dim">
        Shared by all heroes of the account. {nf(account.shelf.gold)} gold
        {mats.length > 0
          ? `; ${mats.map(([id, n]) => `${materialName(id)} ${nf(n)}`).join(', ')}`
          : '; no materials'}
        .
      </p>
      <ItemLedger
        account={account}
        items={account.shelf.items}
        heroes={account.heroes}
        shelf
        label="Shelf items"
      />
    </section>
  );
}

function DeletedPanel({
  account,
  heroes,
  onViewAs,
}: {
  account: AccountFile;
  heroes: HeroFile[];
  onViewAs: (id: string) => void;
}) {
  const openWrit = useWrit();
  if (heroes.length === 0) {
    return <p className="adt-none">No deleted heroes on this account.</p>;
  }
  return (
    <ul className="adt-graves" aria-label="Deleted heroes">
      {heroes.map((h) => (
        <li key={h.id} className="adt-grave">
          <p>
            <strong className="adt-grave__name">{h.name}</strong>{' '}
            <span className="adt-dim">
              Level {h.level} {className(h.classId)}
            </span>
          </p>
          <p>
            Deleted {formatWhen(h.deleted!.at)} · “{h.deleted!.reason}”
          </p>
          <p className="adt-dim">
            {h.deleted!.restorable
              ? `Restorable until ${formatWhen(h.deleted!.restoreUntil)}.`
              : `Not restorable (the window ended ${formatWhen(h.deleted!.restoreUntil)} or no slot is free). After 14 days only the server CLI purge, deploy/admin.sh purge, removes it for good.`}
          </p>
          <div className="adt-row__act">
            <button
              type="button"
              className="btn btn--small"
              disabled={!h.deleted!.restorable}
              onClick={() => openWrit(restoreWrit(account, h))}
            >
              Restore…
            </button>
            <button type="button" className="btn btn--small" onClick={() => onViewAs(h.id)}>
              View as player (read-only)
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

function AccountRecords({ account }: { account: AccountFile }) {
  return (
    <div className="adt-records">
      <section aria-labelledby="adt-sanctions">
        <h3 id="adt-sanctions" className="rule-heading">
          Sanctions
        </h3>
        {account.sanctions.length === 0 ? <p className="adt-none">Never sanctioned.</p> : null}
        <ul className="adt-rows">
          {account.sanctions.map((s) => (
            <li key={s.id} className={`adt-row${s.active ? ' adt-row--active' : ''}`}>
              <span>
                <strong>{SANCTION_LABELS[s.kind as SanctionKind] ?? s.kind}</strong>{' '}
                <span className="adt-dim">
                  ·{' '}
                  {s.active
                    ? `until ${formatWhen(s.expiresAt)}`
                    : s.liftedAt
                      ? `lifted ${day(s.liftedAt)}`
                      : `ended ${day(s.expiresAt)}`}{' '}
                  · issued {day(s.createdAt)}
                </span>
                <br />“{s.reason}”
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="adt-offers">
        <h3 id="adt-offers" className="rule-heading">
          Open offers
        </h3>
        {account.offers.length === 0 ? <p className="adt-none">No open trade offers.</p> : null}
        <ul className="adt-rows">
          {account.offers.map((o) => (
            <li key={o.id} className="adt-row">
              <span>
                <strong>{o.direction === 'sent' ? 'Sent to' : 'Received from'}</strong>{' '}
                {o.counterpart
                  ? `${o.counterpart.displayName} (@${o.counterpart.handle})`
                  : 'a removed account'}{' '}
                <span className="adt-dim">
                  · {o.status} · made {formatWhen(o.createdAt)} · expires {formatWhen(o.expiresAt)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="adt-audit" className="adt-records__wide">
        <h3 id="adt-audit" className="rule-heading">
          Recent audit
        </h3>
        {account.audit.length === 0 ? <p className="adt-none">Nothing recorded yet.</p> : null}
        {account.audit.length > 0 ? (
          <ol className="adt-audit">
            {account.audit.map((a) => (
              <li key={a.id}>
                <span className="adt-audit__when">{formatWhen(a.at)}</span>
                <span className="adt-audit__event">{a.event}</span>
                <span className="adt-audit__hero">{a.heroName ?? '–'}</span>
                <code className="adt-audit__data" title={auditLine(a.data, 2000)}>
                  {auditLine(a.data)}
                </code>
              </li>
            ))}
          </ol>
        ) : null}
      </section>
    </div>
  );
}
