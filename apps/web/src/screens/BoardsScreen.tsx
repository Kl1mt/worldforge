import { useEffect, useState } from 'react';
import {
  BOARD_METRICS,
  CLASSES,
  LEVEL_BRACKETS,
  FORMULA_VERSIONS,
  powerConfig,
  pveMilestones,
  findLevelBracket,
  isClassId,
  type ClassId,
  type ReportTarget,
  type ScoreMetric,
} from '@worldforge/game-core';
import { formatNumber } from '../lib/format';
import { boardHref, boardLocation, profileHref, routeHref } from '../lib/route';
import { ReportDialog } from '../social/ReportDialog';
import type { ApiFailure } from '../lib/api';
import { useBoard, type BoardEntry, type BoardView } from '../social/boards';
import { FrameMark, ShownTitle } from '../social/Prestige';
import {
  LADDER_BRACKET_IDS,
  rangeWords,
  recordWords,
  standingWords,
  useLadder,
  type LadderEntry,
  type LadderView,
} from '../social/ladder';
import { daysLeft, seasonSpan, seasonsApi, type SeasonList } from '../social/seasons';
import './gate.css';
import './boards.css';

/**
 * The leaderboards (ticket 5.2, docs/LEADERBOARDS.md "Boards"): the Roll of Renown in the town
 * hall. Four rolls (Character Level, Gear Score, Character Power, PvE Progress), filtered by class
 * and level bracket, all time or one season (ticket 5.3: the season under way, or a past season's
 * sealed final standings). Players show their chosen season title and frame. Every player is listed by display
 * name; the name opens the profile only where its owner's settings allow it for you, and the hero's
 * name shows only there. Your own heroes' places sit on a brass slip above the roll. Each entry can
 * be reported (the display name, and the hero's name where shown). Scores are the server's; the
 * page only reads them.
 *
 * Ticket 5.6: a fifth roll, the Arena Ladder (`#/boards/arena`): the season's rated heroes by
 * their duel rating, under the same rules (names, profile links, sanctions, reports, pages). It
 * has no all-time view and no 1–9 bracket; provisional heroes show only to their owner.
 */

const CLASS_NAME = new Map(CLASSES.map((c) => [c.id, c.name]));

/** Plain words: what each roll measures (the full formulas: Standing on the character screen). */
// Ticket 6.1: the counts follow the formula version in force (a newer one waits for the season's end).
const measured = (version: {
  power: number;
  pveProgress: number;
}): Record<ScoreMetric, string> => ({
  level:
    'Your level. Between heroes of the same level, whoever has earned more experience toward the next is ahead.',
  gearScore:
    'How good your equipped items are, item by item: item level, rarity, upgrades and Void or Prismatic. Nothing else counts.',
  power: `How your hero fares in the Proving Grounds, ${powerConfig(version.power).rungs.length} fixed trials fought as equipped: builds, crits, sets and Legendary effects all fight. Classes differ; filter by class to compare like with like.`,
  pveProgress: `How many of the ${pveMilestones(version.pveProgress).length} milestones your hero has reached; then how far the furthest one is, then the highest guild boss stage your hero helped break.`,
});

function headline(metric: ScoreMetric, value: number, version: number): string {
  if (metric === 'level') return `Level ${value}`;
  if (metric === 'pveProgress') return `${value} of ${pveMilestones(version).length}`;
  return formatNumber(value);
}

const isMetric = (v: string | null): v is ScoreMetric => BOARD_METRICS.some((m) => m.id === v);

