// Ticket 6.5: Item Awakening, the evaluation (docs/AWAKENING.md). Dev script; guards in
// packages/game-core/src/balance/awakening-balance.test.ts. Game-core only; nothing touches the server.
//   pnpm --filter @worldforge/server exec tsx ../../tools/balance/awakening.ts [builds|items|older|power|pvp|time|all]
//   builds: per class and job, the B.2 build search with every piece +10 Void and +10 Prismatic (the
//           best of the two is the "best Void/Prismatic +10 kit"), and again with every piece awakened
//           under option (a) an extra affix and option (b) an awakened effect (each search picks the
//           build that suits the awakening)
//   items:  awakening one piece of the best +10 kit at a time: mean and largest gain per piece
//   older:  does an awakened older kit beat new drops? (Verge kit awakened vs Depths kit plain)
//   power:  Character Power (version in force) of the best kits, plain and awakened
//   pvp:    30+ duels: an awakened kit against the same kit, and class pairs with both awakened
//   time:   days and hours of play to the first awakening and to a full kit (realistic cadence)
//   realistic: a realistic late kit (plain Legendaries +10 from the Verge, item level 33): Tyrant
//           and Heroic win rates and Depths kills, plain and awakened
// Env: STRENGTH (option b's factor) and SHARE (option a's share of a full affix), default the
// prototype's settings (1.1, 0.5); JOBS=pass,warden,depths,tyrant,heroic, CLASSES=…
import * as G from '../../packages/game-core/src/index.ts';
import {
  PASS_FARM_JOB,
  WARDEN_JOB,
  affixOrder,
  bossTime,
  buildItems,
  buildSlots,
  describeBuild,
  farmRate,
  searchBuilds,
  setChassis,
  type Build,
  type BossJob,
  type FarmJob,
} from '../../packages/game-core/src/balance/builds.ts';
import {
  DEFAULT_AWAKENING_SETTINGS,
  awakenItem,
  evaluationSettings,
  type AwakenableItem,
  type AwakeningSettings,
} from '../../packages/game-core/src/items/awakening.ts';

const mode = process.argv[2] ?? 'all';
const STRENGTH = Number(process.env.STRENGTH ?? DEFAULT_AWAKENING_SETTINGS.effectStrength);
const CLASSES = (process.env.CLASSES?.split(',') ?? G.CLASS_IDS) as G.ClassId[];

type Variant = 'void' | 'prismatic';
type Option = 'none' | 'a' | 'b';

const settingsB: AwakeningSettings = evaluationSettings({
  option: 'effect',
  effectStrength: STRENGTH,
});
const SHARE = Number(process.env.SHARE ?? DEFAULT_AWAKENING_SETTINGS.affixValueShare);
const settingsA: AwakeningSettings = evaluationSettings({
  option: 'affixSlot',
  affixValueShare: SHARE,
});

/** Option (a)'s pick for a piece: the next affix of the build's package the piece may carry. */
function awakenA(c: G.ClassId, pkg: Build['pkg'], item: AwakenableItem): AwakenableItem {
  for (const affixId of affixOrder(c, pkg)) {
    const r = awakenItem(item, settingsA, { affixId, roll: 0.5, classId: c });
    if (r.ok) return r.item;
  }
  return item;
}
const awakenB = (item: AwakenableItem): AwakenableItem => {
  const r = awakenItem(item, settingsB);
  return r.ok ? r.item : item;
};

/** A build's items dressed: +10, the variant, and the awakening on the pieces in `only` (all by default). */
export function dress(
  build: Build,
  items: G.EquippedItem[],
  variant: Variant | null,
  option: Option,
  only?: number,
): AwakenableItem[] {
  return items.map((raw, i) => {
    const item: AwakenableItem = { ...raw, upgradeLevel: 10, ...(variant ? { variant } : {}) };
    if (option === 'none' || (only !== undefined && only !== i)) return item;
    return option === 'a' ? awakenA(build.classId, build.pkg, item) : awakenB(item);
  });
}

interface Job {
  itemLevel: number;
  score: (c: G.ClassId, items: G.EquippedItem[]) => number;
  unit: (s: number) => string;
  /** Higher is better for every score (boss jobs score −time). */
  gain: (after: number, before: number) => number;
}
const farmJob = (job: FarmJob): Job => ({
  itemLevel: job.itemLevel,
  score: (c, items) => farmRate(c, items, job),
  unit: (s) => `${s.toFixed(2)}/min`,
  gain: (a, b) => a / b - 1,
});
const bossJob = (job: BossJob): Job => ({
  itemLevel: job.itemLevel,
  score: (c, items) => -bossTime(c, items, job.runs, job),
  unit: (s) => `${(-s / 1000).toFixed(1)} s`,
  // Faster kill = gain: time before ÷ time after − 1.
  gain: (a, b) => b / a - 1,
});

