// `pnpm admin:events <command>` (ticket 6.6, docs/DEPLOY.md "Events", docs/EVENTS.md). The owner's
// event controls on the server, the same rules as the admin panel's Events tab:
//   status                                   the event under way, the next and past ones
//   list                                     the event definitions you can schedule
//   schedule <eventId> --start <ISO> [--days N | --end <ISO>]
//                                            put an event on the calendar (one at a time)
//   end <number>                             end the event under way now
//   extend <number> --to <ISO>               move an event's end (later, or earlier)
//   cancel <number>                          call off an event that has not begun
//   close                                    close ended events and sweep their reward tracks now
//                                            (the running server does this every few minutes)
//   calendar status                          ticket 8.3: the automatic calendar, the next 3 planned
//   calendar pause | resume | skip           stop or start it; pass over its next event
//   calendar set [--rotation id:days,…] [--gap N]
//                                            the rotation in order with each length, the gap in days
// Times are UTC (ISO 8601, e.g. 2026-11-23T00:00:00Z). Every change is audited (`via: 'cli'`).
// Uses DATABASE_URL, else (outside production) the playtest database.
import { EVENT_DEFINITIONS, findEventDefinition } from '@worldforge/game-core';
import { loadConfig } from '../config.js';
import { openCliDatabase } from '../db/cli-database.js';
import type { Database } from '../db/types.js';
import { ApiError } from '../errors.js';
import { cancelEvent, runEventJobs, scheduleEvent, setEventEnd } from './model.js';
import { adminEventsBody } from './routes.js';
import { calendarView, skipCalendarEvent, updateCalendar } from './calendar.js';

const USAGE = `Usage:
  pnpm admin:events status
  pnpm admin:events list
  pnpm admin:events schedule <eventId> --start <ISO> [--days N | --end <ISO>]   (default: the event's own length)
  pnpm admin:events end <number>
  pnpm admin:events extend <number> --to <ISO>
  pnpm admin:events cancel <number>
  pnpm admin:events close
  pnpm admin:events calendar status
  pnpm admin:events calendar pause | resume | skip
  pnpm admin:events calendar set [--rotation lanternProcession:28,harvestOfBones:7] [--gap 7]
Times are UTC, e.g. 2026-11-23T00:00:00Z.`;

const DAY_MS = 24 * 60 * 60 * 1000;

export class UsageError extends Error {}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new UsageError(`${name} needs a value.`);
  return v;
}

function isoTime(v: string, name: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v))
    throw new UsageError(`${name} must be an ISO time with a zone, e.g. 2026-11-23T00:00:00Z.`);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new UsageError(`${name} is not a valid time.`);
  return d;
}

function eventNumber(v: string | undefined): number {
  if (!v || !/^\d{1,6}$/.test(v)) throw new UsageError('Give the event number.');
  return Number(v);
}

const label = (n: number, definitionId: string) =>
  `Event ${n} (${findEventDefinition(definitionId)?.name ?? definitionId})`;

