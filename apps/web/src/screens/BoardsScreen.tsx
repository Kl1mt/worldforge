import { useEffect, useState } from 'react';
import {
  BOARD_METRICS,
  CLASSES,
  LEVEL_BRACKETS,
  PVE_MILESTONES,
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
import './gate.css';
import './boards.css';

/**
 * The leaderboards (ticket 5.2, docs/LEADERBOARDS.md "Boards"): the Roll of Renown in the town
 * hall. Four rolls (Character Level, Gear Score, Character Power, PvE Progress), filtered by class
 * and level bracket, all-time for now (seasons come later). Every player is listed by display
 * name; the name opens the profile only where its owner's settings allow it for you, and the hero's
 * name shows only there. Your own heroes' places sit on a brass slip above the roll. Each entry can
 * be reported (the display name, and the hero's name where shown). Scores are the server's; the
 * page only reads them.
 */

const CLASS_NAME = new Map(CLASSES.map((c) => [c.id, c.name]));

/** Plain words: what each roll measures (the full formulas: Standing on the character screen). */
const MEASURED: Record<ScoreMetric, string> = {
  level:
    'Your level. Between heroes of the same level, whoever has earned more experience toward the next is ahead.',
  gearScore:
    'How good your equipped items are, item by item: item level, rarity, upgrades and Void. Nothing else counts.',
  power:
    'How your hero fares in the Proving Grounds, 20 fixed trials fought as equipped: builds, crits, sets and Legendary effects all fight. Classes differ; filter by class to compare like with like.',
  pveProgress: `How many of the ${PVE_MILESTONES.length} milestones your hero has reached; then how far the furthest one is, then the highest guild boss stage your hero helped break.`,
};

function headline(metric: ScoreMetric, value: number): string {
  if (metric === 'level') return `Level ${value}`;
  if (metric === 'pveProgress') return `${value} of ${PVE_MILESTONES.length}`;
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

type Reporting = { entry: BoardEntry; about: 'displayName' | 'heroName' } | null;

export function BoardsScreen() {
  const loc = boardLocation(useHash());
  const metric: ScoreMetric = isMetric(loc.metric) ? loc.metric : 'level';
  const classId: ClassId | null = loc.classId && isClassId(loc.classId) ? loc.classId : null;
  const bracket = loc.bracket && findLevelBracket(loc.bracket) ? loc.bracket : null;
  // Cursors of the pages before this one, so "back" works with forward-only cursors.
  const [pages, setPages] = useState<(string | null)[]>([null]);
  const filterKey = `${metric}|${classId}|${bracket}`;
  const [pagesFor, setPagesFor] = useState(filterKey);
  if (pagesFor !== filterKey) {
    setPagesFor(filterKey);
    setPages([null]);
  }
  const cursor = pages.at(-1) ?? null;
  const { state, reload } = useBoard({ metric, classId, bracket, cursor });
  const [reporting, setReporting] = useState<Reporting>(null);
  const name = BOARD_METRICS.find((m) => m.id === metric)!.name;

  const go = (next: { classId?: ClassId | null; bracket?: string | null }) => {
    window.location.assign(
      boardHref(metric, {
        classId: next.classId === undefined ? classId : next.classId,
        bracket: next.bracket === undefined ? bracket : next.bracket,
      }),
    );
  };

  return (
    <section className="renown" aria-labelledby="renown-title">
      <header className="renown__head">
        <p className="caps renown__eyebrow">Graumark · The town hall</p>
        <h1 id="renown-title" className="display">
          Roll of Renown
        </h1>
        <p className="renown__lede">
          Every hero of the town, ranked by what the server counts. All time; seasons come later.
        </p>
      </header>

      <nav className="renown__rolls" aria-label="Rolls">
        {BOARD_METRICS.map((m) => (
          <a
            key={m.id}
            className="renown__roll-tab"
            href={boardHref(m.id, { classId, bracket })}
            aria-current={m.id === metric ? 'page' : undefined}
          >
            {m.name}
          </a>
        ))}
      </nav>

      <div className="renown__filters panel-ledger">
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
          <p>{MEASURED[metric]}</p>
          <p>
            Ties go to whoever got there first. Your own breakdown is under Standing on the{' '}
            <a href={routeHref('character')}>character screen</a>.
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
                <span className="renown__yours-value">{headline(metric, e.value)}</span>
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
            {filtered
              ? 'No hero fits these filters yet. Widen the class or the levels.'
              : 'The roll is still blank. The first names go up as heroes fight.'}
          </p>
        ) : (
          <ol className="renown__list" start={first}>
            {board.entries.map((e) => (
              <Row key={`${e.rank}`} entry={e} metric={metric} onReport={onReport} />
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
  onReport,
}: {
  entry: BoardEntry;
  metric: ScoreMetric;
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
        {e.player.profile ? (
          <a className="renown__name" href={profileHref(e.player.handle)}>
            {name}
          </a>
        ) : (
          <span className={`renown__name${e.player.displayName ? '' : ' renown__name--withheld'}`}>
            {name}
          </span>
        )}
        <span className="renown__hero">
          {e.hero.name ? `${e.hero.name}, ` : ''}level {e.hero.level} {cls}
          {e.you ? <span className="renown__you caps"> You</span> : null}
        </span>
      </span>
      <span className="renown__value">
        {headline(metric, e.value)}
        <span className="renown__since">since {formatDay(e.achievedOn)}</span>
      </span>
      {e.you ? (
        <span className="renown__actions" />
      ) : (
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
      )}
    </li>
  );
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}
