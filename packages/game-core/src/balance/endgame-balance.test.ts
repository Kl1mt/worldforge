import { describe, expect, it } from 'vitest';
import {
  CLASS_IDS,
  simulateDungeonRun,
  settleFarming,
  xpToNextLevel,
  type AreaId,
  type BossModifierId,
  type ClassId,
  type DungeonId,
  type DungeonTier,
  type EquippedItem,
} from '../index.js';
import { kit, legendarySample, upgraded } from './kits.js';
import { PASS_FARM_JOB, buildItems, farmRate, searchBuilds, setChassis } from './builds.js';

/**
 * Ticket B.5, the endgame balance pass (docs/BALANCE.md "B.5"; numbers from
 * `tools/balance/endgame.ts`). Every run and settlement draws from a fixed seed, so each number
 * is a measurement that is the same in every run; a band fails only when a rule or content
 * changes.
 */
const SLOW = { timeout: 120_000 };

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

describe('class spread at the Forge Tyrant and the Heroic Gravewarden (B.5)', () => {
  // 8 Legendary kits (with effects, item level 33: the Verge's drops) × 12 seeds per class. Before
  // B.5 the mage trailed by 25–35 points with Legendaries +5 (Tyrant 36: 89/54/78/75 %, spread 34;
  // Heroic 34: 90/68/77/89 %, spread 22); after the armour/resistance scales 80/71/68/91 % and
  // 85/72/70/91 % (docs/BALANCE.md).
  const SAMPLES = 8;
  const RUNS = 12;
  const fights: [string, DungeonId, DungeonTier, number[]][] = [
    ['Forge Tyrant', 'tyrantsForge', 1, [36, 38]],
    ['Heroic', 'namelessCrypt', 4, [32, 34, 36]],
  ];
  for (const [name, d, tier, levels] of fights) {
    for (const level of levels) {
      it(`${name} at ${level}: every class has a fair shot with upgraded Legendaries`, SLOW, () => {
        const per = (up: number) =>
          CLASS_IDS.map((c) => {
            let s = 0;
            for (let k = 0; k < SAMPLES; k++)
              s += winRate(d, tier, c, level, upgraded(legendarySample(c, 33, k), up), RUNS);
            return s / SAMPLES;
          });
        const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
        const plain = per(0);
        const five = per(5);
        const ten = per(10);
        const label = `+0 ${plain.map((x) => x.toFixed(2))} · +5 ${five.map((x) => x.toFixed(2))} · +10 ${ten.map((x) => x.toFixed(2))}`;
        // +5: every class wins most runs, at most 25 points apart (measured 17–23).
        for (const x of five) expect(x, label).toBeGreaterThanOrEqual(0.6);
        expect(spread(five), label).toBeLessThanOrEqual(0.25);
        // +0: a third to a half on average, at most a third apart (measured 22–29; before 29–54).
        expect(spread(plain), label).toBeLessThanOrEqual(0.33);
        // +10: everybody nearly always (measured 94–100 %).
        for (const x of ten) expect(x, label).toBeGreaterThanOrEqual(0.9);
        // Upgrades still pay at every step for every class.
        for (let i = 0; i < CLASS_IDS.length; i++) {
          expect(five[i]!, label).toBeGreaterThan(plain[i]!);
          expect(ten[i]!, label).toBeGreaterThanOrEqual(five[i]!);
        }
      });
    }
  }
});

describe('weekly boss modifiers (B.5)', () => {
  // Warded was the hardest modifier at most bosses (−30 % from 60 % to 45 %); at −25 % it sits
  // among the others. The two kits where it cost most (16 seeds per class, heroic.ts's).
  const OTHERS: BossModifierId[] = ['burning', 'frenzied', 'unyielding', 'relentless'];
  const cases: [string, DungeonId, DungeonTier, number, (c: ClassId) => EquippedItem[]][] = [
    ['crypt III, epics +8', 'namelessCrypt', 3, 21, (c) => upgraded(kit(c, 20, 'epic'), 8)],
    ['the Ashen Warden, Legendaries', 'ashenWatch', 1, 26, (c) => legendarySample(c, 25, 0)],
  ];
  for (const [label, d, tier, level, gear] of cases) {
    it(`${label}: Warded is not the hardest modifier`, SLOW, () => {
      const mean = (mod: BossModifierId | null) =>
        CLASS_IDS.reduce(
          (s, c) => s + winRate(d, tier, c, level, gear(c), 16, mod, 'heroic-balance'),
          0,
        ) / CLASS_IDS.length;
      const warded = mean('warded');
      const worstOther = Math.min(...OTHERS.map(mean));
      expect(warded).toBeGreaterThanOrEqual(worstOther);
      expect(mean(null) - warded).toBeLessThanOrEqual(0.2);
    });
  }
});

describe('endgame XP pacing, levels 28–48 (B.5)', () => {
  // The best open area for XP in a realistic kit (Legendaries +5, item level = level − 2 within
  // the areas' drops), one hour per level and class. Measured: 3.5–5.5 h a level from 28 to 42,
  // 28 → 40 in 38–52 h of farming (dedicated 2.5–3.5 days), and the soft cap from ~47: 47 → 48
  // takes 19–68 h.
  it('levels 28–42 take hours, not days; the soft cap holds from about 47', SLOW, () => {
    const areas = (level: number): AreaId[] =>
      level >= 34 ? ['ashfallVerge', 'cinderDepths'] : ['ashenPass', 'ashfallVerge'];
    for (const c of CLASS_IDS) {
      const hours = (level: number) => {
        const items = upgraded(legendarySample(c, Math.max(25, Math.min(39, level - 2)), 0), 5);
        const xph = Math.max(
          ...areas(level).map(
            (areaId) =>
              settleFarming({
                character: { classId: c, level, xp: 0 },
                equipment: items,
                areaId,
                seed: `b5-pace:${c}:${level}:0`,
                firstCycle: 0,
                durationMs: 3_600_000,
                inventoryCount: 0,
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

describe('older drops still matter (B.5, Phase 6 exit)', () => {
  it(
    'Ashen Pass set pieces in a Depths kit cost a few percent; an all-Pass kit trails',
    SLOW,
    () => {
      const job = { ...PASS_FARM_JOB, areaId: 'cinderDepths' as const, level: 40, itemLevel: 39 };
      for (const c of CLASS_IDS) {
        const top = searchBuilds(
          c,
          PASS_FARM_JOB.itemLevel,
          (items) => farmRate(c, items, PASS_FARM_JOB),
          setChassis(c),
        )[0]!.build;
        const at = (il: number) => buildItems({ ...top, upgradeLevel: 10, void: true }, il);
        const depths = at(39);
        const pass = at(25);
        const mixed = depths.map((i, k) => (i.setId ? pass[k]! : i));
        const full = farmRate(c, depths, job);
        // Measured: −1 % to −3 % (the set bonus carries; the pieces' own stats are older).
        expect(farmRate(c, mixed, job) / full, c).toBeGreaterThanOrEqual(0.95);
        // Newer drops still pay: an all-Pass kit farms 14–18 % slower (still without deaths).
        expect(farmRate(c, pass, job) / full, c).toBeLessThanOrEqual(0.92);
        // And an older kit still beats the Tyrant at +10 Void.
        expect(winRate('tyrantsForge', 1, c, 38, mixed, 8)).toBe(1);
      }
    },
  );
});
