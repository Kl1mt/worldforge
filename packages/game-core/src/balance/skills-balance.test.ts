import { describe, expect, it } from 'vitest';
import {
  BOSS_MODIFIER_IDS,
  CLASS_IDS,
  defaultLoadout,
  loadoutKey,
  settleFarming,
  tierTakesBossModifier,
  xpToNextLevel,
  type AreaId,
  type BossModifierId,
  type ClassId,
  type DungeonId,
  type DungeonTier,
  type EquippedItem,
  type Loadout,
} from '../index.js';
import { kit, legendaryKit, legendarySample, upgraded } from './kits.js';
import {
  allLoadouts,
  bossTime,
  farmRate,
  scoreAll,
  viable,
  type ScoredLoadout,
} from './loadouts.js';
import {
  B7_JOBS,
  KIT_SAMPLES,
  asBossJob,
  asFarmJob,
  bossRuns,
  distinctKey,
  leader,
  type KitVariant,
} from './skills-balance.js';

/**
 * Ticket B.7, the balance pass over skills and loadouts (docs/BALANCE.md "B.7"; numbers from
 * `tools/balance/skills-balance.ts`). The town is not live, so there is no telemetry by loadout:
 * like B.5, everything is game-core from fixed seeds, so each number is a measurement that is the
 * same in every run and a band fails only when a rule, a skill or content changes.
 *
 * PvE here; the PvP bands are in `skills-pvp-balance.test.ts`. Slow by design (every loadout over
 * three kit samples): each test has a timeout with several times its measured run.
 */
const SEARCH = { timeout: 900_000 };
const SLOW = { timeout: 300_000 };

const job = (id: string) => B7_JOBS.find((j) => j.id === id)!;

/** Every loadout of a job, scored over the kit samples (kills/min, or −mean boss time). */
const memo = new Map<string, ScoredLoadout[]>();
function measured(c: ClassId, jobId: string, variant: KitVariant = 'plain'): ScoredLoadout[] {
  const key = `${c}:${jobId}:${variant}`;
  if (!memo.has(key)) {
    const j = job(jobId);
    const score = (l: Loadout) => {
      let s = 0;
      for (const k of KIT_SAMPLES)
        s +=
          j.kind === 'farm'
            ? farmRate(c, asFarmJob(j, k, variant), l)
            : -bossTime(c, asBossJob(j, k, variant), l).time;
      return s / KIT_SAMPLES.length;
    };
    memo.set(key, scoreAll(c, allLoadouts(c, j.hero), score));
  }
  return memo.get(key)!;
}

const distinct = (list: ScoredLoadout[]) => new Set(list.map((s) => distinctKey(s.loadout))).size;

/** The loadouts within 2 % of both bests, over the loadouts both jobs can field (9.1's test). */
function leadsBoth(farm: ScoredLoadout[], boss: ScoredLoadout[]) {
  const keys = new Set(boss.map((x) => x.key));
  const fb = farm.filter((x) => keys.has(x.key));
  const bb = boss.filter((x) => fb.some((y) => y.key === x.key));
  const lf = new Set(viable(fb, 0.02).map((x) => x.key));
  const at = (list: ScoredLoadout[], key: string) => list.find((x) => x.key === key)!.score;
  const behind = (list: ScoredLoadout[], key: string) =>
    Math.abs(list[0]!.score / at(list, key) - 1);
  return {
    both: viable(bb, 0.02)
      .filter((x) => lf.has(x.key))
      .map((x) => x.key),
    farmLeaderAtBoss: behind(bb, fb[0]!.key),
    bossLeaderFarming: behind(fb, bb[0]!.key),
  };
}