export const JOBS: Record<string, Job> = {
  pass: farmJob(PASS_FARM_JOB),
  warden: bossJob(WARDEN_JOB),
  depths: farmJob({ ...PASS_FARM_JOB, areaId: 'cinderDepths', level: 37, itemLevel: 36 }),
  tyrant: bossJob({ dungeonId: 'tyrantsForge', tier: 1, level: 38, itemLevel: 37, runs: 12 }),
  heroic: bossJob({ dungeonId: 'namelessCrypt', tier: 4, level: 34, itemLevel: 33, runs: 12 }),
};
const jobNames = process.env.JOBS?.split(',') ?? Object.keys(JOBS);

function best(c: G.ClassId, job: Job, variant: Variant, option: Option) {
  const scored = searchBuilds(
    c,
    job.itemLevel,
    (items, build) => job.score(c, dress(build, items, variant, option)),
    setChassis(c),
  );
  return scored[0]!;
}

/** The best +10 Void/Prismatic build and its score, for a class and job. */
function baseline(c: G.ClassId, job: Job) {
  const v = best(c, job, 'void', 'none');
  const p = best(c, job, 'prismatic', 'none');
  return v.score >= p.score
    ? { ...v, variant: 'void' as Variant }
    : { ...p, variant: 'prismatic' as Variant };
}

const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)} %`;

if (mode === 'builds' || mode === 'all') {
  console.log(`## builds (option b strength ${STRENGTH})`);
  for (const name of jobNames) {
    const job = JOBS[name]!;
    for (const c of CLASSES) {
      const base = baseline(c, job);
      const out: string[] = [];
      for (const option of ['a', 'b'] as const) {
        const v = best(c, job, 'void', option);
        const p = best(c, job, 'prismatic', option);
        const top = v.score >= p.score ? v : p;
        out.push(
          `${option}: ${pct(job.gain(top.score, base.score))} (void ${job.unit(v.score)}, prismatic ${job.unit(p.score)}, p/v ${pct(job.gain(p.score, v.score))}) ${describeBuild(top.build)}`,
        );
      }
      console.log(
        `${name} ${c}: best ${base.variant} ${job.unit(base.score)} ${describeBuild(base.build)}`,
      );
      for (const line of out) console.log(`   ${line}`);
    }
  }
}

if (mode === 'items' || mode === 'all') {
  console.log(`## one piece at a time (option b strength ${STRENGTH})`);
  for (const name of jobNames) {
    const job = JOBS[name]!;
    for (const c of CLASSES) {
      const base = baseline(c, job);
      const items = buildItems(base.build, job.itemLevel);
      const slots = buildSlots(c);
      const before = job.score(c, dress(base.build, items, base.variant, 'none'));
      const row: string[] = [];
      for (const option of ['a', 'b'] as const) {
        const gains = items.map((_, i) =>
          job.gain(job.score(c, dress(base.build, items, base.variant, option, i)), before),
        );
        const full = job.gain(job.score(c, dress(base.build, items, base.variant, option)), before);
        const top = gains.indexOf(Math.max(...gains));
        const mean = gains.reduce((s, g) => s + g, 0) / gains.length;
        row.push(
          `${option}: mean ${pct(mean)} · best ${slots[top]} ${pct(gains[top]!)} · full kit same build ${pct(full)}`,
        );
      }
      console.log(`${name} ${c}: ${row.join(' | ')}`);
    }
  }
}

// Does an awakened older kit make new drops irrelevant? The best Verge build (item level 33)
// awakened, against the same build from the Depths (item level 39) plain, both +10 Void, farming the
// Depths at 39 and fighting the Tyrant at 38.
if (mode === 'older' || mode === 'all') {
  console.log(`## older gear awakened vs newer gear plain (strength ${STRENGTH})`);
  const farm = farmJob({ ...PASS_FARM_JOB, areaId: 'cinderDepths', level: 39, itemLevel: 33 });
  const boss = bossJob({ dungeonId: 'tyrantsForge', tier: 1, level: 38, itemLevel: 33, runs: 12 });
  for (const c of CLASSES) {
    const row: string[] = [];
    for (const [label, job] of [
      ['depths farm', farm],
      ['tyrant', boss],
    ] as const) {
      const b = best(c, { ...job, itemLevel: 33 }, 'void', 'none').build;
      const old = buildItems(b, 33);
      const fresh = buildItems(b, 39);
      const plainNew = job.score(c, dress(b, fresh, 'void', 'none'));
      const plainOld = job.score(c, dress(b, old, 'void', 'none'));
      const cells = [`il33 ${pct(job.gain(plainOld, plainNew))}`];
      for (const option of ['a', 'b'] as const) {
        cells.push(
          `il33 ${option} ${pct(job.gain(job.score(c, dress(b, old, 'void', option)), plainNew))}`,
        );
      }
      // One awakened older piece (the weapon) among new plain pieces vs all new plain.
      for (const option of ['a', 'b'] as const) {
        const mixed = dress(b, fresh, 'void', 'none');
        mixed[0] = dress(b, old, 'void', option)[0]!;
        cells.push(`old ${option} weapon ${pct(job.gain(job.score(c, mixed), plainNew))}`);
      }
      row.push(`${label} vs il39 plain: ${cells.join(', ')}`);
    }
    console.log(`${c}: ${row.join(' | ')}`);
  }
  // A level-28 hero in good Ashen Pass gear: unchanged by awakening (no new requirement).
}

