import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACTIVITY_CONFIG,
  equipmentModifiers,
  generateItem,
  itemContribution,
  requestAreaChange,
  salvageValue,
  settleFarming,
  type ActivityAreaState,
  type AreaId,
  type GeneratedItem,
  type SettleFarmingInput,
} from '../index.js';

const HOUR = 60 * 60 * 1000;

const input = (overrides: Partial<SettleFarmingInput> = {}): SettleFarmingInput => ({
  character: { classId: 'warrior', level: 1, xp: 0 },
  areaId: 'abandonedFields',
  seed: 'activity-test',
  durationMs: HOUR,
  inventoryCount: 0,
  firstCycle: 0,
  ...overrides,
});

function addMaterials(into: Record<string, number>, add: Partial<Record<string, number>>) {
  for (const [id, n] of Object.entries(add)) into[id] = (into[id] ?? 0) + (n ?? 0);
}

const goldRing = (value: number): GeneratedItem => ({
  seed: 1,
  baseId: 'iron-ring',
  rarityId: 'rare',
  itemLevel: 10,
  affixes: [{ affixId: 'gold-find', tier: 1, value }],
});

describe('itemContribution / equipmentModifiers', () => {
  it('sums implicit stats and affixes, splitting gold find off', () => {
    const item = generateItem({ seed: 42, itemLevel: 20, rarityId: 'mythic' })!;
    const c = itemContribution(item);
    for (const v of Object.values(c.stats)) expect(Number.isFinite(v)).toBe(true);
    expect(c.goldFind).toBeGreaterThanOrEqual(0);
  });

  it('caps total gold find', () => {
    const many = Array.from({ length: 30 }, () => goldRing(0.1));
    const m = equipmentModifiers(many);
    expect(m.goldFindUncapped).toBeCloseTo(3);
    expect(m.goldFind).toBe(DEFAULT_ACTIVITY_CONFIG.modifierCaps.goldFind);
    expect(equipmentModifiers([goldRing(0.1)]).goldFind).toBeCloseTo(0.1);
    expect(equipmentModifiers([]).goldFind).toBe(0);
  });
});

