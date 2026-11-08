// Ticket B.4: a season's player population built from realistic-player runs.
//
// `telemetry:simulate --days 56 --snapshots` (docs/TELEMETRY.md) plays 28 realistic heroes through
// the real API for a whole 8-week season and writes every hero's 5.1 scoring input at the end of
// each game day. Each hero is a **trajectory** (its state on day 1 … 56). Several runs give
// different trajectories (server seeds are random). A season population is drawn from them:
//
// - **New players** start a fresh hero (the level-1 profile); **veterans** bring a hero from an
//   earlier season (the profiles that start at levels 7–25, with gear of their tier).
// - **Join day:** veterans play from the first day; half the new players too, the others join at
//   a random day of the season.
// - **Activity:** the realistic player visits five times a day (≈ 15 credited hours). A *casual*
//   player plays a quarter of that, a *regular* one half, a *dedicated* one all of it: a player
//   with activity a on season day t is the trajectory's state on day ⌊a · (t − join)⌋.
//
// Players that land on the same trajectory and day are the same hero state; measures of ties
// count distinct states only.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLASS_IDS,
  computeScores,
  createRng,
  type ClassId,
  type ScoringInput,
  type Scores,
} from '../../packages/game-core/src/index.ts';

export const SEASON_DAYS = 56;
/** `telemetry:simulate`'s profiles, in order (start level). */
export const PROFILE_LEVELS = [1, 7, 12, 16, 21, 23, 25];

export interface Trajectory {
  id: number;
  run: string;
  classId: ClassId;
  /** Index into PROFILE_LEVELS. */
  profile: number;
  /** days[d] = the state at the end of game day d (days[0]: the hero as it starts). */
  days: ScoringInput[];
}

export function loadTrajectories(dirs: readonly string[]): Trajectory[] {
  const out: Trajectory[] = [];
  for (const dir of dirs) {
    const snap = join(dir, 'snapshots');
    const files = readdirSync(snap)
      .filter((f) => /^day-\d+\.json$/.test(f))
      .sort();
    const byHero = new Map<number, ScoringInput[]>();
    for (const f of files) {
      const rows = JSON.parse(readFileSync(join(snap, f), 'utf8')) as {
        n: number;
        input: ScoringInput;
      }[];
      for (const r of rows) {
        const list = byHero.get(r.n) ?? [];
        list.push(r.input);
        byHero.set(r.n, list);
      }
    }
    for (const [n, days] of [...byHero.entries()].sort((a, b) => a[0] - b[0])) {
      out.push({
        id: out.length,
        run: dir,
        classId: CLASS_IDS[Math.floor((n - 1) / PROFILE_LEVELS.length)]!,
        profile: (n - 1) % PROFILE_LEVELS.length,
        days,
      });
    }
  }
  return out;
}

export const ACTIVITIES = [
  { id: 'casual', share: 0.25, weight: 30 },
  { id: 'regular', share: 0.5, weight: 40 },
  { id: 'dedicated', share: 1, weight: 30 },
] as const;
export type ActivityId = (typeof ACTIVITIES)[number]['id'];

export interface Player {
  index: number;
  traj: Trajectory;
  veteran: boolean;
  join: number;
  activity: (typeof ACTIVITIES)[number];
}

export interface PopulationMix {
  /** Share of veterans (heroes from an earlier season). The launch season has none. */
  veterans: number;
}
export const SEASON_MIX: PopulationMix = { veterans: 0.5 };
export const LAUNCH_MIX: PopulationMix = { veterans: 0 };

export function drawPopulation(
  trajectories: readonly Trajectory[],
  size: number,
  seed: string,
  mix: PopulationMix = SEASON_MIX,
): Player[] {
  const rng = createRng(`season-pop:${seed}`);
  const fresh = trajectories.filter((t) => t.profile === 0);
  const old = trajectories.filter((t) => t.profile > 0);
  const totalWeight = ACTIVITIES.reduce((s, a) => s + a.weight, 0);
  const players: Player[] = [];
  for (let i = 0; i < size; i++) {
    const veteran = rng.next() < mix.veterans;
    const pool = veteran ? old : fresh;
    const traj = pool[rng.int(0, pool.length - 1)]!;
    const join = veteran || rng.next() < 0.5 ? 0 : rng.int(0, SEASON_DAYS - 7);
    let x = rng.next() * totalWeight;
    let activity: (typeof ACTIVITIES)[number] = ACTIVITIES[0];
    for (const a of ACTIVITIES) {
      if ((x -= a.weight) < 0) {
        activity = a;
        break;
      }
    }
    players.push({ index: i, traj, veteran, join, activity });
  }
  return players;
}

/** The trajectory day a player has reached on season day `t` (0 = not played yet). */
export function effectiveDay(p: Player, t: number): number {
  return Math.max(0, Math.min(p.traj.days.length - 1, Math.floor(p.activity.share * (t - p.join))));
}

/** The hero on season day `t`: a veteran's hero exists from the start, a new one once played. */
export function stateOf(p: Player, t: number): ScoringInput | null {
  const d = effectiveDay(p, t);
  return d >= 1 || (p.veteran && t >= 0) ? p.traj.days[d]! : null;
}

export const stateKey = (p: Player, t: number) => `${p.traj.id}:${effectiveDay(p, t)}`;

const scoreMemo = new Map<string, Scores>();
export function scoresOf(p: Player, t: number): Scores | null {
  const input = stateOf(p, t);
  if (!input) return null;
  return scoresAt(p.traj, effectiveDay(p, t));
}

/** The scores of a trajectory on its day `d` (memoised). */
export function scoresAt(traj: Trajectory, d: number): Scores {
  const input = traj.days[d]!;
  const key = `${traj.id}:${d}`;
  let s = scoreMemo.get(key);
  if (!s) {
    s = computeScores(input);
    scoreMemo.set(key, s);
  }
  return s;
}
