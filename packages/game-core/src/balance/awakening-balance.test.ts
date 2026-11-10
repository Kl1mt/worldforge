import { describe, expect, it } from 'vitest';
import { settleFarming, type ClassId, type EquippedItem } from '../index.js';
import {
  DEFAULT_AWAKENING_SETTINGS,
  awakenItem,
  awakeningCost,
  evaluationSettings,
  type AwakenableItem,
  type AwakeningSettings,
} from '../items/awakening.js';
import {
  CLASS_IDS,
  PASS_FARM_JOB,
  affixOrder,
  bossTime,
  buildItems,
  farmRate,
  searchBuilds,
  setChassis,
  type BossJob,
  type Build,
} from './builds.js';
import { legendaryKit, upgraded } from './kits.js';

/**
 * Ticket 6.5: the Item Awakening evaluation's guards (docs/AWAKENING.md; the full tables come from
 * `tools/balance/awakening.ts`). Everything is game-core on pinned seeds, so every number is
 * deterministic. The B.2 build search at the Forge Tyrant (level 38, item level 37, 12 runs) is
 * the job the guards use: it is the fastest search and the content awakening is gated on.
 * Measured with the prototype's settings (option b × 1.1, runner-up a at half an affix):
 * full kit +4.8–9.5 % (b) and +3.5–8.2 % (a) faster Tyrant kills over the best +10 Void/Prismatic
 * kit; an awakened item-level-33 kit −3.8 … +0.6 % against the same build from the Depths plain.
 */
const TYRANT: BossJob = { dungeonId: 'tyrantsForge', tier: 1, level: 38, itemLevel: 37, runs: 12 };
const B = evaluationSettings({ option: 'effect' });
const A = evaluationSettings({ option: 'affixSlot' });
type Option = 'none' | 'a' | 'b';
type Variant = 'void' | 'prismatic';

function dress(
  build: Build,
  items: EquippedItem[],
  variant: Variant,
  option: Option,
  settings: { a: AwakeningSettings; b: AwakeningSettings } = { a: A, b: B },
  only?: number,
): AwakenableItem[] {
  return items.map((raw, i) => {
    const item: AwakenableItem = { ...raw, upgradeLevel: 10, variant };
    if (option === 'none' || (only !== undefined && only !== i)) return item;
    if (option === 'b') {
      const r = awakenItem(item, settings.b);
      return r.ok ? r.item : item;
    }
    for (const affixId of affixOrder(build.classId, build.pkg)) {
      const r = awakenItem(item, settings.a, { affixId, roll: 0.5, classId: build.classId });
      if (r.ok) return r.item;
    }
    return item;
  });
}

/** Tyrant fight time (ms; lower is better). */
const tyrant = (c: ClassId, items: EquippedItem[], job: BossJob = TYRANT) =>
  bossTime(c, items, job.runs, job);
/** Faster kill as a gain: time before ÷ time after − 1. */
const gain = (after: number, before: number) => before / after - 1;

function best(c: ClassId, variant: Variant, option: Option, itemLevel = TYRANT.itemLevel) {
  return searchBuilds(
    c,
    itemLevel,
    (items, build) => -tyrant(c, dress(build, items, variant, option), { ...TYRANT, itemLevel }),
    setChassis(c),
  )[0]!;
}

describe('Item Awakening below +10 (ticket 6.5b)', () => {
  it('refuses every piece of a +9 top kit, which fights exactly as before', () => {
    expect(DEFAULT_AWAKENING_SETTINGS.effectStrength).toBe(1.1);
    const build = best('warrior', 'void', 'none').build;
    const items = buildItems(build, TYRANT.itemLevel).map((i) => ({
      ...i,
      upgradeLevel: 9,
      variant: 'void' as const,
    }));
    const offered = items.map((item) => {
      const r = awakenItem(item);
      expect(r).toEqual({ ok: false, reason: 'upgrade_level' });
      return item;
    });
    expect(tyrant('warrior', offered)).toBe(tyrant('warrior', items));
  });
});

