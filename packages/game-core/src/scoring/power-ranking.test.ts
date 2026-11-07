import { describe, expect, it } from 'vitest';
import type { ClassId, EquippedItem, GeneratedItem } from '../index.js';
import {
  BOSS_JOB,
  CLASS_IDS,
  bossTime,
  buildItems,
  buildSlots,
  describeBuild,
  searchBuilds,
  setChassis,
  topBuilds,
} from '../balance/builds.js';
import { characterPower, powerScore } from './power.js';
import type { ScoredItem } from './equipment.js';

/**
 * Ticket 5.1: Character Power against the build-diversity suite (B.2, `balance/builds.ts`). The
 * same 48 late-game builds per class (12 set layouts × 4 affix packages, greedy Legendary
 * effects), ranked by the tier III Gravewarden's boss time, must be ranked sensibly by Power:
 * B.2's top builds near the top, Power and boss time in the same order overall, and power sources
 * (upgrades, Void) adding Power. Everything is deterministic (fixed seeds on both sides), so the
 * numbers are the same on every run. Measured: Spearman 0.65–0.78 (warrior 0.78, mage 0.72,
 * hunter 0.65, warlock 0.69).
 */

function spearman(a: readonly number[], b: readonly number[]): number {
  const rank = (x: readonly number[]) => {
    const order = x.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]);
    const r: number[] = new Array<number>(x.length);
    // Ties share their mean rank.
    for (let i = 0; i < order.length;) {
      let j = i;
      while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
      for (let k = i; k <= j; k++) r[order[k]![1]] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const ra = rank(a);
  const rb = rank(b);
  const mean = (a.length - 1) / 2;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (ra[i]! - mean) * (rb[i]! - mean);
    da += (ra[i]! - mean) ** 2;
    db += (rb[i]! - mean) ** 2;
  }
  return num / Math.sqrt(da * db);
}

/** A build's items with the equipment slots they are worn in (rings → ring1, ring2). */
function slotted(c: ClassId, items: EquippedItem[]): ScoredItem[] {
  let ring = 0;
  return buildSlots(c).map((s, i) => {
    const slot = s === 'ring' ? `ring${++ring}` : s;
    return { ...(items[i] as GeneratedItem & EquippedItem), slot };
  });
}

describe('Character Power ranks the B.2 builds (ticket 5.1)', () => {
  it.each(CLASS_IDS)(
    '%s: the boss job’s top builds rank high, and Power follows boss time',
    (c) => {
      const scored = searchBuilds(
        c,
        BOSS_JOB.itemLevel,
        (items) => -bossTime(c, items),
        setChassis(c),
        true,
      );
      const power = scored.map((s) => {
        const items = buildItems(s.build, BOSS_JOB.itemLevel);
        const p = characterPower({ classId: c, level: BOSS_JOB.level, equipment: items }).power;
        // The builds are real items: the checked score is the same (nothing is rejected).
        expect(powerScore(c, BOSS_JOB.level, slotted(c, items)).value).toBe(p);
        return p;
      });
      const top = topBuilds(scored, 0.07).length;
      const sorted = [...power].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)]!;
      const rho = spearman(
        scored.map((s) => s.score),
        power,
      );
      const label = `${c}: ρ ${rho.toFixed(2)}, median ${median}\n${scored
        .map((s, i) => `${power[i]} ${(-s.score / 1000).toFixed(2)}s ${describeBuild(s.build)}`)
        .join('\n')}`;
      expect(rho, label).toBeGreaterThan(0.5);
      // Every build within 7 % of the fastest is above the median build's Power.
      for (let i = 0; i < top; i++) expect(power[i]!, label).toBeGreaterThan(median);
      // And the slowest builds are not near the top: the slowest quarter's best stays below the
      // top builds' best.
      const slowest = power.slice(Math.floor(power.length * 0.75));
      expect(Math.max(...slowest), label).toBeLessThan(Math.max(...power.slice(0, top)));

      // Power sources add Power: the best build at +5 and at +10 Void.
      const best = scored[0]!.build;
      const at = (b: typeof best) =>
        characterPower({
          classId: c,
          level: BOSS_JOB.level,
          equipment: buildItems(b, BOSS_JOB.itemLevel),
        }).power;
      const p0 = power[0]!;
      const p5 = at({ ...best, upgradeLevel: 5 });
      const p10v = at({ ...best, upgradeLevel: 10, void: true });
      expect(p5, label).toBeGreaterThan(p0);
      expect(p10v, label).toBeGreaterThan(p5);
    },
    60_000,
  );
});