describe('settleFarming', () => {
  it('is deterministic for the same input', () => {
    expect(settleFarming(input())).toEqual(settleFarming(input()));
    expect(settleFarming(input({ seed: 'other' }))).not.toEqual(settleFarming(input()));
  });

  it('accounts for every millisecond and produces progress', () => {
    const r = settleFarming(input({ durationMs: 3 * HOUR }));
    expect(r.simulatedMs + r.unusedMs).toBe(3 * HOUR);
    expect(r.unusedMs).toBeLessThan(60_000);
    expect(r.kills).toBeGreaterThan(100);
    expect(r.xpGained).toBeGreaterThan(0);
    expect(r.level).toBeGreaterThan(1);
    expect(r.goldLooted).toBeGreaterThan(0);
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.length + r.salvaged.length).toBeLessThanOrEqual(r.kills);
    for (const v of [r.goldLooted, r.xp, r.health, r.damageTaken]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns nothing for an empty window', () => {
    const r = settleFarming(input({ durationMs: 0 }));
    expect(r).toMatchObject({ kills: 0, xpGained: 0, goldLooted: 0, unusedMs: 0, items: [] });
  });

  it('carries unfinished time instead of awarding it', () => {
    const r = settleFarming(input({ durationMs: 1_000 }));
    expect(r.kills).toBe(0);
    expect(r.unusedMs).toBe(1_000);
  });

  it('item levels follow the character within the area range', () => {
    const r = settleFarming(input({ character: { classId: 'hunter', level: 30, xp: 0 } }));
    for (const item of r.items) expect(item.itemLevel).toBeLessThanOrEqual(7);
  });

  it('salvages items beyond inventory capacity into gold', () => {
    const cap = DEFAULT_ACTIVITY_CONFIG.inventory.capacity;
    const window = { durationMs: HOUR / 2 };
    const roomy = settleFarming(input(window));
    expect(roomy.items.length).toBeGreaterThan(2);
    expect(roomy.items.length).toBeLessThan(cap);
    expect(roomy.salvaged).toEqual([]);
    const full = settleFarming(input({ ...window, inventoryCount: cap }));
    const nearly = settleFarming(input({ ...window, inventoryCount: cap - 2 }));
    expect(full.items).toEqual([]);
    expect(full.salvaged).toEqual(roomy.items);
    expect(full.goldSalvaged).toBe(roomy.items.reduce((s, i) => s + salvageValue(i), 0));
    expect(full.goldLooted).toBe(roomy.goldLooted);
    expect(nearly.items).toEqual(roomy.items.slice(0, 2));
    expect(nearly.salvaged.length).toBe(roomy.items.length - 2);
  });

  it('gold find raises gold, but only up to the cap', () => {
    const base = settleFarming(input({ durationMs: 3 * HOUR }));
    const capped = settleFarming(
      input({ durationMs: 3 * HOUR, equipment: Array.from({ length: 20 }, () => goldRing(0.1)) }),
    );
    const atCap = settleFarming(
      input({ durationMs: 3 * HOUR, equipment: Array.from({ length: 10 }, () => goldRing(0.1)) }),
    );
    expect(capped.goldFind).toBe(1);
    expect(capped.goldLooted).toBeGreaterThan(base.goldLooted);
    // Same rolls with and without the excess: the cap makes them identical in gold.
    expect(capped.goldLooted).toBe(atCap.goldLooted);
  });

  it('rejects invalid input', () => {
    expect(() => settleFarming(input({ durationMs: -1 }))).toThrow(RangeError);
    expect(() => settleFarming(input({ durationMs: 1.5 }))).toThrow(RangeError);
    expect(() => settleFarming(input({ inventoryCount: -1 }))).toThrow(RangeError);
    expect(() => settleFarming(input({ firstCycle: -1 }))).toThrow(RangeError);
    expect(() => settleFarming(input({ firstCycle: 0.5 }))).toThrow(RangeError);
  });

  /**
   * Ticket 1.9 exploit regression: the unfinished cycle at a window end used to be re-rolled by the
   * next settlement, so settling every second removed nearly all deaths (≈6.4 → 0.1 per hour) and
   * raised kills by ~20 %. Now a span of farming gives the same result however it is split.
   */
  describe('settlement splitting', () => {
    /** Settles `totalMs` in windows of `stepMs`, chaining state the way the server does. */
    function settleInSteps(seed: string, totalMs: number, stepMs: number, inventoryCount = 0) {
      let character: SettleFarmingInput['character'] = { classId: 'warrior', level: 1, xp: 0 };
      let carry = 0;
      let firstCycle = 0;
      let held = inventoryCount;
      let professions: SettleFarmingInput['professions'] = undefined;
      const totals = {
        kills: 0,
        deaths: 0,
        xp: 0,
        gold: 0,
        items: [] as GeneratedItem[],
        materials: {} as Record<string, number>,
      };
      for (let t = 0; t < totalMs; t += stepMs) {
        const s = settleFarming(
          input({
            seed,
            character,
            firstCycle,
            inventoryCount: held,
            durationMs: carry + Math.min(stepMs, totalMs - t),
            ...(professions ? { professions } : {}),
          }),
        );
        carry = s.unusedMs;
        firstCycle += s.encounters;
        held += s.items.length;
        totals.kills += s.kills;
        totals.deaths += s.deaths;
        totals.xp += s.xpGained;
        totals.gold += s.goldLooted + s.goldSalvaged;
        totals.items.push(...s.items);
        addMaterials(totals.materials, s.materials);
        professions = s.professions;
        character = { classId: 'warrior', level: s.level, xp: s.xp, health: s.health };
      }
      return { ...totals, character, carry, firstCycle, professions };
    }

    it('gives exactly the same result for one window or many small ones', () => {
      const total = 20 * 60 * 1000;
      const once = settleInSteps('split', total, total);
      expect(once.kills).toBeGreaterThan(0);
      // Gathering is part of the invariant (ticket 2.3).
      expect(once.materials.timber).toBeGreaterThan(0);
      expect(once.professions!.woodcutting!.xp).toBeGreaterThan(0);
      for (const step of [1_000, 7_000, 60_000]) {
        expect(settleInSteps('split', total, step)).toEqual(once);
      }
    });

    it('keeps the death rate when settling every second', () => {
      // Level-1 warrior over an hour: deaths happen; frequent settling must not avoid them.
      let once = 0;
      let spam = 0;
      for (let i = 0; i < 4; i++) {
        once += settleInSteps(`deaths-${i}`, HOUR, HOUR).deaths;
        spam += settleInSteps(`deaths-${i}`, HOUR, 1_000).deaths;
      }
      expect(once).toBeGreaterThan(0);
      expect(spam).toBe(once);
    });

    it('applies the capacity rule identically across windows', () => {
      const cap = DEFAULT_ACTIVITY_CONFIG.inventory.capacity;
      const total = 30 * 60 * 1000;
      expect(settleInSteps('cap', total, 5_000, cap - 3)).toEqual(
        settleInSteps('cap', total, total, cap - 3),
      );
    });
  });
});