if (mode === 'power' || mode === 'all') {
  console.log(`## Character Power v${G.POWER_FORMULA_VERSION} at 38 (best Tyrant builds, il 37)`);
  const job = JOBS.tyrant!;
  for (const c of CLASSES) {
    const base = baseline(c, job);
    const items = buildItems(base.build, job.itemLevel);
    const p = (o: Option) =>
      G.characterPower({
        classId: c,
        level: 38,
        equipment: dress(base.build, items, base.variant, o),
      }).power;
    const p0 = p('none');
    const pa = p('a');
    const pb = p('b');
    console.log(`${c}: ${p0} · a ${pa} (${pct(pa / p0 - 1)}) · b ${pb} (${pct(pb / p0 - 1)})`);
  }
}

if (mode === 'pvp' || mode === 'all') {
  const F = await import('../../packages/game-core/src/balance/pvp-fixtures.ts');
  console.log(`## PvP 30+ (strength ${STRENGTH}): awakened vs the same build`);
  const L = 38;
  for (const option of ['a', 'b'] as const) {
    const per: string[] = [];
    let total = 0;
    for (const c of G.CLASS_IDS) {
      let s = 0;
      for (let k = 0; k < 6; k++) {
        const items = F.sampleBuild(c, L - 1, k);
        // sampleBuild has no build object; option (a) uses the `crit` order.
        const build = { classId: c, chassis: '', picks: [], pkg: 'crit' } as Build;
        s += F.winShare(
          F.fighter(c, L, dress(build, items, 'void', option)),
          F.fighter(c, L, dress(build, items, 'void', 'none')),
          24,
          `pvp-awakening:${c}:${k}`,
        ).share;
      }
      per.push(`${c} ${(s / 6).toFixed(2)}`);
      total += s / 6;
    }
    console.log(`${option}: ${(total / 4).toFixed(3)} · ${per.join(' ')}`);
  }
  // Class pairs, both sides awakened (b) vs both plain: does awakening widen a class gap?
  for (const option of ['none', 'b', 'a'] as const) {
    const row: string[] = [];
    for (let i = 0; i < G.CLASS_IDS.length; i++)
      for (let j = i + 1; j < G.CLASS_IDS.length; j++) {
        const a = G.CLASS_IDS[i]!;
        const d = G.CLASS_IDS[j]!;
        let s = 0;
        for (let k = 0; k < 6; k++) {
          const ba = { classId: a, chassis: '', picks: [], pkg: 'crit' } as Build;
          const bd = { classId: d, chassis: '', picks: [], pkg: 'crit' } as Build;
          s += F.winShare(
            F.fighter(a, L, dress(ba, F.sampleBuild(a, L - 1, k), 'void', option)),
            F.fighter(d, L, dress(bd, F.sampleBuild(d, L - 1, k + 3), 'void', option)),
            24,
            `pvp-awakening-pair:${a}:${d}:${k}`,
          ).share;
        }
        row.push(`${a}-${d} ${(s / 6).toFixed(2)}`);
      }
    console.log(`pairs ${option}: ${row.join(' ')}`);
  }
}

