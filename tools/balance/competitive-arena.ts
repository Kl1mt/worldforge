// Ticket B.4: the arena on a realistic season population (see competitive.ts).
import {
  CLASS_IDS,
  DEFAULT_MATCHMAKING,
  DEFAULT_PVP_CONFIG,
  PROVISIONAL_GAMES,
  RATED_DUEL_MIN_LEVEL,
  SETTLED_DEVIATION,
  bracketPower,
  createRng,
  duelFighter,
  duelSnapshot,
  initialRating,
  pickOpponents,
  pvpBracketOf,
  rateDuel,
  ratingFactor,
  seasonStartRating,
  simulateDuel,
  type ClassId,
  type MatchmakingConfig,
  type PvpBracket,
  type PvpConfig,
  type PvpFighterInput,
  type Rating,
  type ScoringInput,
} from '../../packages/game-core/src/index.ts';
import { matchupShare, winShare } from '../../packages/game-core/src/balance/pvp-fixtures.ts';
import {
  SEASON_DAYS,
  SEASON_MIX,
  drawPopulation,
  stateKey,
  stateOf,
  type Player,
  type Trajectory,
} from './season-population.ts';

const pct = (v: number) => `${(v * 100).toFixed(0)} %`;
const DAY = 86_400_000;
const START = Date.UTC(2026, 0, 5);

const fighterMemo = new Map<string, PvpFighterInput>();
function fighterOf(p: Player, t: number): PvpFighterInput | null {
  const s: ScoringInput | null = stateOf(p, t);
  if (!s) return null;
  const key = stateKey(p, t);
  let f = fighterMemo.get(key);
  if (!f) {
    f = duelFighter(
      duelSnapshot({
        classId: s.classId,
        level: s.level,
        xp: s.experience,
        name: 'x',
        equipment: s.equipment,
      }),
    );
    fighterMemo.set(key, f);
  }
  return f;
}
const powerMemo = new Map<string, number>();
function powerOf(p: Player, t: number, b: PvpBracket): number {
  const key = `${stateKey(p, t)}:${b.id}`;
  let v = powerMemo.get(key);
  if (v === undefined) {
    v = bracketPower(fighterOf(p, t)!, b);
    powerMemo.set(key, v);
  }
  return v;
}

interface Hero {
  p: Player;
  defenceId: string;
  accountId: string;
  classId: ClassId;
  level: number;
  power: number;
  rating: number;
  deviation: number;
  fighter: PvpFighterInput;
}

/** The rated arena on day t: every player of level ≥ 10 with a defence, by bracket. */
function arenaAt(pop: readonly Player[], t: number): Map<string, Hero[]> {
  const out = new Map<string, Hero[]>();
  for (const p of pop) {
    const f = fighterOf(p, t);
    if (!f || f.level < RATED_DUEL_MIN_LEVEL) continue;
    const b = pvpBracketOf(f.level);
    const list = out.get(b.id) ?? [];
    list.push({
      p,
      defenceId: `d${p.index}`,
      accountId: `a${p.index}`,
      classId: f.classId,
      level: f.level,
      power: powerOf(p, t, b),
      rating: 1500,
      deviation: 350,
      fighter: f,
    });
    out.set(b.id, list);
  }
  return out;
}

const bracketById = (id: string) => pvpBracketOf(id === '10-19' ? 10 : id === '20-29' ? 20 : 30);

