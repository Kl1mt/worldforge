import { describe, expect, it } from 'vitest';
import {
  CLASS_IDS,
  DEFAULT_FORGE_ACTION_CONFIG,
  MAX_UPGRADE_LEVEL,
  UPGRADE_IMPLICIT_BONUS,
  attemptUpgrade,
  createRng,
  expectedAttempts,
  findAffix,
  forgeCostBlockers,
  generateItem,
  getImplicitStats,
  getItemBase,
  improveAffix,
  itemStatContribution,
  quoteImprove,
  quoteReroll,
  quoteUpgrade,
  rerollAffix,
  rerollOptions,
  upgradePathCost,
  validateItem,
  type ForgeItem,
  type GeneratedItem,
} from '../index.js';

const forgeItem = (item: GeneratedItem, extra: Partial<ForgeItem> = {}): ForgeItem => ({
  ...item,
  upgradeLevel: 0,
  upgradePity: 0,
  rerollCount: 0,
  ...extra,
});

const rareRing = generateItem({ seed: 7, itemLevel: 18, baseId: 'iron-ring', rarityId: 'rare' })!;
const epicSword = generateItem({
  seed: 21,
  itemLevel: 16,
  baseId: 'longsword-notched',
  rarityId: 'epic',
  classId: 'warrior',
})!;

describe('upgrade levels raise base values (ticket 3.4)', () => {
  it('+0, null and a missing level give exactly the pre-3.4 implicit stats', () => {
    const item = generateItem({ seed: 3, itemLevel: 13, baseId: 'barbute', rarityId: 'epic' })!;
    const base = getItemBase(item.baseId);
    const expected = base.stats.map((s) => ({
      stat: s.stat,
      value: Math.round((s.base + s.perLevel * (item.itemLevel - 1)) * 1.35),
    }));
    expect(getImplicitStats(item)).toEqual(expected);
    expect(getImplicitStats({ ...item, upgradeLevel: 0 })).toEqual(expected);
    expect(getImplicitStats({ ...item, upgradeLevel: null })).toEqual(expected);
    expect(itemStatContribution({ ...item, upgradeLevel: 0 })).toEqual(itemStatContribution(item));
  });

  it('each level adds to the implicit stats only, up to +50 % at +10', () => {
    const plain = itemStatContribution(epicSword);
    let previous = getImplicitStats(epicSword);
    for (let n = 1; n <= MAX_UPGRADE_LEVEL; n++) {
      const now = getImplicitStats({ ...epicSword, upgradeLevel: n });
      now.forEach((s, i) => expect(s.value).toBeGreaterThanOrEqual(previous[i]!.value));
      previous = now;
    }
    const top = getImplicitStats({ ...epicSword, upgradeLevel: 10 });
    getImplicitStats(epicSword).forEach((s, i) =>
      expect(top[i]!.value).toBe(
        Math.round(
          (getItemBase(epicSword.baseId).stats[i]!.base +
            getItemBase(epicSword.baseId).stats[i]!.perLevel * 15) *
            1.35 *
            1.5,
        ),
      ),
    );
    // Affixes are untouched: the difference is exactly the implicit difference.
    const upgraded = itemStatContribution({ ...epicSword, upgradeLevel: 10 });
    for (const s of getImplicitStats(epicSword)) {
      const after = top.find((t) => t.stat === s.stat)!.value;
      expect(upgraded[s.stat]! - plain[s.stat]!).toBe(after - s.value);
    }
    expect(UPGRADE_IMPLICIT_BONUS).toHaveLength(MAX_UPGRADE_LEVEL + 1);
  });
});

