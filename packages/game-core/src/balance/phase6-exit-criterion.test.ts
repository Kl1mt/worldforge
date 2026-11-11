import { describe, expect, it } from 'vitest';
import {
  AREAS,
  AREA_LOOT_TABLES,
  BOSS_LOOT_TABLES,
  BOSS_MODIFIER_IDS,
  CLASS_IDS,
  COMMUNITY_PROJECTS,
  COSMETIC_EXCHANGE,
  DEFAULT_AWAKENING_SETTINGS,
  ENGRAVING_PRICES,
  DEFAULT_ECONOMY_CONFIG,
  DUNGEONS,
  FORGE_RECIPES,
  ITEM_BASES,
  MATERIAL_IDS,
  awakenItem,
  focusedSetPieces,
  salvageYield,
  setForBase,
  settleFarming,
  simulateDungeonRun,
  type AreaId,
  type BossModifierId,
  type ClassId,
  type DungeonId,
  type DungeonTier,
  type EquippedItem,
  type MaterialId,
} from '../index.js';
import { legendarySample, upgraded } from './kits.js';
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
} from './builds.js';

/**
 * Ticket 6.10: the Phase 6 exit criterion in numbers (GDD §15 Phase 6: "Endgame systems add
 * meaningful choices without making older content or most item drops irrelevant";
 * docs/BALANCE.md "Phase 6 exit criterion"). It gathers what B.5 measured piecemeal into one
 * record, with the realistic endgame kits (B.5): game-core only, every run and settlement from a
 * fixed seed, so each number is the same in every run and a band fails only when a rule or content
 * changes. The dev tool with the same measurements: `tools/balance/phase6-exit.ts`.
 *
 * 1. Older content stays relevant: good Ashen Pass gear farms the Ashfall Verge; older drops
 *    salvage into live sinks; Pass set pieces hold their place in a Depths kit; Phase 1–5
 *    materials stay inputs of live recipes; older areas and crypt tiers still drop what is used.
 * 2. Meaningful choices: Void and Prismatic are a sidegrade either way round; awakening is a
 *    modest step; the weekly modifiers each cost something, differently by class, none dominating.
 * 3. No new system required: unawakened, non-Prismatic kits from the Verge's drops beat the Forge
 *    Tyrant and the Heroic Gravewarden.
 */
const SLOW = { timeout: 120_000 };
const HOUR = 3_600_000;

