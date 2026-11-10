import { useCallback, useState } from 'react';
import { getWorldFlag, isWorldFlagId, seasonName } from '@worldforge/game-core';
import { toolsApi, type WorldView } from '../admin/tools-api';
import { nf } from '../admin/tools-view';
import { formatDuration } from '../lib/format';
import { formatWhen } from '../social/api';
import { answered, Failed, Waiting, WritHost, useAdminLoad, useWrit } from './AdminToolKit';
import './admin-tools.css';

/**
 * Ticket D.4: the world folio ("Flags & scheduler"). The global world flags with set / unset
 * (each through the writ: it changes the game for every player), the scheduler's heartbeat and
 * jobs, the season roll and the deleted heroes waiting for the CLI purge.
 */
export function AdminWorld() {
  const [state, refresh] = useAdminLoad(toolsApi.world);
  const [flash, setFlash] = useState<string | null>(null);
  const onSuccess = useCallback(
    (message: string) => {
      setFlash(message);
      refresh();
    },
    [refresh],
  );

  return (
    <WritHost onSuccess={onSuccess}>
      <div className="adt-world">
        <div className="strong__bar">
          <h2 className="rule-heading">The world</h2>
          <button type="button" className="btn btn--small" onClick={refresh}>
            Refresh
          </button>
        </div>
        {flash ? (
          <p className="adt-flash" role="status">
            {flash}
          </p>
        ) : null}
        {state.kind === 'loading' ? <Waiting>Reading the world ledger…</Waiting> : null}
        {state.kind === 'error' ? (
          <Failed what="The world could not be read." error={state.error} onRetry={refresh} />
        ) : null}
        {state.kind === 'ready' ? <WorldBody world={state.value} /> : null}
      </div>
    </WritHost>
  );
}

function flagName(id: string): string {
  return isWorldFlagId(id) ? getWorldFlag(id).opens : id;
}