describe('upgrade attempts', () => {
  it('success chance falls with the level; pity thresholds and costs rise', () => {
    const steps = DEFAULT_FORGE_ACTION_CONFIG.upgradeSteps;
    expect(steps).toHaveLength(MAX_UPGRADE_LEVEL);
    expect(steps[0]!.chance).toBe(1);
    for (let n = 1; n < steps.length; n++) {
      expect(steps[n]!.chance).toBeLessThan(steps[n - 1]!.chance);
      expect(steps[n]!.pity).toBeGreaterThanOrEqual(steps[n - 1]!.pity);
      expect(steps[n]!.gold).toBeGreaterThan(steps[n - 1]!.gold);
      expect(steps[n]!.pity).toBeGreaterThan(0);
    }
    const item = forgeItem(epicSword);
    let gold = 0;
    for (let n = 0; n < MAX_UPGRADE_LEVEL; n++) {
      const q = quoteUpgrade({ ...item, upgradeLevel: n });
      if (!q.ok) throw new Error(q.reason);
      expect(q.value.cost.gold).toBeGreaterThan(gold);
      gold = q.value.cost.gold;
    }
    expect(quoteUpgrade({ ...item, upgradeLevel: 10 })).toEqual({
      ok: false,
      reason: 'max_upgrade',
    });
  });

  it('costs the item’s tier materials and scale with the item level', () => {
    const t1 = generateItem({ seed: 1, itemLevel: 4, baseId: 'iron-helm', rarityId: 'common' })!;
    const t2 = generateItem({ seed: 1, itemLevel: 12, baseId: 'barbute', rarityId: 'common' })!;
    const q1 = quoteUpgrade(forgeItem(t1, { upgradeLevel: 5 }));
    const q2 = quoteUpgrade(forgeItem(t2, { upgradeLevel: 5 }));
    if (!q1.ok || !q2.ok) throw new Error('refused');
    expect(Object.keys(q1.value.cost.materials).sort()).toEqual(['soulShard', 'timber']);
    expect(Object.keys(q2.value.cost.materials).sort()).toEqual(['rawHide', 'soulShard', 'timber']);
    expect(q2.value.cost.gold).toBeGreaterThan(q1.value.cost.gold);
  });

  it('a failure keeps the level and counts toward the pity; a success resets it', () => {
    let state = { upgradeLevel: 9, upgradePity: 0 };
    const rng = createRng('fail-stream');
    let failures = 0;
    while (state.upgradeLevel === 9) {
      const out = attemptUpgrade(state, rng);
      expect(out.upgradeLevel).toBeGreaterThanOrEqual(9);
      if (!out.success) {
        failures += 1;
        expect(out.upgradePity).toBe(state.upgradePity + 1);
      } else {
        expect(out.upgradeLevel).toBe(10);
        expect(out.upgradePity).toBe(0);
      }
      state = out;
    }
    expect(failures).toBeLessThanOrEqual(DEFAULT_FORGE_ACTION_CONFIG.upgradeSteps[9]!.pity);
  });

  it('the pity guarantees success after N failures, whatever the roll', () => {
    const always = { next: () => 0.999999 } as ReturnType<typeof createRng>;
    for (let n = 1; n < MAX_UPGRADE_LEVEL; n++) {
      const pity = DEFAULT_FORGE_ACTION_CONFIG.upgradeSteps[n]!.pity;
      let state = { upgradeLevel: n, upgradePity: 0 };
      for (let k = 0; k < pity; k++) {
        const out = attemptUpgrade(state, always);
        expect(out.success, `+${n} attempt ${k}`).toBe(false);
        state = out;
      }
      const last = attemptUpgrade(state, always);
      expect(last).toMatchObject({ success: true, guaranteed: true, upgradeLevel: n + 1 });
    }
    expect(() => attemptUpgrade({ upgradeLevel: 10, upgradePity: 0 }, always)).toThrow();
  });

  it('is a pure function of the stream: the same seed always gives the same outcome', () => {
    for (let i = 0; i < 50; i++) {
      const a = attemptUpgrade({ upgradeLevel: 7, upgradePity: 1 }, createRng(`s:${i}`));
      const b = attemptUpgrade({ upgradeLevel: 7, upgradePity: 1 }, createRng(`s:${i}`));
      expect(a).toEqual(b);
    }
  });

  it('observed success rates and attempts match the table (statistical, 20k seeds)', () => {
    const N = 20_000;
    for (const n of [3, 6, 9]) {
      const step = DEFAULT_FORGE_ACTION_CONFIG.upgradeSteps[n]!;
      let wins = 0;
      let attempts = 0;
      for (let i = 0; i < N; i++) {
        if (attemptUpgrade({ upgradeLevel: n, upgradePity: 0 }, createRng(`p:${n}:${i}`)).success)
          wins += 1;
        // A whole step from pity 0 on its own stream.
        let state = { upgradeLevel: n, upgradePity: 0 };
        const rng = createRng(`walk:${n}:${i}`);
        while (state.upgradeLevel === n) {
          state = attemptUpgrade(state, rng);
          attempts += 1;
        }
      }
      expect(wins / N).toBeCloseTo(step.chance, 1);
      expect(Math.abs(attempts / N - expectedAttempts(step))).toBeLessThan(0.05);
    }
  });

  it('path costs: the worst case is the pity-capped number of attempts', () => {
    const c = upgradePathCost(epicSword, 0, 10);
    const steps = DEFAULT_FORGE_ACTION_CONFIG.upgradeSteps;
    expect(c.worst.attempts).toBe(steps.reduce((s, x) => s + (x.chance >= 1 ? 1 : x.pity + 1), 0));
    expect(c.expected.attempts).toBeCloseTo(
      steps.reduce((s, x) => s + expectedAttempts(x), 0),
      9,
    );
    expect(c.worst.gold).toBeGreaterThan(c.expected.gold);
    expect(upgradePathCost(epicSword, 4, 4).expected.gold).toBe(0);
  });
});