/** Plain-text status; exported for tests. */
export async function formatEventStatus(db: Database, now: Date): Promise<string> {
  const v = await adminEventsBody(db, now);
  const lines = [`Now (UTC): ${v.now}`];
  if (!v.current && !v.next && v.past.length === 0) {
    lines.push(
      'No event has been scheduled yet. See `list`, then `schedule <eventId> --start <ISO>`.',
    );
    return lines.join('\n');
  }
  const count = (n: number) => {
    const c = v.counts.find((x) => x.event === n);
    return c
      ? `  (${c.heroes} heroes of ${c.accounts} accounts, ${c.questsDone} quests done, ${c.grants} rewards; test accounts left out)`
      : '';
  };
  const line = (tag: string, e: NonNullable<typeof v.current>) =>
    `${tag}: ${label(e.number, e.definitionId)} ${e.startsAt} → ${e.endsAt}  ${e.status}${count(e.number)}`;
  lines.push(v.current ? line('Current', v.current) : 'Current: none');
  lines.push(v.next ? line('Next', v.next) : 'Next: none');
  for (const p of v.past) {
    if (!p.event) continue;
    lines.push(`  ${line('Past', p.event)}`);
  }
  return lines.join('\n');
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** "Mon" for an ISO time (UTC). */
const day = (iso: string) => WEEKDAYS[new Date(iso).getUTCDay()]!;

/** Ticket 8.3: the calendar in plain text; exported for tests. */
export async function formatCalendarStatus(db: Database, now: Date): Promise<string> {
  const c = await calendarView(db, now);
  const lines = [
    `Calendar: ${c.paused ? 'PAUSED (nothing is created automatically)' : 'running'}${c.saved ? '' : ' (defaults, never saved)'}`,
    `Gap between events: ${c.gapDays} days; automatic events start on the first Monday 00:00 UTC after it. Automatic events created so far: ${c.createdCount}.`,
    c.rotation.length === 0
      ? 'Rotation: empty.'
      : `Rotation: ${c.rotation
          .map((e, i) => `${i === c.nextIndex ? '→ ' : ''}${e.definitionId} (${e.days} days)`)
          .join(', ')}`,
    c.planned.length === 0 ? 'Planned: nothing.' : 'Planned (UTC):',
    ...c.planned.map(
      (p) =>
        `  ${day(p.startsAt)} ${p.startsAt} → ${day(p.endsAt)} ${p.endsAt}  ${p.name}  ${
          p.kind === 'scheduled'
            ? `event ${p.number}, on the calendar (${p.source === 'calendar' ? 'automatic' : 'by hand'})`
            : c.paused
              ? 'from the rotation, once resumed'
              : 'from the rotation'
        }`,
    ),
  ];
  return lines.join('\n');
}

function parseRotation(v: string): { definitionId: string; days: number }[] {
  if (v === '' || v === '-') return [];
  return v.split(',').map((part) => {
    const [id, daysArg] = part.split(':');
    const def = id ? findEventDefinition(id) : undefined;
    if (!def) throw new UsageError(`No event "${id ?? ''}" (see \`list\`).`);
    const days = daysArg === undefined ? def.defaultDays : Number(daysArg);
    if (!Number.isInteger(days) || days < 1 || days > 28)
      throw new UsageError('Each length must be a whole number of days from 1 to 28.');
    return { definitionId: def.id, days };
  });
}

async function runCalendarCommand(db: Database, args: string[], now: Date): Promise<string> {
  const [sub, ...rest] = args;
  const actor = { accountId: null, via: 'cli' as const };
  switch (sub) {
    case undefined:
    case 'status':
      return formatCalendarStatus(db, now);
    case 'pause':
    case 'resume':
      await updateCalendar(db, { paused: sub === 'pause' }, now, actor);
      return `${sub === 'pause' ? 'Paused' : 'Resumed'}.\n${await formatCalendarStatus(db, now)}`;
    case 'skip': {
      const out = await skipCalendarEvent(db, now, actor);
      const name = findEventDefinition(out.skipped)?.name ?? out.skipped;
      return `Skipped ${name}${out.cancelled ? ` (event ${out.cancelled} cancelled)` : ''}.\n${await formatCalendarStatus(db, now)}`;
    }
    case 'set': {
      const rotationArg = flag(rest, '--rotation');
      const gapArg = flag(rest, '--gap');
      if (rotationArg === undefined && gapArg === undefined)
        throw new UsageError('calendar set needs --rotation and/or --gap.');
      let gapDays: number | undefined;
      if (gapArg !== undefined) {
        gapDays = Number(gapArg);
        if (!/^\d{1,2}$/.test(gapArg)) throw new UsageError('--gap must be whole days, 0 to 60.');
      }
      await updateCalendar(
        db,
        {
          ...(rotationArg !== undefined ? { rotation: parseRotation(rotationArg) } : {}),
          ...(gapDays !== undefined ? { gapDays } : {}),
        },
        now,
        actor,
      );
      return `Saved.\n${await formatCalendarStatus(db, now)}`;
    }
    default:
      throw new UsageError(USAGE);
  }
}

/** Runs one command; returns its output. Exported for tests. */
export async function runEventCommand(db: Database, args: string[], now: Date): Promise<string> {
  const [command, ...rest] = args;
  const actor = { accountId: null, via: 'cli' as const };
  switch (command) {
    case 'status':
      return formatEventStatus(db, now);
    case 'list':
      return EVENT_DEFINITIONS.map(
        (d) => `${d.id}: ${d.name} (${d.defaultDays} days) — ${d.tagline}`,
      ).join('\n');
    case 'schedule': {
      const definitionId = rest[0];
      if (!definitionId || definitionId.startsWith('--'))
        throw new UsageError('schedule needs the event id (see `list`).');
      const def = findEventDefinition(definitionId);
      if (!def) throw new UsageError(`No event "${definitionId}" (see \`list\`).`);
      const startArg = flag(rest, '--start');
      if (!startArg) throw new UsageError('schedule needs --start.');
      const startsAt = isoTime(startArg, '--start');
      const endArg = flag(rest, '--end');
      const daysArg = flag(rest, '--days');
      if (endArg && daysArg) throw new UsageError('Give --days or --end, not both.');
      let endsAt: Date;
      if (endArg) endsAt = isoTime(endArg, '--end');
      else {
        const days = daysArg === undefined ? def.defaultDays : Number(daysArg);
        if (!Number.isInteger(days) || days < 1 || days > 28)
          throw new UsageError('--days must be a whole number from 1 to 28.');
        endsAt = new Date(startsAt.getTime() + days * DAY_MS);
      }
      const e = await scheduleEvent(db, { definitionId, startsAt, endsAt }, now, actor);
      return `Scheduled ${label(e.number, e.definitionId)}: ${e.startsAt.toISOString()} → ${e.endsAt.toISOString()}.`;
    }
    case 'end': {
      const e = await setEventEnd(db, eventNumber(rest[0]), now, now, actor);
      return `${label(e.number, e.definitionId)} ended at ${e.endsAt.toISOString()}.`;
    }
    case 'extend': {
      const n = eventNumber(rest[0]);
      const to = flag(rest, '--to');
      if (!to) throw new UsageError('extend needs --to.');
      const e = await setEventEnd(db, n, isoTime(to, '--to'), now, actor);
      return `${label(e.number, e.definitionId)} now ends at ${e.endsAt.toISOString()}.`;
    }
    case 'cancel': {
      const e = await cancelEvent(db, eventNumber(rest[0]), now, actor);
      return `${label(e.number, e.definitionId)} is cancelled.`;
    }
    case 'calendar':
      return runCalendarCommand(db, rest, now);
    case 'close': {
      const out = await runEventJobs(db, now);
      return [
        out.closed.length ? `Closed: events ${out.closed.join(', ')}.` : null,
        out.swept.length ? `Rewards swept: events ${out.swept.join(', ')}.` : null,
        out.created !== null ? `The calendar put event ${out.created} on the calendar.` : null,
        'Nothing else was due.',
      ]
        .filter(Boolean)
        .join(' ');
    }
    default:
      throw new UsageError(USAGE);
  }
}

const isMain =
  process.argv[1]?.endsWith('event-cli.ts') || process.argv[1]?.endsWith('event-cli.js');
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.error(USAGE);
    process.exit(2);
  }
  const config = loadConfig();
  let cli: Awaited<ReturnType<typeof openCliDatabase>>;
  try {
    cli = await openCliDatabase(config.databaseUrl);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
  try {
    console.log(await runEventCommand(cli.database.db, args, new Date()));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(err.message === USAGE ? USAGE : `${err.message}\n\n${USAGE}`);
      process.exitCode = 2;
    } else if (err instanceof ApiError) {
      console.error(err.message);
      process.exitCode = 1;
    } else {
      console.error('Event command failed:', err);
      process.exitCode = 1;
    }
  } finally {
    await cli.close();
  }
}