function WorldBody({ world }: { world: WorldView }) {
  const openWrit = useWrit();
  const toggle = (f: WorldView['flags'][number]) => {
    const set = !f.set;
    openWrit({
      caps: 'World · every player',
      title: `${set ? 'Set' : 'Unset'} the flag “${f.id}”`,
      destructive: true,
      warning: (
        <>
          <strong>This changes the world for every player at once.</strong> World flags are normally
          set only by a finished community project.
        </>
      ),
      changes: [
        set
          ? `${flagName(f.id)} opens for every hero who meets its other conditions.`
          : `${flagName(f.id)} closes again for every player.`,
        f.projectId
          ? `It was set by the community project ${f.projectId}; that project stays as it is.`
          : 'No community project is linked to it.',
      ],
      confirm: { expected: f.id, what: 'the flag id' },
      action: set ? 'Set the flag' : 'Unset the flag',
      busy: 'Sending…',
      run: (key, reason, confirm) =>
        answered(
          toolsApi.setWorldFlag(f.id, key, { set, confirm, reason }),
          (a) => `“${a.flagId}” is now ${a.after ? 'set' : 'unset'}.`,
        ),
    });
  };
  const s = world.scheduler;
  const { current, next, pendingArchive } = world.seasons;
  return (
    <div className="adt-world__cols">
      <section className="panel-ledger adt-world__flags" aria-labelledby="adt-flags">
        <h3 id="adt-flags" className="rule-heading">
          World flags
        </h3>
        <p className="adt-dim">Game time {formatWhen(world.gameNow)}.</p>
        {world.flags.length === 0 ? <p className="adt-none">No world flags exist.</p> : null}
        <ul className="adt-flags">
          {world.flags.map((f) => (
            <li key={f.id} className={`adt-flag${f.set ? ' adt-flag--set' : ''}`}>
              <div>
                <p className="adt-flag__name">
                  <span aria-hidden="true">{f.set ? '◆' : '◇'}</span> {flagName(f.id)}{' '}
                  <code className="adt-dim">{f.id}</code>
                </p>
                <p className="adt-dim">
                  {f.set
                    ? `Set ${f.setAt ? formatWhen(f.setAt) : '(time not recorded)'}${f.projectId ? ` by project ${f.projectId}` : ''}.`
                    : 'Not set.'}
                </p>
              </div>
              <button type="button" className="btn btn--small" onClick={() => toggle(f)}>
                {f.set ? 'Unset…' : 'Set…'}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="adt-world__side" aria-labelledby="adt-sched">
        <h3 id="adt-sched" className="rule-heading">
          Scheduler
        </h3>
        <dl className="adt-facts adt-facts--two">
          <div>
            <dt className="caps">State</dt>
            <dd className={s.running ? 'adt-ok' : 'adt-warn'}>
              {s.running ? 'Running' : 'Stopped'}
            </dd>
          </div>
          <div>
            <dt className="caps">Every</dt>
            <dd>{formatDuration(s.intervalMs)}</dd>
          </div>
          <div>
            <dt className="caps">Last tick</dt>
            <dd>{s.lastTickAt ? formatWhen(s.lastTickAt) : 'Not yet'}</dd>
          </div>
          <div>
            <dt className="caps">Next tick (about)</dt>
            <dd>{s.nextTickAt ? formatWhen(s.nextTickAt) : 'Unknown'}</dd>
          </div>
        </dl>
        {s.jobs.length === 0 ? <p className="adt-none">No jobs have run yet.</p> : null}
        <ul className="adt-rows">
          {s.jobs.map((j) => (
            <li
              key={j.job}
              className={`adt-row adt-job${j.ok === false ? ' adt-job--bad' : j.ok ? ' adt-job--ok' : ''}`}
            >
              <span>
                <strong>{j.job}</strong>{' '}
                <span className="adt-dim">
                  · {j.lastRunAt ? formatWhen(j.lastRunAt) : 'never run'} ·{' '}
                  {j.ok === null ? 'no result' : j.ok ? 'ok' : 'failed'}
                </span>
                {j.detail ? <span className="adt-job__detail">{j.detail}</span> : null}
              </span>
            </li>
          ))}
        </ul>

        <h3 className="rule-heading">Seasons</h3>
        <dl className="adt-facts adt-facts--two">
          <div>
            <dt className="caps">Current</dt>
            <dd>
              {current
                ? `${seasonName(current.number)}, ends ${formatWhen(current.endsAt)}`
                : 'No season running'}
            </dd>
          </div>
          <div>
            <dt className="caps">Next</dt>
            <dd>
              {next
                ? `${seasonName(next.number)}, starts ${formatWhen(next.startsAt)}`
                : 'None scheduled'}
            </dd>
          </div>
          <div>
            <dt className="caps">Waiting to archive</dt>
            <dd className={pendingArchive > 0 ? 'adt-warn' : undefined}>
              {pendingArchive === 0 ? 'Nothing' : `${pendingArchive} ended seasons`}
            </dd>
          </div>
        </dl>

        <h3 className="rule-heading">Boss modifiers</h3>
        <dl className="adt-facts adt-facts--two">
          {(
            [
              ['This week', world.bossModifiers.current],
              ['Next week', world.bossModifiers.next],
            ] as const
          ).map(([label, w]) => (
            <div key={label}>
              <dt className="caps">
                {label} · from {formatWhen(w.week.startsAt)}
              </dt>
              <dd>
                <strong>{w.modifier.name}</strong>: {w.modifier.effect}{' '}
                <span className="adt-dim">Hoard focus: {w.modifier.lootFocus.name}.</span>
              </dd>
            </div>
          ))}
        </dl>

        <h3 className="rule-heading">Deleted heroes</h3>
        <p>
          {nf(world.deletedHeroes.total)} deleted in all;{' '}
          <strong className={world.deletedHeroes.purgeDue > 0 ? 'adt-warn' : undefined}>
            {nf(world.deletedHeroes.purgeDue)}
          </strong>{' '}
          past the 14-day restore window and due for the purge.
        </p>
        <p className="adt-dim">
          Only the server CLI removes them for good: <code>deploy/admin.sh purge</code>.
        </p>
      </section>
    </div>
  );
}