/** Offers and offered pairs at one moment (all ratings 1500: matchmaking by Power alone). */
export function offersReport(
  pop: readonly Player[],
  t: number,
  seeds: number,
  config: MatchmakingConfig = DEFAULT_MATCHMAKING,
  label = '',
) {
  const arena = arenaAt(pop, t);
  const pairs = new Map<string, { a: number; n: number }>();
  for (const [bid, heroes] of [...arena.entries()].sort()) {
    const ranges = [0, 0, 0, 0];
    let offered = 0;
    const fav: number[] = [];
    for (const seeker of heroes) {
      const others = heroes.filter((h) => h.accountId !== seeker.accountId);
      const res = pickOpponents(seeker, others, `b4:${label}:${bid}:${seeker.p.index}`, 5, config);
      ranges[res.picks.length === 0 ? 3 : res.widened]! += 1;
      offered += res.picks.length;
      for (const pick of res.picks) {
        const d = pick.candidate;
        const share = winShare(
          seeker.fighter,
          d.fighter,
          seeds,
          `b4:${t}:${seeker.p.index}:${d.p.index}`,
        ).share;
        fav.push(Math.max(share, 1 - share));
        if (seeker.classId !== d.classId) {
          const [x, y, s] =
            seeker.classId < d.classId
              ? [seeker.classId, d.classId, share]
              : [d.classId, seeker.classId, 1 - share];
          const k = `${bid}:${x}:${y}`;
          const cell = pairs.get(k) ?? { a: 0, n: 0 };
          cell.a += s;
          cell.n += 1;
          pairs.set(k, cell);
        }
      }
    }
    const n = heroes.length;
    const mean = fav.reduce((s, x) => s + x, 0) / Math.max(1, fav.length);
    console.log(
      `  ${bid.padEnd(6)} ${String(n).padStart(4)} heroes  offers range0 ${ranges[0]} range1 ${ranges[1]} range2 ${ranges[2]} none ${ranges[3]} (${pct(ranges[3]! / Math.max(1, n))} empty)` +
        `  list ${(offered / Math.max(1, n)).toFixed(1)}  pairs ${fav.length}  mean fav ${pct(mean)}  ≥90 % ${pct(fav.filter((x) => x >= 0.9).length / Math.max(1, fav.length))}  ≥95 % ${pct(fav.filter((x) => x >= 0.95).length / Math.max(1, fav.length))}`,
    );
  }
  return pairs;
}

function printPairs(pairs: Map<string, { a: number; n: number }>) {
  console.log('  class pairs on offered (matched) pairs, share of the first class (pairs):');
  const byBracket = new Map<string, string[]>();
  for (const [k, v] of [...pairs.entries()].sort()) {
    const [bid, x, y] = k.split(':');
    const list = byBracket.get(bid!) ?? [];
    list.push(`${x}–${y} ${pct(v.a / v.n)} (${v.n})`);
    byBracket.set(bid!, list);
  }
  for (const [bid, list] of byBracket) console.log(`    ${bid}: ${list.join('  ')}`);
}

/** Duels a day by activity (at most the 10 a day). */
const DUELS_PER_DAY = { casual: 3, regular: 6, dedicated: 10 } as const;

interface RatingState {
  r: Rating;
  at: Date | null;
  games: number;
  establishedDay: number | null;
  settledGames: number | null;
}