describe('the evaluation (ticket 6.5, B.2 build search at the Forge Tyrant)', () => {
  // Searched once, on first use (inside a test, not while the file is collected).
  let cache: ReturnType<typeof search> | undefined;
  const rowsOf = () => (cache ??= search());
  const search = () =>
    CLASS_IDS.map((c) => {
      const v = best(c, 'void', 'none');
      const p = best(c, 'prismatic', 'none');
      const base =
        v.score >= p.score
          ? { ...v, variant: 'void' as Variant }
          : { ...p, variant: 'prismatic' as Variant };
      const awakened = (option: 'a' | 'b') => {
        const av = best(c, 'void', option);
        const ap = best(c, 'prismatic', option);
        return { void: av.score, prismatic: ap.score, top: Math.max(av.score, ap.score) };
      };
      return { c, base, a: awakened('a'), b: awakened('b') };
    });
  const row = (c: ClassId) => rowsOf().find((x) => x.c === c)!;

  it.each(CLASS_IDS)(
    '%s: a full awakened kit is a modest step over the best +10 Void/Prismatic kit',
    (c) => {
      const r = row(c);
      for (const option of ['a', 'b'] as const) {
        // Scores are −time: the gain is (−base) ÷ (−awakened) − 1.
        const g = gain(-r[option].top, -r.base.score);
        expect(g, `${c} ${option}`).toBeGreaterThanOrEqual(0);
        expect(g, `${c} ${option}`).toBeLessThan(0.12);
        // Void and Prismatic stay a sidegrade with every piece awakened (6.4's 5 % band).
        const pv = gain(-r[option].prismatic, -r[option].void);
        expect(Math.abs(pv), `${c} ${option} prismatic vs void`).toBeLessThan(0.05);
      }
    },
  );

  it('no class gains much more than another (spread of the full-kit gains under 8 points)', () => {
    for (const option of ['a', 'b'] as const) {
      const gains = rowsOf().map((r) => gain(-r[option].top, -r.base.score));
      expect(Math.max(...gains) - Math.min(...gains), option).toBeLessThan(0.08);
    }
  });

  it.each(CLASS_IDS)('%s: one awakened piece is a small step (under 5 %)', (c) => {
    const r = row(c);
    const items = buildItems(r.base.build, TYRANT.itemLevel);
    const before = tyrant(c, dress(r.base.build, items, r.base.variant, 'none'));
    for (const option of ['a', 'b'] as const) {
      for (let i = 0; i < items.length; i++) {
        const after = tyrant(c, dress(r.base.build, items, r.base.variant, option, undefined, i));
        expect(gain(after, before), `${c} ${option} piece ${i}`).toBeLessThan(0.05);
      }
    }
  });

  it.each(CLASS_IDS)(
    '%s: newer drops stay worth wearing (an awakened item-level-33 kit is no better than the Depths’ plain one)',
    (c) => {
      const build = best(c, 'void', 'none', 33).build;
      const older = buildItems(build, 33);
      const newer = buildItems(build, 39);
      const plainNew = tyrant(c, dress(build, newer, 'void', 'none'));
      for (const option of ['a', 'b'] as const) {
        const kit = tyrant(c, dress(build, older, 'void', option));
        expect(gain(kit, plainNew), `${c} ${option} kit`).toBeLessThan(0.02);
        // A single awakened older weapon among plain newer pieces loses to the newer weapon.
        const mixed = dress(build, newer, 'void', 'none');
        mixed[0] = dress(build, older, 'void', option)[0]!;
        expect(gain(tyrant(c, mixed), plainNew), `${c} ${option} weapon`).toBeLessThanOrEqual(0);
      }
    },
  );

  it('a stronger awakening is never weaker (option b, same build)', () => {
    for (const c of ['warrior', 'mage'] as const) {
      const r = row(c);
      const items = buildItems(r.base.build, TYRANT.itemLevel);
      const times = [1.05, 1.1, 1.25].map((effectStrength) =>
        tyrant(
          c,
          dress(r.base.build, items, r.base.variant, 'b', {
            a: A,
            b: evaluationSettings({ option: 'effect', effectStrength }),
          }),
        ),
      );
      expect(times[1]!, c).toBeLessThanOrEqual(times[0]!);
      expect(times[2]!, c).toBeLessThanOrEqual(times[1]!);
    }
  });
});

describe('farming and the cost (ticket 6.5)', () => {
  const DEPTHS = { ...PASS_FARM_JOB, areaId: 'cinderDepths' as const, level: 37, itemLevel: 36 };

  it.each(CLASS_IDS)('%s: an awakened kit farms the Depths at most a few percent faster', (c) => {
    const build = searchBuilds(
      c,
      DEPTHS.itemLevel,
      (items, b) => farmRate(c, dress(b, items, 'void', 'none'), DEPTHS),
      setChassis(c).slice(0, 4),
    )[0]!.build;
    const items = buildItems(build, DEPTHS.itemLevel);
    const before = farmRate(c, dress(build, items, 'void', 'none'), DEPTHS);
    for (const option of ['a', 'b'] as const) {
      const ratio = farmRate(c, dress(build, items, 'void', option), DEPTHS) / before;
      expect(ratio, `${c} ${option}`).toBeGreaterThanOrEqual(1);
      expect(ratio, `${c} ${option}`).toBeLessThan(1.05);
    }
  });

  it('one awakening is days of Tyrant hoards, and its gold is not the gate', () => {
    const cost = awakeningCost({ itemLevel: 37 });
    // One Tyrant's Ember per hero per 20 h hoard: at least three days a piece, three weeks a kit.
    expect(cost.tyrantsEmber).toBeGreaterThanOrEqual(3);
    expect(cost.tyrantsEmber * 8).toBeGreaterThanOrEqual(21);
    // Its gold is under 12 hours of Depths farming for a realistic late kit (+10 Verge Legendaries).
    const kit = upgraded(legendaryKit('warrior', 33), 10);
    let gold = 0;
    for (const seed of ['cost-a', 'cost-b']) {
      const r = settleFarming({
        character: { classId: 'warrior', level: 38, xp: 0 },
        equipment: kit,
        areaId: 'cinderDepths',
        seed,
        firstCycle: 0,
        durationMs: 3_600_000,
        inventoryCount: 0,
      });
      gold += r.goldLooted + r.goldSalvaged;
    }
    expect(cost.gold / (gold / 2)).toBeLessThan(12);
    expect(cost.gold / (gold / 2)).toBeGreaterThan(2);
  });
});
