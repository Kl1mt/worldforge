// The build-diversity search of `builds.test.ts`, printed (ticket B.2): per class, the best build,
// how many builds are within 7 % and what every one of them wears. Arg: `boss` or `farm`.
import {
  BOSS_JOB,
  CLASS_IDS,
  FARM_JOB,
  bossTime,
  buildItems,
  buildParts,
  buildSlots,
  classMythic,
  describeBuild,
  farmRate,
  searchBuilds,
  setChassis,
  topBuilds,
} from '../../packages/game-core/src/balance/builds.ts';

const job = process.argv[2] === 'farm' ? 'farm' : 'boss';
for (const c of CLASS_IDS) {
  const scored =
    job === 'boss'
      ? searchBuilds(c, BOSS_JOB.itemLevel, (i) => -bossTime(c, i), setChassis(c), true)
      : searchBuilds(c, FARM_JOB.itemLevel, (i) => farmRate(c, i), setChassis(c));
  const top = topBuilds(scored, 0.07);
  const parts = top.map((t) => buildParts(t.build));
  const items = (p: (typeof parts)[number]) => [...p.unique, ...p.effects, ...p.affixes];
  const everywhere = [...new Set(parts.flatMap(items))].filter((x) =>
    parts.every((p) => items(p).includes(x)),
  );
  const fmt = (s: number) =>
    job === 'boss' ? `${(-s / 1000).toFixed(1)} s` : `${s.toFixed(1)}/min`;
  let mythic = '';
  if (job === 'boss') {
    const best = scored.find((s) => s.build.picks[0]!.kind === 'legendary')!;
    const picks = best.build.picks.slice();
    picks[buildSlots(c).indexOf('weapon')] = { kind: 'mythic', mythicId: classMythic(c) };
    const t = bossTime(c, buildItems({ ...best.build, picks }, BOSS_JOB.itemLevel));
    mythic = ` · class Mythic weapon ${(t / 1000).toFixed(1)} s`;
  }
  const layouts = new Set(top.map((t) => t.build.chassis)).size;
  console.log(
    `${c} | best ${fmt(scored[0]!.score)} | within 7 %: ${top.length} builds, ${layouts} set layouts | in all: ${everywhere.join(', ') || '—'}${mythic}`,
  );
  for (const t of top.slice(0, 6)) console.log(`   ${fmt(t.score)}  ${describeBuild(t.build)}`);
}
