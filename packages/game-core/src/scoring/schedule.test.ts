import { describe, expect, it } from 'vitest';
import {
  FORMULA_BASELINE,
  FORMULA_VERSIONS,
  computeScore,
  formulaVersionsAt,
  normaliseFormulaSchedule,
  planFormulaSwitches,
  plannedFormulaVersions,
  type FormulaSchedule,
} from '../index.js';

const DAY = 86_400_000;
const t0 = new Date('2026-12-01T00:00:00Z');
const at = (days: number) => new Date(t0.getTime() + days * DAY);
const season = (number: number, from: number, to: number) => ({
  number,
  startsAt: at(from),
  endsAt: at(to),
});

describe('formula versions between seasons (ticket 6.1)', () => {
  it('knows the baseline and the newest versions', () => {
    expect(FORMULA_BASELINE).toEqual({ level: 1, gearScore: 2, power: 1, pveProgress: 1 });
    expect(FORMULA_VERSIONS).toEqual({ level: 1, gearScore: 2, power: 2, pveProgress: 4 });
    expect(formulaVersionsAt([], [], t0)).toEqual(FORMULA_BASELINE);
  });

  it('switches at once between seasons', () => {
    const seasons = [season(1, -60, -4), season(2, 3, 59)];
    const plan = planFormulaSwitches([], seasons, t0);
    expect(plan.map((s) => [s.metric, s.from, s.to, s.afterSeason])).toEqual([
      ['power', 1, 2, null],
      ['pveProgress', 1, 4, null],
    ]);
    expect(formulaVersionsAt(plan, seasons, t0)).toEqual(FORMULA_VERSIONS);
    // Planning again adds nothing.
    expect(planFormulaSwitches(plan, seasons, at(10))).toEqual([]);
  });

  it('waits for the end of the season under way, as the plan stands', () => {
    const seasons = [season(1, -10, 46)];
    const plan = planFormulaSwitches([], seasons, t0);
    expect(plan.every((s) => s.afterSeason === 1)).toBe(true);
    expect(formulaVersionsAt(plan, seasons, t0)).toEqual(FORMULA_BASELINE);
    expect(formulaVersionsAt(plan, seasons, new Date(at(46).getTime() - 1))).toEqual(
      FORMULA_BASELINE,
    );
    expect(formulaVersionsAt(plan, seasons, at(46))).toEqual(FORMULA_VERSIONS);
    // Ended early or extended: the switch moves with the season's end.
    expect(formulaVersionsAt(plan, [season(1, -10, 5)], at(5))).toEqual(FORMULA_VERSIONS);
    expect(formulaVersionsAt(plan, [season(1, -10, 60)], at(50))).toEqual(FORMULA_BASELINE);
    expect(plannedFormulaVersions(plan)).toEqual(FORMULA_VERSIONS);
    expect(planFormulaSwitches(plan, seasons, at(1))).toEqual([]);
  });

  it('chains later versions and never trusts a stored plan', () => {
    const seasons = [season(1, -10, 46), season(2, 46, 102)];
    const plan: FormulaSchedule = planFormulaSwitches([], seasons, t0);
    const stored = JSON.parse(JSON.stringify(plan)) as unknown;
    expect(normaliseFormulaSchedule(stored)).toEqual(plan);
    expect(
      normaliseFormulaSchedule([
        ...plan,
        { metric: 'power', from: 2, to: 9, afterSeason: null },
        { metric: 'nope', from: 1, to: 2, afterSeason: null },
        { metric: 'power', from: 1, to: 2, afterSeason: 0.5 },
        null,
      ]),
    ).toEqual(plan);
    expect(normaliseFormulaSchedule('x')).toEqual([]);
  });

  it('adds 6.2’s PvE Progress 3 after a stored 6.1 plan, at the end of the season under way', () => {
    // Production already holds 6.1's switches (power 1 → 2, PvE Progress 1 → 2, in force).
    const v61 = planFormulaSwitches([], [season(1, -60, -4)], at(-30), {
      ...FORMULA_VERSIONS,
      pveProgress: 2,
    });
    expect(v61.map((s) => [s.metric, s.from, s.to])).toEqual([
      ['power', 1, 2],
      ['pveProgress', 1, 2],
    ]);
    const seasons = [season(1, -60, -4), season(2, -3, 40)];
    const v62 = { ...FORMULA_VERSIONS, pveProgress: 3 };
    const added = planFormulaSwitches(v61, seasons, t0, v62);
    expect(added.map((s) => [s.metric, s.from, s.to, s.afterSeason])).toEqual([
      ['pveProgress', 2, 3, 2],
    ]);
    const plan = [...v61, ...added];
    expect(formulaVersionsAt(plan, seasons, t0)).toEqual({ ...FORMULA_VERSIONS, pveProgress: 2 });
    expect(formulaVersionsAt(plan, seasons, at(40))).toEqual(v62);
    expect(planFormulaSwitches(plan, seasons, at(1), v62)).toEqual([]);
  });

  it('adds 6.3’s PvE Progress 4 after 6.2’s, chained: each lands at the end of its own season', () => {
    const seasons = [season(1, -60, -4), season(2, -3, 40), season(3, 41, 90)];
    const v61 = planFormulaSwitches([], [season(1, -60, -4)], at(-30), {
      ...FORMULA_VERSIONS,
      pveProgress: 2,
    });
    // 6.2's switch waits for season 2 …
    const v62 = planFormulaSwitches(v61, seasons, t0, { ...FORMULA_VERSIONS, pveProgress: 3 });
    // … and 6.3 ships during season 2 too: version 4 follows version 3 at the same end.
    const v63 = planFormulaSwitches([...v61, ...v62], seasons, at(1));
    expect(v63.map((s) => [s.metric, s.from, s.to, s.afterSeason])).toEqual([
      ['pveProgress', 3, 4, 2],
    ]);
    const plan = [...v61, ...v62, ...v63];
    expect(formulaVersionsAt(plan, seasons, at(1)).pveProgress).toBe(2);
    expect(formulaVersionsAt(plan, seasons, at(40)).pveProgress).toBe(4);
    // Shipped in season 3 instead, it waits for that season's end.
    const late = planFormulaSwitches([...v61, ...v62], seasons, at(50));
    expect(late.map((s) => [s.from, s.to, s.afterSeason])).toEqual([[3, 4, 3]]);
    expect(formulaVersionsAt([...v61, ...v62, ...late], seasons, at(50)).pveProgress).toBe(3);
    expect(formulaVersionsAt([...v61, ...v62, ...late], seasons, at(90)).pveProgress).toBe(4);
  });

  it('computes every supported version and refuses others', () => {
    const input = {
      classId: 'mage' as const,
      level: 30,
      experience: 0,
      equipment: [],
      progress: { gravewardenDefeated: true, ashenWardenDefeated: true },
      guildBossStage: 0,
    };
    expect(computeScore('power', input, 1).formulaVersion).toBe(1);
    expect(computeScore('power', input).formulaVersion).toBe(2);
    expect(computeScore('pveProgress', input, 1).value).toBe(7);
    expect(computeScore('pveProgress', input, 2).value).toBe(8);
    expect(computeScore('pveProgress', input, 3).value).toBe(8);
    expect(computeScore('pveProgress', { ...input, level: 34 }, 3).value).toBe(11);
    expect(() => computeScore('gearScore', input, 1)).toThrow(RangeError);
    expect(() => computeScore('power', input, 3)).toThrow(RangeError);
    expect(computeScore('pveProgress', { ...input, level: 34 }, 4).value).toBe(11);
    expect(() => computeScore('pveProgress', input, 5)).toThrow(RangeError);
  });
});