/** A season of rated duels (ratings, pair factors and empty lists) on the evolving population. */
export function seasonOfDuels(
  pop: readonly Player[],
  label: string,
  config: MatchmakingConfig = DEFAULT_MATCHMAKING,
  carry: Map<number, Rating> | null = null,
  fixedDay: number | null = null,
  days = SEASON_DAYS,
) {
  const rs = new Map<number, RatingState>();
  const pairLog = new Map<string, number[]>();
  const factors = [0, 0, 0, 0];
  let lists = 0;
  let empty = 0;
  const emptyBy = new Map<string, [number, number]>();
  let pairExcluded = 0;
  const checkpoints: string[] = [];
  const rng = createRng(`b4-season:${label}`);
  for (let day = 1; day <= days; day++) {
    const t = fixedDay ?? day;
    const now = new Date(START + day * DAY);
    const arena = arenaAt(pop, t);
    for (const heroes of arena.values()) {
      for (const h of heroes) {
        if (!rs.has(h.p.index)) {
          const r = carry?.get(h.p.index)
            ? seasonStartRating(carry.get(h.p.index)!)
            : initialRating();
          rs.set(h.p.index, { r, at: null, games: 0, establishedDay: null, settledGames: null });
        }
      }
    }
    for (let round = 0; round < 10; round++) {
      for (const [bid, heroes] of arena) {
        for (const h of heroes) {
          if (round >= DUELS_PER_DAY[h.p.activity.id]) continue;
          const mine = rs.get(h.p.index)!;
          const pairCount = (o: Hero) => {
            const k =
              h.p.index < o.p.index ? `${h.p.index}:${o.p.index}` : `${o.p.index}:${h.p.index}`;
            return (pairLog.get(k) ?? []).filter((x) => x > now.getTime() - 7 * DAY).length;
          };
          const all = heroes.filter((o) => o.p.index !== h.p.index);
          const eligible = all.filter((o) => ratingFactor(pairCount(o)) > 0);
          pairExcluded += all.length - eligible.length;
          const cands = eligible.map((o) => ({
            ...o,
            rating: rs.get(o.p.index)!.r.rating,
            deviation: rs.get(o.p.index)!.r.deviation,
            recentDuels: pairCount(o),
          }));
          const res = pickOpponents(
            {
              power: h.power,
              classId: h.classId,
              rating: mine.r.rating,
              deviation: mine.r.deviation,
            },
            cands,
            `b4s:${label}:${day}:${round}:${h.p.index}`,
            5,
            config,
          );
          lists++;
          const eb = emptyBy.get(bid) ?? [0, 0];
          eb[1] += 1;
          if (res.picks.length === 0) eb[0] += 1;
          emptyBy.set(bid, eb);
          if (res.picks.length === 0) {
            empty++;
            continue;
          }
          const d = res.picks[rng.int(0, res.picks.length - 1)]!.candidate;
          const prior = pairCount(d);
          const factor = ratingFactor(prior);
          factors[Math.min(3, prior)]! += 1;
          const duel = simulateDuel({
            challenger: h.fighter,
            defender: d.fighter,
            seed: `b4d:${label}:${day}:${round}:${h.p.index}`,
          });
          const other = rs.get(d.p.index)!;
          const out = rateDuel({
            challenger: { rating: mine.r, lastRatedAt: mine.at },
            defender: { rating: other.r, lastRatedAt: other.at },
            outcome: duel.outcome,
            factor,
            now,
          });
          for (const [st, after] of [
            [mine, out.challenger.after],
            [other, out.defender.after],
          ] as const) {
            st.r = after;
            st.at = now;
            st.games += 1;
            if (st.games >= PROVISIONAL_GAMES && st.establishedDay === null)
              st.establishedDay = day;
            if (st.settledGames === null && st.r.deviation <= SETTLED_DEVIATION)
              st.settledGames = st.games;
          }
          const k =
            h.p.index < d.p.index ? `${h.p.index}:${d.p.index}` : `${d.p.index}:${h.p.index}`;
          pairLog.set(k, [...(pairLog.get(k) ?? []), now.getTime()]);
        }
      }
    }
    if ([7, 14, 28, 56].includes(day) || (fixedDay !== null && [1, 2, 3, 5, 7, 14].includes(day))) {
      checkpoints.push(`day ${day}: ${spearmanByBracket(arena, rs, t)}`);
    }
  }
  const states = [...rs.entries()];
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[s.length >> 1]! : NaN;
  };
  const totalDuels = factors.reduce((s, x) => s + x, 0);
  console.log(
    `  ${label}: ${states.length} rated heroes, ${totalDuels} rated duels; factor 1 ${pct(factors[0]! / totalDuels)}, ½ ${pct(factors[1]! / totalDuels)}, ¼ ${pct(factors[2]! / totalDuels)}, 4th+ ${pct(factors[3]! / totalDuels)} (full-value duels ${factors[0]}); ` +
      `empty lists ${pct(empty / Math.max(1, lists))} of ${lists}; candidates held back by the pair rule ${(pairExcluded / Math.max(1, lists)).toFixed(1)} per list`,
  );
  console.log(
    `    empty lists by bracket: ${[...emptyBy.entries()]
      .sort()
      .map(([b, [e, n]]) => `${b} ${pct(e / n)} of ${n}`)
      .join('  ')}`,
  );
  for (const a of ['casual', 'regular', 'dedicated'] as const) {
    const mine = states.filter(([i]) => pop[i]!.activity.id === a).map(([, s]) => s);
    const est = mine.filter((s) => s.establishedDay !== null);
    console.log(
      `    ${a.padEnd(9)} ${mine.length} heroes: established ${est.length} (median day ${median(est.map((s) => s.establishedDay!))}); settled (dev ≤ ${SETTLED_DEVIATION}) after median ${median(mine.filter((s) => s.settledGames !== null).map((s) => s.settledGames!))} games; end deviation median ${median(mine.map((s) => Math.round(s.r.deviation)))}; rating p10–p90 ${Math.round(
        quantile(
          mine.map((s) => s.r.rating),
          0.1,
        ),
      )}–${Math.round(
        quantile(
          mine.map((s) => s.r.rating),
          0.9,
        ),
      )}`,
    );
  }
  for (const c of checkpoints) console.log(`    ${c}`);
  return new Map(states.map(([i, s]) => [i, s.r]));
}
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : NaN;
};

