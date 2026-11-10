import { describe, expect, it } from 'vitest';
import {
  COMMUNITY_PROJECTS as ALL_PROJECTS,
  COMMUNITY_PROJECT_CONFIG,
  type CommunityProjectConfig,
  type CommunityProjectDefinition,
} from '../index.js';
import {
  ENDLESS,
  playTown as playAll,
  town,
  type StageResult,
  type Supply,
} from './community-town.js';

/**
 * Community projects over time (ticket B.3, docs/COMMUNITY.md "How long a stage takes"): a day-by-
 * day model of N players giving to the projects in order, with the real caps (`stageCap`, growing
 * with the stage's age) and what each player can spare a day. It answers: how many days each
 * stage and project takes at 1, 3, 10 and 30 active players, and whether a few players can finish
 * a stage alone (no monopoly, GDD §12.2).
 *
 * Two views:
 * - **cap-bound**: players with endless means, so only the caps limit (the fastest a town of that
 *   size can go, and the no-monopoly checks);
 * - **with gathering**: what a player spares a day. Gathering is ~600 cycles an hour at 5–6 % per
 *   material (≈ 30–36 units an hour, docs/ECONOMY.md "Balance (ticket B.1)"), five visits a day
 *   credit ~15 h; a player spares about a third of that day's gathering of its area's materials
 *   and a quarter (newcomer, levels 9–16: Crowwood to Blackwater, ~1,000 gold an hour) or a third
 *   (veteran: the Abbey and the crypt, ~1,650–2,400 gold an hour) of its gold; materials outside
 *   its area come from salvage and stock (smaller). Seals: one per crypt hoard (20 h cooldown), so
 *   one a day per hero; silver: 0.8 % per Abbey cycle (~70 a day).
 *
 * Ticket 6.7 moved the model to `community-town.ts` (shared with `forgeward-balance.test.ts`) and
 * pinned this suite to B.3's two projects, so its table stays exactly as B.3 measured it; the
 * Forgeward Outpost's pacing is in its own suite.
 */
/** B.3's projects: the Warehouse and the Ashen Pass (ticket 6.7 added a third after them). */
const COMMUNITY_PROJECTS = ALL_PROJECTS.slice(0, 2);
const playTown = (
  players: Supply[],
  config: CommunityProjectConfig = COMMUNITY_PROJECT_CONFIG,
  projects: readonly CommunityProjectDefinition[] = COMMUNITY_PROJECTS,
) => playAll(players, config, projects);
/** Days from the start until each project is finished (1-based: finished on day 1 = 1). */
const projectDays = (r: StageResult[]): [warehouse: number, pass: number] => {
  const [w, p] = COMMUNITY_PROJECTS.map((def) => {
    const last = r.filter((x) => x.project === def.id).at(-1);
    return last && last.stage === def.stages.at(-1)!.id ? last.doneOn + 1 : Infinity;
  });
  // Days for the Ashen Pass counted from the day the Warehouse was done.
  return [w!, p! - w!];
};
/** Before B.3: a flat 20 % cap and the Warehouse's old material needs (timber 400, 300; raw hide
 * 300; iron ore 250). */
const BEFORE: CommunityProjectConfig = { capShare: 0.2, capGrowthPerDay: 0, capShareMax: 0.2 };
const OLD_NEEDS: Record<string, number> = {
  'clearRubble:timber': 400,
  'raiseRoof:timber': 300,
  'raiseRoof:rawHide': 300,
  'ironDoors:ironOre': 250,
};
const BEFORE_PROJECTS: CommunityProjectDefinition[] = COMMUNITY_PROJECTS.map((p) => ({
  ...p,
  stages: p.stages.map((st) => ({
    ...st,
    needs: st.needs.map((n) => ({
      ...n,
      amount: OLD_NEEDS[`${st.id}:${n.resource}`] ?? n.amount,
    })),
  })),
}));
const SIZES = [1, 3, 10, 30];