/**
 * Area switches mid-cycle (ticket 2.2, closes the accepted risk of PR #18). The cycle in progress
 * finishes in the area where it started; the switch applies at its end. A run with a switch must
 * not depend on how often the client settles, and the switch target must not change the cycle that
 * was already running.
 */
describe('area switches', () => {
  const MIN = 60 * 1000;
  type Totals = {
    kills: number;
    deaths: number;
    xp: number;
    gold: number;
    items: GeneratedItem[];
    materials: Record<string, number>;
  };

  /**
   * Plays the server's sequence: settle at every time in `settleAt`; at `switchAt` settle, then
   * `requestAreaChange(target)`. Returns the totals and the state at `endMs`.
   */
  function run(opts: {
    seed: string;
    endMs: number;
    settleEveryMs: number;
    switches: { atMs: number; to: AreaId }[];
  }) {
    let character: SettleFarmingInput['character'] = { classId: 'mage', level: 10, xp: 0 };
    let area: ActivityAreaState = { areaId: 'crowwood', pendingAreaId: null, carryMs: 0 };
    let firstCycle = 0;
    let held = 0;
    let last = 0;
    let professions: SettleFarmingInput['professions'] = undefined;
    const totals: Totals = { kills: 0, deaths: 0, xp: 0, gold: 0, items: [], materials: {} };
    const settle = (t: number) => {
      const s = settleFarming(
        input({
          seed: opts.seed,
          character,
          areaId: area.areaId,
          ...(area.pendingAreaId ? { switchToAreaId: area.pendingAreaId } : {}),
          firstCycle,
          inventoryCount: held,
          durationMs: area.carryMs + (t - last),
          ...(professions ? { professions } : {}),
        }),
      );
      last = t;
      area = {
        areaId: s.areaId,
        pendingAreaId: s.switched ? null : area.pendingAreaId,
        carryMs: s.unusedMs,
      };
      firstCycle += s.encounters;
      held += s.items.length;
      totals.kills += s.kills;
      totals.deaths += s.deaths;
      totals.xp += s.xpGained;
      totals.gold += s.goldLooted + s.goldSalvaged;
      totals.items.push(...s.items);
      addMaterials(totals.materials, s.materials);
      professions = s.professions;
      character = { classId: 'mage', level: s.level, xp: s.xp, health: s.health };
    };
    const events = [
      ...opts.switches.map((sw) => ({ t: sw.atMs, to: sw.to as AreaId | null })),
      ...Array.from({ length: Math.floor(opts.endMs / opts.settleEveryMs) }, (_, i) => ({
        t: (i + 1) * opts.settleEveryMs,
        to: null as AreaId | null,
      })),
      { t: opts.endMs, to: null },
    ].sort((a, b) => a.t - b.t || (a.to === null ? -1 : 1));
    for (const e of events) {
      settle(e.t);
      if (e.to) area = requestAreaChange(area, e.to);
    }
    return { ...totals, character, area, firstCycle, professions };
  }

  it('gives the same result however often the client settles around switches', () => {
    for (const seed of ['sw-1', 'sw-2', 'sw-3']) {
      const switches = [
        { atMs: 7 * MIN + 1_234, to: 'oldBurialGrounds' as const },
        { atMs: 7 * MIN + 1_500, to: 'abandonedFields' as const }, // re-targets while pending
        { atMs: 13 * MIN + 77, to: 'crowwood' as const },
      ];
      const once = run({ seed, endMs: 20 * MIN, settleEveryMs: 20 * MIN, switches });
      expect(once.kills).toBeGreaterThan(0);
      // Materials from several areas (Crowwood hide, Fields ashwort), split-invariant too.
      expect(once.materials.rawHide).toBeGreaterThan(0);
      expect(once.materials.ashwort).toBeGreaterThan(0);
      for (const step of [1_000, 3_333, 60_000]) {
        expect(run({ seed, endMs: 20 * MIN, settleEveryMs: step, switches })).toEqual(once);
      }
    }
  });

  it('does not let the switch target change the cycle in progress', () => {
    const base = input({ character: { classId: 'mage', level: 10, xp: 0 }, areaId: 'crowwood' });
    // A window that ends mid-cycle: the switch would become pending here.
    const partial = settleFarming({ ...base, durationMs: 4 * MIN + 500 });
    expect(partial.unusedMs).toBeGreaterThan(0);
    const next = { ...base, firstCycle: partial.encounters, durationMs: 10 * MIN };
    next.character = {
      classId: 'mage',
      level: partial.level,
      xp: partial.xp,
      health: partial.health,
    };
    const toGrave = settleFarming({ ...next, switchToAreaId: 'oldBurialGrounds' });
    const toFields = settleFarming({ ...next, switchToAreaId: 'abandonedFields' });
    expect(toGrave.switched).toBe(true);
    expect(toGrave.switchedAtMs).toBe(toFields.switchedAtMs);
    // Settling exactly the first cycle: identical to staying in Crowwood.
    const firstOnly = { ...next, durationMs: toGrave.switchedAtMs! };
    const stay = settleFarming(firstOnly);
    // Everything but the area bookkeeping (and the per-roster kill map) must match.
    const core = (r: ReturnType<typeof settleFarming>) => {
      const copy: Partial<typeof r> = { ...r };
      delete copy.areaId;
      delete copy.killsByEnemy;
      delete copy.switched;
      delete copy.switchedAtMs;
      return copy;
    };
    for (const target of ['oldBurialGrounds', 'abandonedFields'] as const) {
      const r = settleFarming({ ...firstOnly, switchToAreaId: target });
      expect(r.areaId).toBe(target);
      expect(core(r)).toEqual(core(stay));
    }
  });

  it('does not switch until the cycle in progress completes', () => {
    const r = settleFarming(input({ switchToAreaId: 'crowwood', durationMs: 1_000 }));
    expect(r).toMatchObject({ areaId: 'abandonedFields', switched: false, encounters: 0 });
    expect(r.unusedMs).toBe(1_000);
  });

  describe('requestAreaChange', () => {
    const state = (carryMs: number, pendingAreaId: AreaId | null = null): ActivityAreaState => ({
      areaId: 'abandonedFields',
      pendingAreaId,
      carryMs,
    });
    it('switches at once between cycles', () => {
      expect(requestAreaChange(state(0), 'crowwood')).toEqual({
        areaId: 'crowwood',
        pendingAreaId: null,
        carryMs: 0,
      });
    });
    it('defers the switch while a cycle is in progress', () => {
      expect(requestAreaChange(state(5), 'crowwood').pendingAreaId).toBe('crowwood');
      expect(requestAreaChange(state(5, 'crowwood'), 'blackwater').pendingAreaId).toBe(
        'blackwater',
      );
      // A bound cycle with no time in it yet (restart after a mid-cycle stop) stays bound.
      expect(requestAreaChange(state(0, 'crowwood'), 'blackwater')).toEqual(state(0, 'blackwater'));
    });
    it('cancels a pending switch when the current area is chosen again', () => {
      expect(requestAreaChange(state(5, 'crowwood'), 'abandonedFields')).toEqual(state(5));
    });
    it('rejects an invalid carry', () => {
      expect(() => requestAreaChange(state(-1), 'crowwood')).toThrow(RangeError);
    });
  });
});

describe('salvageValue', () => {
  it('grows with rarity and item level', () => {
    const v = (rarityId: GeneratedItem['rarityId'], itemLevel: number) =>
      salvageValue({ rarityId, itemLevel });
    expect(v('common', 1)).toBeGreaterThanOrEqual(1);
    expect(v('rare', 5)).toBeGreaterThan(v('common', 5));
    expect(v('common', 20)).toBeGreaterThan(v('common', 1));
  });
});