const strengthMemo = new Map<string, number>();
/** A hero's strength: mean win share against up to 16 heroes of its bracket (4 duels each). */
function strength(h: Hero, heroes: readonly Hero[], t: number, local = false): number {
  const key = `${stateKey(h.p, t)}:${heroes.length}:${t}:${local}`;
  const hit = strengthMemo.get(key);
  if (hit !== undefined) return hit;
  const rng = createRng(`b4-strength:${key}`);
  // local: against heroes within 10 % of its bracket Power (whom matchmaking pairs it with).
  const others = heroes.filter(
    (o) =>
      o.p.index !== h.p.index &&
      (!local || Math.abs(o.power - h.power) <= 0.1 * Math.max(o.power, h.power, 400)),
  );
  let sum = 0;
  let n = 0;
  for (let i = 0; i < Math.min(16, others.length); i++) {
    const o = others[rng.int(0, others.length - 1)]!;
    sum += winShare(h.fighter, o.fighter, 4, `b4-str:${key}:${i}`).share;
    n++;
  }
  const v = n ? sum / n : 0.5;
  strengthMemo.set(key, v);
  return v;
}

function spearman(xs: number[], ys: number[]): number {
  const rank = (v: number[]) => {
    const idx = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array<number>(v.length);
    idx.forEach(([, i], k) => (r[i] = k));
    return r;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const n = xs.length;
  const mx = (n - 1) / 2;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i]! - mx) * (ry[i]! - mx);
    dx += (rx[i]! - mx) ** 2;
    dy += (ry[i]! - mx) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : NaN;
}

function spearmanByBracket(
  arena: Map<string, Hero[]>,
  rs: Map<number, RatingState>,
  t: number,
): string {
  const parts: string[] = [];
  for (const [bid, heroes] of [...arena.entries()].sort()) {
    const est = heroes.filter((h) => (rs.get(h.p.index)?.games ?? 0) >= PROVISIONAL_GAMES);
    if (est.length < 5) {
      parts.push(`${bid} n=${est.length}`);
      continue;
    }
    const rho = spearman(
      est.map((h) => rs.get(h.p.index)!.r.rating),
      est.map((h) => strength(h, heroes, t)),
    );
    const rhoPower = spearman(
      est.map((h) => h.power),
      est.map((h) => strength(h, heroes, t)),
    );
    const rhoLocal = spearman(
      est.map((h) => rs.get(h.p.index)!.r.rating),
      est.map((h) => strength(h, heroes, t, true)),
    );
    parts.push(
      `${bid} ρ(rating, strength) ${rho.toFixed(2)} [Power ${rhoPower.toFixed(2)}] ρ(rating, vs Power peers) ${rhoLocal.toFixed(2)} n=${est.length}`,
    );
  }
  return parts.join('  ');
}