/** The class's best Ashen Pass farming build (4.8's search; B.5 item 10, 6.1), searched once. */
const passBest = new Map<ClassId, Build>();
function passBuild(c: ClassId): Build {
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

function hour(c: ClassId, level: number, areaId: AreaId, items: EquippedItem[]) {
  const seeds = ['p6x:1', 'p6x:2'];
  const r = { kpm: 0, deaths: 0, xp: 0, gold: 0 };
  for (const seed of seeds) {
    const f = settleFarming({
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

function winRate(
  d: DungeonId,
  tier: DungeonTier,
  c: ClassId,
  level: number,
  eq: EquippedItem[],
  runs: number,
  mod: BossModifierId | null = null,
  prefix = 'b5-boss',
) {
  let wins = 0;
  for (let i = 0; i < runs; i++) {
    const r = simulateDungeonRun({
      dungeonId: d,
      tier,
      character: { classId: c, level, xp: 0 },
      equipment: eq,
      seed: `${prefix}:${i}`,
      bossLootEligible: false,
      inventoryCount: 0,
      bossModifier: mod,
    });
    if (r.bossDefeated) wins++;
  }
  return wins / runs;
}

/* --- What counts as "older" and as a "live sink" (content data) ------------------------------ */

/** Materials Phase 6 added (`world/materials.ts`); every other one is a Phase 1–5 material. */
const PHASE6_MATERIALS: readonly MaterialId[] = ['tyrantsEmber'];
/** Loot tables Phase 6 added (the Cinderwastes, Heroic, the Tyrant); the rest are older. */
const PHASE6_TABLES = [
  'ashfallVerge',
  'cinderDepths',
  'namelessCryptIV',
  'gravewardenIV',
  'forgeTyrant',
];
/** Ticket 8.1: tables newer than Phase 6 (the Hollow Reach); neither Phase 6 nor older. */
const PHASE8_TABLES = ['paleMarches'];
const OLDER_TABLES = [...AREA_LOOT_TABLES, ...BOSS_LOOT_TABLES].filter(
  (t) => !PHASE6_TABLES.includes(t.id) && !PHASE8_TABLES.includes(t.id),
);

/**
 * Where a material is spent, from the content data. Repeatable sinks: Forge recipes, the Forge's
 * upgrades, rerolls and improvements on an item of a tier (they cost that tier's salvage
 * materials and the essence), awakening. One-off sinks: community project stages (a town
 * finishes each once).
 */
function sinksOf(m: MaterialId) {
  const econ = DEFAULT_ECONOMY_CONFIG.salvage;
  const repeatable: string[] = [];
  for (const r of FORGE_RECIPES) {
    if (r.materials.some((x) => x.materialId === m)) repeatable.push(`recipe:${r.id}`);
  }
  for (const [tier, ms] of Object.entries(econ.tierMaterials)) {
    if (ms.some((x) => x.materialId === m)) repeatable.push(`forge:tier-${tier}`);
  }
  if (econ.essence.materialId === m) repeatable.push('forge:essence');
  const cost: Partial<Record<string, number>> = { ...DEFAULT_AWAKENING_SETTINGS.cost };
  if ((cost[m] ?? 0) > 0) repeatable.push('awakening');
  // Ticket 6.11: the engraver (repeatable: every engraving pays) and the exchange (once each).
  if (Object.values(ENGRAVING_PRICES).some((p) => (p as Record<string, number>)[m])) {
    repeatable.push('engraving');
  }
  const oneOff = COMMUNITY_PROJECTS.filter((p) =>
    p.stages.some((s) => s.needs.some((n) => n.resource === m)),
  ).map((p) => `project:${p.id}`);
  if (COSMETIC_EXCHANGE.some((o) => (o.price as Record<string, number>)[m])) {
    oneOff.push('exchange');
  }
  return { repeatable, oneOff };
}
/**
 * The Phase 6 sinks: the Tyrant's recipe, the Forge on tier-4 (Cinderwastes) items, awakening, the
 * engraver (6.11).
 */
const PHASE6_SINKS = [
  'recipe:tyrantforgedWork',
  'forge:tier-4',
  'forge:essence',
  'awakening',
  'engraving',
];

/* --- The endgame's best builds (sections 1 and 2) -------------------------------------------- */

const TYRANT: BossJob = { dungeonId: 'tyrantsForge', tier: 1, level: 38, itemLevel: 37, runs: 12 };
const HEROIC: BossJob = { dungeonId: 'namelessCrypt', tier: 4, level: 36, itemLevel: 37, runs: 12 };
const DEPTHS = { ...PASS_FARM_JOB, areaId: 'cinderDepths' as const, level: 40, itemLevel: 39 };
type Variant = 'void' | 'prismatic';

/** +10, the variant on every piece, and the shipped awakening on all (true) or one piece (index). */
const dress = (items: EquippedItem[], variant: Variant, awaken: boolean | number = false) =>
  items.map((raw, i) => {
    const item = { ...raw, upgradeLevel: 10, variant };
    if (awaken === false || (typeof awaken === 'number' && awaken !== i)) return item;
    const r = awakenItem(item);
    return r.ok ? r.item : item;
  });

/** The best +10 build of a variant at the Tyrant (kill time, ms) and in the Depths (kills/min). */
const bests = new Map<string, { build: Build; score: number }>();
function bestAt(c: ClassId, variant: Variant, job: 'tyrant' | 'depths') {
  const key = `${c}:${variant}:${job}`;
  let b = bests.get(key);
  if (!b) {
    const s =
      job === 'tyrant'
        ? searchBuilds(
            c,
            TYRANT.itemLevel,
            (items) => -bossTime(c, dress(items, variant), TYRANT.runs, TYRANT),
            setChassis(c),
          )[0]!
        : searchBuilds(
            c,
            DEPTHS.itemLevel,
            (items) => farmRate(c, dress(items, variant), DEPTHS),
            setChassis(c).slice(0, 6),
          )[0]!;
    b = { build: s.build, score: job === 'tyrant' ? -s.score : s.score };
    bests.set(key, b);
  }
  return b;
}

describe('Phase 6 exit 1: older content stays relevant (ticket 6.10)', () => {
  // Good Ashen Pass gear: the class's best Pass build at +5 (no Void, no Prismatic, no awakening),
  // in the Pass's top drops (item level 27). Measured, Verge 28 against the Pass at 28: kills
  // × 0.77–0.87 (16.1–18.9 a minute), XP × 1.18–1.33, gold × 1.09–1.25, no deaths at 28 or 34.
  it.each(CLASS_IDS)(
    '%s: a level-28 hero in good Pass gear farms the Ashfall Verge profitably',
    (c) => {
      const items = buildItems({ ...passBuild(c), upgradeLevel: 5 }, 27);
      const pass = hour(c, 28, 'ashenPass', items);
      const verge = hour(c, 28, 'ashfallVerge', items);
      const top = hour(c, 34, 'ashfallVerge', items);
      const label = `${c} ${describeBuild(passBuild(c))}: Pass ${JSON.stringify(pass)} · Verge 28 ${JSON.stringify(verge)} · 34 ${JSON.stringify(top)}`;
      expect(verge.deaths, label).toBeLessThanOrEqual(1);
      expect(top.deaths, label).toBeLessThanOrEqual(2);
      expect(verge.kpm, label).toBeGreaterThan(14);
      expect(top.kpm, label).toBeGreaterThan(13);
      // A step up (slower kills), not a wall.
      expect(verge.kpm / pass.kpm, label).toBeGreaterThan(0.7);
      expect(verge.kpm / pass.kpm, label).toBeLessThan(0.95);
      // And it pays: more XP and gold an hour than the Pass with the same gear.
      expect(verge.xp / pass.xp, label).toBeGreaterThan(1.1);
      expect(verge.gold / pass.gold, label).toBeGreaterThan(1.05);
    },
    60_000,
  );

  it.each(CLASS_IDS)(
    '%s: Pass set pieces keep their place in a Depths kit; newer drops still pay',
    (c) => {
      // B.5 item 10: the best build at +10 Void, set pieces from the Pass (item level 25), the rest
      // from the Depths (39), farming the Depths at 40. Measured × 0.971–0.987 (all Depths
      // 15.3–18.1 kills a minute), an all-Pass kit × 0.818–0.852; the mixed kit beats the Tyrant
      // in every run.
      const job = { ...PASS_FARM_JOB, areaId: 'cinderDepths' as const, level: 40, itemLevel: 39 };
      const at = (il: number) => buildItems({ ...passBuild(c), upgradeLevel: 10, void: true }, il);
      const depths = at(39);
      const pass = at(25);
      const mixed = depths.map((i, k) => (i.setId ? pass[k]! : i));
      expect(mixed.some((i) => i.setId)).toBe(true);
      const full = farmRate(c, depths, job);
      const label = `${c}: Depths ${full.toFixed(2)}, mixed ${farmRate(c, mixed, job).toFixed(2)}, Pass ${farmRate(c, pass, job).toFixed(2)}`;
      expect(farmRate(c, mixed, job) / full, label).toBeGreaterThanOrEqual(0.95);
      expect(farmRate(c, pass, job) / full, label).toBeLessThanOrEqual(0.9);
      expect(winRate('tyrantsForge', 1, c, 38, mixed, 8)).toBe(1);
    },
    60_000,
  );

  it('every older drop salvages into materials the endgame Forge still spends', () => {
    // A Legendary of each tier at item level 25: 44 gold and 3 soul shards each, plus timber
    // (tier 1), timber and raw hide (2), 8 iron ore (3). Ore and shards are what the Tyrantforged
    // Work (60 ore, 12 shards) and every tier-4 upgrade ask for.
    for (const tier of [1, 2, 3] as const) {
      for (const rarityId of ['common', 'rare', 'legendary'] as const) {
        const base = ITEM_BASES.find((b) => b.tier === tier && !b.unique)!;
        const y = salvageYield({ baseId: base.id, rarityId, itemLevel: 25 });
        expect(y.gold, `${tier} ${rarityId}`).toBeGreaterThan(0);
        const mats = Object.keys(y.materials) as MaterialId[];
        expect(mats.length, `${tier} ${rarityId}`).toBeGreaterThan(0);
        for (const m of mats) expect(sinksOf(m).repeatable, m).not.toHaveLength(0);
      }
    }
    const pass = salvageYield({
      baseId: ITEM_BASES.find((b) => b.tier === 3 && !b.unique)!.id,
      rarityId: 'legendary',
      itemLevel: 25,
    });
    expect(pass.materials).toEqual({ ironOre: 8, soulShard: 3 });
    for (const m of ['ironOre', 'soulShard'] as const) {
      expect(sinksOf(m).repeatable.filter((s) => PHASE6_SINKS.includes(s)).length).toBeGreaterThan(
        0,
      );
    }
  });

  it('Phase 1–5 materials stay inputs of live sinks (content scan)', () => {
    const older = MATERIAL_IDS.filter((m) => !PHASE6_MATERIALS.includes(m));
    const scan = Object.fromEntries(older.map((m) => [m, sinksOf(m)]));
    const label = JSON.stringify(scan);
    // Every older material has a repeatable sink. Until 6.11 Abbey silver's only sinks were
    // community stages (the Ashen Pass and the Forgeward Outpost); the engraver closes the gap.
    const noRepeatable = older.filter((m) => scan[m]!.repeatable.length === 0);
    expect(noRepeatable, label).toEqual([]);
    expect(scan.abbeySilver!.repeatable, label).toEqual(['engraving']);
    expect(scan.abbeySilver!.oneOff, label).toContain('project:forgewardOutpost');
    expect(scan.abbeySilver!.oneOff, label).toContain('exchange');
    expect(scan.gravewardenSeal!.repeatable, label).toEqual(['awakening', 'engraving']);
    // The endgame's own sinks spend older materials: ore and shards (the Tyrantforged Work, the
    // Forge on tier-4 items), soul shards and Gravewarden Seals (awakening), Seals and Abbey
    // silver (the engraver, 6.11).
    const spentByPhase6 = older.filter((m) =>
      scan[m]!.repeatable.some((s) => PHASE6_SINKS.includes(s)),
    );
    expect([...spentByPhase6].sort(), label).toEqual([
      'abbeySilver',
      'gravewardenSeal',
      'ironOre',
      'soulShard',
    ]);
  });

  it(
    'older areas and crypt tiers still drop what the endgame uses',
    () => {
      // The crypt's hoard drops a Gravewarden Seal at every tier (I–III included): an awakening input.
      const crypt = DUNGEONS.find((d) => d.id === 'namelessCrypt')!;
      expect(crypt.bossDrops).toContain('gravewardenSeal');
      expect(sinksOf('gravewardenSeal').repeatable).toContain('awakening');
      // Every older area's gathered and dropped materials have a repeatable sink (Abbey silver
      // since 6.11's engraver): no older area yields a dead material.
      for (const area of AREAS.filter(
        (a) => !PHASE6_TABLES.includes(a.id) && !PHASE8_TABLES.includes(a.id),
      )) {
        const used = area.materials.filter((m) => sinksOf(m).repeatable.length > 0);
        expect(used.length, area.id).toBeGreaterThan(0);
        for (const m of area.materials) expect(used, area.id).toContain(m);
      }
      // The set pieces of the endgame's best builds (B.5 item 10 farming; the Tyrant's below) all
      // drop from older tables (the Abbey, the crypt's tiers I–III, the Pass, their bosses).
      const olderPieces = new Set(
        OLDER_TABLES.flatMap((t) =>
          t.itemLevel && (t.setShare ?? 0) > 0 ? focusedSetPieces(t, t.itemLevel.max) : [],
        ),
      );
      for (const c of CLASS_IDS) {
        const builds = [passBuild(c), bestAt(c, 'void', 'tyrant').build];
        for (const item of builds.flatMap((b) => buildItems(b, 39))) {
          if (!item.setId) continue;
          expect(olderPieces.has(item.baseId), `${c} ${item.baseId}`).toBe(true);
          expect(setForBase(item.baseId)?.id).toBe(item.setId);
        }
      }
      // And the crypt's tiers II and III each focus one of those sets.
      const focused = OLDER_TABLES.flatMap((t) => t.focus?.sets ?? []);
      expect(focused).toEqual(expect.arrayContaining(['drowned-vigil', 'ashen-choir']));
    },
    SLOW.timeout,
  );
});

describe('Phase 6 exit 2: meaningful choices (ticket 6.10)', () => {
  it('best Void against best Prismatic is a sidegrade, and either can lead', SLOW, () => {
    // Prismatic ÷ Void, measured: Tyrant kill time 0.970 / 1.010 / 0.985 / 1.007 (warrior, mage,
    // hunter, warlock; below 1 = Prismatic faster), Depths kills 0.999 / 1.011 / 1.007 / 0.998.
    let prismaticLeads = 0;
    let voidLeads = 0;
    for (const c of CLASS_IDS) {
      const t = bestAt(c, 'prismatic', 'tyrant').score / bestAt(c, 'void', 'tyrant').score;
      const f = bestAt(c, 'prismatic', 'depths').score / bestAt(c, 'void', 'depths').score;
      for (const ratio of [t, f]) {
        expect(ratio, `${c} tyrant ${t} depths ${f}`).toBeGreaterThan(0.95);
        expect(ratio, `${c} tyrant ${t} depths ${f}`).toBeLessThan(1.05);
      }
      if (t < 1) prismaticLeads++;
      if (t > 1) voidLeads++;
      if (f > 1) prismaticLeads++;
      if (f < 1) voidLeads++;
    }
    // Which one wins depends on the class's build and job: both directions occur.
    expect(prismaticLeads).toBeGreaterThanOrEqual(2);
    expect(voidLeads).toBeGreaterThanOrEqual(2);
  });

  it.each(CLASS_IDS)(
    '%s: awakening is a modest step, and the unawakened best kit already clears',
    (c) => {
      // The better of the class's two Tyrant builds, the same build awakened (shipped option b).
      // Measured: full kit +3.1 to +11.0 % faster at the Tyrant 38 and +4.5 to +10.0 % at Heroic
      // 36; the best single piece +0.0 to +4.9 %; unawakened, 100 % at both.
      const v = bestAt(c, 'void', 'tyrant');
      const p = bestAt(c, 'prismatic', 'tyrant');
      const [variant, best] =
        v.score <= p.score ? (['void', v] as const) : (['prismatic', p] as const);
      const items = buildItems(best.build, TYRANT.itemLevel);
      const time = (eq: EquippedItem[], job: BossJob) => bossTime(c, eq, job.runs, job);
      for (const job of [TYRANT, HEROIC]) {
        const before = time(dress(items, variant), job);
        const gain = before / time(dress(items, variant, true), job) - 1;
        const label = `${c} ${variant} ${job.dungeonId}: ${before.toFixed(0)} ms, gain ${gain.toFixed(3)}`;
        expect(gain, label).toBeGreaterThan(0.02);
        expect(gain, label).toBeLessThan(0.12);
        if (job === TYRANT) {
          for (let i = 0; i < items.length; i++) {
            const one = before / time(dress(items, variant, i), job) - 1;
            expect(one, `${label} piece ${i}`).toBeLessThan(0.05);
          }
        }
        // Not required: the unawakened kit wins every run.
        expect(
          winRate(job.dungeonId, job.tier, c, job.level, dress(items, variant), 12),
          label,
        ).toBe(1);
      }
    },
    60_000,
  );

  // The five weekly modifiers at the endgame bosses (B.5 item 6's seeds), over 8 Legendary kits
  // (+5, item level 33) × 32 seeds per class. Measured mean cost (points; burning / warded /
  // frenzied / unyielding / relentless): Heroic 34 −2.4 / −7.1 / −7.8 / −7.7 / −10.5, Tyrant 36
  // −7.1 / −6.7 / −6.6 / −6.1 / −9.1. Relentless costs most on average, 2–3 points more than the
  // next; Burning is mild at Heroic but the hunter's worst at the Tyrant (−14.5).
  const modCases: [string, DungeonId, DungeonTier, number][] = [
    ['Heroic 34', 'namelessCrypt', 4, 34],
    ['Tyrant 36', 'tyrantsForge', 1, 36],
  ];
  it('each weekly modifier costs something, differently by class; none dominates', SLOW, () => {
    const KITS = 8;
    const RUNS = 32;
    const hardest = new Set<BossModifierId>();
    for (const [name, d, tier, level] of modCases) {
      const shifts = CLASS_IDS.map((c) => {
        const rate = (mod: BossModifierId | null) => {
          let s = 0;
          for (let k = 0; k < KITS; k++) {
            s += winRate(
              d,
              tier,
              c,
              level,
              upgraded(legendarySample(c, 33, k), 5),
              RUNS,
              mod,
              'heroic-balance',
            );
          }
          return s / KITS;
        };
        const none = rate(null);
        return BOSS_MODIFIER_IDS.map((m) => rate(m) - none);
      });
      const means = BOSS_MODIFIER_IDS.map(
        (_, i) => shifts.reduce((s, row) => s + row[i]!, 0) / CLASS_IDS.length,
      );
      const label = `${name}: ${JSON.stringify(shifts.map((r) => r.map((x) => +(x * 100).toFixed(1))))}`;
      // Every modifier makes the week harder, but none by more than 15 points on average.
      for (const m of means) {
        expect(m, label).toBeLessThan(0);
        expect(m, label).toBeGreaterThan(-0.15);
      }
      // None dominates: the hardest on average is within 5 points of the next.
      const sorted = [...means].sort((a, b) => a - b);
      expect(sorted[1]! - sorted[0]!, label).toBeLessThanOrEqual(0.05);
      // Classes feel them differently: some modifier's cost differs by 6+ points between classes (measured 7.4 and 12.2).
      const ranges = BOSS_MODIFIER_IDS.map((_, i) => {
        const col = shifts.map((r) => r[i]!);
        return Math.max(...col) - Math.min(...col);
      });
      expect(Math.max(...ranges), label).toBeGreaterThanOrEqual(0.06);
      for (const row of shifts) {
        const worst = Math.min(...row);
        BOSS_MODIFIER_IDS.forEach((m, i) => row[i] === worst && hardest.add(m));
      }
    }
    // Which modifier is a class's hardest depends on the class and the boss.
    expect(hardest.size).toBeGreaterThanOrEqual(2);
  });
});

describe('Phase 6 exit 3: no new system required (ticket 6.10)', () => {
  // Verge drops (item level 33) only: no Prismatic, no awakening, no Tyrantforged Work, no Heroic
  // loot. Measured: plain Legendaries +5 (8 kits × 12 seeds) Tyrant 38 86 / 76 / 75 / 92 %, Heroic
  // 34 85 / 72 / 70 / 91 % (warrior, mage, hunter, warlock); the best Pass build at +5 and at +10
  // Void 100 % at both.
  it.each(CLASS_IDS)(
    '%s: unawakened, non-Prismatic Verge kits beat the Forge Tyrant and the Heroic Gravewarden',
    (c) => {
      const plain = (d: DungeonId, tier: DungeonTier, level: number) => {
        let s = 0;
        for (let k = 0; k < 8; k++) {
          s += winRate(d, tier, c, level, upgraded(legendarySample(c, 33, k), 5), 12);
        }
        return s / 8;
      };
      const tyrant = plain('tyrantsForge', 1, 38);
      const heroic = plain('namelessCrypt', 4, 34);
      expect(tyrant, `${c} Tyrant ${tyrant}`).toBeGreaterThanOrEqual(0.65);
      expect(heroic, `${c} Heroic ${heroic}`).toBeGreaterThanOrEqual(0.65);
      for (const items of [
        buildItems({ ...passBuild(c), upgradeLevel: 5 }, 33),
        buildItems({ ...passBuild(c), upgradeLevel: 10, void: true }, 33),
      ]) {
        expect(items.every((i) => i.variant !== 'prismatic' && !i.awakening)).toBe(true);
        expect(winRate('tyrantsForge', 1, c, 38, items, 16), c).toBe(1);
        expect(winRate('namelessCrypt', 4, c, 34, items, 16), c).toBe(1);
      }
    },
    60_000,
  );
});

describe('Phase 6 exit, extended: Phase 6 content stays relevant in the Hollow Reach (ticket 8.1)', () => {
  // The Depths' best farming build (+10 Void, item level 39; this file's search), plain and with the
  // shipped awakening on every piece, at level 40 in the Pale Marches against the Depths at 40.
  // Measured: docs/BALANCE.md "Phase 6 exit criterion" (8.1).
  it.each(CLASS_IDS)(
    '%s: a level-40 hero in the best Depths build farms the Pale Marches profitably',
    (c) => {
      const build = bestAt(c, 'void', 'depths').build;
      for (const awaken of [false, true]) {
        const items = dress(buildItems(build, DEPTHS.itemLevel), 'void', awaken);
        const depths = hour(c, 40, 'cinderDepths', items);
        const entry = hour(c, 40, 'paleMarches', items);
        const top = hour(c, 46, 'paleMarches', items);
        const label = `${c} ${describeBuild(build)}${awaken ? ' awakened' : ''}: Depths ${JSON.stringify(depths)} · Marches 40 ${JSON.stringify(entry)} · 46 ${JSON.stringify(top)}`;
        expect(entry.deaths, label).toBe(0);
        expect(top.deaths, label).toBeLessThanOrEqual(1);
        expect(entry.kpm, label).toBeGreaterThan(11);
        // A step up (slower kills), not a wall; and it pays more an hour than the Depths.
        expect(entry.kpm / depths.kpm, label).toBeGreaterThan(0.75);
        expect(entry.kpm / depths.kpm, label).toBeLessThan(0.96);
        expect(entry.xp / depths.xp, label).toBeGreaterThan(1.03);
        expect(entry.gold / depths.gold, label).toBeGreaterThan(1.05);
      }
    },
    60_000,
  );

  it('Phase 6 drops salvage into materials the Hollow Reach’s Forge spends; its sinks stay live', () => {
    // A tier-4 Legendary (the Cinderwastes) salvages to ore and shards; tier-5 upgrades spend the
    // same ore (4 a unit, tier 4's 3) and the essence, and the Marches drop both.
    const t4 = ITEM_BASES.find((b) => b.tier === 4 && !b.unique)!;
    const y = salvageYield({ baseId: t4.id, rarityId: 'legendary', itemLevel: 39 });
    expect(y.materials).toEqual({ ironOre: 12, soulShard: 3 });
    expect(sinksOf('ironOre').repeatable).toEqual(expect.arrayContaining(['forge:tier-4', 'forge:tier-5']));
    expect(sinksOf('soulShard').repeatable).toContain('forge:essence');
    const marches = AREAS.find((a) => a.id === 'paleMarches')!;
    expect([...marches.materials].sort()).toEqual(['ironOre', 'soulShard']);
    // The Tyrant's Ember keeps its sink (the Tyrantforged Work, tier 4) and no new material came.
    expect(sinksOf('tyrantsEmber').repeatable).toContain('recipe:tyrantforgedWork');
    expect(MATERIAL_IDS).not.toContain('hollowEssence');
    expect(FORGE_RECIPES.map((r) => r.tier)).toEqual([1, 2, 3, 4]);
  });
});
