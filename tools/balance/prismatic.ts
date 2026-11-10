// Ticket 6.4: the best Prismatic build against the best Void build (the B.2 build search).
// Dev script; guards in balance/prismatic-balance.test.ts.
//   pnpm --filter @worldforge/server exec tsx ../../tools/balance/prismatic.ts [farm|verge|boss|all] [upgrade]
// For every class and job, the build search runs three times: every piece plain, every piece Void
// and every piece Prismatic (so each variant gets the effects and affix package that suit it).
// It prints each search's best score, and how the best plain builds fare as Void and as Prismatic.
import * as G from '../../packages/game-core/src/index.ts';
import {
  PASS_FARM_JOB,
  WARDEN_JOB,
  bossTime,
  describeBuild,
  farmRate,
  searchBuilds,
  setChassis,
  type Build,
} from '../../packages/game-core/src/balance/builds.ts';

const mode = process.argv[2] ?? 'all';
const upgradeLevel = Number(process.argv[3] ?? 0);
type Variant = 'plain' | 'void' | 'prismatic';
const as = (v: Variant) => (items: G.EquippedItem[]) =>
  v === 'plain' ? items : items.map((i) => ({ ...i, variant: v }));
const withUp = (items: G.EquippedItem[]) =>
  upgradeLevel ? items.map((i) => ({ ...i, upgradeLevel })) : items;

const jobs = {
  farm: {
    itemLevel: PASS_FARM_JOB.itemLevel,
    score: (c: G.ClassId, items: G.EquippedItem[]) => farmRate(c, items, PASS_FARM_JOB),
    unit: (s: number) => `${s.toFixed(2)} kills/min`,
  },
  // The Ashfall Verge at 32 (item level 31: tier-4 bases, tier-5 affixes), where Void's base
  // bonus is largest next to the affixes.
  verge: {
    itemLevel: 31,
    score: (c: G.ClassId, items: G.EquippedItem[]) =>
      farmRate(c, items, { ...PASS_FARM_JOB, areaId: 'ashfallVerge', level: 32, itemLevel: 31 }),
    unit: (s: number) => `${s.toFixed(2)} kills/min`,
  },
  boss: {
    itemLevel: WARDEN_JOB.itemLevel,
    score: (c: G.ClassId, items: G.EquippedItem[]) => -bossTime(c, items, 12, WARDEN_JOB),
    unit: (s: number) => `${(-s / 1000).toFixed(2)} s`,
  },
} as const;

for (const [name, job] of Object.entries(jobs)) {
  if (mode !== 'all' && mode !== name) continue;
  for (const c of G.CLASS_IDS) {
    const best: Record<string, { score: number; build: Build }> = {};
    for (const v of ['plain', 'void', 'prismatic'] as const) {
      const scored = searchBuilds(
        c,
        job.itemLevel,
        (items) => job.score(c, as(v)(withUp(items))),
        setChassis(c),
      );
      best[v] = scored[0]!;
    }
    const ratio = best.prismatic!.score / best.void!.score;
    console.log(
      `${name} ${c} +${upgradeLevel}: plain ${job.unit(best.plain!.score)} · void ${job.unit(best.void!.score)} · prismatic ${job.unit(best.prismatic!.score)} · prismatic/void ${ratio.toFixed(3)}`,
    );
    console.log(`   void:      ${describeBuild(best.void!.build)}`);
    console.log(`   prismatic: ${describeBuild(best.prismatic!.build)}`);
  }
}

// PvP (mode `pvp`): +10 Prismatic against +10 Void and against +5, per bracket (5.4 fixtures).
if (mode === 'pvp') {
  const F = await import('../../packages/game-core/src/balance/pvp-fixtures.ts');
  for (const b of G.PVP_BRACKETS) {
    const L = b.referenceLevel;
    const share = (
      a: 'legendary+10prismatic' | 'legendary+10void',
      d: 'legendary+10void' | 'legendary+5',
    ) => {
      let total = 0;
      for (const c of G.CLASS_IDS)
        for (let s = 0; s < 3; s++)
          total += F.winShare(
            F.fighter(c, L, F.gear(c, L, a, s)),
            F.fighter(c, L, F.gear(c, L, d, s + 7)),
            24,
            `pvp-prismatic:${b.id}:${c}:${d}:${s}`,
          ).share;
      return (total / (G.CLASS_IDS.length * 3)).toFixed(3);
    };
    console.log(
      `${b.id} (ref ${L}): prismatic vs void ${share('legendary+10prismatic', 'legendary+10void')} · prismatic vs +5 ${share('legendary+10prismatic', 'legendary+5')} · void vs +5 ${share('legendary+10void', 'legendary+5')}`,
    );
  }
}