describe('community projects over time (ticket B.3)', () => {
  const endless = (n: number) => Array.from({ length: n }, () => ENDLESS);
  const runs = {
    capBefore: new Map(SIZES.map((n) => [n, playTown(endless(n), BEFORE, BEFORE_PROJECTS)])),
    capAfter: new Map(SIZES.map((n) => [n, playTown(endless(n))])),
    before: new Map(SIZES.map((n) => [n, playTown(town(n), BEFORE, BEFORE_PROJECTS)])),
    after: new Map(SIZES.map((n) => [n, playTown(town(n))])),
  };
  const stageDays = (r: StageResult[]) => r.map((x) => x.doneOn - x.firstDay + 1).join('/');
  const table = () =>
    SIZES.map((n) => {
      const row = (k: keyof typeof runs) =>
        `${projectDays(runs[k].get(n)!).join(' + ')} d (stages ${stageDays(runs[k].get(n)!)})`;
      return `${n} players — cap-bound: ${row('capBefore')} → ${row('capAfter')}; with gathering: ${row('before')} → ${row('after')}`;
    }).join('\n');

  it('a small town finishes both projects in weeks, not months', () => {
    const label = table();
    // Cap-bound: one player 3 days a stage (was 5), two to four 2 (was 2–3), five or more 1.
    const days = (n: number) => runs.capAfter.get(n)!.map((x) => x.doneOn - x.firstDay + 1);
    expect(
      days(1).every((d) => d === 3),
      label,
    ).toBe(true);
    expect(
      days(3).every((d) => d === 2),
      label,
    ).toBe(true);
    expect(
      days(10).every((d) => d <= 2),
      label,
    ).toBe(true);
    // With gathering: one player alone opens the Warehouse in under two weeks and the Pass within
    // four (bound by materials and gold, not the cap); three players the Warehouse in under a
    // week and the Pass within two.
    const [w1, p1] = projectDays(runs.after.get(1)!);
    const [w3, p3] = projectDays(runs.after.get(3)!);
    expect(w1, label).toBeLessThanOrEqual(12);
    expect(w1 + p1, label).toBeLessThanOrEqual(28);
    expect(w3, label).toBeLessThanOrEqual(5);
    expect(w3 + p3, label).toBeLessThanOrEqual(14);
    // Never slower than before B.3.
    for (const n of SIZES) {
      for (const [b, a] of [
        [runs.before, runs.after],
        [runs.capBefore, runs.capAfter],
      ] as const) {
        const [wb, pb] = projectDays(b.get(n)!);
        const [wa, pa] = projectDays(a.get(n)!);
        expect(wa, label).toBeLessThanOrEqual(wb);
        expect(wa + pa, label).toBeLessThanOrEqual(wb + pb);
      }
    }
  });

  it('no monopoly: a stage needs five players on its first day', () => {
    expect(COMMUNITY_PROJECT_CONFIG.capShare).toBe(0.2);
    expect(COMMUNITY_PROJECT_CONFIG.capShareMax).toBeLessThanOrEqual(0.6);
    for (const k of Object.keys(runs) as (keyof typeof runs)[]) {
      for (const n of SIZES) {
        for (const r of runs[k].get(n)!) {
          const label = `${k} ${n}: ${r.project}/${r.stage}`;
          // Nobody gives more than a fifth of a need on a stage's first day, or more than the
          // ceiling of the growth on any day.
          expect(r.maxFirstDayShare, label).toBeLessThanOrEqual(0.2 + 1e-9);
          expect(r.maxDayShare, label).toBeLessThanOrEqual(
            COMMUNITY_PROJECT_CONFIG.capShareMax + 1e-9,
          );
          // A stage finished on its first day had at least five givers.
          if (r.doneOn === r.firstDay) expect(r.givers, label).toBeGreaterThanOrEqual(5);
        }
      }
    }
    // A big town finishes every stage on the day it opens.
    for (const r of runs.capAfter.get(30)!) expect(r.doneOn).toBe(r.firstDay);
    // Four players with endless means can't finish a stage on its first day.
    for (const r of playTown(endless(4))) expect(r.doneOn, r.stage).toBeGreaterThan(r.firstDay);
  });

  it('records the timeline (the table in docs/COMMUNITY.md)', () => {
    expect(runs.capAfter.get(30)!.length).toBe(COMMUNITY_PROJECTS.flatMap((p) => p.stages).length);
    // Warehouse + Ashen Pass days (the Pass counted from the Warehouse's end), before → after B.3.
    expect(table()).toMatchInlineSnapshot(`
      "1 players — cap-bound: 13 + 12 d (stages 5/5/5/5/5/5) → 7 + 6 d (stages 3/3/3/3/3/3); with gathering: 16 + 13 d (stages 7/6/5/5/5/6) → 10 + 11 d (stages 5/4/3/5/4/5)
      3 players — cap-bound: 5 + 4 d (stages 2/2/3/2/2/3) → 4 + 3 d (stages 2/2/2/2/2/2); with gathering: 5 + 10 d (stages 2/3/2/3/5/5) → 4 + 6 d (stages 2/2/2/2/3/4)
      10 players — cap-bound: 2 + 1 d (stages 1/1/2/1/2/1) → 2 + 1 d (stages 1/1/2/1/1/2); with gathering: 2 + 3 d (stages 1/1/2/1/3/2) → 2 + 2 d (stages 1/1/2/1/2/2)
      30 players — cap-bound: 1 + 0 d (stages 1/1/1/1/1/1) → 1 + 0 d (stages 1/1/1/1/1/1); with gathering: 1 + 1 d (stages 1/1/1/1/2/1) → 1 + 1 d (stages 1/1/1/1/2/1)"
    `);
  });
});
