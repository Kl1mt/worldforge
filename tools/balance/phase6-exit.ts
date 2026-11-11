// Ticket 6.10: the Phase 6 exit criterion in numbers (docs/BALANCE.md "Phase 6 exit criterion").
// "Endgame systems add meaningful choices without making older content or most item drops
// irrelevant" (GDD §15 Phase 6). Dev script, game-core only, fixed seeds; the guard with the same
// measurements is packages/game-core/src/balance/phase6-exit-criterion.test.ts.
//   pnpm --filter @worldforge/server exec tsx ../../tools/balance/phase6-exit.ts [verge|older|materials|variants|awakening|modifiers|bosses|all]
import * as G from '../../packages/game-core/src/index.ts';
import { salvageYield } from '../../packages/game-core/src/economy/forge.ts';
import {
  DEFAULT_ECONOMY_CONFIG,
  FORGE_RECIPES,
} from '../../packages/game-core/src/economy/config.ts';
import {
  DEFAULT_AWAKENING_SETTINGS,
  awakenItem,
} from '../../packages/game-core/src/items/awakening.ts';
import { legendarySample, upgraded } from '../../packages/game-core/src/balance/kits.ts';
import {
  PASS_FARM_JOB,
  bossTime,
  buildItems,
  describeBuild,
  farmRate,
  searchBuilds,
  setChassis,
  type BossJob,
  type Build,
} from '../../packages/game-core/src/balance/builds.ts';

const mode = process.argv[2] ?? 'all';
const on = (m: string) => mode === 'all' || mode === m;
const HOUR = 3_600_000;
const pct = (x: number) => `${(x * 100).toFixed(1)} %`;
const t0 = Date.now();
const lap = (what: string) =>
  console.log(`  (${what}: ${((Date.now() - t0) / 1000).toFixed(1)} s)`);

/** The best Ashen Pass farming build (4.8's search, as B.5 item 10 and 6.1). */
const passBest = new Map<G.ClassId, Build>();
function passBuild(c: G.ClassId): Build {
  let b = passBest.get(c);
  if (!b) {
    b = searchBuilds(
      c,
      PASS_FARM_JOB.itemLevel,
      (items) => farmRate(c, items, PASS_FARM_JOB),
      setChassis(c),
    )[0]!.build;
    passBest.set(c, b);
  }
  return b;
}

function hour(c: G.ClassId, level: number, areaId: G.AreaId, items: G.EquippedItem[]) {
  const seeds = ['p6x:1', 'p6x:2'];
  const r = { kpm: 0, deaths: 0, xp: 0, gold: 0 };
  for (const seed of seeds) {
    const f = G.settleFarming({
      character: { classId: c, level, xp: 0 },
      equipment: items,
      areaId,
      seed,
      firstCycle: 0,
      durationMs: HOUR,
      inventoryCount: 0,
    });
    r.kpm += f.kills / 60 / seeds.length;
    r.deaths += f.deaths / seeds.length;
    r.xp += f.xpGained / seeds.length;
    r.gold += f.goldLooted / seeds.length;
  }
  return r;
}

function wins(
  d: G.DungeonId,
  tier: G.DungeonTier,
  c: G.ClassId,
  level: number,
  eq: G.EquippedItem[],
  runs: number,
  mod: G.BossModifierId | null = null,
  prefix = 'b5-boss',
) {
  let w = 0;
  for (let i = 0; i < runs; i++) {
    const r = G.simulateDungeonRun({
      dungeonId: d,
      tier,
      character: { classId: c, level, xp: 0 },
      equipment: eq,
      seed: `${prefix}:${i}`,
      bossLootEligible: false,
      inventoryCount: 0,
      bossModifier: mod,
    });
    if (r.bossDefeated) w++;
  }
  return w / runs;
}