describe('B.7: viable loadouts over three kit samples, none leading both kinds of job', () => {
  for (const c of CLASS_IDS) {
    it(
      `${c}: three viable on every full-tier job, no loadout leads both, sidegrades`,
      SEARCH,
      () => {
        for (const id of ['depths37', 'tyrant38', 'deep49', 'sovereign50']) {
          const list = measured(c, id);
          const label = `${id}: ${list
            .slice(0, 5)
            .map((s) => `${s.key} ${Math.abs(s.score).toFixed(2)}`)
            .join(' · ')}`;
          // Measured: 15–87 distinct viable loadouts (7 % of the best) per class and job.
          expect(distinct(viable(list)), label).toBeGreaterThanOrEqual(3);
          if (job(id).kind === 'farm') {
            // Farming sidegrades over the samples: × 1.08–1.15 (owner decision 4 keeps 6–16 %).
            const def = list.find((s) => s.key === loadoutKey(defaultLoadout(c)))!;
            expect(list[0]!.score / def.score, label).toBeGreaterThan(1.03);
            expect(list[0]!.score / def.score, label).toBeLessThan(1.18);
          }
        }
        for (const [farm, boss] of [
          ['depths37', 'tyrant38'],
          ['deep49', 'sovereign50'],
        ] as const) {
          const r = leadsBoth(measured(c, farm), measured(c, boss));
          // Measured: none; each leader 4.8–26.9 % behind on the other job.
          expect(r.both, `${farm} × ${boss}`).toEqual([]);
          expect(r.farmLeaderAtBoss, `${c} farm leader at ${boss}`).toBeGreaterThan(0.03);
          expect(r.bossLeaderFarming, `${c} boss leader at ${farm}`).toBeGreaterThan(0.03);
        }
      },
    );
  }

  // 9.3's skill-aware Legendaries (the quest ring and torc at +10 with each class's best effect
  // pair) in place of the kit's ring and neck, at the top tier where both are taught.
  for (const c of CLASS_IDS) {
    it(`${c}, with the skill quests' rewards: three viable, no loadout leads both`, SEARCH, () => {
      for (const id of ['deep49', 'sovereign50'])
        expect(distinct(viable(measured(c, id, 'quest'))), id).toBeGreaterThanOrEqual(3);
      const r = leadsBoth(measured(c, 'deep49', 'quest'), measured(c, 'sovereign50', 'quest'));
      expect(r.both).toEqual([]);
      expect(r.farmLeaderAtBoss).toBeGreaterThan(0.03);
      expect(r.bossLeaderFarming).toBeGreaterThan(0.03);
    });
  }
});

/** Win rate over kit samples `samples` × `runs` fixed seeds. */
function winRate(
  c: ClassId,
  d: DungeonId,
  tier: DungeonTier,
  level: number,
  gear: (k: number) => EquippedItem[],
  loadout: Loadout | null,
  samples: number,
  runs: number,
  prefix: string,
  mod: BossModifierId | null = null,
) {
  let s = 0;
  for (let k = 0; k < samples; k++)
    s += bossRuns(c, d, tier, level, gear(k), loadout, runs, prefix, mod).wins;
  return s / samples;
}

