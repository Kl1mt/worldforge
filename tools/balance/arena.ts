// Ticket 5.6: arena matchmaking fairness behind docs/PVP.md "Matchmaking". Dev script; guards in
// packages/game-core/src/balance/arena-fairness.test.ts.
//   pnpm --filter @worldforge/server exec tsx ../../tools/balance/arena.ts [size] [seeds] [rounds]
// Per rated bracket: the favourite's win share over offered pairs, for 5.5's random draw and for
// 5.6's matchmaking at the season's start (every rating 1500) and after a simulated season.
// Ticket 6.5b env: AWAKENED=1 (the +10 Void heroes awaken every piece), POWER=1|2 (the bracket
// Power version matchmaking ranks by; 2 sees awakening), BRACKETS=20-29,30-plus.
import { DEFAULT_MATCHMAKING, matchmakingConfig } from '../../packages/game-core/src/index.ts';
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
const pct = (v: number) => `${(v * 100).toFixed(1)} %`;
const line = (label: string, r: FairnessReport) =>
  console.log(
    `  ${label.padEnd(12)} pairs ${String(r.pairs).padStart(4)}  mean ${pct(r.meanFavourite)}  p90 ${pct(r.p90Favourite)}  ≥90 % ${pct(r.over90)}  ≥95 % ${pct(r.over95)}  max ${pct(r.maxFavourite)}  3+ tiers ${pct(r.extremePairs)}  list ${r.meanListSize.toFixed(1)}  widened ${pct(r.widened)}  empty ${r.emptyLists}`,
  );

console.log(
  `matchmaking 1–29 ${JSON.stringify(DEFAULT_MATCHMAKING)}, 30+ ${JSON.stringify(matchmakingConfig('30-plus').classPowerScale)}; ${size} heroes, ${seeds} duels per pair`,
);
const options = {
  awakened: process.env.AWAKENED === '1',
  ...(process.env.POWER ? { powerVersion: Number(process.env.POWER) as 1 | 2 | 3 } : {}),
  ...(process.env.MAX_LEVEL ? { maxLevel: Number(process.env.MAX_LEVEL) } : {}),
};
console.log(`population ${JSON.stringify(options)}`);
const only = process.env.BRACKETS?.split(',');
for (const b of RATED_BRACKETS.filter((x) => !only || only.includes(x.id))) {
  const t0 = Date.now();
  const pop = arenaPopulation(b, size, options);
  // Ticket B.5: POWER=1|2 ranks by Character Power as before, with matchmaking 3's class scale.
  const cfg =
    process.env.POWER && process.env.POWER !== '3' ? DEFAULT_MATCHMAKING : matchmakingConfig(b.id);
  const powers = pop.map((h) => h.power).sort((x, y) => x - y);
  console.log(
    `${b.label}: Power ${powers[0]}–${powers[powers.length - 1]} (median ${powers[powers.length >> 1]})`,
  );
  line('random', measureFairness(b, pop, 'random', seeds));
  line('start', measureFairness(b, pop, 'matchmaking', seeds, cfg));
  const settled = settleRatings(b, pop, rounds, cfg);
  line(`settled ${rounds}`, measureFairness(b, settled, 'matchmaking', seeds, cfg));
  {
    // Ticket 6.5b: only the offered pairs with exactly one side in a +10 Void kit (the heroes
    // that awaken with AWAKENED=1), so the same pairs can be compared with and without it.
    const awake = (h: (typeof pop)[number]) => h.tier === 'legendary+10void';
    const one = (a: (typeof pop)[number], d: (typeof pop)[number]) => awake(a) !== awake(d);
    const n = pop.filter(awake).length;
    console.log(`  ${n} heroes in +10 Void kits (awakened: ${options.awakened})`);
    line('one +10V', measureFairness(b, pop, 'matchmaking', seeds, cfg, 5, one));
    line('one +10V set', measureFairness(b, settled, 'matchmaking', seeds, cfg, 5, one));
  }
  console.log(`  (${Date.now() - t0} ms)`);
}
