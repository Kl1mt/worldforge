// `pnpm admin:seasons <command>` (ticket 5.3, docs/DEPLOY.md "Seasons", docs/LEADERBOARDS.md
// "Seasons"). The owner's season controls on the server, the same rules as the admin panel:
//   status                                   current, next and past seasons with their counts
//   schedule --start <ISO> [--weeks N | --end <ISO>]
//                                            schedule the next season (or replace the scheduled one)
//   end <number>                             end the season under way now
//   extend <number> --to <ISO>               move a season's end (current or next; later or earlier)
//   close                                    take due archives and give due awards now (the
//                                            running server does this by itself every few minutes)
// Times are UTC (ISO 8601, e.g. 2026-12-07T00:00:00Z). Every change is audited (`via: 'cli'`).
// Uses DATABASE_URL, else (outside production) the playtest database.
import { DEFAULT_SEASON_WEEKS, seasonName } from '@worldforge/game-core';
import { loadConfig } from '../config.js';
import { openCliDatabase } from '../db/cli-database.js';
import type { Database } from '../db/types.js';
import { ApiError } from '../errors.js';
import { queryRows } from '../db/query.js';
import { sql } from 'drizzle-orm';
import {
  currentAndNext,
  listSeasons,
  runSeasonJobs,
  scheduleSeason,
  seasonView,
  setSeasonEnd,
} from './model.js';

const USAGE = `Usage:
  pnpm admin:seasons status
  pnpm admin:seasons schedule --start <ISO> [--weeks N | --end <ISO>]   (default ${DEFAULT_SEASON_WEEKS} weeks)
  pnpm admin:seasons end <number>
  pnpm admin:seasons extend <number> --to <ISO>
  pnpm admin:seasons close
Times are UTC, e.g. 2026-12-07T00:00:00Z.`;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export class UsageError extends Error {}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new UsageError(`${name} needs a value.`);
  return v;
}

function isoTime(v: string, name: string): Date {
  // A full date and time with an explicit zone, so nobody schedules in local time by accident.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v))
    throw new UsageError(`${name} must be an ISO time with a zone, e.g. 2026-12-07T00:00:00Z.`);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new UsageError(`${name} is not a valid time.`);
  return d;
}

function seasonNumber(v: string | undefined): number {
  if (!v || !/^\d{1,6}$/.test(v)) throw new UsageError('Give the season number.');
  return Number(v);
}

/** Plain-text status; exported for tests. */
export async function formatStatus(db: Database, now: Date): Promise<string> {
  const list = await listSeasons(db);
  if (list.length === 0) {
    return 'No season has been scheduled yet. Schedule the first with `schedule --start <ISO>`.';
  }
  const counts = await queryRows<{
    season: number;
    entries: number;
    standings: number;
    awards: number;
  }>(
    db,
    sql`select s.number as season,
        (select count(*)::int from season_entries e where e.season = s.number) as entries,
        (select count(*)::int from season_standings t where t.season = s.number) as standings,
        (select count(*)::int from season_awards a where a.season = s.number) as awards
      from seasons s order by s.number`,
  );
  const { current, next } = currentAndNext(list, now);
  const lines = [`Now (UTC): ${now.toISOString()}`];
  lines.push(`Current: ${current ? seasonName(current.number) : 'none'}`);
  lines.push(`Next: ${next ? seasonName(next.number) : 'none'}`);
  for (const s of [...list].reverse().slice(0, 12)) {
    const v = seasonView(s, now);
    const c = counts.find((x) => x.season === s.number);
    lines.push(
      `  ${seasonName(s.number)}: ${v.startsAt} → ${v.endsAt}  ${v.status}` +
        `  (board rows ${c?.entries ?? 0}, final standings ${c?.standings ?? 0}, awards ${c?.awards ?? 0})`,
    );
  }
  return lines.join('\n');
}

/** Runs one command; returns its output. Exported for tests. */
export async function runSeasonCommand(db: Database, args: string[], now: Date): Promise<string> {
  const [command, ...rest] = args;
  const actor = { accountId: null, via: 'cli' as const };
  switch (command) {
    case 'status':
      return formatStatus(db, now);
    case 'schedule': {
      const startArg = flag(rest, '--start');
      if (!startArg) throw new UsageError('schedule needs --start.');
      const startsAt = isoTime(startArg, '--start');
      const endArg = flag(rest, '--end');
      const weeksArg = flag(rest, '--weeks');
      if (endArg && weeksArg) throw new UsageError('Give --weeks or --end, not both.');
      let endsAt: Date;
      if (endArg) endsAt = isoTime(endArg, '--end');
      else {
        const weeks = weeksArg === undefined ? DEFAULT_SEASON_WEEKS : Number(weeksArg);
        if (!Number.isInteger(weeks) || weeks < 1 || weeks > 26)
          throw new UsageError('--weeks must be a whole number from 1 to 26.');
        endsAt = new Date(startsAt.getTime() + weeks * WEEK_MS);
      }
      const s = await scheduleSeason(db, { startsAt, endsAt }, now, actor);
      return `Scheduled ${seasonName(s.number)}: ${s.startsAt.toISOString()} → ${s.endsAt.toISOString()}.`;
    }
    case 'end': {
      const n = seasonNumber(rest[0]);
      const { season, follower } = await setSeasonEnd(db, n, now, now, actor);
      return (
        `${seasonName(season.number)} ended at ${season.endsAt.toISOString()}.` +
        (follower ? ` ${seasonName(follower.number)} now starts then.` : '')
      );
    }
    case 'extend': {
      const n = seasonNumber(rest[0]);
      const to = flag(rest, '--to');
      if (!to) throw new UsageError('extend needs --to.');
      const { season, follower } = await setSeasonEnd(db, n, isoTime(to, '--to'), now, actor);
      return (
        `${seasonName(season.number)} now ends at ${season.endsAt.toISOString()}.` +
        (follower
          ? ` ${seasonName(follower.number)} moved to ${follower.startsAt.toISOString()} → ${follower.endsAt.toISOString()}.`
          : '')
      );
    }
    case 'close': {
      const out = await runSeasonJobs(db, now, now);
      return [
        out.created !== null ? `Created ${seasonName(out.created)}.` : null,
        out.archived.length ? `Archived: ${out.archived.map(seasonName).join(', ')}.` : null,
        out.awarded.length ? `Awarded: ${out.awarded.map(seasonName).join(', ')}.` : null,
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
  process.argv[1]?.endsWith('season-cli.ts') || process.argv[1]?.endsWith('season-cli.js');
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
    console.log(await runSeasonCommand(cli.database.db, args, new Date()));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(err.message === USAGE ? USAGE : `${err.message}\n\n${USAGE}`);
      process.exitCode = 2;
    } else if (err instanceof ApiError) {
      console.error(err.message);
      process.exitCode = 1;
    } else {
      console.error('Season command failed:', err);
      process.exitCode = 1;
    }
  } finally {
    await cli.close();
  }
}
