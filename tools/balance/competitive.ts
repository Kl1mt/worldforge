// Ticket B.4: the competitive systems on a realistic season population (docs/LEADERBOARDS.md
// "Balance pass: competitive systems", docs/PVP.md "Balance pass: competitive systems").
//
//   pnpm --filter @worldforge/server telemetry:simulate -- --dir .season-a --days 56 --snapshots
//   pnpm --filter @worldforge/server exec tsx ../../tools/balance/competitive.ts boards ../../.season-a [more runs…]
//   … competitive.ts arena ../../.season-a …    (matchmaking, class pairs, rating over a season)
//
// Dev script; the guards are packages/game-core/src/balance/competitive-balance.test.ts.
import {
  LEVEL_BRACKETS,
  SCORE_METRICS,
  compareSortKeys,
  metricInput,
  levelBracketOf,
  prestigeTierFor,
  type PrestigeTier,
  type ScoreMetric,
} from '../../packages/game-core/src/index.ts';
import {
  SEASON_DAYS,
  LAUNCH_MIX,
  SEASON_MIX,
  drawPopulation,
  effectiveDay,
  loadTrajectories,
  scoresAt,
  scoresOf,
  stateKey,
  stateOf,
  type Player,
  type PopulationMix,
} from './season-population.ts';
import { arenaReport } from './competitive-arena.ts';

const [mode = 'boards', ...dirs] = process.argv.slice(2).filter((a) => a !== '--');
const trajectories = loadTrajectories(dirs);
console.log(
  `${trajectories.length} trajectories from ${dirs.length} run(s), ${Math.min(...trajectories.map((t) => t.days.length))} days each`,
);

const pct = (v: number) => `${(v * 100).toFixed(0)} %`;
const quant = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
};

/** Players who have played by day t. */
const listed = (pop: Player[], t: number) => pop.filter((p) => effectiveDay(p, t) >= 1);
/**
 * On a season board (5.3): played, and the board's sort key rose above where the hero started the
 * season (a new hero: above the fresh hero's).
 */
const risen = (p: Player, metric: ScoreMetric, t: number) =>
  effectiveDay(p, t) >= 1 &&
  compareSortKeys(scoresOf(p, t)![metric].sortKey, scoresAt(p.traj, 0)[metric].sortKey) < 0;

interface Entry {
  p: Player;
  key: string;
  value: number;
  sortKey: number[];
  level: number;
}

const sigMemo = new Map<string, string>();
/** What a metric reads of a player's hero at season end (`metricInput`), as a string. */
function inputSignature(p: Player, metric: ScoreMetric, t = SEASON_DAYS): string {
  // Level and PvE Progress read only numbers that different heroes share; a kit is a hero's own.
  if (metric === 'level' || metric === 'pveProgress') return String(p.traj.id);
  const key = `${stateKey(p, t)}:${metric}`;
  let s = sigMemo.get(key);
  if (s === undefined) {
    s = JSON.stringify(metricInput(metric, stateOf(p, t)!));
    sigMemo.set(key, s);
  }
  return s;
}

function board(pop: Player[], metric: ScoreMetric, t: number): Entry[] {
  return listed(pop, t)
    .filter((p) => risen(p, metric, t))
    .map((p) => {
      const s = scoresOf(p, t)![metric];
      return {
        p,
        key: stateKey(p, t),
        value: s.value,
        sortKey: [...s.sortKey],
        level: scoresOf(p, t)!.level.sortKey[0]!,
      };
    })
    .sort((a, b) => compareSortKeys(a.sortKey, b.sortKey));
}