describe('B.7: the Phase 6 boss bands with each class’s boss leader', () => {
  // B.5's class spread (endgame-balance.test.ts, same kits and seeds: 8 Legendary kits at item
  // level 33 × 12 runs). Measured with the leaders: +5 79–100 %, spread 6–17 points (default
  // 17–23); +0 spread 22–30 (default 22–29); +10 98–100 %.
  const fights: [string, DungeonId, DungeonTier, string, number][] = [
    ['Forge Tyrant', 'tyrantsForge', 1, 'tyrant36', 36],
    ['Forge Tyrant', 'tyrantsForge', 1, 'tyrant38', 38],
    ['Heroic', 'namelessCrypt', 4, 'heroic32', 32],
    ['Heroic', 'namelessCrypt', 4, 'heroic34', 34],
    ['Heroic', 'namelessCrypt', 4, 'heroic36', 36],
  ];
  for (const [name, d, tier, leaders, level] of fights) {
    it(`${name} at ${level}: B.5's fair shot holds on the leaders`, SLOW, () => {
      const per = (up: number) =>
        CLASS_IDS.map((c) =>
          winRate(
            c,
            d,
            tier,
            level,
            (k) => upgraded(legendarySample(c, 33, k), up),
            leader(leaders, c),
            8,
            12,
            'b5-boss',
          ),
        );
      const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
      const [plain, five, ten] = [per(0), per(5), per(10)];
      const label = `+0 ${plain.map((x) => x.toFixed(2))} · +5 ${five.map((x) => x.toFixed(2))} · +10 ${ten.map((x) => x.toFixed(2))}`;
      for (const x of five) expect(x, label).toBeGreaterThanOrEqual(0.6);
      expect(spread(five), label).toBeLessThanOrEqual(0.25);
      expect(spread(plain), label).toBeLessThanOrEqual(0.33);
      for (const x of ten) expect(x, label).toBeGreaterThanOrEqual(0.9);
      for (let i = 0; i < CLASS_IDS.length; i++) {
        expect(five[i]!, label).toBeGreaterThan(plain[i]!);
        expect(ten[i]!, label).toBeGreaterThanOrEqual(five[i]!);
      }
    });
  }

  it(
    '6.3’s Heroic: upgrades still pay; the leaders’ ceilings recorded (owner question 1)',
    SLOW,
    () => {
      // heroic-balance.test.ts asserts, for the default loadout: epic +10 ≤ 10 %, Legendary 15–60 %,
      // +5 ≤ 85 %, +10 ≥ 85 %. With the boss leaders (measured): epic +10 11–16 %, Legendary 59–72 %,
      // +5 78–84 %, +10 100 %: a boss loadout is worth about a +5 upgrade. Asserted here at the
      // measured values so they cannot slip further unseen while the owner decides.
      for (const level of [32, 35]) {
        const name = level === 32 ? 'heroic32' : 'heroic34';
        const at = (gear: (c: ClassId) => EquippedItem[]) =>
          CLASS_IDS.reduce(
            (s, c) =>
              s +
              bossRuns(c, 'namelessCrypt', 4, level, gear(c), leader(name, c), 16, 'heroic-balance')
                .wins,
            0,
          ) / CLASS_IDS.length;
        const epic10 = at((c) => upgraded(kit(c, 33, 'epic'), 10));
        const legendary = at((c) => legendaryKit(c, 33));
        const legendary5 = at((c) => upgraded(legendaryKit(c, 33), 5));
        const legendary10 = at((c) => upgraded(legendaryKit(c, 33), 10));
        const label = `L${level}: ${[epic10, legendary, legendary5, legendary10].map((x) => x.toFixed(2))}`;
        expect(epic10, label).toBeLessThanOrEqual(0.2);
        expect(legendary, label).toBeGreaterThanOrEqual(0.15);
        expect(legendary, label).toBeLessThanOrEqual(0.75);
        expect(legendary5, label).toBeGreaterThan(legendary);
        expect(legendary5, label).toBeLessThanOrEqual(0.9);
        expect(legendary10, label).toBeGreaterThanOrEqual(legendary5);
      }
    },
  );

  it(
    '6.3’s weekly modifiers on the leaders: somewhat harder, never a wall, never easier',
    SLOW,
    () => {
      const BOSSES: [
        string,
        DungeonId,
        DungeonTier,
        number,
        string,
        (c: ClassId) => EquippedItem[],
      ][] = [
        ['crypt II', 'namelessCrypt', 2, 18, 'crypt21', (c) => upgraded(kit(c, 17, 'rare'), 5)],
        ['crypt III', 'namelessCrypt', 3, 21, 'crypt21', (c) => legendaryKit(c, 20)],
        ['Heroic', 'namelessCrypt', 4, 34, 'heroic34', (c) => upgraded(legendaryKit(c, 33), 10)],
        ['Ashen Warden', 'ashenWatch', 1, 26, 'crypt26', (c) => upgraded(legendaryKit(c, 25), 5)],
        [
          'Forge Tyrant',
          'tyrantsForge',
          1,
          36,
          'tyrant36',
          (c) => upgraded(legendaryKit(c, 33), 10),
        ],
      ];
      for (const [name, d, t, level, leaders, gear] of BOSSES) {
        const mean = (m: BossModifierId | null) =>
          CLASS_IDS.reduce(
            (s, c) =>
              s +
              bossRuns(c, d, t, level, gear(c), leader(leaders, c), 12, 'heroic-balance', m).wins,
            0,
          ) / CLASS_IDS.length;
        const none = mean(null);
        for (const m of BOSS_MODIFIER_IDS) {
          if (!tierTakesBossModifier(d, t)) continue;
          expect(mean(m), `${name} ${m}`).toBeLessThanOrEqual(none + 0.05);
          expect(mean(m), `${name} ${m}`).toBeGreaterThanOrEqual(none - 0.3);
        }
      }
    },
  );

  it('B.5’s Warded is still not the hardest modifier on the leaders', SLOW, () => {
    // Measured: crypt III 0.58 against 0.53–0.58 for the others; the Warden 0.75 against 0.69–0.75.
    const OTHERS: BossModifierId[] = ['burning', 'frenzied', 'unyielding', 'relentless'];
    const cases: [DungeonId, DungeonTier, number, string, (c: ClassId) => EquippedItem[]][] = [
      ['namelessCrypt', 3, 21, 'crypt21', (c) => upgraded(kit(c, 20, 'epic'), 8)],
      ['ashenWatch', 1, 26, 'crypt26', (c) => legendarySample(c, 25, 0)],
    ];
    for (const [d, tier, level, leaders, gear] of cases) {
      const mean = (mod: BossModifierId | null) =>
        CLASS_IDS.reduce(
          (s, c) =>
            s +
            bossRuns(c, d, tier, level, gear(c), leader(leaders, c), 16, 'heroic-balance', mod)
              .wins,
          0,
        ) / CLASS_IDS.length;
      const warded = mean('warded');
      expect(warded, d).toBeGreaterThanOrEqual(Math.min(...OTHERS.map(mean)));
      expect(mean(null) - warded, d).toBeLessThanOrEqual(0.2);
    }
  });
});