if (on('verge')) {
  console.log(
    '\n# 1. A level-28 hero in good Ashen Pass gear (best Pass build, item level 27, +5, no Void)',
  );
  for (const c of G.CLASS_IDS) {
    const items = buildItems({ ...passBuild(c), upgradeLevel: 5 }, 27);
    const p = hour(c, 28, 'ashenPass', items);
    const v = hour(c, 28, 'ashfallVerge', items);
    const top = hour(c, 34, 'ashfallVerge', items);
    console.log(
      `${c.padEnd(8)} ${describeBuild(passBuild(c))}\n  Pass 28 ${p.kpm.toFixed(1)}/min ${(p.xp / 1000).toFixed(0)}k XP ${p.gold.toFixed(0)} g · Verge 28 ${v.kpm.toFixed(1)}/min ${v.deaths} deaths ${(v.xp / 1000).toFixed(0)}k XP ${v.gold.toFixed(0)} g (× ${(v.kpm / p.kpm).toFixed(2)} kills, × ${(v.xp / p.xp).toFixed(2)} XP, × ${(v.gold / p.gold).toFixed(2)} gold) · Verge 34 ${top.kpm.toFixed(1)}/min ${top.deaths} deaths`,
    );
  }
  lap('verge');
}

if (on('older')) {
  console.log('\n# 2. Older drops: salvage and set pieces in a Depths kit');
  for (const tier of [1, 2, 3, 4] as const) {
    const base = G.ITEM_BASES.find((b) => b.tier === tier && !b.unique)!;
    const y = salvageYield({ baseId: base.id, rarityId: 'legendary', itemLevel: 25 });
    console.log(
      `  tier ${tier} Legendary (il 25, ${base.id}): ${y.gold} g ${JSON.stringify(y.materials)}`,
    );
  }
  const job = { ...PASS_FARM_JOB, areaId: 'cinderDepths' as const, level: 40, itemLevel: 39 };
  for (const c of G.CLASS_IDS) {
    const at = (il: number) => buildItems({ ...passBuild(c), upgradeLevel: 10, void: true }, il);
    const depths = at(39);
    const pass = at(25);
    const mixed = depths.map((i, k) => (i.setId ? pass[k]! : i));
    const full = farmRate(c, depths, job);
    console.log(
      `  ${c.padEnd(8)} Depths 40: all Depths ${full.toFixed(1)}/min · Pass set pieces ${farmRate(c, mixed, job).toFixed(1)} (× ${(farmRate(c, mixed, job) / full).toFixed(3)}) · all Pass ${farmRate(c, pass, job).toFixed(1)} (× ${(farmRate(c, pass, job) / full).toFixed(3)}) · mixed vs Tyrant 38 ${pct(wins('tyrantsForge', 1, c, 38, mixed, 8))}`,
    );
  }
  lap('older');
}

if (on('materials')) {
  console.log('\n# 3. Materials and their live sinks');
  const econ = DEFAULT_ECONOMY_CONFIG;
  for (const m of G.MATERIAL_IDS) {
    const sinks: string[] = [];
    for (const r of FORGE_RECIPES)
      if (r.materials.some((x) => x.materialId === m)) sinks.push(`recipe ${r.id}`);
    for (const [tier, ms] of Object.entries(econ.salvage.tierMaterials))
      if (ms.some((x) => x.materialId === m)) sinks.push(`forge tier-${tier} items`);
    if (econ.salvage.essence.materialId === m) sinks.push('forge essence (every tier)');
    const cost = DEFAULT_AWAKENING_SETTINGS.cost as Record<string, number>;
    if ((cost[m] ?? 0) > 0) sinks.push('awakening');
    for (const p of G.COMMUNITY_PROJECTS)
      if (p.stages.some((s) => s.needs.some((n) => n.resource === m)))
        sinks.push(`project ${p.id}`);
    console.log(`  ${m.padEnd(16)} ${sinks.join(', ')}`);
  }
  lap('materials');
}

