import { useCallback, useEffect, useId, useState } from 'react';
import { adminApi, describeAdminFailure, type AdminEvents } from '../admin/api';
import type { EventView } from '../events/api';
import { timeLeft } from '../events/text';
import { EventCalendarPanel } from './AdminEventCalendar';
import type { ApiFailure } from '../lib/api';
import './admin-events.css';

/**
 * Ticket 6.6: the admin panel's Events tab (docs/EVENTS.md "Scheduling"). The calendar: the event
 * under way, the next one and past ones with their participation (test accounts left out); schedule
 * one (one at a time, never overlapping), move its end (extend or bring forward), end it early or
 * cancel one that has not begun. Every change is audited on the server; the same rules as the CLI.
 * Ticket 8.3: the automatic calendar (`AdminEventCalendar.tsx`) sits above the schedule form.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const toUtcInput = (iso: string) => iso.slice(0, 16);
const fromUtcInput = (v: string) => (v ? new Date(`${v}:00Z`).toISOString() : '');
const UTC = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
});
const span = (e: Pick<EventView, 'startsAt' | 'endsAt'>) =>
  `${UTC.format(new Date(e.startsAt))} → ${UTC.format(new Date(e.endsAt))} UTC`;

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;

const STATUS: Record<EventView['status'], string> = {
  scheduled: 'Scheduled',
  active: 'Under way',
  closing: 'Ended, closing',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; value: AdminEvents }
  | { kind: 'error'; error: ApiFailure };

export function EventsFolio() {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    adminApi.events(ctrl.signal).then(
      (res) =>
        setLoad(res.ok ? { kind: 'ready', value: res.value } : { kind: 'error', error: res.error }),
      () => undefined,
    );
    return () => ctrl.abort();
  }, [attempt]);

  const act = useCallback(async (label: string, run: () => ReturnType<typeof adminApi.events>) => {
    setBusy(true);
    setMessage(null);
    const res = await run();
    setBusy(false);
    if (!res.ok) {
      setMessage({ ok: false, text: describeAdminFailure(res.error) });
      return;
    }
    setLoad({ kind: 'ready', value: res.value });
    setMessage({ ok: true, text: label });
  }, []);

  const view = load.kind === 'ready' ? load.value : null;
  const counts = (n: number) => view?.counts.find((c) => c.event === n);

  return (
    <div className="strong__split strong__split--roles">
      <div className="strong__main">
        <div className="strong__bar">
          <h2 className="rule-heading">The event calendar</h2>
          <button
            type="button"
            className="btn btn--small"
            onClick={() => {
              setLoad({ kind: 'loading' });
              setAttempt((n) => n + 1);
            }}
            disabled={load.kind === 'loading'}
          >
            Refresh
          </button>
        </div>
        {load.kind === 'loading' ? (
          <p className="strong__wait" role="status">
            Unrolling the calendar…
          </p>
        ) : null}
        {load.kind === 'error' ? (
          <div className="gate__alert strong__alert" role="alert">
            <p>The events could not be read. {describeAdminFailure(load.error)}</p>
            <button
              type="button"
              className="btn btn--small"
              onClick={() => setAttempt((n) => n + 1)}
            >
              Try again
            </button>
          </div>
        ) : null}
        {message ? (
          <p
            className={message.ok ? 'strong__note' : 'gate__alert'}
            role={message.ok ? 'status' : 'alert'}
          >
            {message.text}
          </p>
        ) : null}
        {view ? (
          <div className="evfolio">
            {!view.current && !view.next && view.past.length === 0 ? (
              <div className="strong__empty panel-ledger">
                <p className="display">No event has been called yet.</p>
                <p className="strong__note">
                  Schedule one below. Only one runs at a time; it starts and ends on its own.
                </p>
              </div>
            ) : null}
            {view.current ? (
              <EventCard
                label="Under way"
                event={view.current}
                now={view.now}
                counts={counts(view.current.number)}
                busy={busy}
                onEnd={(endsAt) =>
                  act(endsAt ? 'The event’s end has moved.' : 'The event has ended.', () =>
                    adminApi.endEvent(view.current!.number, endsAt),
                  )
                }
              />
            ) : null}
            {view.next ? (
              <EventCard
                label="Next"
                event={view.next}
                now={view.now}
                counts={undefined}
                busy={busy}
                onEnd={(endsAt) =>
                  endsAt
                    ? act('The event’s end has moved.', () =>
                        adminApi.endEvent(view.next!.number, endsAt),
                      )
                    : Promise.resolve()
                }
                onCancel={() =>
                  act('The event is cancelled.', () => adminApi.cancelEvent(view.next!.number))
                }
              />
            ) : null}
            <EventCalendarPanel
              key={view.calendar.updatedAt ?? 'defaults'}
              view={view}
              busy={busy}
              onSet={(label, patch) => void act(label, () => adminApi.setEventCalendar(patch))}
              onSkip={() =>
                void act('The next event is skipped.', () =>
                  adminApi.skipCalendarEvent(view.calendar.skipToken),
                )
              }
            />
            <ScheduleForm
              view={view}
              busy={busy}
              onSchedule={(input) =>
                act('The event is on the calendar.', () => adminApi.scheduleEvent(input))
              }
            />
            {view.past.length > 0 ? (
              <section className="panel-ledger almanac__section" aria-label="Past events">
                <h3 className="caps">Past events</h3>
                <ul className="evfolio__past">
                  {view.past.map((p) => {
                    const c = counts(p.event.number);
                    return (
                      <li key={p.event.number} className="evfolio__row">
                        <span className="display">
                          {p.event.number}. {p.event.name}
                        </span>
                        <span className="strong__note">{span(p.event)}</span>
                        <span className={`evfolio__status evfolio__status--${p.event.status}`}>
                          {STATUS[p.event.status]}
                          {p.event.status === 'closed' && !p.rewardsSweptAt
                            ? ', rewards pending'
                            : ''}
                        </span>
                        <span className="strong__note">
                          {c && p.event.status !== 'cancelled'
                            ? `${plural(c.heroes, 'hero', 'heroes')}, ${plural(c.questsDone, 'task')} done, ${plural(c.grants, 'reward')}`
                            : ''}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}
          </div>
        ) : null}
      </div>
      <aside className="strong__side writ-cli panel-iron" aria-labelledby="event-cli-title">
        <p className="caps">Also on the server</p>
        <h2 id="event-cli-title" className="display">
          Events from the shell
        </h2>
        <p>
          Times are UTC. An event begins and ends on its own; a few minutes after its end,
          unfinished tasks lapse and any reward still owed is given, once. Rewards are cosmetic
          only.
        </p>
        <pre className="writ-cli__code">
          <code>
            deploy/admin.sh events status{'\n'}deploy/admin.sh events list{'\n'}deploy/admin.sh
            events schedule harvestOfBones --start 2026-11-23T00:00:00Z --days 7{'\n'}
            deploy/admin.sh events extend 1 --to 2026-12-01T00:00:00Z{'\n'}deploy/admin.sh events
            end 1{'\n'}deploy/admin.sh events cancel 2{'\n'}deploy/admin.sh events calendar status
            {'\n'}deploy/admin.sh events calendar pause|resume|skip{'\n'}deploy/admin.sh events
            calendar set --rotation lanternProcession:28,harvestOfBones:7 --gap 7
          </code>
        </pre>
        <p className="dossier__dim">
          In development: <code>pnpm admin:events …</code>. Every change is audited. Test accounts
          are left out of the counts.
        </p>
      </aside>
    </div>
  );
}

function EventCard({
  label,
  event,
  now,
  counts,
  busy,
  onEnd,
  onCancel,
}: {
  label: string;
  event: EventView;
  now: string;
  counts: AdminEvents['counts'][number] | undefined;
  busy: boolean;
  onEnd: (endsAt?: string) => void | Promise<void>;
  onCancel?: () => void;
}) {
  const ids = useId();
  const [endsAt, setEndsAt] = useState(toUtcInput(event.endsAt));
  const [confirming, setConfirming] = useState<'end' | 'cancel' | null>(null);
  const active = event.status === 'active';
  return (
    <section className="panel-ledger almanac__section evfolio__card" aria-labelledby={`${ids}-h`}>
      <p className="caps">{label}</p>
      <h3 id={`${ids}-h`} className="display">
        {event.number}. {event.name}
      </h3>
      <p>
        {span(event)} · {STATUS[event.status]}
        {active ? ` · ${timeLeft(event.endsAt, now)}` : ''}
      </p>
      <p className="strong__note">{event.modifier.description}</p>
      {counts && active ? (
        <p className="strong__note">
          {plural(counts.heroes, 'hero', 'heroes')} of {plural(counts.accounts, 'account')} taking
          part, {plural(counts.questsDone, 'task')} done, {plural(counts.grants, 'reward')} given.
        </p>
      ) : null}
      <form
        className="seasoncard__form"
        onSubmit={(e) => {
          e.preventDefault();
          void onEnd(fromUtcInput(endsAt));
        }}
      >
        <label className="field__label caps" htmlFor={`${ids}-end`}>
          Ends (UTC)
        </label>
        <div className="seasoncard__row">
          <input
            id={`${ids}-end`}
            className="field__input"
            type="datetime-local"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
          />
          <button type="submit" className="btn btn--small" disabled={busy || !endsAt}>
            Move the end
          </button>
        </div>
      </form>
      {confirming ? (
        <div className="seasoncard__row">
          <span className="strong__note">
            {confirming === 'end'
              ? 'End it now? Unfinished tasks lapse; what heroes earned stays theirs.'
              : 'Call it off before it begins?'}
          </span>
          <button
            type="button"
            className="btn btn--small"
            disabled={busy}
            onClick={() => {
              const which = confirming;
              setConfirming(null);
              if (which === 'end') void onEnd();
              else onCancel?.();
            }}
          >
            {confirming === 'end' ? 'End now' : 'Cancel the event'}
          </button>
          <button type="button" className="btn btn--small" onClick={() => setConfirming(null)}>
            Keep it
          </button>
        </div>
      ) : active ? (
        <button type="button" className="btn btn--small" onClick={() => setConfirming('end')}>
          End early…
        </button>
      ) : onCancel ? (
        <button type="button" className="btn btn--small" onClick={() => setConfirming('cancel')}>
          Cancel…
        </button>
      ) : null}
    </section>
  );
}

function ScheduleForm({
  view,
  busy,
  onSchedule,
}: {
  view: AdminEvents;
  busy: boolean;
  onSchedule: (input: { definitionId: string; startsAt: string; endsAt: string }) => void;
}) {
  const ids = useId();
  const first = view.definitions[0];
  const [definitionId, setDefinitionId] = useState(first?.id ?? '');
  const def = view.definitions.find((d) => d.id === definitionId);
  const defaultStart = view.current ? view.current.endsAt : view.now;
  const [start, setStart] = useState(toUtcInput(defaultStart));
  const [days, setDays] = useState(String(first?.defaultDays ?? 7));
  const n = Number(days);
  // Ticket 8.3b: a weekly event gets all of its weeks.
  const minDays = Math.max(1, def?.minDays ?? 1);
  const valid = def !== undefined && start !== '' && Number.isInteger(n) && n >= minDays && n <= 28;
  // Ticket 8.3: an automatic event waiting may be replaced by hand (manual always wins).
  const replaces = view.next?.source === 'calendar' ? view.next : null;
  if (view.next && !replaces) {
    return (
      <p className="strong__note evfolio__hint">
        One event waits to begin. To plan another, cancel it or wait until it starts.
      </p>
    );
  }
  return (
    <section className="panel-ledger almanac__section" aria-labelledby={`${ids}-h`}>
      <h3 id={`${ids}-h`} className="caps">
        Schedule an event
      </h3>
      <p className="strong__note">
        {view.current
          ? 'It may start when the event under way ends, or later; events never overlap.'
          : 'It may start now or later.'}
        {replaces
          ? ` It replaces ${replaces.name}, which the calendar put on for ${UTC.format(new Date(replaces.startsAt))} UTC; the rotation comes back to it afterwards.`
          : ''}
      </p>
      <form
        className="seasoncard__form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          const startsAt = fromUtcInput(start);
          onSchedule({
            definitionId,
            startsAt,
            endsAt: new Date(Date.parse(startsAt) + n * DAY_MS).toISOString(),
          });
        }}
      >
        <div className="seasoncard__row">
          <label className="field__label caps" htmlFor={`${ids}-def`}>
            Event
          </label>
          <select
            id={`${ids}-def`}
            className="field__input"
            value={definitionId}
            onChange={(e) => {
              setDefinitionId(e.target.value);
              const d = view.definitions.find((x) => x.id === e.target.value);
              if (d) setDays(String(d.defaultDays));
            }}
          >
            {view.definitions.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
        {def ? (
          <p className="strong__note">
            {def.tagline}
            {def.minDays > 0
              ? ` It runs over ${def.minDays / 7} weeks: at least ${def.minDays} days.`
              : ''}
          </p>
        ) : null}
        <div className="seasoncard__row">
          <label className="field__label caps" htmlFor={`${ids}-start`}>
            Starts (UTC)
          </label>
          <input
            id={`${ids}-start`}
            className="field__input"
            type="datetime-local"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
          <label className="field__label caps" htmlFor={`${ids}-days`}>
            Days
          </label>
          <input
            id={`${ids}-days`}
            className="field__input seasoncard__weeks"
            type="number"
            min={minDays}
            max={28}
            value={days}
            onChange={(e) => setDays(e.target.value)}
          />
          <button type="submit" className="btn btn--small btn--brass" disabled={busy || !valid}>
            Schedule
          </button>
        </div>
      </form>
    </section>
  );
}