export function arenaReport(trajectories: readonly Trajectory[]) {
  const mode = process.env.ARENA ?? 'all';
  const sizes = (process.env.SIZES ?? '20,100,500').split(',').map(Number);
  const steps = process.env.STEPS ? process.env.STEPS.split(',').map(Number) : null;
  const config: MatchmakingConfig = {
    ...DEFAULT_MATCHMAKING,
    ...(steps ? { powerSteps: steps } : {}),
    ...(process.env.FRESH ? { freshPairsFirst: process.env.FRESH === '1' } : {}),
    ...(process.env.MIN_ACCOUNTS ? { minAccounts: Number(process.env.MIN_ACCOUNTS) } : {}),
    ...(process.env.POOL ? { poolFactor: Number(process.env.POOL) } : {}),
    // MM=1: 5.6's matchmaking (raw Power, no fresh-pair preference), for the before tables.
    ...(process.env.MM === '1'
      ? { freshPairsFirst: false, classPowerScale: { warrior: 1, mage: 1, hunter: 1, warlock: 1 } }
      : {}),
  };
  console.log(`matchmaking ${JSON.stringify(config)}`);
  if (mode === 'fitscale')
    return fitScale(trajectories, (process.env.BRACKETS ?? '20-29,30-plus').split(','));
  if (mode === 'tune')
    return tuneClassFactors(trajectories, (process.env.BRACKETS ?? '20-29,30-plus').split(','));
  for (const size of sizes) {
    const pop = drawPopulation(trajectories, size, `arena:${size}`, SEASON_MIX);
    if (mode === 'all' || mode === 'offers') {
      for (const t of [14, 28, 56]) {
        console.log(`\n== ${size} players, offers on day ${t} (ratings all 1500)`);
        const pairs = offersReport(pop, t, 16, config, `${size}:${t}`);
        if (t === 56) printPairs(pairs);
      }
    }
    if (mode === 'all' || mode === 'rating') {
      console.log(`\n== ${size} players, a season of rated duels`);
      seasonOfDuels(pop, `s1:${size}`, config);
      console.log(
        `\n== ${size} players, the end-of-season heroes fixed for 14 days: from 1500, then from the soft reset`,
      );
      const first = seasonOfDuels(pop, `fixA:${size}`, config, null, SEASON_DAYS, 14);
      seasonOfDuels(pop, `fixB:${size}`, config, first, SEASON_DAYS, 14);
    }
  }
}

/**
 * `ARENA=tune`: re-fit the per-bracket class damage factors to realistic matched pairs (the pairs
 * matchmaking offers in a 500-player season on days 14, 28 and 56, classes differing), then report
 * those pairs and 5.4's synthetic class matchups (`matchupShare`) under the new factors.
 */
