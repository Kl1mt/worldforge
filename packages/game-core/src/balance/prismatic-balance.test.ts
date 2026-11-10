import { describe, expect, it } from 'vitest';
import { settleFarming, type ClassId, type EquippedItem } from '../index.js';
import {
  CLASS_IDS,
  PASS_FARM_JOB,
  WARDEN_JOB,
  bossTime,
  buildItems,
  describeBuild,
  farmRate,
  searchBuilds,
  setChassis,
} from './builds.js';

/**
 * Ticket 6.4: Prismatic is a sidegrade to Void, not more power (owner decision). For every class
 * the B.2 build search runs with every piece Void and with every piece Prismatic (so each variant
 * gets the effects and affix package that suit it), for farming the Ashen Pass at 26 and the
 * Ashen Warden at 28, at +0 and +10. The best Prismatic build stays within 5 % of the best Void
 * build (which one leads changes by class and job; see the docs table). Measured (docs/EFFECTS.md "Prismatic balance"):
 * farming 0.997–1.009, the Warden 0.974–1.041 (Prismatic ÷ Void, kills per minute and boss time).
 * Dev tool with the Verge job too: `tools/balance/prismatic.ts`.
 */
const BAND = 0.05;

const as = (variant: 'void' | 'prismatic', upgradeLevel: number) => (items: EquippedItem[]) =>
  items.map((i) => ({ ...i, variant, ...(upgradeLevel ? { upgradeLevel } : {}) }));

const best = (c: ClassId, itemLevel: number, score: (items: EquippedItem[]) => number) =>
  searchBuilds(c, itemLevel, score, setChassis(c))[0]!;

describe('Prismatic is a sidegrade to Void (ticket 6.4, B.2 build search)', () => {
  for (const upgradeLevel of [0, 10]) {
    it.each(CLASS_IDS)(
      `%s: the best Prismatic build farms the Ashen Pass like the best Void build (+${upgradeLevel})`,
      (c) => {
        const score = (v: 'void' | 'prismatic') => (items: EquippedItem[]) =>
          farmRate(c, as(v, upgradeLevel)(items), PASS_FARM_JOB);
        const v = best(c, PASS_FARM_JOB.itemLevel, score('void'));
        const p = best(c, PASS_FARM_JOB.itemLevel, score('prismatic'));
        const ratio = p.score / v.score;
        const label = `${c} +${upgradeLevel}: Void ${v.score.toFixed(2)} ${describeBuild(v.build)} · Prismatic ${p.score.toFixed(2)} ${describeBuild(p.build)} · ${ratio.toFixed(3)}`;
        expect(ratio, label).toBeGreaterThan(1 - BAND);
        expect(ratio, label).toBeLessThan(1 + BAND);
      },
      120_000,
    );

    it.each(CLASS_IDS)(
      `%s: the best Prismatic build fights the Ashen Warden like the best Void build (+${upgradeLevel})`,
      (c) => {
        const score = (v: 'void' | 'prismatic') => (items: EquippedItem[]) =>
          -bossTime(c, as(v, upgradeLevel)(items), 12, WARDEN_JOB);
        const v = best(c, WARDEN_JOB.itemLevel, score('void'));
        const p = best(c, WARDEN_JOB.itemLevel, score('prismatic'));
        // Boss time: lower is better, so Prismatic ÷ Void below 1 means Prismatic is faster.
        const ratio = p.score / v.score;
        const label = `${c} +${upgradeLevel}: Void ${(-v.score / 1000).toFixed(2)}s ${describeBuild(v.build)} · Prismatic ${(-p.score / 1000).toFixed(2)}s ${describeBuild(p.build)} · ${ratio.toFixed(3)}`;
        expect(ratio, label).toBeGreaterThan(1 - BAND);
        expect(ratio, label).toBeLessThan(1 + BAND);
      },
      120_000,
    );
  }

  it.each(CLASS_IDS)(
    '%s: a full Prismatic kit is a small step over the same kit, never a new tier, never less safe',
    (c) => {
      const plain = searchBuilds(
        c,
        PASS_FARM_JOB.itemLevel,
        (items) => farmRate(c, items, PASS_FARM_JOB),
        setChassis(c).slice(0, 2),
      )[0]!.build;
      const items = buildItems(plain, PASS_FARM_JOB.itemLevel);
      const run = (equipment: EquippedItem[]) =>
        settleFarming({
          character: { classId: c, level: PASS_FARM_JOB.level, xp: 0 },
          equipment,
          areaId: 'ashenPass',
          seed: 'prismatic-step',
          firstCycle: 0,
          durationMs: 30 * 60_000,
          inventoryCount: 0,
        });
      const a = run(items);
      const b = run(as('prismatic', 0)(items));
      expect(b.kills / a.kills, c).toBeGreaterThanOrEqual(0.99);
      expect(b.kills / a.kills, c).toBeLessThan(1.1);
      expect(b.deaths, c).toBeLessThanOrEqual(a.deaths);
    },
    60_000,
  );
});