describe('B.7: the Phase 8 bands with each class’s leaders', () => {
  it(
    '8.2’s Sovereign: upgrades pay, the Deep’s gear wins, ceilings recorded (owner question 1)',
    SLOW,
    () => {
      // hollow-deep-balance.test.ts asserts for the default loadout (4 kits × 12 runs at 48 and 50):
      // Marches +0 < 25 %, +5 25–65 %, item level 45 +5 35–75 %, +10 70–95 %, the Deep's +10 > 95 %.
      // With the Sovereign leaders (the Tyrant's active taught, his own passive not yet) measured:
      // +0 23–24 %, +5 70–73 %, 45 +5 78–89 %, +10 95–97 %, the Deep's +10 100 %, the Depths' +10
      // 57–65 % (default 41–42 %). Asserted at the measured values while the owner decides.
      const GEAR: Record<string, (c: ClassId, k: number) => EquippedItem[]> = {
        'Depths +10': (c, k) => upgraded(legendarySample(c, 39, k), 10),
        'Marches +0': (c, k) => legendarySample(c, 47, k),
        'Marches +5': (c, k) => upgraded(legendarySample(c, 47, k), 5),
        'Marches +10': (c, k) => upgraded(legendarySample(c, 47, k), 10),
        'Deep +10': (c, k) => upgraded(legendarySample(c, 53, k), 10),
      };
      for (const level of [48, 50]) {
        const per = (g: string) =>
          CLASS_IDS.map((c) =>
            winRate(
              c,
              'hollowThrone',
              1,
              level,
              (k) => GEAR[g]!(c, k),
              leader('sovereign', c),
              4,
              12,
              `sov:${c}:${level}`,
            ),
          );
        const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
        const rows = Object.fromEntries(Object.keys(GEAR).map((g) => [g, per(g)]));
        const label = `L${level}: ${Object.entries(rows)
          .map(([g, xs]) => `${g} ${mean(xs).toFixed(2)}`)
          .join(' · ')}`;
        expect(mean(rows['Marches +0']!), label).toBeLessThan(0.3);
        expect(mean(rows['Marches +5']!), label).toBeLessThanOrEqual(0.8);
        expect(mean(rows['Marches +5']!), label).toBeGreaterThan(mean(rows['Marches +0']!));
        expect(mean(rows['Marches +10']!), label).toBeGreaterThan(mean(rows['Marches +5']!));
        expect(mean(rows['Marches +10']!), label).toBeLessThanOrEqual(0.98);
        expect(mean(rows['Deep +10']!), label).toBeGreaterThan(0.95);
        expect(mean(rows['Depths +10']!), label).toBeLessThan(mean(rows['Marches +10']!));
        for (const [i, c] of CLASS_IDS.entries())
          expect(rows['Marches +10']![i]!, `${c} ${label}`).toBeGreaterThan(0.5);
      }
    },
  );

  it('the farming leaders keep 8.1’s and 8.2’s farming bands: no deaths, idle pace', SLOW, () => {
    // Measured (3 seeds × 1 h): the Deep 7.4–10.4 kills a minute, damage share ≤ 0.16; the
    // Marches at 40 in the Depths' or Heroic Legendaries +10 7.6–10.5, no deaths.
    const cases: [AreaId, number, string, (c: ClassId) => EquippedItem[], number][] = [
      ['hollowDeep', 46, 'deep', (c) => upgraded(legendaryKit(c, 47), 10), 11],
      ['hollowDeep', 49, 'deep', (c) => upgraded(legendaryKit(c, 47), 10), 11],
      ['hollowDeep', 52, 'deep', (c) => upgraded(legendaryKit(c, 47), 10), 11],
      ['paleMarches', 40, 'depths', (c) => upgraded(legendaryKit(c, 39), 10), 13],
      ['paleMarches', 40, 'depths', (c) => upgraded(legendaryKit(c, 37), 10), 13],
    ];
    for (const [areaId, level, leaders, gear, cap] of cases) {
      for (const c of CLASS_IDS) {
        let deaths = 0,
          kills = 0,
          share = 0,
          encounters = 0;
        for (const seed of ['hd-a', 'hd-b', 'hd-c']) {
          const r = settleFarming({
            character: { classId: c, level, xp: 0 },
            equipment: gear(c),
            areaId,
            seed,
            firstCycle: 0,
            durationMs: 3_600_000,
            inventoryCount: 0,
            loadout: leader(leaders, c),
          });
          deaths += r.deaths;
          kills += r.kills;
          share += r.damageTaken / r.maxHealth;
          encounters += r.encounters;
        }
        const label = `${c} ${areaId} ${level}`;
        expect(deaths, label).toBe(0);
        expect(share / encounters, label).toBeLessThan(0.2);
        expect(kills / 180, label).toBeGreaterThan(6);
        expect(kills / 180, label).toBeLessThan(cap);
      }
    }
  });

  it('B.5’s XP pacing holds on the farming leaders: hours a level, not minutes', SLOW, () => {
    // Measured with the leaders: 2.3–5.0 h a level from 28 to 39, 28 → 40 in 35–47 h (default
    // 38–52 h), 47 → 48 18–24 h: about a tenth faster, inside every band.
    for (const c of CLASS_IDS) {
      const hours = (level: number) => {
        const areas: AreaId[] =
          level >= 34 ? ['ashfallVerge', 'cinderDepths'] : ['ashenPass', 'ashfallVerge'];
        const items = upgraded(legendarySample(c, Math.max(25, Math.min(39, level - 2)), 0), 5);
        const loadout = leader(level >= 36 ? 'depths' : 'farm28', c);
        const xph = Math.max(
          ...areas.map(
            (areaId) =>
              settleFarming({
                character: { classId: c, level, xp: 0 },
                equipment: items,
                areaId,
                seed: `b5-pace:${c}:${level}:0`,
                firstCycle: 0,
                durationMs: 3_600_000,
                inventoryCount: 0,
                loadout,
              }).xpGained,
          ),
        );
        return xpToNextLevel(level) / xph;
      };
      let to40 = 0;
      for (let level = 28; level < 40; level++) {
        const h = hours(level);
        expect(h, `${c} ${level}`).toBeGreaterThanOrEqual(2);
        expect(h, `${c} ${level}`).toBeLessThanOrEqual(8);
        to40 += h;
      }
      expect(to40, c).toBeGreaterThanOrEqual(30);
      expect(to40, c).toBeLessThanOrEqual(70);
      expect(hours(47), c).toBeGreaterThanOrEqual(12);
    }
  });
});