export function tuneClassFactors(trajectories: readonly Trajectory[], brackets: readonly string[]) {
  const pop = drawPopulation(trajectories, 500, 'arena:500', SEASON_MIX);
  const pairs = new Map<string, { a: Hero; d: Hero }[]>();
  for (const t of [14, 28, 56]) {
    for (const [bid, heroes] of arenaAt(pop, t)) {
      if (!brackets.includes(bid)) continue;
      const seen = new Set<string>();
      for (const seeker of heroes) {
        const res = pickOpponents(
          seeker,
          heroes.filter((h) => h.accountId !== seeker.accountId),
          `tune:${t}:${seeker.p.index}`,
          5,
        );
        for (const pick of res.picks) {
          const d = pick.candidate;
          if (d.classId === seeker.classId) continue;
          const k = `${stateKey(seeker.p, t)}|${stateKey(d.p, t)}`;
          if (seen.has(k)) continue;
          seen.add(k);
          const list = pairs.get(bid) ?? [];
          list.push({ a: seeker, d });
          pairs.set(bid, list);
        }
      }
    }
  }
  const classDamage: Record<string, Record<ClassId, number>> = JSON.parse(
    JSON.stringify(DEFAULT_PVP_CONFIG.classDamage),
  );
  const measure = (bid: string, cfg: PvpConfig) => {
    const cell = new Map<string, { s: number; n: number }>();
    const mean = Object.fromEntries(CLASS_IDS.map((c) => [c, { s: 0, n: 0 }])) as Record<
      ClassId,
      { s: number; n: number }
    >;
    for (const [i, { a, d }] of (pairs.get(bid) ?? []).entries()) {
      const share = winShare(a.fighter, d.fighter, 16, `tune:${bid}:${i}`, undefined, cfg).share;
      const [x, y, s] =
        a.classId < d.classId ? [a.classId, d.classId, share] : [d.classId, a.classId, 1 - share];
      const c = cell.get(`${x}–${y}`) ?? { s: 0, n: 0 };
      c.s += s;
      c.n += 1;
      cell.set(`${x}–${y}`, c);
    }
    // Class means over pair cells (each class pair weighs the same, like 5.4's bands).
    for (const [k, v] of cell) {
      const [x, y] = k.split('–') as [ClassId, ClassId];
      mean[x].s += v.s / v.n;
      mean[x].n += 1;
      mean[y].s += 1 - v.s / v.n;
      mean[y].n += 1;
    }
    return {
      cell,
      mean: Object.fromEntries(
        CLASS_IDS.map((c) => [c, mean[c].s / Math.max(1, mean[c].n)]),
      ) as Record<ClassId, number>,
    };
  };
  for (const bid of brackets) {
    console.log(
      `\n== ${bid}: ${(pairs.get(bid) ?? []).length} realistic matched pairs (different classes)`,
    );
    for (let i = 0; i < Number(process.env.ITER ?? 8); i++) {
      if (i > 0 && process.env.ITER === '1') break;
      const cfg = { ...DEFAULT_PVP_CONFIG, classDamage };
      const { cell, mean } = measure(bid, cfg);
      const t = classDamage[bid]!;
      console.log(
        `  ${i}: ${CLASS_IDS.map((c) => `${c} ${pct(mean[c])} (× ${t[c]})`).join('  ')} | ${[
          ...cell.entries(),
        ]
          .sort()
          .map(([k, v]) => `${k} ${pct(v.s / v.n)}`)
          .join(' ')}`,
      );
      for (const c of CLASS_IDS) t[c] = +(t[c] * Math.pow(0.5 / mean[c], 0.25)).toFixed(3);
    }
    const cfg = { ...DEFAULT_PVP_CONFIG, classDamage };
    const b = bracketById(bid);
    const synth: string[] = [];
    const synthMean = Object.fromEntries(CLASS_IDS.map((c) => [c, 0])) as Record<ClassId, number>;
    let worst = 0.5;
    for (const a of CLASS_IDS)
      for (const d of CLASS_IDS)
        if (a < d) {
          const s = matchupShare(b, a, d, 6, 12, cfg);
          synth.push(`${a}–${d} ${pct(s)}`);
          synthMean[a] += s / 3;
          synthMean[d] += (1 - s) / 3;
          if (Math.abs(s - 0.5) > Math.abs(worst - 0.5)) worst = s;
        }
    console.log(
      `  synthetic (5.4 kits) with these factors: ${synth.join(' ')}; means ${CLASS_IDS.map((c) => `${c} ${pct(synthMean[c])}`).join(' ')}; worst ${pct(worst)}`,
    );
    console.log(`  factors: ${JSON.stringify(classDamage[bid])}`);
  }
}