// PvP (mode `pvp-builds`): B.2-shaped late builds (`sampleBuild`) at +10, Prismatic against Void.
if (mode === 'pvp-builds') {
  const F = await import('../../packages/game-core/src/balance/pvp-fixtures.ts');
  for (const b of G.PVP_BRACKETS) {
    const L = b.referenceLevel;
    const dress = (items: G.EquippedItem[], variant: 'void' | 'prismatic') =>
      items.map((i) => ({ ...i, upgradeLevel: 10, variant }));
    const per: string[] = [];
    let total = 0;
    for (const c of G.CLASS_IDS) {
      let cs = 0;
      for (let s = 0; s < 6; s++) {
        cs += F.winShare(
          F.fighter(c, L, dress(F.sampleBuild(c, Math.max(1, L - 1), s), 'prismatic')),
          F.fighter(c, L, dress(F.sampleBuild(c, Math.max(1, L - 1), s), 'void')),
          24,
          `pvp-prismatic-build:${b.id}:${c}:${s}`,
        ).share;
      }
      per.push(`${c} ${(cs / 6).toFixed(2)}`);
      total += cs / 6;
    }
    console.log(
      `${b.id}: prismatic vs void (same build) ${(total / 4).toFixed(3)} · ${per.join(' ')}`,
    );
  }
}

// Rates (mode `rates`): Void and Prismatic items per hour of farming and per boss run, by source,
// for a hero in strong gear (a warrior's top Pass build, +10, at each source's item level).
if (mode === 'rates') {
  const { buildItems } = await import('../../packages/game-core/src/balance/builds.ts');
  const hours = Number(process.env.HOURS ?? 300);
  const runs = Number(process.env.RUNS ?? 3000);
  const c: G.ClassId = 'warrior';
  const build = searchBuilds(
    c,
    PASS_FARM_JOB.itemLevel,
    (items) => farmRate(c, items, PASS_FARM_JOB),
    setChassis(c).slice(0, 2),
  )[0]!.build;
  const kit = (il: number) => buildItems({ ...build, upgradeLevel: 10 }, il);
  const tally = (items: G.GeneratedItem[], acc: Record<string, number>) => {
    for (const i of items) {
      acc.items = (acc.items ?? 0) + 1;
      if (i.rarityId === 'legendary' || i.rarityId === 'mythic') acc.top = (acc.top ?? 0) + 1;
      if (i.variant) acc[i.variant] = (acc[i.variant] ?? 0) + 1;
    }
  };
  const line = (label: string, acc: Record<string, number>, n: number, unit: string) => {
    const f = (k: string) => ((acc[k] ?? 0) / n).toFixed(4);
    const every = (k: string) => (acc[k] ? `1 per ~${Math.round(n / acc[k]!)} ${unit}` : '—');
    console.log(
      `${label}: Legendary+Mythic+set ${f('top')}/${unit} · Void ${f('void')} (${every('void')}) · Prismatic ${f('prismatic')} (${every('prismatic')})`,
    );
  };
  for (const [areaId, level] of [
    ['ashenPass', 28],
    ['ashfallVerge', 33],
    ['cinderDepths', 39],
  ] as const) {
    const acc: Record<string, number> = {};
    for (let h = 0; h < hours; h++) {
      const r = G.settleFarming({
        character: { classId: c, level, xp: 0 },
        equipment: kit(level - 1),
        areaId,
        seed: `prismatic-rates:${areaId}:${h}`,
        firstCycle: 0,
        durationMs: 3_600_000,
        inventoryCount: 0,
      });
      tally([...r.items, ...(r.overCapacity ?? []), ...(r.salvaged ?? [])], acc);
    }
    line(`farm ${areaId} at ${level}`, acc, hours, 'h');
  }
  for (const [dungeonId, tier, level] of [
    ['ashenWatch', 1, 28],
    ['tyrantsForge', 1, 38],
    ['namelessCrypt', 4, 34],
    ['namelessCrypt', 3, 23],
  ] as const) {
    const acc: Record<string, number> = {};
    for (let i = 0; i < runs; i++) {
      const r = G.simulateDungeonRun({
        dungeonId,
        tier,
        character: { classId: c, level, xp: 0 },
        equipment: kit(Math.min(level + 1, 41)),
        seed: `prismatic-rates:${dungeonId}:${tier}:${i}`,
        bossLootEligible: true,
        inventoryCount: 0,
      });
      tally([...r.items, ...r.salvaged], acc);
    }
    line(`run ${dungeonId} ${tier} at ${level}`, acc, runs, 'runs');
  }
}