function useHash(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

type Reportable = Pick<BoardEntry, 'player' | 'hero'>;
type Reporting = { entry: Reportable; about: 'displayName' | 'heroName' } | null;

export function BoardsScreen() {
  const loc = boardLocation(useHash());
  return loc.metric === 'arena' ? <ArenaLadder loc={loc} /> : <ScoreBoards loc={loc} />;
}

function RenownHead() {
  return (
    <header className="renown__head">
      <p className="caps renown__eyebrow">Graumark · The town hall</p>
      <h1 id="renown-title" className="display">
        Roll of Renown
      </h1>
      <p className="renown__lede">
        Every hero of the town, ranked by what the server counts: all time, or one season at a time.
        At a season&rsquo;s end the best are honoured with titles and frames.
      </p>
    </header>
  );
}

/** The five rolls: the four score boards and (ticket 5.6) the arena ladder. */
function RollTabs({
  current,
  classId,
  bracket,
  season,
}: {
  current: ScoreMetric | 'arena';
  classId: ClassId | null;
  bracket: string | null;
  season: 'current' | number | null;
}) {
  const ladderBracket =
    bracket && (LADDER_BRACKET_IDS as readonly string[]).includes(bracket) ? bracket : null;
  return (
    <nav className="renown__rolls" aria-label="Rolls">
      {BOARD_METRICS.map((m) => (
        <a
          key={m.id}
          className="renown__roll-tab"
          href={boardHref(m.id, { classId, bracket, season })}
          aria-current={m.id === current ? 'page' : undefined}
        >
          {m.name}
        </a>
      ))}
      <a
        className="renown__roll-tab renown__roll-tab--arena"
        href={boardHref('arena', { classId, bracket: ladderBracket, season })}
        aria-current={current === 'arena' ? 'page' : undefined}
      >
        Arena Ladder
      </a>
    </nav>
  );
}

function ScoreBoards({ loc }: { loc: ReturnType<typeof boardLocation> }) {
  const metric: ScoreMetric = isMetric(loc.metric) ? loc.metric : 'level';
  const classId: ClassId | null = loc.classId && isClassId(loc.classId) ? loc.classId : null;
  const bracket = loc.bracket && findLevelBracket(loc.bracket) ? loc.bracket : null;
  const season = loc.season;
  const seasons = useSeasonList();
  // Cursors of the pages before this one, so "back" works with forward-only cursors.
  const [pages, setPages] = useState<(string | null)[]>([null]);
  const filterKey = `${metric}|${classId}|${bracket}|${season}`;
  const [pagesFor, setPagesFor] = useState(filterKey);
  if (pagesFor !== filterKey) {
    setPagesFor(filterKey);
    setPages([null]);
  }
  const cursor = pages.at(-1) ?? null;
  const { state, reload } = useBoard({ metric, classId, bracket, season, cursor });
  const [reporting, setReporting] = useState<Reporting>(null);
  const name = BOARD_METRICS.find((m) => m.id === metric)!.name;

  const go = (next: {
    classId?: ClassId | null;
    bracket?: string | null;
    season?: 'current' | number | null;
  }) => {
    window.location.assign(
      boardHref(metric, {
        classId: next.classId === undefined ? classId : next.classId,
        bracket: next.bracket === undefined ? bracket : next.bracket,
        season: next.season === undefined ? season : next.season,
      }),
    );
  };

  return (
    <section className="renown" aria-labelledby="renown-title">
      <RenownHead />
      <RollTabs current={metric} classId={classId} bracket={bracket} season={season} />

      <div className="renown__filters panel-ledger">
        <label className="renown__filter">
          <span className="caps">Time</span>
          <select
            value={season === null ? '' : String(season)}
            onChange={(e) => {
              const v = e.target.value;
              go({ season: v === '' ? null : v === 'current' ? 'current' : Number(v) });
            }}
          >
            <option value="">All time</option>
            <option value="current">
              {seasons?.current ? `This season (Season ${seasons.current.number})` : 'This season'}
            </option>
            {(seasons?.past ?? []).map((p) => (
              <option key={p.number} value={p.number}>
                Season {p.number}
              </option>
            ))}
            {typeof season === 'number' && !seasons?.past.some((p) => p.number === season) ? (
              <option value={season}>Season {season}</option>
            ) : null}
          </select>
        </label>
        <label className="renown__filter">
          <span className="caps">Class</span>
          <select
            value={classId ?? ''}
            onChange={(e) => go({ classId: (e.target.value || null) as ClassId | null })}
          >
            <option value="">All classes</option>
            {CLASSES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="renown__filter">
          <span className="caps">Levels</span>
          <select value={bracket ?? ''} onChange={(e) => go({ bracket: e.target.value || null })}>
            <option value="">All levels</option>
            {LEVEL_BRACKETS.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
        <details className="renown__measured">
          <summary>How is {name} measured?</summary>
          <p>
            {
              measured(
                state.kind === 'ready'
                  ? { ...FORMULA_VERSIONS, [metric]: state.board.formulaVersion }
                  : FORMULA_VERSIONS,
              )[metric]
            }
          </p>
          <p>
            Ties go to whoever got there first. Your own breakdown is under Standing on the{' '}
            <a href={routeHref('character')}>character screen</a>.
          </p>
          <p>
            A season roll lists the heroes whose score on it rose during the season, ranked by their
            score at its end. When a season ends, its roll is sealed and the best are honoured:
            Champion for first place, Exalted for the top 2 % (at least the top 3, at most the top
            10), Renowned for the top 10 % (at least the top 5, at most the top 100), Veteran for
            every other hero of level 10 or more on the roll. Honours are titles and frames only;
            they change nothing in a fight.
          </p>
        </details>
      </div>

      {state.kind === 'loading' ? (
        <p className="renown__wait" role="status">
          The clerk unrolls the parchment…
        </p>
      ) : null}
      {state.kind === 'error' ? (
        <div className="gate__alert renown__alert" role="alert">
          <p>The roll cannot be read right now: {describeBoardFailure(state.error)}</p>
          <button type="button" className="btn btn--small" onClick={reload}>
            Try again
          </button>
        </div>
      ) : null}
      {state.kind === 'ready' && state.board.scope === 'season' ? (
        <SeasonBanner season={state.board.season} now={seasons?.now ?? null} />
      ) : null}
      {state.kind === 'ready' ? (
        <Roll
          board={state.board}
          stale={state.stale}
          metric={metric}
          pageIndex={pages.length - 1}
          onNext={() => setPages((p) => [...p, state.board.nextCursor])}
          onPrev={() => setPages((p) => (p.length > 1 ? p.slice(0, -1) : p))}
          onReport={setReporting}
        />
      ) : null}

      <ReportDialog
        open={reporting !== null}
        onClose={() => setReporting(null)}
        {...(reporting ? { target: reportTarget(reporting) } : {})}
      />
    </section>
  );
}

function describeBoardFailure(error: ApiFailure): string {
  if (error.code === 'rate_limited') return 'Too many looks in a short time. Wait a minute.';
  if (error.code === 'network') return 'The town hall cannot be reached.';
  return error.message;
}

function reportTarget(r: NonNullable<Reporting>): { target: ReportTarget; label: string } {
  const who = r.entry.player.displayName ?? 'this player';
  if (r.about === 'heroName' && r.entry.hero.name) {
    return {
      target: { kind: 'characterName', handle: r.entry.player.handle, name: r.entry.hero.name },
      label: `the hero name “${r.entry.hero.name}”`,
    };
  }
  return {
    target: { kind: 'profileField', handle: r.entry.player.handle, field: 'displayName' },
    label: `${who}’s display name`,
  };
}

interface RollProps {
  board: BoardView;
  stale: boolean;
  metric: ScoreMetric;
  pageIndex: number;
  onNext: () => void;
  onPrev: () => void;
  onReport: (r: Reporting) => void;
}

function Roll({ board, stale, metric, pageIndex, onNext, onPrev, onReport }: RollProps) {
  const filtered = board.filters.classId !== null || board.filters.bracket !== null;
  const first = board.entries[0]?.rank ?? 0;
  const last = board.entries.at(-1)?.rank ?? 0;
  return (
    <div className="renown__body">
      <aside className="renown__yours" aria-labelledby="renown-yours-title">
        <h2 id="renown-yours-title" className="caps">
          Your place
        </h2>
        {board.youExcluded ? (
          <p className="renown__fine">
            Your heroes are left off the rolls while a sanction is active.{' '}
            <a href={routeHref('account')}>Why?</a>
          </p>
        ) : board.yours.length === 0 ? (
          <p className="renown__fine">
            {filtered
              ? 'None of your heroes fits these filters.'
              : board.scope === 'season' && board.season === null
                ? 'No season has begun yet.'
                : board.scope === 'season'
                  ? 'None of your heroes has risen on this roll this season.'
                  : 'Your heroes are not on this roll yet.'}
          </p>
        ) : (
          <ul className="renown__yours-list">
            {board.yours.map((e) => (
              <li key={`${e.hero.name}-${e.rank}`}>
                <span className="renown__yours-rank display">{e.rank}</span>
                <span className="renown__yours-who">
                  {e.hero.name}
                  <span className="renown__dim">
                    {' '}
                    · Level {e.hero.level} {CLASS_NAME.get(e.hero.classId)}
                  </span>
                </span>
                <span className="renown__yours-value">
                  {headline(metric, e.value, board.formulaVersion)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <div className="renown__plate panel-iron">
        <h2 className="rule-heading">
          {BOARD_METRICS.find((m) => m.id === metric)!.name}
          <span className="renown__count">
            {board.total === 0 ? '' : ` · ${formatNumber(board.total)} heroes`}
          </span>
        </h2>
        {stale ? (
          <p className="renown__fine" role="status">
            Could not refresh; showing the roll as it was a moment ago.
          </p>
        ) : null}
        {board.entries.length === 0 ? (
          <p className="renown__empty">
            {board.scope === 'season' && board.season === null
              ? 'No season has begun yet. The first season roll opens when the town calls it.'
              : filtered
                ? 'No hero fits these filters yet. Widen the class or the levels.'
                : board.scope === 'season'
                  ? 'No hero has risen on this roll this season yet. The first to gain a step goes up.'
                  : 'The roll is still blank. The first names go up as heroes fight.'}
          </p>
        ) : (
          <ol className="renown__list" start={first}>
            {board.entries.map((e) => (
              <Row
                key={`${e.rank}`}
                entry={e}
                metric={metric}
                version={board.formulaVersion}
                onReport={onReport}
              />
            ))}
          </ol>
        )}
        {board.entries.length > 0 && (pageIndex > 0 || board.nextCursor) ? (
          <nav className="renown__pages" aria-label="Pages">
            <button
              type="button"
              className="btn btn--small"
              onClick={onPrev}
              disabled={pageIndex === 0}
            >
              Higher places
            </button>
            <span className="renown__dim">
              {first}–{last} of {formatNumber(board.total)}
            </span>
            <button
              type="button"
              className="btn btn--small"
              onClick={onNext}
              disabled={!board.nextCursor}
            >
              Lower places
            </button>
          </nav>
        ) : null}
      </div>
    </div>
  );
}

function Row({
  entry: e,
  metric,
  version,
  onReport,
}: {
  entry: BoardEntry;
  metric: ScoreMetric;
  /** The board's formula version (6.1: the milestone count follows it). */
  version: number;
  onReport: (r: Reporting) => void;
}) {
  const name = e.player.displayName ?? 'Name withheld';
  const cls = CLASS_NAME.get(e.hero.classId) ?? e.hero.classId;
  const podium = e.rank <= 3 ? ` renown__row--podium renown__row--rank${e.rank}` : '';
  return (
    <li className={`renown__row${e.you ? ' renown__row--you' : ''}${podium}`}>
      <span className="renown__rank display" aria-label={`Place ${e.rank}`}>
        {e.rank}
      </span>
      <span className="renown__who">
        <span className="renown__nameline">
          <FrameMark frame={e.player.prestige.frame} />
          {e.player.profile ? (
            <a className="renown__name" href={profileHref(e.player.handle)}>
              {name}
            </a>
          ) : (
            <span
              className={`renown__name${e.player.displayName ? '' : ' renown__name--withheld'}`}
            >
              {name}
            </span>
          )}
          <ShownTitle shown={e.player.prestige} compact />
        </span>
        <span className="renown__hero">
          {e.hero.name ? `${e.hero.name}, ` : ''}level {e.hero.level} {cls}
          {e.you ? <span className="renown__you caps"> You</span> : null}
        </span>
      </span>
      <span className="renown__value">
        {headline(metric, e.value, version)}
        <span className="renown__since">since {formatDay(e.achievedOn)}</span>
      </span>
      {e.you ? <span className="renown__actions" /> : <ReportMenu entry={e} onReport={onReport} />}
    </li>
  );
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}

/** The season list for the Time filter (and the clock for "days left"); null while loading. */
function useSeasonList(): SeasonList | null {
  const [list, setList] = useState<SeasonList | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    seasonsApi.list(controller.signal).then(
      (res) => {
        if (res.ok) setList(res.value);
      },
      () => undefined,
    );
    return () => controller.abort();
  }, []);
  return list;
}

/** Which season a season roll shows, and how it stands: under way, sealing, or sealed. */
function SeasonBanner({ season: s, now }: { season: BoardView['season']; now: string | null }) {
  if (!s) return null;
  let state: string;
  if (s.status === 'active') {
    const left = now ? daysLeft(s.endsAt, now) : null;
    state =
      left === null
        ? 'Under way.'
        : left <= 1
          ? 'Ends within a day.'
          : `Under way, ${left} days left.`;
  } else if (s.archivedAt) {
    state = 'Ended. These are its sealed final standings; honours have been given.';
  } else {
    state = 'Ended. The clerks are sealing the final standings.';
  }
  return (
    <p className={`renown__season renown__season--${s.status}`} role="status">
      <span className="caps">Season {s.number}</span>
      <span className="renown__season-span">{seasonSpan(s)} (UTC)</span>
      <span>{state}</span>
    </p>
  );
}

/* --- Ticket 5.6: the arena ladder --------------------------------------------------------- */

const LADDER_BRACKETS = LEVEL_BRACKETS.filter((b) =>
  (LADDER_BRACKET_IDS as readonly string[]).includes(b.id),
);

function ArenaLadder({ loc }: { loc: ReturnType<typeof boardLocation> }) {
  const classId: ClassId | null = loc.classId && isClassId(loc.classId) ? loc.classId : null;
  const bracket =
    loc.bracket && (LADDER_BRACKET_IDS as readonly string[]).includes(loc.bracket)
      ? loc.bracket
      : null;
  const season = loc.season;
  const seasons = useSeasonList();
  const [pages, setPages] = useState<(string | null)[]>([null]);
  const filterKey = `arena|${classId}|${bracket}|${season}`;
  const [pagesFor, setPagesFor] = useState(filterKey);
  if (pagesFor !== filterKey) {
    setPagesFor(filterKey);
    setPages([null]);
  }
  const cursor = pages.at(-1) ?? null;
  const { state, reload } = useLadder({ classId, bracket, season, cursor });
  const [reporting, setReporting] = useState<Reporting>(null);
  const go = (next: {
    classId?: ClassId | null;
    bracket?: string | null;
    season?: 'current' | number | null;
  }) => {
    window.location.assign(
      boardHref('arena', {
        classId: next.classId === undefined ? classId : next.classId,
        bracket: next.bracket === undefined ? bracket : next.bracket,
        season: next.season === undefined ? season : next.season,
      }),
    );
  };
  const provisional = state.kind === 'ready' ? state.ladder.provisionalGames : 10;
  return (
    <section className="renown renown--ladder" aria-labelledby="renown-title">
      <RenownHead />
      <RollTabs current="arena" classId={classId} bracket={bracket} season={season} />
      <div className="renown__filters panel-ledger">
        <label className="renown__filter">
          <span className="caps">Season</span>
          <select
            value={typeof season === 'number' ? String(season) : ''}
            onChange={(e) => go({ season: e.target.value === '' ? null : Number(e.target.value) })}
          >
            <option value="">
              {seasons?.current ? `This season (Season ${seasons.current.number})` : 'This season'}
            </option>
            {(seasons?.past ?? []).map((p) => (
              <option key={p.number} value={p.number}>
                Season {p.number}
              </option>
            ))}
            {typeof season === 'number' && !seasons?.past.some((p) => p.number === season) ? (
              <option value={season}>Season {season}</option>
            ) : null}
          </select>
        </label>
        <label className="renown__filter">
          <span className="caps">Class</span>
          <select
            value={classId ?? ''}
            onChange={(e) => go({ classId: (e.target.value || null) as ClassId | null })}
          >
            <option value="">All classes</option>
            {CLASSES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="renown__filter">
          <span className="caps">Levels</span>
          <select value={bracket ?? ''} onChange={(e) => go({ bracket: e.target.value || null })}>
            <option value="">All rated levels</option>
            {LADDER_BRACKETS.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
        <details className="renown__measured">
          <summary>How is the Arena Ladder measured?</summary>
          <p>
            Every hero has a duel rating for the season, worked out by the server from its rated
            duels (Glicko-2). A new hero starts at 1,500. Each rated duel moves both heroes, the
            challenger and the defender: beating a stronger rating gains more, losing to a weaker
            one costs more.
          </p>
          <p>
            A rating comes with its uncertainty: &ldquo;likely 1,380–1,660&rdquo; is where the
            hero&rsquo;s true strength most likely lies. A hero is <em>provisional</em> until{' '}
            {provisional} rated duels (attacking or defending), and only then ranked here; the range
            narrows as it fights (&ldquo;still settling&rdquo;, then &ldquo;settled&rdquo;).
          </p>
          <p>
            Ties go to more rated duels, then to whoever got there first. Each new season starts
            softly: halfway back to 1,500, with a wide range. At a season&rsquo;s end the ladder is
            sealed and the best are honoured as Champion, Exalted, Renowned or Veteran Duellist.
            Honours change nothing in a fight.
          </p>
          <p>
            Your rated duels are in the <a href={routeHref('arena')}>Arena</a>.
          </p>
        </details>
      </div>

      {state.kind === 'loading' ? (
        <p className="renown__wait" role="status">
          The herald reads the ladder…
        </p>
      ) : null}
      {state.kind === 'error' ? (
        <div className="gate__alert renown__alert" role="alert">
          <p>The ladder cannot be read right now: {describeBoardFailure(state.error)}</p>
          <button type="button" className="btn btn--small" onClick={reload}>
            Try again
          </button>
        </div>
      ) : null}
      {state.kind === 'ready' ? (
        <SeasonBanner season={state.ladder.season} now={seasons?.now ?? null} />
      ) : null}
      {state.kind === 'ready' ? (
        <LadderRoll
          ladder={state.ladder}
          stale={state.stale}
          pageIndex={pages.length - 1}
          onNext={() => setPages((p) => [...p, state.ladder.nextCursor])}
          onPrev={() => setPages((p) => (p.length > 1 ? p.slice(0, -1) : p))}
          onReport={setReporting}
        />
      ) : null}
      <ReportDialog
        open={reporting !== null}
        onClose={() => setReporting(null)}
        {...(reporting ? { target: reportTarget(reporting) } : {})}
      />
    </section>
  );
}

function LadderRoll({
  ladder,
  stale,
  pageIndex,
  onNext,
  onPrev,
  onReport,
}: {
  ladder: LadderView;
  stale: boolean;
  pageIndex: number;
  onNext: () => void;
  onPrev: () => void;
  onReport: (r: Reporting) => void;
}) {
  const filtered = ladder.filters.classId !== null || ladder.filters.bracket !== null;
  const first = ladder.entries[0]?.rank ?? 0;
  const last = ladder.entries.at(-1)?.rank ?? 0;
  const sealed = ladder.season?.archivedAt != null;
  return (
    <div className="renown__body">
      <aside className="renown__yours" aria-labelledby="renown-yours-title">
        <h2 id="renown-yours-title" className="caps">
          Your place
        </h2>
        {ladder.youExcluded ? (
          <p className="renown__fine">
            Your heroes are left off the rolls while a sanction is active.{' '}
            <a href={routeHref('account')}>Why?</a>
          </p>
        ) : ladder.yours.length === 0 ? (
          <p className="renown__fine">
            {ladder.season === null
              ? 'No season has begun yet.'
              : filtered
                ? 'None of your heroes fits these filters.'
                : sealed
                  ? 'None of your heroes was ranked on this ladder.'
                  : 'None of your heroes has fought a rated duel this season. Rated duels open at level 10 in the Arena.'}
          </p>
        ) : (
          <ul className="renown__yours-list">
            {ladder.yours.map((e) => (
              <li key={`${e.hero.name}-${e.rank}-${e.rating.games}`}>
                <span className="renown__yours-rank display">{e.rank ?? '–'}</span>
                <span className="renown__yours-who">
                  {e.hero.name}
                  <span className="renown__dim">
                    {' '}
                    · Level {e.hero.level} {CLASS_NAME.get(e.hero.classId)}
                  </span>
                  <span className="renown__ladder-note">
                    {standingWords(e.rating, ladder.provisionalGames)} · {recordWords(e.rating)}
                  </span>
                </span>
                <span className="renown__yours-value">{formatNumber(e.rating.rating)}</span>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <div className="renown__plate panel-iron">
        <h2 className="rule-heading">
          {sealed ? 'Arena Ladder · final standings' : 'Arena Ladder'}
          <span className="renown__count">
            {ladder.total === 0 ? '' : ` · ${formatNumber(ladder.total)} heroes`}
          </span>
        </h2>
        {stale ? (
          <p className="renown__fine" role="status">
            Could not refresh; showing the ladder as it was a moment ago.
          </p>
        ) : null}
        {ladder.entries.length === 0 ? (
          <p className="renown__empty">
            {ladder.season === null
              ? 'No season has begun yet. The ladder opens with the first season.'
              : filtered
                ? 'No ranked hero fits these filters yet. Widen the class or the levels.'
                : `No hero is ranked yet. A hero goes up after ${ladder.provisionalGames} rated duels this season.`}
          </p>
        ) : (
          <ol className="renown__list" start={first}>
            {ladder.entries.map((e) => (
              <LadderRow
                key={`${e.rank}`}
                entry={e}
                provisionalGames={ladder.provisionalGames}
                onReport={onReport}
              />
            ))}
          </ol>
        )}
        {ladder.entries.length > 0 && (pageIndex > 0 || ladder.nextCursor) ? (
          <nav className="renown__pages" aria-label="Pages">
            <button
              type="button"
              className="btn btn--small"
              onClick={onPrev}
              disabled={pageIndex === 0}
            >
              Higher places
            </button>
            <span className="renown__dim">
              {first}–{last} of {formatNumber(ladder.total)}
            </span>
            <button
              type="button"
              className="btn btn--small"
              onClick={onNext}
              disabled={!ladder.nextCursor}
            >
              Lower places
            </button>
          </nav>
        ) : null}
      </div>
    </div>
  );
}

function LadderRow({
  entry: e,
  provisionalGames,
  onReport,
}: {
  entry: LadderEntry;
  provisionalGames: number;
  onReport: (r: Reporting) => void;
}) {
  const name = e.player.displayName ?? 'Name withheld';
  const cls = CLASS_NAME.get(e.hero.classId) ?? e.hero.classId;
  const rank = e.rank ?? 0;
  const podium = rank >= 1 && rank <= 3 ? ` renown__row--podium renown__row--rank${rank}` : '';
  return (
    <li className={`renown__row${e.you ? ' renown__row--you' : ''}${podium}`}>
      <span className="renown__rank display" aria-label={`Place ${rank}`}>
        {rank}
      </span>
      <span className="renown__who">
        <span className="renown__nameline">
          <FrameMark frame={e.player.prestige.frame} />
          {e.player.profile ? (
            <a className="renown__name" href={profileHref(e.player.handle)}>
              {name}
            </a>
          ) : (
            <span
              className={`renown__name${e.player.displayName ? '' : ' renown__name--withheld'}`}
            >
              {name}
            </span>
          )}
          <ShownTitle shown={e.player.prestige} compact />
        </span>
        <span className="renown__hero">
          {e.hero.name ? `${e.hero.name}, ` : ''}level {e.hero.level} {cls} ·{' '}
          {recordWords(e.rating)}
          {e.you ? <span className="renown__you caps"> You</span> : null}
        </span>
      </span>
      <span className="renown__value">
        {formatNumber(e.rating.rating)}
        <span className="renown__since">
          {rangeWords(e.rating)} · {standingWords(e.rating, provisionalGames)}
        </span>
      </span>
      {e.you ? <span className="renown__actions" /> : <ReportMenu entry={e} onReport={onReport} />}
    </li>
  );
}

function ReportMenu({
  entry: e,
  onReport,
}: {
  entry: Reportable;
  onReport: (r: Reporting) => void;
}) {
  const name = e.player.displayName ?? 'Name withheld';
  return (
    <details className="renown__actions renown__report">
      <summary className="btn btn--small">
        Report<span className="visually-hidden"> {name}</span>
      </summary>
      <div className="renown__report-menu">
        <button
          type="button"
          className="btn btn--small"
          onClick={(ev) => {
            (ev.currentTarget.closest('details') as HTMLDetailsElement).open = false;
            onReport({ entry: e, about: 'displayName' });
          }}
        >
          Their display name
        </button>
        {e.hero.name ? (
          <button
            type="button"
            className="btn btn--small"
            onClick={(ev) => {
              (ev.currentTarget.closest('details') as HTMLDetailsElement).open = false;
              onReport({ entry: e, about: 'heroName' });
            }}
          >
            The hero’s name
          </button>
        ) : null}
      </div>
    </details>
  );
}
