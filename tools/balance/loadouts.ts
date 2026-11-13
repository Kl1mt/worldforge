// Ticket 9.1: skills, resources and loadouts, measured with game-core's prototype (docs/SKILLS.md).
// Dev script; guards in packages/game-core/src/balance/loadouts.test.ts.
//   pnpm --filter @worldforge/server exec tsx ../../tools/balance/loadouts.ts search   # or: jobs, cost, pvp
//   search: every loadout of every class on every farming and boss job; the default's place, the
//           best, the viable ones (within 7 %), and whether one loadout leads both kinds of job
//   jobs:   the default loadout against today (switch off) on every job (the replay, in numbers)
//   cost:   the offline settlement's cost on 3 h and 8 h windows, today against loadouts
//   pvp:    duels of a loadout against the default one, per class and bracket
// CLASSES=warrior,mage  JOBS=deep49,sovereign50  TOP=5  COMPLETE=1 (only full loadouts)
import * as G from '../../packages/game-core/src/index.ts';
import {
  BOSS_JOBS,
  FARM_JOBS,
  allLoadouts,
  bossTime,
  farmRate,
  scoreAll,
  viable,
  withSkillsPrototype,
  type ScoredLoadout,
} from '../../packages/game-core/src/balance/loadouts.ts';
import { legendaryKit, upgraded } from '../../packages/game-core/src/balance/kits.ts';

const mode = process.argv[2] ?? 'search';
const CLASSES = (process.env.CLASSES?.split(',') ?? G.CLASS_IDS) as G.ClassId[];
const JOBS = process.env.JOBS?.split(',');
const TOP = Number(process.env.TOP ?? 5);
const COMPLETE = process.env.COMPLETE === '1';
const f1 = (x: number) => x.toFixed(1);
const f2 = (x: number) => x.toFixed(2);
const short = (k: string) => k.replace(/,-/g, '').replace(/\/-$/, '');

type Kind = 'farm' | 'boss';
const jobs = [
  ...FARM_JOBS.map((j) => ({ kind: 'farm' as Kind, j })),
  ...BOSS_JOBS.map((j) => ({ kind: 'boss' as Kind, j })),
].filter((x) => !JOBS || JOBS.includes(x.j.id));

function measure(c: G.ClassId, kind: Kind, j: (typeof jobs)[number]['j'], l: G.Loadout) {
  return kind === 'farm'
    ? farmRate(c, j as (typeof FARM_JOBS)[number], l)
    : -bossTime(c, j as (typeof BOSS_JOBS)[number], l).time;
}

if (mode === 'jobs') {
  for (const { kind, j } of jobs) {
    const row = CLASSES.map((c) => {
      const today = withSkillsPrototype(() => measure(c, kind, j, G.defaultLoadout(c)), 'off');
      const kit = withSkillsPrototype(() => measure(c, kind, j, G.defaultLoadout(c)), 'on');
      return `${c} ${f2(Math.abs(today))} → ${f2(Math.abs(kit))}${today === kit ? ' =' : ' ≠'}`;
    });
    console.log(`${j.label}: ${row.join(' · ')}`);
  }
}

const PAIRS: [string, string[]][] = [
  ['pass26', ['crypt3']],
  ['depths37', ['heroic34', 'tyrant38']],
  ['deep49', ['sovereign50']],
];