// Time: the realistic player's cadence (B.2/B.3: five visits a day, about 15 credited hours of
// farming; boss hoards once off their 20 h cooldown, so one a day; a failed boss run is retried
// at the next visit). Income from game-core: Depths farming at 38 in a +10 Legendary kit of Verge
// drops (item level 33), kill gold plus salvage, soul shards from the materials; the Tyrant and
// the Heroic crypt win rates with the same kit. Casual and regular play a quarter and a half of it
// (B.4's population), so their days are × 4 and × 2.
if (mode === 'time' || mode === 'all') {
  const { legendaryKit, upgraded } = await import('../../packages/game-core/src/balance/kits.ts');
  const { awakeningCost } = await import('../../packages/game-core/src/items/awakening.ts');
  console.log('## time to awaken (realistic cadence, dedicated player)');
  const HOURS_A_DAY = 15;
  for (const c of CLASSES) {
    const items = upgraded(legendaryKit(c, 33), 10);
    let gold = 0;
    let shards = 0;
    const H = 6;
    for (let h = 0; h < H; h++) {
      const r = G.settleFarming({
        character: { classId: c, level: 38, xp: 0 },
        equipment: items,
        areaId: 'cinderDepths',
        seed: `awakening-time:${c}:${h}`,
        firstCycle: 0,
        durationMs: 3_600_000,
        inventoryCount: 0,
      });
      gold += r.goldLooted + r.goldSalvaged;
      shards += r.materials.soulShard ?? 0;
    }
    const win = (dungeonId: G.DungeonId, tier: G.DungeonTier, level: number) => {
      let w = 0;
      const n = 40;
      for (let i = 0; i < n; i++)
        if (
          G.simulateDungeonRun({
            dungeonId,
            tier,
            character: { classId: c, level, xp: 0 },
            equipment: items,
            seed: `awakening-time:${dungeonId}:${i}`,
            bossLootEligible: false,
            inventoryCount: 0,
          }).bossDefeated
        )
          w++;
      return w / n;
    };
    const pT = win('tyrantsForge', 1, 38);
    const pH = win('namelessCrypt', 4, 38);
    const p3 = win('namelessCrypt', 3, 38);
    const perDay = (p: number) => 1 - (1 - p) ** 5; // up to five tries a day, one hoard
    const embersDay = perDay(pT);
    const sealsDay = perDay(Math.max(pH, p3));
    const goldDay = (gold / H) * HOURS_A_DAY;
    const shardsDay = (shards / H) * HOURS_A_DAY;
    const k = DEFAULT_AWAKENING_SETTINGS.cost;
    const one = awakeningCost({ itemLevel: 37 });
    const days = Math.max(
      k.tyrantsEmber / embersDay,
      k.gravewardenSeal / sealsDay,
      one.gold / goldDay,
      one.soulShard / shardsDay,
    );
    const pieces = buildSlots(c).length;
    console.log(
      `${c}: gold ${Math.round(gold / H)}/h, shards ${(shards / H).toFixed(1)}/h · Tyrant ${(pT * 100).toFixed(0)} %, Heroic ${(pH * 100).toFixed(0)} %, tier III ${(p3 * 100).toFixed(0)} % · embers ${embersDay.toFixed(2)}/day, seals ${sealsDay.toFixed(2)}/day · one awakening (${one.gold} g, ${k.tyrantsEmber} embers, ${k.gravewardenSeal} seals, ${one.soulShard} shards): ${days.toFixed(1)} days (${(days * HOURS_A_DAY).toFixed(0)} h of play; gold alone ${((one.gold / goldDay) * HOURS_A_DAY).toFixed(1)} h) · full kit (${pieces}): ${(days * pieces).toFixed(0)} days · regular ${(days * pieces * 2).toFixed(0)} · casual ${(days * pieces * 4).toFixed(0)}`,
    );
  }
}

if (mode === 'realistic' || mode === 'all') {
  const { legendaryKit, upgraded } = await import('../../packages/game-core/src/balance/kits.ts');
  console.log(`## realistic kit (Verge Legendaries +10, il 33): a ${SHARE}, b ${STRENGTH}`);
  const N = 48;
  for (const c of CLASSES) {
    const kit = upgraded(legendaryKit(c, 33), 10);
    const build = { classId: c, chassis: '', picks: [], pkg: 'crit' } as Build;
    const row: string[] = [];
    for (const option of ['none', 'a', 'b'] as const) {
      const items = dress(build, kit, null, option);
      const win = (dungeonId: G.DungeonId, tier: G.DungeonTier, level: number) => {
        let w = 0;
        for (let i = 0; i < N; i++)
          if (
            G.simulateDungeonRun({
              dungeonId,
              tier,
              character: { classId: c, level, xp: 0 },
              equipment: items,
              seed: `awakening-real:${dungeonId}:${level}:${i}`,
              bossLootEligible: false,
              inventoryCount: 0,
            }).bossDefeated
          )
            w++;
        return Math.round((w / N) * 100);
      };
      const kpm = farmRate(c, items, {
        ...PASS_FARM_JOB,
        areaId: 'cinderDepths',
        level: 37,
        itemLevel: 33,
      });
      row.push(
        `${option}: Tyrant@36 ${win('tyrantsForge', 1, 36)} % @38 ${win('tyrantsForge', 1, 38)} % · Heroic@32 ${win('namelessCrypt', 4, 32)} % · Depths ${kpm.toFixed(2)}/min`,
      );
    }
    // Older: this kit awakened against a plain kit of Depths drops (item level 39), farming.
    const newer = farmRate(c, upgraded(legendaryKit(c, 39), 10), {
      ...PASS_FARM_JOB,
      areaId: 'cinderDepths',
      level: 37,
      itemLevel: 39,
    });
    row.push(`plain il39 Depths ${newer.toFixed(2)}/min`);
    console.log(`${c}: ${row.join(' | ')}`);
  }
}
