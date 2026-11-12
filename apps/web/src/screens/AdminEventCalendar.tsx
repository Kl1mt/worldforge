import { useId, useState } from 'react';
import type { AdminEvents, CalendarEntryInput } from '../admin/api';

/**
 * Ticket 8.3: the automatic event calendar in the admin panel's Events tab (docs/EVENTS.md "The
 * calendar"). The owner turns it on or pauses it, sets the rotation (which events, their order and
 * each one's length) and the gap between events, skips the next one, and sees the next three
 * planned. The server decides and audits every change; an event scheduled by hand always wins.
 * The parent keys it by the calendar's `updatedAt`, so a saved change starts the form afresh.
 * Scoped classes `evcal-`.
 */

const UTC = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
});
const when = (iso: string) => UTC.format(new Date(iso));

type Calendar = AdminEvents['calendar'];

/** Words for a planned event's origin. */
export function plannedTag(p: Calendar['planned'][number], paused: boolean): string {
  if (p.kind === 'scheduled')
    return p.source === 'calendar'
      ? `Event ${p.number}, put on the calendar automatically`
      : `Event ${p.number}, scheduled by hand`;
  return paused ? 'From the rotation, once the calendar is on' : 'From the rotation';
}

export function EventCalendarPanel({
  view,
  busy,
  onSet,
  onSkip,
}: {
  view: AdminEvents;
  busy: boolean;
  onSet: (
    label: string,
    patch: { paused?: boolean; rotation?: CalendarEntryInput[]; gapDays?: number },
  ) => void;
  onSkip: () => void;
}) {
  const ids = useId();
  const c = view.calendar;
  const [rotation, setRotation] = useState<CalendarEntryInput[]>(() =>
    c.rotation.map((e) => ({ definitionId: e.definitionId, days: e.days })),
  );
  const [gap, setGap] = useState(String(c.gapDays));
  const [confirm, setConfirm] = useState<'on' | 'skip' | null>(null);

  const name = (id: string) => view.definitions.find((d) => d.id === id)?.name ?? id;
  const gapN = Number(gap);
  const valid =
    rotation.length <= 12 &&
    rotation.every((e) => Number.isInteger(e.days) && e.days >= 1 && e.days <= 28) &&
    Number.isInteger(gapN) &&
    gapN >= 0 &&
    gapN <= 60;
  const dirty =
    gapN !== c.gapDays ||
    rotation.length !== c.rotation.length ||
    rotation.some(
      (e, i) => e.definitionId !== c.rotation[i]?.definitionId || e.days !== c.rotation[i]?.days,
    );
  const move = (i: number, by: -1 | 1) =>
    setRotation((r) => {
      const j = i + by;
      if (j < 0 || j >= r.length) return r;
      const next = [...r];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  const first = view.definitions[0];
  // What skip passes over: an automatic event waiting to begin, else the rotation's next entry.
  const skipTarget =
    c.planned.find((p) => p.kind === 'scheduled' && p.source === 'calendar') ??
    c.planned.find((p) => p.kind === 'rotation');

  return (
    <section className="panel-ledger almanac__section evcal" aria-labelledby={`${ids}-h`}>
      <div className="evcal__head">
        <div>
          <p className="caps">Runs by itself</p>
          <h3 id={`${ids}-h`} className="display evcal__title">
            The automatic calendar
          </h3>
        </div>
        <span className={`evcal__state evcal__state--${c.paused ? 'paused' : 'on'}`}>
          {c.paused ? 'Paused' : 'On'}
        </span>
      </div>
      <p className="strong__note">
        {c.paused
          ? 'Nothing is put on the calendar automatically. An event already waiting still begins.'
          : `When an event closes, the next one in the rotation is put on the calendar, ${c.gapDays === 1 ? 'a day' : `${c.gapDays} days`} after its end. One event at a time, never overlapping.`}{' '}
        An event you schedule by hand always wins: it replaces an automatic one that has not begun,
        and the rotation carries on after it.
      </p>

      <div className="evcal__actions">
        {confirm === 'on' ? (
          <>
            <span className="strong__note">
              Turn it on? The next event of the rotation is put on the calendar within a few
              minutes, if none is waiting or under way.
            </span>
            <button
              type="button"
              className="btn btn--small btn--brass"
              disabled={busy}
              onClick={() => {
                setConfirm(null);
                onSet('The calendar is on.', { paused: false });
              }}
            >
              Turn it on
            </button>
            <button type="button" className="btn btn--small" onClick={() => setConfirm(null)}>
              Not yet
            </button>
          </>
        ) : confirm === 'skip' ? (
          <>
            <span className="strong__note">
              Skip {skipTarget ? skipTarget.name : 'the next event'}? An automatic event waiting to
              begin is cancelled; otherwise the rotation passes over its next entry.
            </span>
            <button
              type="button"
              className="btn btn--small"
              disabled={busy}
              onClick={() => {
                setConfirm(null);
                onSkip();
              }}
            >
              Skip it
            </button>
            <button type="button" className="btn btn--small" onClick={() => setConfirm(null)}>
              Keep it
            </button>
          </>
        ) : (
          <>
            {c.paused ? (
              <button
                type="button"
                className="btn btn--small btn--brass"
                disabled={busy || c.rotation.length === 0}
                onClick={() => setConfirm('on')}
              >
                Turn on…
              </button>
            ) : (
              <button
                type="button"
                className="btn btn--small"
                disabled={busy}
                onClick={() => onSet('The calendar is paused.', { paused: true })}
              >
                Pause
              </button>
            )}
            <button
              type="button"
              className="btn btn--small"
              disabled={busy || c.rotation.length === 0}
              onClick={() => setConfirm('skip')}
            >
              Skip the next one…
            </button>
          </>
        )}
      </div>

      <h4 className="caps evcal__sub">Next three</h4>
      {c.planned.length === 0 ? (
        <p className="strong__note">Nothing planned: the rotation is empty.</p>
      ) : (
        <ol className="evcal__planned">
          {c.planned.map((p, i) => (
            <li
              key={`${p.startsAt}-${i}`}
              className={`evcal__plan evcal__plan--${p.kind}${c.paused && p.kind === 'rotation' ? ' evcal__plan--held' : ''}`}
            >
              <span className="display evcal__plan-name">{p.name}</span>
              <span className="strong__note">
                {when(p.startsAt)} → {when(p.endsAt)} UTC
              </span>
              <span className="evcal__plan-tag">{plannedTag(p, c.paused)}</span>
            </li>
          ))}
        </ol>
      )}

      <form
        className="evcal__form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid || !dirty) return;
          onSet('The rotation is saved.', { rotation, gapDays: gapN });
        }}
      >
        <h4 className="caps evcal__sub">Rotation</h4>
        {rotation.length === 0 ? (
          <p className="strong__note">No events in the rotation: nothing runs automatically.</p>
        ) : (
          <ol className="evcal__rotation">
            {rotation.map((entry, i) => (
              <li key={i} className="evcal__entry">
                <span className="evcal__index" aria-hidden="true">
                  {i + 1}
                </span>
                <label className="visually-hidden" htmlFor={`${ids}-ev-${i}`}>
                  Event {i + 1}
                </label>
                <select
                  id={`${ids}-ev-${i}`}
                  className="field__input"
                  value={entry.definitionId}
                  onChange={(e) => {
                    const d = view.definitions.find((x) => x.id === e.target.value);
                    setRotation((r) =>
                      r.map((x, j) =>
                        j === i
                          ? { definitionId: e.target.value, days: d?.defaultDays ?? x.days }
                          : x,
                      ),
                    );
                  }}
                >
                  {view.definitions.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
                <label className="field__label caps" htmlFor={`${ids}-days-${i}`}>
                  Days
                </label>
                <input
                  id={`${ids}-days-${i}`}
                  className="field__input evcal__days"
                  type="number"
                  min={1}
                  max={28}
                  value={entry.days}
                  onChange={(e) =>
                    setRotation((r) =>
                      r.map((x, j) => (j === i ? { ...x, days: Number(e.target.value) } : x)),
                    )
                  }
                />
                {i === c.nextIndex && !dirty ? (
                  <span className="evcal__next caps">Next</span>
                ) : null}
                <span className="evcal__moves">
                  <button
                    type="button"
                    className="btn btn--small"
                    onClick={() => move(i, -1)}
                    disabled={i === 0}
                    aria-label={`Move ${name(entry.definitionId)} up`}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="btn btn--small"
                    onClick={() => move(i, 1)}
                    disabled={i === rotation.length - 1}
                    aria-label={`Move ${name(entry.definitionId)} down`}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="btn btn--small"
                    onClick={() => setRotation((r) => r.filter((_, j) => j !== i))}
                    aria-label={`Take ${name(entry.definitionId)} out of the rotation`}
                  >
                    ✕
                  </button>
                </span>
              </li>
            ))}
          </ol>
        )}
        <div className="seasoncard__row">
          <button
            type="button"
            className="btn btn--small"
            disabled={rotation.length >= 12 || !first}
            onClick={() =>
              first &&
              setRotation((r) => [...r, { definitionId: first.id, days: first.defaultDays }])
            }
          >
            Add an event
          </button>
          <label className="field__label caps" htmlFor={`${ids}-gap`}>
            Gap (days)
          </label>
          <input
            id={`${ids}-gap`}
            className="field__input evcal__days"
            type="number"
            min={0}
            max={60}
            value={gap}
            onChange={(e) => setGap(e.target.value)}
          />
          <button
            type="submit"
            className="btn btn--small btn--brass"
            disabled={busy || !valid || !dirty}
          >
            Save the rotation
          </button>
        </div>
        <p className="strong__note">
          Lengths are whole days (1–28); a weekly event shorter than its weeks never opens its last
          tasks. Events may run across a season boundary: their rewards belong to no season and
          change no score.
        </p>
      </form>
    </section>
  );
}
