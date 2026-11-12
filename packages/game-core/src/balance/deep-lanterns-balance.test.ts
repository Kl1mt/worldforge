import { describe, expect, it } from 'vitest';
import {
  COMMUNITY_PROJECT_CONFIG,
  findCommunityProject,
  type CommunityProjectDefinition,
} from '../index.js';
import { ENDLESS, playTown, reachTown, type StageResult } from './community-town.js';

/**
 * Ticket 8.2 (docs/COMMUNITY.md "The lanterns of the deep"): how the Hollow Reach's community gate
 * paces at 20, 100 and 500 active players with the realistic player (`reachTown`: a tenth Hollow
 * Reach heroes, a tenth Cinderwastes heroes, a third veterans, the rest newcomers), whether a small
 * town still finishes it, and whether B.5b's ten-giver first day holds. Modelled from the day it
 * opens (after the Forgeward Outpost). Deterministic: no seed, the same table every run.
 */
const LANTERNS = findCommunityProject('deepLanterns')!;
const SIZES = [20, 100, 500];
const SMALL = [1, 3, 5, 10];
const endless = (n: number) => Array.from({ length: n }, () => ENDLESS);
const play = (players: (typeof ENDLESS)[], projects: readonly CommunityProjectDefinition[]) =>
  playTown(players, COMMUNITY_PROJECT_CONFIG, projects, 200);
const done = (r: StageResult[]) => (r.length === 3 ? r[2]!.doneOn + 1 : Infinity);
const stageDays = (r: StageResult[]) => r.map((x) => x.doneOn - x.firstDay + 1).join('/');
const row = (r: StageResult[]) =>
  `${done(r)} d (stages ${stageDays(r)}; givers ${r.map((x) => x.givers).join('/')}; top ${r.map((x) => Math.round(x.topGiverShare * 100)).join('/')} %)`;

describe('the lanterns of the deep at scale (ticket 8.2)', () => {
  const gather = new Map([...SMALL, ...SIZES].map((n) => [n, play(reachTown(n), [LANTERNS])]));
  const cap = new Map([...SMALL, ...SIZES].map((n) => [n, play(endless(n), [LANTERNS])]));

  it('is a late-game sink: three stages, 400,000 gold, ten Tyrant’s Embers in the last', () => {
    expect(LANTERNS.requires).toBe('forgewardOutpost');
    expect(LANTERNS.stages).toHaveLength(3);
    const total = (r: string) =>
      LANTERNS.stages.reduce(
        (sum, s) => sum + (s.needs.find((n) => n.resource === r)?.amount ?? 0),
        0,
      );
    expect(total('gold')).toBe(400_000);
    expect(total('tyrantsEmber')).toBe(10);
    expect(LANTERNS.stages.at(-1)!.needs.some((n) => n.resource === 'tyrantsEmber')).toBe(true);
    // Nothing from behind its own gate: no crown shard, no new material.
    for (const s of LANTERNS.stages)
      for (const n of s.needs) expect(n.resource, s.id).not.toBe('crownShard');
  });

  it('paces: about a week at 20 players, a day or two at 100 and 500', () => {
    const label = SIZES.map((n) => `${n}: ${row(gather.get(n)!)}`).join('\n');
    expect(done(gather.get(20)!), label).toBeGreaterThanOrEqual(4);
    expect(done(gather.get(20)!), label).toBeLessThanOrEqual(10);
    expect(done(gather.get(100)!), label).toBeLessThanOrEqual(3);
    expect(done(gather.get(500)!), label).toBeLessThanOrEqual(3);
  });

  it('a small town still finishes it: about ten days at five to ten players, three weeks at three', () => {
    const label = SMALL.map((n) => `${n}: ${row(gather.get(n)!)}`).join('\n');
    expect(done(gather.get(10)!), label).toBeLessThanOrEqual(16);
    expect(done(gather.get(5)!), label).toBeLessThanOrEqual(16);
    expect(done(gather.get(3)!), label).toBeLessThanOrEqual(30);
    expect(done(gather.get(1)!), label).toBeLessThan(42);
  });

  it('needs ten givers on a stage’s first day (B.5b’s tenth), and no one carries a stage', () => {
    expect(LANTERNS.stages.map((s) => s.capShare)).toEqual([0.1, 0.1, 0.1]);
    for (const [k, m] of Object.entries({ gather, cap })) {
      for (const [n, r] of m) {
        expect(r.length, `${k} ${n}`).toBe(3);
        for (const x of r) {
          const label = `${k} ${n}: ${x.stage}`;
          expect(x.maxFirstDayShare, label).toBeLessThanOrEqual(0.1 + 1e-9);
          expect(x.maxDayShare, label).toBeLessThanOrEqual(
            COMMUNITY_PROJECT_CONFIG.capShareMax + 1e-9,
          );
          if (x.doneOn === x.firstDay) {
            expect(x.givers, label).toBeGreaterThanOrEqual(10);
            expect(x.topGiverShare, label).toBeLessThanOrEqual(0.1 + 1e-9);
          }
          if (k === 'gather' && n >= 20) expect(x.topGiverShare, label).toBeLessThanOrEqual(0.2);
        }
      }
    }
    // Nine accounts with endless means can't finish a stage on its first day.
    for (const x of play(endless(9), [LANTERNS]))
      expect(x.doneOn, x.stage).toBeGreaterThan(x.firstDay);
  });

  it('records the pacing table (docs/COMMUNITY.md)', () => {
    const table = [...SMALL, ...SIZES]
      .map((n) => `${n}: cap-bound ${row(cap.get(n)!)}; gathering ${row(gather.get(n)!)}`)
      .join('\n');
    expect(table).toMatchInlineSnapshot(`
      "1: cap-bound 10 d (stages 4/4/4; givers 1/1/1; top 100/100/100 %); gathering 37 d (stages 7/23/9; givers 1/1/1; top 100/100/100 %)
      3: cap-bound 4 d (stages 2/2/2; givers 3/3/3; top 40/40/40 %); gathering 20 d (stages 3/5/14; givers 3/3/3; top 48/54/69 %)
      5: cap-bound 4 d (stages 2/2/2; givers 5/4/4; top 40/40/40 %); gathering 10 d (stages 2/3/7; givers 5/5/5; top 30/33/38 %)
      10: cap-bound 3 d (stages 1/2/2; givers 10/4/9; top 10/30/20 %); gathering 10 d (stages 2/2/8; givers 10/10/10; top 20/26/34 %)
      20: cap-bound 2 d (stages 1/1/2; givers 10/10/5; top 10/10/30 %); gathering 6 d (stages 1/2/5; givers 10/18/20; top 10/16/17 %)
      100: cap-bound 1 d (stages 1/1/1; givers 10/10/10; top 10/10/10 %); gathering 2 d (stages 1/1/2; givers 10/15/28; top 10/8/4 %)
      500: cap-bound 1 d (stages 1/1/1; givers 10/10/10; top 10/10/10 %); gathering 2 d (stages 1/1/2; givers 10/23/20; top 10/8/7 %)"
    `);
  });
});