const TYRANT: BossJob = { dungeonId: 'tyrantsForge', tier: 1, level: 38, itemLevel: 37, runs: 12 };
const HEROIC: BossJob = { dungeonId: 'namelessCrypt', tier: 4, level: 36, itemLevel: 37, runs: 12 };
const dress = (items: G.EquippedItem[], variant: 'void' | 'prismatic', awaken: boolean | number) =>
  items.map((raw, i) => {
    const item = { ...raw, upgradeLevel: 10, variant };
    if (awaken === false || (typeof awaken === 'number' && awaken !== i)) return item;
    const r = awakenItem(item);
    return r.ok ? r.item : item;
  });
const tyrantBest = new Map<string, { build: Build; time: number }>();
function bestAt(c: G.ClassId, variant: 'void' | 'prismatic') {
  const key = `${c}:${variant}`;
  let b = tyrantBest.get(key);
  if (!b) {
    const s = searchBuilds(
      c,
      TYRANT.itemLevel,
      (items) => -bossTime(c, dress(items, variant, false), TYRANT.runs, TYRANT),
      setChassis(c),
    )[0]!;
    b = { build: s.build, time: -s.score };
    tyrantBest.set(key, b);
  }
  return b;
}

if (on('variants')) {
  console.log(
    '\n# 4. Best Void vs best Prismatic (+10, item level 37), Tyrant 38 kill time; Depths 40 farming',
  );
  for (const c of G.CLASS_IDS) {
    const v = bestAt(c, 'void');
    const p = bestAt(c, 'prismatic');
    const depths = { ...PASS_FARM_JOB, areaId: 'cinderDepths' as const, level: 40, itemLevel: 39 };
    const fv = searchBuilds(
      c,
      39,
      (items) => farmRate(c, dress(items, 'void', false), depths),
      setChassis(c).slice(0, 6),
    )[0]!;
    const fp = searchBuilds(
      c,
      39,
      (items) => farmRate(c, dress(items, 'prismatic', false), depths),
      setChassis(c).slice(0, 6),
    )[0]!;
    console.log(
      `  ${c.padEnd(8)} Tyrant: Void ${(v.time / 1000).toFixed(2)} s ${describeBuild(v.build)} · Prismatic ${(p.time / 1000).toFixed(2)} s ${describeBuild(p.build)} · P÷V time ${(p.time / v.time).toFixed(3)} | Depths: V ${fv.score.toFixed(2)} P ${fp.score.toFixed(2)} P÷V ${(fp.score / fv.score).toFixed(3)}`,
    );
  }
  lap('variants');
}

if (on('awakening')) {
  console.log('\n# 5. Awakening (shipped option b) on the better of the two builds, same build');
  for (const c of G.CLASS_IDS) {
    const v = bestAt(c, 'void');
    const p = bestAt(c, 'prismatic');
    const [variant, b] = v.time <= p.time ? (['void', v] as const) : (['prismatic', p] as const);
    const items = buildItems(b.build, TYRANT.itemLevel);
    const t = (eq: G.EquippedItem[], job = TYRANT) => bossTime(c, eq, job.runs, job);
    const before = t(dress(items, variant, false));
    const full = t(dress(items, variant, true));
    let one = 0;
    for (let i = 0; i < items.length; i++)
      one = Math.max(one, before / t(dress(items, variant, i)) - 1);
    const hb = t(dress(items, variant, false), HEROIC);
    const hf = t(dress(items, variant, true), HEROIC);
    console.log(
      `  ${c.padEnd(8)} ${variant}: Tyrant 38 ${(before / 1000).toFixed(2)} → ${(full / 1000).toFixed(2)} s (full kit +${pct(before / full - 1)}, best single piece +${pct(one)}) · Heroic 36 ${(hb / 1000).toFixed(2)} → ${(hf / 1000).toFixed(2)} s (+${pct(hb / hf - 1)}) · unawakened wins Tyrant ${pct(wins('tyrantsForge', 1, c, 38, dress(items, variant, false), 12))} Heroic ${pct(wins('namelessCrypt', 4, c, 36, dress(items, variant, false), 12))}`,
    );
  }
  lap('awakening');
}