describe('affix reroll', () => {
  const item = forgeItem(epicSword);

  it('replaces only the picked affix, never with one the item keeps, and marks it', () => {
    for (let index = 0; index < item.affixes.length; index++) {
      for (let s = 0; s < 40; s++) {
        const out = rerollAffix(item, index, 'warrior', createRng(`r:${index}:${s}`));
        if (!out.ok) throw new Error(out.reason);
        const affixes = out.value;
        expect(affixes).toHaveLength(item.affixes.length);
        affixes.forEach((a, i) => {
          if (i !== index) expect(a).toEqual(item.affixes[i]);
        });
        const fresh = affixes[index]!;
        expect(fresh.rerolled).toBe(true);
        expect(fresh.improvements).toBeUndefined();
        expect(fresh.affixId).not.toBe(item.affixes[index]!.affixId);
        expect(new Set(affixes.map((a) => a.affixId)).size).toBe(affixes.length);
        expect(validateItem({ ...epicSword, affixes })).toEqual([]);
      }
    }
  });

  it('only offers class affixes for the owner’s class', () => {
    for (const c of CLASS_IDS) {
      const out = rerollOptions(item, 0, c);
      if (!out.ok) throw new Error(out.reason);
      for (const o of out.value) {
        if (o.affix.classes) expect(o.affix.classes).toContain(c);
        expect(o.tiers.length).toBeGreaterThan(0);
      }
    }
  });

  it('is deterministic per stream and refuses a missing affix', () => {
    const a = rerollAffix(item, 1, 'warrior', createRng('same'));
    const b = rerollAffix(item, 1, 'warrior', createRng('same'));
    expect(a).toEqual(b);
    expect(rerollAffix(item, 9, 'warrior', createRng('x'))).toEqual({
      ok: false,
      reason: 'no_such_affix',
    });
    expect(rerollAffix(item, -1, 'warrior', createRng('x')).ok).toBe(false);
  });

  it('costs more with every reroll of the same item', () => {
    let gold = 0;
    let shards = 0;
    for (let n = 0; n < 8; n++) {
      const q = quoteReroll({ ...item, rerollCount: n });
      if (!q.ok) throw new Error(q.reason);
      expect(q.value.gold).toBeGreaterThan(gold);
      expect(q.value.materials.soulShard!).toBeGreaterThanOrEqual(shards);
      gold = q.value.gold;
      shards = q.value.materials.soulShard!;
    }
  });
});

describe('affix improvement', () => {
  const item = forgeItem(rareRing);

  it('raises the value toward the tier maximum, on the step grid, and counts it', () => {
    for (let index = 0; index < item.affixes.length; index++) {
      let current = item;
      const affix = findAffix(current.affixes[index]!.affixId)!;
      const tier = affix.tiers.find((t) => t.tier === current.affixes[index]!.tier)!;
      for (let step = 0; step < 3; step++) {
        const q = quoteImprove(current, index);
        if (!q.ok) {
          expect(q.reason).toBe('affix_at_max');
          expect(current.affixes[index]!.value).toBe(tier.max);
          break;
        }
        const out = improveAffix(current, index, createRng(`i:${index}:${step}`));
        if (!out.ok) throw new Error(out.reason);
        const before = current.affixes[index]!;
        const after = out.value[index]!;
        expect(after.value).toBeGreaterThan(before.value);
        expect(after.value).toBeLessThanOrEqual(tier.max);
        expect(after.value).toBeGreaterThanOrEqual(q.value.next.low);
        expect(after.value).toBeLessThanOrEqual(q.value.next.high);
        expect(after.improvements).toBe(step + 1);
        expect(after.affixId).toBe(before.affixId);
        expect(validateItem({ ...rareRing, affixes: out.value })).toEqual([]);
        current = { ...current, affixes: out.value };
      }
    }
  });

  it('stops at the cap and at the maximum', () => {
    const capped = {
      ...item,
      affixes: item.affixes.map((a, i) => (i === 0 ? { ...a, improvements: 3 } : a)),
    };
    expect(improveAffix(capped, 0, createRng('c'))).toEqual({
      ok: false,
      reason: 'improvement_cap',
    });
    const affix = findAffix(item.affixes[1]!.affixId)!;
    const max = affix.tiers.find((t) => t.tier === item.affixes[1]!.tier)!.max;
    const maxed = {
      ...item,
      affixes: item.affixes.map((a, i) => (i === 1 ? { ...a, value: max } : a)),
    };
    expect(quoteImprove(maxed, 1)).toEqual({ ok: false, reason: 'affix_at_max' });
  });

  it('each improvement of an affix costs more than the last', () => {
    let gold = 0;
    for (let n = 0; n < 3; n++) {
      const it = {
        ...item,
        affixes: item.affixes.map((a, i) =>
          i === 0
            ? { ...a, value: findAffix(a.affixId)!.tiers[0]!.min, tier: 1, improvements: n }
            : a,
        ),
      };
      const q = quoteImprove(it, 0);
      if (!q.ok) throw new Error(q.reason);
      expect(q.value.cost.gold).toBeGreaterThan(gold);
      gold = q.value.cost.gold;
    }
  });
});

describe('forge cost blockers', () => {
  it('lists the gold and each short material', () => {
    const cost = { gold: 100, materials: { timber: 10, soulShard: 2 } };
    expect(forgeCostBlockers(cost, 100, { timber: 10, soulShard: 2 })).toEqual([]);
    expect(forgeCostBlockers(cost, 99, { timber: 4 })).toEqual([
      { kind: 'gold', required: 100, held: 99 },
      { kind: 'material', materialId: 'timber', required: 10, held: 4 },
      { kind: 'material', materialId: 'soulShard', required: 2, held: 0 },
    ]);
  });
});