/**
 * `ARENA=fitscale`: fit the per-class Power scale of matchmaking (`classPowerScale`) so that the
 * classes average 50 % over the realistic pairs matchmaking offers (500 players, days 14/28/56).
 * Pairs are re-drawn under each scale. Duel rules are not touched.
 */
export function fitScale(trajectories: readonly Trajectory[], brackets: readonly string[]) {
  const pop = drawPopulation(trajectories, 500, 'arena:500', SEASON_MIX);
  const one = { warrior: 1, mage: 1, hunter: 1, warlock: 1 };
  const scale: Record<string, Record<ClassId, number>> = Object.fromEntries(
    brackets.map((b) => [
      b,
      { ...(process.env.FROM_ONE ? one : DEFAULT_MATCHMAKING.classPowerScale) },
    ]),
  );
  for (const bid of brackets) {
    for (let it = 0; it < Number(process.env.ITER ?? 6); it++) {
      const cell = new Map<string, { s: number; n: number }>();
      const fav: number[] = [];
      for (const t of [14, 28, 56]) {
        const heroes = arenaAt(pop, t).get(bid) ?? [];
        const cfg = { ...DEFAULT_MATCHMAKING, classPowerScale: scale[bid]! };
        const seen = new Set<string>();
        for (const seeker of heroes) {
          const res = pickOpponents(
            seeker,
            heroes.filter((h) => h.accountId !== seeker.accountId),
            `fit:${t}:${seeker.p.index}`,
            5,
            cfg,
          );
          for (const pick of res.picks) {
            const d = pick.candidate;
            const k = `${stateKey(seeker.p, t)}|${stateKey(d.p, t)}`;
            if (seen.has(k)) continue;
            seen.add(k);
            const share = winShare(seeker.fighter, d.fighter, 16, `fit:${bid}:${k}`).share;
            fav.push(Math.max(share, 1 - share));
            if (d.classId === seeker.classId) continue;
            const [x, y, s] =
              seeker.classId < d.classId
                ? [seeker.classId, d.classId, share]
                : [d.classId, seeker.classId, 1 - share];
            const c = cell.get(`${x}–${y}`) ?? { s: 0, n: 0 };
            c.s += s;
            c.n += 1;
            cell.set(`${x}–${y}`, c);
          }
        }
      }
      const mean = Object.fromEntries(CLASS_IDS.map((c) => [c, { s: 0, n: 0 }])) as Record<
        ClassId,
        { s: number; n: number }
      >;
      for (const [k, v] of cell) {
        const [x, y] = k.split('–') as [ClassId, ClassId];
        mean[x].s += v.s / v.n;
        mean[x].n++;
        mean[y].s += 1 - v.s / v.n;
        mean[y].n++;
      }
      const m = Object.fromEntries(
        CLASS_IDS.map((c) => [c, mean[c].s / Math.max(1, mean[c].n)]),
      ) as Record<ClassId, number>;
      const mf = fav.reduce((a, b) => a + b, 0) / fav.length;
      console.log(
        `${bid} ${it}: ${CLASS_IDS.map((c) => `${c} ${pct(m[c])} (÷ ${scale[bid]![c]})`).join('  ')} | ${[
          ...cell.entries(),
        ]
          .sort()
          .map(([k, v]) => `${k} ${pct(v.s / v.n)} (${v.n})`)
          .join(' ')} | mean fav ${pct(mf)}`,
      );
      // A class that wins too often must meet stronger heroes: lower its scale (its Power counts more).
      for (const c of CLASS_IDS)
        scale[bid]![c] = +(
          scale[bid]![c] * Math.pow(0.5 / m[c], Number(process.env.RATE ?? 0.1))
        ).toFixed(3);
    }
  }
  console.log(JSON.stringify(scale));
}
