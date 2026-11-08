// Ticket 5.6: arena matchmaking fairness behind docs/PVP.md "Matchmaking". Dev script; guards in
// packages/game-core/src/balance/arena-fairness.test.ts.
//   pnpm --filter @worldforge/server exec tsx ../../tools/balance/arena.ts [size] [seeds] [rounds]
// Per rated bracket: the favourite's win share over offered pairs, for 5.5's random draw and for
// 5.6's matchmaking at the season's start (every rating 1500) and after a simulated season.
import { DEFAULT_MATCHMAKING } from '../../packages/game-core/src/index.ts';
import {
  RATED_BRACKETS,
  arenaPopulation,
  measureFairness,
  settleRatings,
  type FairnessReport,
} from '../../packages/game-core/src/balance/arena-fixtures.ts';

const size = Number(process.argv[2] ?? 120);
const seeds = Number(process.argv[3] ?? 16);
const rounds = Number(process.argv[4] ?? 20);
const pct = (v: number) => `${(v * 100).toFixed(0)} %`;
const line = (label: string, r: FairnessReport) =>
  console.log(
    `  ${label.padEnd(12)} pairs ${String(r.pairs).padStart(4)}  mean ${pct(r.meanFavourite)}  p90 ${pct(r.p90Favourite)}  ≥90 % ${pct(r.over90)}  ≥95 % ${pct(r.over95)}  max ${pct(r.maxFavourite)}  list ${r.meanListSize.toFixed(1)}  widened ${pct(r.widened)}  empty ${r.emptyLists}`,
  );

console.log(
  `matchmaking ${JSON.stringify(DEFAULT_MATCHMAKING)}; ${size} heroes, ${seeds} duels per pair`,
);
for (const b of RATED_BRACKETS) {
  const t0 = Date.now();
  const pop = arenaPopulation(b, size);
  const powers = pop.map((h) => h.power).sort((x, y) => x - y);
  console.log(
    `${b.label}: Power ${powers[0]}–${powers[powers.length - 1]} (median ${powers[powers.length >> 1]})`,
  );
  line('random', measureFairness(b, pop, 'random', seeds));
  line('start', measureFairness(b, pop, 'matchmaking', seeds));
  const settled = settleRatings(b, pop, rounds);
  line(`settled ${rounds}`, measureFairness(b, settled, 'matchmaking', seeds));
  console.log(`  (${Date.now() - t0} ms)`);
}