const MODS: (G.BossModifierId | null)[] = [null, ...G.BOSS_MODIFIER_IDS];
if (on('modifiers')) {
  console.log('\n# 6. Weekly modifiers: win-rate shift (points) per class and kit');
  const cases: [
    string,
    G.DungeonId,
    G.DungeonTier,
    number,
    (c: G.ClassId, k: number) => G.EquippedItem[],
  ][] = [
    [
      'Heroic 34, Legendaries +5',
      'namelessCrypt',
      4,
      34,
      (c, k) => upgraded(legendarySample(c, 33, k), 5),
    ],
    [
      'Tyrant 36, Legendaries +5',
      'tyrantsForge',
      1,
      36,
      (c, k) => upgraded(legendarySample(c, 33, k), 5),
    ],
    ['Ashen Warden 26, Legendaries', 'ashenWatch', 1, 26, (c, k) => legendarySample(c, 25, k)],
  ];
  const KITS = Number(process.env.KITS ?? 8);
  const RUNS = Number(process.env.RUNS ?? 32);
  for (const [label, d, tier, level, gear] of cases) {
    console.log(
      `  ${label} (${KITS} kits × ${RUNS} seeds): none, then ${G.BOSS_MODIFIER_IDS.join(' / ')}`,
    );
    const sums = G.BOSS_MODIFIER_IDS.map(() => 0);
    for (const c of G.CLASS_IDS) {
      const rate = (mod: G.BossModifierId | null) => {
        let s = 0;
        for (let k = 0; k < KITS; k++)
          s += wins(d, tier, c, level, gear(c, k), RUNS, mod, 'heroic-balance');
        return s / KITS;
      };
      const r = MODS.map(rate);
      const shifts = r.slice(1).map((x) => x - r[0]!);
      shifts.forEach((x, i) => (sums[i]! += x / G.CLASS_IDS.length));
      const worst = Math.min(...shifts);
      const hardest = G.BOSS_MODIFIER_IDS.filter((_, i) => shifts[i] === worst);
      console.log(
        `    ${c.padEnd(8)} ${(r[0]! * 100).toFixed(0)} · ${shifts.map((x) => (x * 100).toFixed(1)).join(' / ')} · hardest ${hardest.join(', ')}`,
      );
    }
    console.log(
      `    mean     ${sums.map((x) => (x * 100).toFixed(1)).join(' / ')} · spread ${((Math.max(...sums) - Math.min(...sums)) * 100).toFixed(1)}`,
    );
  }
  lap('modifiers');
}

if (on('bosses')) {
  console.log(
    '\n# 7. No new system: Verge drops (item level 33), no Prismatic, no awakening, no Tyrantforged',
  );
  for (const c of G.CLASS_IDS) {
    const b = passBuild(c);
    const k5 = buildItems({ ...b, upgradeLevel: 5 }, 33);
    const k10 = buildItems({ ...b, upgradeLevel: 10, void: true }, 33);
    const plain = (d: G.DungeonId, tier: G.DungeonTier, level: number) => {
      let s = 0;
      for (let k = 0; k < 8; k++)
        s += wins(d, tier, c, level, upgraded(legendarySample(c, 33, k), 5), 12);
      return s / 8;
    };
    console.log(
      `  ${c.padEnd(8)} plain Legendaries +5 (8 kits × 12): Tyrant 36 ${pct(plain('tyrantsForge', 1, 36))} 38 ${pct(plain('tyrantsForge', 1, 38))} Heroic 34 ${pct(plain('namelessCrypt', 4, 34))} · best +5: Tyrant 38 ${pct(wins('tyrantsForge', 1, c, 38, k5, 16))} Heroic 34 ${pct(wins('namelessCrypt', 4, c, 34, k5, 16))} · +10 Void: Tyrant 38 ${pct(wins('tyrantsForge', 1, c, 38, k10, 16))} Heroic 34 ${pct(wins('namelessCrypt', 4, c, 34, k10, 16))}`,
    );
  }
  lap('bosses');
}