if (mode === 'search') {
  const scores: Record<string, Record<string, ScoredLoadout[]>> = {};
  const leaders: Record<string, Record<string, string[]>> = {};
  for (const c of CLASSES) {
    leaders[c] = {};
    for (const { kind, j } of jobs) {
      const t0 = Date.now();
      const scored = withSkillsPrototype(() =>
        scoreAll(c, allLoadouts(c, j.hero, COMPLETE), (l) => measure(c, kind, j, l)),
      );
      const def = scored.find((s) => s.key === G.loadoutKey(G.defaultLoadout(c)))!;
      const v = viable(scored);
      const distinct = new Set(
        v.map((x) => {
          const [core, ...rest] = x.loadout.actives;
          return `${core}|${rest.filter(Boolean).sort().join(',')}|${x.loadout.passive ?? ''}`;
        }),
      ).size;
      const best = scored[0]!;
      const unit = kind === 'farm' ? 'k/min' : 's';
      const val = (s: ScoredLoadout) => f1(Math.abs(s.score));
      console.log(
        `\n${c} · ${j.label}: ${scored.length} loadouts (${((Date.now() - t0) / 1000).toFixed(1)} s); default ${val(def)} ${unit}; best ${val(best)} (× ${f2(kind === 'farm' ? best.score / def.score : def.score / best.score)}); viable (7 %) ${v.length} (${distinct} distinct)`,
      );
      const wins = (s: ScoredLoadout) =>
        kind === 'boss'
          ? ` (wins ${f2(withSkillsPrototype(() => bossTime(c, j as (typeof BOSS_JOBS)[number], s.loadout).wins))})`
          : '';
      if (kind === 'boss') console.log(`  default${wins(def)}`);
      for (const s of scored.slice(0, TOP)) console.log(`  ${val(s)}  ${short(s.key)}${wins(s)}`);
      leaders[c]![j.id] = v.map((s) => s.key);
      (scores[c] ??= {})[j.id] = scored;
    }
  }
  // Does one loadout lead both kinds of job? Per tier: a farming job and the boss jobs near its
  // level, over the loadouts both can field. "Leads" = within 2 % of the job’s best (boss times move ~2 % between seed sets, B.2).
  console.log(
    '\nLeaders of both kinds (within 2 % of the best on a farming and a boss job of a tier; should be none):',
  );
  for (const c of CLASSES) {
    const out: string[] = [];
    for (const [farm, bosses] of PAIRS) {
      for (const boss of bosses) {
        const f = scores[c]?.[farm];
        const b = scores[c]?.[boss];
        if (!f || !b) continue;
        const both = f.filter((x) => b.some((y) => y.key === x.key));
        const lead = (list: ScoredLoadout[], share: number) => {
          const inBoth = list.filter((x) => both.some((y) => y.key === x.key));
          return new Set(viable(inBoth, share).map((x) => x.key));
        };
        const lf = lead(f, 0.02);
        const lb = lead(b, 0.02);
        const common = [...lf].filter((k) => lb.has(k));
        const bf = f.find((x) => both.some((y) => y.key === x.key))!;
        const bb = b.find((x) => both.some((y) => y.key === x.key))!;
        const gap = (list: ScoredLoadout[], key: string, best: ScoredLoadout) => {
          const x = list.find((y) => y.key === key)!;
          return Math.abs(best.score / x.score - 1) * 100;
        };
        out.push(
          `${farm}×${boss}: ${common.length ? common.map(short).join(' | ') : 'none'}; farm best ${gap(b, bf.key, bb).toFixed(1)} % behind at the boss, boss best ${gap(f, bb.key, bf).toFixed(1)} % behind farming`,
        );
      }
    }
    console.log(`  ${c}:\n    ${out.join('\n    ')}`);
  }
}

if (mode === 'cost') {
  // Median of REPS runs (after a warm-up): the whole settlement (combat + loot) and the combat
  // alone (`simulateFarmingAggregate`), Hollow Deep 49 in Legendaries 47 +10.
  const REPS = Number(process.env.REPS ?? 9);
  const LOADOUTS: Record<G.ClassId, G.Loadout> = {
    warrior: { actives: ['rend', 'execute', 'earthsplitter'], passive: 'juggernaut' },
    mage: { actives: ['scorch', 'pyroblast', 'meteor'], passive: 'deepReserves' },
    hunter: { actives: ['serratedArrow', 'volley', 'killShot'], passive: 'predator' },
    warlock: { actives: ['agony', 'corruption', 'soulBurn'], passive: 'soulSiphon' },
  };
  const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  const time = (f: () => unknown) => {
    f();
    const xs: number[] = [];
    for (let k = 0; k < REPS; k++) {
      const t0 = performance.now();
      f();
      xs.push(performance.now() - t0);
    }
    return median(xs);
  };
  console.log(
    'window · class: settlement today / default kit / loadout · combat only today / default kit / loadout (ms)',
  );
  for (const hours of [3, 8]) {
    for (const c of CLASSES) {
      const equipment = FARM_JOBS[2]!.gear(c);
      const m = G.equipmentModifiers(
        equipment,
        G.DEFAULT_ACTIVITY_CONFIG.modifierCaps,
        G.DEFAULT_LOOT_CONFIG,
        {
          classId: c,
          extraEffects: G.setBonusInstances(equipment),
        },
      );
      const settle = (l?: G.Loadout) => () =>
        G.settleFarming({
          character: { classId: c, level: 49, xp: 0 },
          equipment,
          areaId: 'hollowDeep',
          seed: 'cost',
          firstCycle: 0,
          durationMs: hours * 3_600_000,
          inventoryCount: 10_000,
          ...(l ? { loadout: l } : {}),
        });
      const combat = (l?: G.Loadout) => () =>
        G.simulateFarmingAggregate({
          character: { classId: c, level: 49, xp: 0 },
          equipment: m.stats,
          modifiers: { xpGain: m.xpGain, skillDamage: m.skillDamage, bossDamage: m.bossDamage },
          effects: m.effects,
          areaId: 'hollowDeep',
          seed: 'cost',
          firstCycle: 0,
          durationMs: hours * 3_600_000,
          ...(l ? { loadout: l } : {}),
        });
      const row = [
        withSkillsPrototype(() => time(settle()), 'off'),
        withSkillsPrototype(() => time(settle()), 'on'),
        withSkillsPrototype(() => time(settle(LOADOUTS[c])), 'on'),
        withSkillsPrototype(() => time(combat()), 'off'),
        withSkillsPrototype(() => time(combat()), 'on'),
        withSkillsPrototype(() => time(combat(LOADOUTS[c])), 'on'),
      ].map(f1);
      console.log(
        `${hours} h · ${c} (${G.loadoutKey(LOADOUTS[c])}): ${row.slice(0, 3).join(' / ')} · ${row.slice(3).join(' / ')}`,
      );
    }
  }
}