function distribution(pop: Player[], label: string, t = SEASON_DAYS) {
  console.log(`\n== ${label}: ${listed(pop, t).length} players on the season boards at day ${t}`);
  for (const metric of SCORE_METRICS) {
    const all = board(pop, metric, t);
    // Ties count only between different heroes: two players on one trajectory are copies of one
    // hero (the population reuses 84 heroes), not two players who happen to tie.
    // The top of the board with one entry per hero (its best copy).
    const seenTraj = new Set<number>();
    const distinct = all.filter((e) => !seenTraj.has(e.p.traj.id) && seenTraj.add(e.p.traj.id));
    const values = all.map((e) => e.value);
    const max = Math.max(...values);
    // A "different hero" is a different metric input (the sim's veteran profiles start every run
    // in the same kit, so copies across runs are one hero too).
    const heroesWith = (k: string, m: Map<string, Set<string>>) => m.get(k)!.size;
    const byValue = new Map<string, Set<string>>();
    const byKey = new Map<string, Set<string>>();
    for (const e of all) {
      const v = String(e.value);
      const k = e.sortKey.join(',');
      const who = inputSignature(e.p, metric);
      byValue.set(v, (byValue.get(v) ?? new Set()).add(who));
      byKey.set(k, (byKey.get(k) ?? new Set()).add(who));
    }
    const tiedValue =
      all.filter((e) => heroesWith(String(e.value), byValue) > 1).length / all.length;
    const tiedKey =
      all.filter((e) => heroesWith(e.sortKey.join(','), byKey) > 1).length / all.length;
    const top10 = distinct.slice(0, 10);
    const top10pct = distinct.slice(0, Math.max(1, Math.ceil(distinct.length / 10)));
    const near = distinct.filter((e) => e.value >= 0.98 * max).length;
    if (process.env.TOP) {
      console.log(
        `  top: ${distinct
          .slice(0, Number(process.env.TOP))
          .map((e) => `${e.p.traj.classId[0]}${e.p.traj.id}:${e.sortKey.join('/')}`)
          .join(' ')}`,
      );
    }
    console.log(
      `${metric}: ${all.length} of ${listed(pop, t).length} players listed (rose this season)`,
    );
    console.log(
      `${metric.padEnd(12)} p10 ${quant(values, 0.1)}  p25 ${quant(values, 0.25)}  p50 ${quant(values, 0.5)}  p75 ${quant(values, 0.75)}  p90 ${quant(values, 0.9)}  max ${max}` +
        `  | tied value ${pct(tiedValue)}  tied key ${pct(tiedKey)}  heroes within 2 % of the top ${near}/${distinct.length}` +
        `  top-10 distinct ${new Set(top10.map((e) => e.value)).size}  top-10 % spread ${top10pct.at(-1)!.value}–${top10pct[0]!.value}`,
    );
    if (metric === 'power') {
      console.log(
        `             ≥ 3,500: ${values.filter((v) => v >= 3500).length}  ≥ 3,800: ${values.filter((v) => v >= 3800).length}  ≥ 3,950: ${values.filter((v) => v >= 3950).length}  (max 4,000)`,
      );
    }
    if (metric === 'pveProgress') {
      const counts = new Map<number, number>();
      for (const e of all) counts.set(e.sortKey[0]!, (counts.get(e.sortKey[0]!) ?? 0) + 1);
      console.log(
        `             milestones: ${[...counts.entries()]
          .sort((a, b) => b[0] - a[0])
          .map(([k, v]) => `${k}: ${v}`)
          .join('  ')}`,
      );
    }
    if (metric === 'level') {
      const counts = new Map<number, number>();
      for (const e of all) counts.set(e.level, (counts.get(e.level) ?? 0) + 1);
      console.log(
        `             levels: ${[...counts.entries()]
          .sort((a, b) => b[0] - a[0])
          .slice(0, 12)
          .map(([k, v]) => `${k}: ${v}`)
          .join('  ')}`,
      );
    }
  }
  console.log(
    'brackets (players):',
    LEVEL_BRACKETS.map(
      (b) =>
        `${b.label} ${listed(pop, t).filter((p) => levelBracketOf(scoresOf(p, t)!.level.sortKey[0]!).id === b.id).length}`,
    ).join('  '),
  );
}

function weekly(pop: Player[]) {
  console.log('\n== The season week by week (all players on the board; max / p90 / p50)');
  for (let week = 1; week <= SEASON_DAYS / 7; week++) {
    const t = week * 7;
    const parts = SCORE_METRICS.map((m) => {
      const v = board(pop, m, t).map((e) => e.value);
      return `${m} ${Math.max(...v)}/${quant(v, 0.9)}/${quant(v, 0.5)}`;
    });
    console.log(`week ${week}: ${listed(pop, t).length} players  ${parts.join('  ')}`);
  }
}

type TierRule = (rank: number, level: number, size: number) => PrestigeTier | null;
/** The tiers before B.4: fixed places. */
const fixedRule: TierRule = (rank, level) =>
  rank === 1
    ? 'champion'
    : rank <= 10
      ? 'exalted'
      : rank <= 100
        ? 'renowned'
        : level >= 10
          ? 'veteran'
          : null;
/** B.4: Exalted and Renowned scale with the board (game-core `PRESTIGE_TIERS`). */
const scaledRule: TierRule = (rank, level, size) => prestigeTierFor(rank, level, size);

function pacing(rule: TierRule, label: string, mix: PopulationMix) {
  console.log(
    `\n== Prestige pacing, ${label} (mean over 20 populations; share of players on the board)`,
  );
  for (const size of [20, 100, 500]) {
    const totals: Record<string, number> = {};
    let onBoard = 0;
    const R = 20;
    for (let r = 0; r < R; r++) {
      const pop = drawPopulation(trajectories, size, `pace:${size}:${r}`, mix);
      for (const metric of SCORE_METRICS) {
        const b = board(pop, metric, SEASON_DAYS);
        onBoard += b.length / SCORE_METRICS.length;
        b.forEach((e, i) => {
          const tier = rule(i + 1, e.level, b.length) ?? 'none';
          totals[tier] = (totals[tier] ?? 0) + 1 / SCORE_METRICS.length;
        });
      }
    }
    const n = onBoard / R;
    const fmt = (t: string) =>
      `${t} ${((totals[t] ?? 0) / R).toFixed(1)} (${pct((totals[t] ?? 0) / R / n)})`;
    console.log(
      `${String(size).padStart(4)} players, ${n.toFixed(0)} on a board: ${['champion', 'exalted', 'renowned', 'veteran', 'none'].map(fmt).join('  ')}`,
    );
  }
}

if (mode === 'boards') {
  const pop = drawPopulation(trajectories, 500, 'boards', SEASON_MIX);
  distribution(pop, 'Season (half veterans), 500 players');
  distribution(
    drawPopulation(trajectories, 500, 'launch', LAUNCH_MIX),
    'Launch season (all new), 500 players',
  );
  weekly(pop);
  pacing(fixedRule, 'tiers before B.4 (1 / 10 / 100 / rest at level ≥ 10)', SEASON_MIX);
  pacing(
    scaledRule,
    'B.4 tiers (1 / 2 % ≥ 3 ≤ 10 / 10 % ≥ 5 ≤ 100 / rest at level ≥ 10)',
    SEASON_MIX,
  );
} else if (mode === 'arena') {
  arenaReport(trajectories);
}