if (mode === 'pvp') {
  // Duels in the 30+ bracket (level 32, Legendaries 29 +5) and 20–29 (level 25, Legendaries 24 +5).
  const SEEDS = Number(process.env.SEEDS ?? 200);
  // KEEP: the share of a loadout's extra damage a duel keeps (PVP_V3_SKILL_KEEP when unset; 1 = none).
  const config = process.env.KEEP
    ? { ...G.DEFAULT_PVP_CONFIG, skillKeep: Number(process.env.KEEP) }
    : G.DEFAULT_PVP_CONFIG;
  const brackets: [string, number, number][] = [
    ['20-29', 25, 24],
    ['30+', 32, 29],
  ];
  const duel = (
    a: G.ClassId,
    la: G.Loadout,
    b: G.ClassId,
    lb: G.Loadout,
    level: number,
    il: number,
  ) =>
    withSkillsPrototype(() => {
      const ea = upgraded(legendaryKit(a, il), 5);
      const eb = upgraded(legendaryKit(b, il), 5);
      let wins = 0;
      for (let i = 0; i < SEEDS; i++) {
        // Alternate sides so initiative and the challenger's role even out.
        const swap = i % 2 === 1;
        const r = G.simulateDuel(
          {
            challenger: swap
              ? { classId: b, level, equipment: eb, loadout: lb }
              : { classId: a, level, equipment: ea, loadout: la },
            defender: swap
              ? { classId: a, level, equipment: ea, loadout: la }
              : { classId: b, level, equipment: eb, loadout: lb },
            seed: `l9-pvp:${i}`,
          },
          config,
        );
        const aSide = swap ? 'defender' : 'challenger';
        wins += r.outcome === aSide ? 1 : r.outcome === 'draw' ? 0.5 : 0;
      }
      return wins / SEEDS;
    });
  for (const [label, level, il] of brackets) {
    console.log(`\n${label} (level ${level}, Legendaries ${il} +5), ${SEEDS} duels per pair`);
    const best: Record<string, G.Loadout> = {};
    for (const c of CLASSES) {
      const def = G.defaultLoadout(c);
      const scored = allLoadouts(c, { level }, true)
        .map((l) => ({ l, w: duel(c, l, c, def, level, il) }))
        .sort((x, y) => y.w - x.w);
      best[c] = scored[0]!.l;
      const share = scored.filter((s) => s.w > 0.5).length / scored.length;
      console.log(
        `  ${c}: ${scored.length} full loadouts against the default: best ${f2(scored[0]!.w)} (${short(G.loadoutKey(scored[0]!.l))}), median ${f2(scored[Math.floor(scored.length / 2)]!.w)}, worst ${f2(scored.at(-1)!.w)}; ${Math.round(share * 100)} % win more than half`,
      );
    }
    // Class matchups: default against default, and each class's best duel loadout against it.
    const rows: string[] = [];
    let spreadDef = 0;
    let spreadBest = 0;
    for (const a of CLASSES)
      for (const b of CLASSES) {
        if (a >= b) continue;
        const d = duel(a, G.defaultLoadout(a), b, G.defaultLoadout(b), level, il);
        const x = duel(a, best[a]!, b, best[b]!, level, il);
        spreadDef = Math.max(spreadDef, Math.abs(d - 0.5));
        spreadBest = Math.max(spreadBest, Math.abs(x - 0.5));
        rows.push(`${a}–${b} ${f2(d)} → ${f2(x)}`);
      }
    console.log(`  matchups (default → best duel loadouts): ${rows.join(' · ')}`);
    console.log(`  largest favourite: ${f2(0.5 + spreadDef)} → ${f2(0.5 + spreadBest)}`);
  }
}

if (mode === 'power') {
  // The proposed Power 4: the Proving Grounds read the hero's saved defence loadout. Level 50 in
  // Legendaries 47 +10 and level 34 in Legendaries 33 +10; every complete loadout.
  for (const [level, il] of [
    [34, 33],
    [50, 47],
  ] as const) {
    console.log(`\nLevel ${level}, Legendaries ${il} +10 (Power 3 trials, at most 4,800)`);
    for (const c of CLASSES) {
      const equipment = upgraded(legendaryKit(c, il), 10);
      const power = (l: G.Loadout | null, m: G.SkillsPrototypeMode) =>
        withSkillsPrototype(
          () => G.characterPower({ classId: c, level, equipment, loadout: l }).power,
          m,
        );
      const today = power(null, 'off');
      const def = power(null, 'on');
      const hero = {
        level,
        progress: { forgeTyrantDefeated: true, hollowSovereignDefeated: true },
      };
      const scored = allLoadouts(c, hero, true)
        .map((l) => ({ l, p: power(l, 'on') }))
        .sort((a, b) => b.p - a.p);
      const median = scored[Math.floor(scored.length / 2)]!.p;
      console.log(
        `  ${c}: today ${today} · default loadout ${def}${today === def ? ' (=)' : ' (≠)'} · best ${scored[0]!.p} (× ${f2(scored[0]!.p / def)}, ${short(G.loadoutKey(scored[0]!.l))}) · median ${median} · worst ${scored.at(-1)!.p}`,
      );
    }
  }
}
